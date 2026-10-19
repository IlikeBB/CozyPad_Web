import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function userId(username) {
  const id = String(username || '').toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid user identifier');
  return id;
}

export class JsonStore {
  queues = new Map();
  constructor(root) { this.root = root; }
  userPath(username, name) { return `users/${userId(username)}/${name}`; }
  resolve(name) {
    const file = path.resolve(this.root, name);
    if (!file.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new Error('Invalid storage path');
    return file;
  }
  async read(name, fallback) {
    try { return JSON.parse(await readFile(this.resolve(name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
  }
  async write(name, value) {
    const file = this.resolve(name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Windows may briefly lock the destination while another request reads it.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  async update(name, fallback, mutate) {
    const previous = this.queues.get(name) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const value = await this.read(name, fallback);
      const result = await mutate(value);
      await this.write(name, value);
      return result;
    });
    this.queues.set(name, operation);
    try { return await operation; }
    finally { if (this.queues.get(name) === operation) this.queues.delete(name); }
  }
}
