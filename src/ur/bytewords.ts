import { QRDecodeError } from '../errors';
import { concatBytes, uint32BE } from '../util/bytes';
import { crc32 } from '../util/crc32';

const WORDS =
  'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';

let minimalLookup: Map<string, number> | undefined;

function lookup(): Map<string, number> {
  if (!minimalLookup) {
    minimalLookup = new Map();
    for (let i = 0; i < 256; i++) minimalLookup.set(WORDS[i * 4]! + WORDS[i * 4 + 3]!, i);
  }
  return minimalLookup;
}

/** The full four-letter byteword for a byte value. */
export function byteword(byte: number): string {
  return WORDS.slice(byte * 4, byte * 4 + 4);
}

/** Encodes bytes in the "minimal" bytewords style (first + last letter), with a CRC-32 suffix. */
export function bytewordsEncodeMinimal(data: Uint8Array): string {
  const withChecksum = concatBytes([data, uint32BE(crc32(data))]);
  let out = '';
  for (const b of withChecksum) out += WORDS[b * 4]! + WORDS[b * 4 + 3]!;
  return out;
}

/** Decodes "minimal" bytewords (case-insensitive) and verifies the CRC-32 suffix. */
export function bytewordsDecodeMinimal(text: string): Uint8Array {
  const lower = text.toLowerCase();
  if (lower.length % 2 !== 0) throw new QRDecodeError('Invalid bytewords length');
  const table = lookup();
  const bytes = new Uint8Array(lower.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const value = table.get(lower.slice(i * 2, i * 2 + 2));
    if (value === undefined) throw new QRDecodeError('Invalid byteword');
    bytes[i] = value;
  }
  if (bytes.length < 5) throw new QRDecodeError('Bytewords payload too short');
  const body = bytes.subarray(0, bytes.length - 4);
  const checksum = new DataView(bytes.buffer, bytes.length - 4).getUint32(0);
  if (checksum !== crc32(body)) throw new QRDecodeError('Bytewords checksum mismatch');
  return body.slice();
}
