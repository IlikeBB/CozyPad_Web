import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class KeyVault {
  constructor(root) { this.root = root; }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, 'keyring.key');
    try { this.key = await readFile(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await writeFile(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
      this.key = await readFile(file);
    }
    if (this.key.length !== 32) throw new Error('Invalid key vault; restore the original keyring.key.');
  }
  seal(credentials) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  open(encoded) {
    const buffer = Buffer.from(encoded, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8'));
  }
}
