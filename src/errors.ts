/** Base class for every error thrown by the SDK. */
export class CatCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A QR frame could not be parsed, or is inconsistent with previously received frames. */
export class QRDecodeError extends CatCardError {}

/** A payload cannot be encoded with the requested options. */
export class QREncodeError extends CatCardError {}
