// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { UserRejectedError } from '../src/bridge';
import { injectCatCard } from '../src/inject';
import { createURSequence } from '../src/sequence';
import { memoryStorage } from '../src/storage';
import { createModalBridge } from '../src/ui';
import { UR } from '../src/ur';
import { SimulatedBridge, SimulatedCatCard } from './helpers/device';

const modalRoot = () => document.querySelector('[data-catcard-modal]')?.shadowRoot ?? null;
const click = (label: string) =>
  [...modalRoot()!.querySelectorAll('button')].find((b) => b.textContent === label || b.title === label)!.click();

/** Lets queued dialogs open. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => document.querySelectorAll('[data-catcard-modal]').forEach((n) => n.remove()));

describe('ModalBridge', () => {
  it('shows the request, then accepts the answer via the paste fallback', async () => {
    const bridge = createModalBridge();
    const answer = UR.fromBytes(new Uint8Array(300).fill(5));
    const promise = bridge.exchange({
      title: 'Sign transaction',
      details: [{ label: 'To', value: '0xabc' }],
      request: createURSequence(UR.fromBytes(new Uint8Array(500).fill(1))),
      parse: (result) => (result.format === 'ur' ? result.ur.toBytes().length : -1),
    });
    await flush();
    const root = modalRoot()!;
    expect(root.querySelector('h2')!.textContent).toBe('Sign transaction');
    expect(root.querySelector('dd')!.textContent).toBe('0xabc');
    expect(root.querySelector('.status')!.textContent).toMatch(/part 1 of \d+/);

    click('Next: scan CatCard');
    const sequence = createURSequence(answer);
    const frames = Array.from({ length: sequence.frameCount }, () => sequence.nextFrame());
    root.querySelector('textarea')!.value = frames.join('\n');
    click('Use pasted text');
    await expect(promise).resolves.toBe(300);
    expect(modalRoot()).toBeNull();
  });

  it('keeps the dialog open when parse rejects the scan', async () => {
    const bridge = createModalBridge();
    const promise = bridge.exchange({
      title: 'Connect',
      parse: () => {
        throw new Error('Not an account QR');
      },
    });
    await flush();
    modalRoot()!.querySelector('textarea')!.value = 'hello';
    click('Use pasted text');
    expect(modalRoot()!.querySelector('.error')!.textContent).toBe('Not an account QR');
    click('Cancel');
    await expect(promise).rejects.toBeInstanceOf(UserRejectedError);
  });

  it('rejects with UserRejectedError on Escape, and runs requests one at a time', async () => {
    const bridge = createModalBridge();
    const first = bridge.exchange({ title: 'First', parse: () => 1 });
    const second = bridge.exchange({ title: 'Second', parse: () => 2 });
    await flush();
    expect(document.querySelectorAll('[data-catcard-modal]')).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(first).rejects.toBeInstanceOf(UserRejectedError);
    await flush();
    expect(modalRoot()!.querySelector('h2')!.textContent).toBe('Second');
    click('Cancel');
    await expect(second).rejects.toBeInstanceOf(UserRejectedError);
  });
});

describe('injectCatCard', () => {
  it('announces the EVM provider via EIP-6963 and registers the Solana wallet', async () => {
    const announced: any[] = [];
    window.addEventListener('eip6963:announceProvider', (e) => announced.push((e as CustomEvent).detail));
    const registered: any[] = [];
    window.addEventListener('wallet-standard:register-wallet', (e) => (e as CustomEvent).detail({ register: (w: any) => registered.push(w) }));

    const device = new SimulatedCatCard();
    const bridge = new SimulatedBridge(device);
    bridge.scanOnly = () => device.evmAccountExport();
    const injected = injectCatCard({ bridge, storage: memoryStorage() });

    expect(announced).toHaveLength(1);
    expect(announced[0].info).toMatchObject({ name: 'CatCard', rdns: 'net.tibane.catcard' });
    expect(announced[0].info.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(announced[0].provider).toBe(injected.evm);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(announced).toHaveLength(2);

    expect(registered).toEqual([injected.solana]);
    expect(injectCatCard()).toBe(injected);

    const accounts = await injected.evm!.request({ method: 'eth_requestAccounts' });
    expect(accounts).toHaveLength(1);
  });
});
