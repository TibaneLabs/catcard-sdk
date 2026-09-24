import { UserRejectedError } from './bridge';

/** EIP-1193 / TIP-1193 error. */
export class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ProviderRpcError';
  }
}

/** Maps any error to a {@link ProviderRpcError} (4001 for user rejections, -32603 otherwise). */
export function toProviderRpcError(e: unknown): ProviderRpcError {
  if (e instanceof ProviderRpcError) return e;
  if (e instanceof UserRejectedError) return new ProviderRpcError(4001, e.message);
  const err = e as { code?: unknown; message?: string; data?: unknown };
  if (typeof err?.code === 'number') return new ProviderRpcError(err.code, err.message ?? 'RPC error', err.data);
  return new ProviderRpcError(-32603, err?.message ?? String(e));
}

type Listener = (...args: any[]) => void;

/** Minimal `on` / `removeListener` event emitter, as EIP-1193 providers expose. */
export class ProviderEvents {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  protected emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(...args);
      } catch (e) {
        console.error(e);
      }
    }
  }
}
