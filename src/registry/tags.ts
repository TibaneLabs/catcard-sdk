/** CBOR tags from the BC-UR and Keystone registries. */
export const TAGS = {
  uuid: 37,
  cryptoHDKey: 303,
  cryptoKeypath: 304,
  cryptoCoinInfo: 305,
  cryptoAccount: 311,
  ethSignRequest: 401,
  ethSignature: 402,
  solSignRequest: 1101,
  solSignature: 1102,
  cryptoMultiAccounts: 1103,
  tronSignRequest: 5101,
  tronSignature: 5102,
  btcSignRequest: 8101,
  btcSignature: 8102,
} as const;
