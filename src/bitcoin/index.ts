export {
  bitcoinPayment,
  btcNetwork,
  deriveBitcoinAccounts,
  type BitcoinAccount,
  type BitcoinAddressType,
  type BitcoinNetwork,
  type BitcoinPayment,
} from './accounts';
export { decodeExtendedPublicKey, isBitcoinJsonExport, parseBitcoinJsonExport } from './json-export';
export {
  finalizePsbt,
  findOwnInputs,
  mergeSignedPsbt,
  preparePsbtForSigning,
  type BitcoinSigHashFlag,
  type InputToSign,
} from './psbt';
export { CatCardSatsConnectProvider, SatsConnectErrorCode, type SatsConnectAddress } from './sats-connect';
export { SCRIPT_TAGS } from './script';
export { CatCardBitcoinSigner, hashBitcoinMessage, type BitcoinMessageSignature, type BitcoinSignerOptions } from './signer';
export {
  BitcoinConnect,
  BitcoinDisconnect,
  BitcoinEvents,
  BitcoinSignAndSendTransaction,
  BitcoinSignMessage,
  BitcoinSignTransaction,
  CatCardBitcoinWallet,
  DEFAULT_ESPLORA,
  registerCatCardBitcoinWallet,
  SatsConnectFeature,
  type BitcoinAddressPurpose,
  type BitcoinSignTransactionInput,
  type BitcoinWalletOptions,
} from './wallet';

/** Registers a sats-connect provider for WBIP004 discovery (`window.btc_providers`). */
export function registerWBIPProvider(info: { id: string; name: string; icon: string; webUrl?: string; methods?: string[] }): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { btc_providers?: (typeof info)[] };
  const providers = (w.btc_providers ??= []);
  if (!providers.some((p) => p.id === info.id)) providers.push(info);
}
