import crypto from 'node:crypto';

// Compatible with the original CozyPad authenticator secrets (RFC 6238, SHA-1).
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function secret() {
  let bits = '';
  for (const byte of crypto.randomBytes(20)) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g).map(chunk => alphabet[parseInt(chunk.padEnd(5, '0'), 2)]).join('');
}
function decode(value) {
  let bits = '';
  for (const char of value.replace(/[\s=-]/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret');
    bits += index.toString(2).padStart(5, '0');
  }
  return Buffer.from((bits.match(/.{8}/g) || []).map(chunk => parseInt(chunk, 2)));
}
export function generateTotp(value, time = Date.now(), digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const digest = crypto.createHmac('sha1', decode(value)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}
export function matchingStep(value, code, time = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  for (const offset of [-1, 0, 1]) {
    const candidateTime = time + offset * 30000;
    if (crypto.timingSafeEqual(Buffer.from(generateTotp(value, candidateTime)), Buffer.from(code))) {
      return Math.floor(candidateTime / 30000);
    }
  }
  return null;
}
