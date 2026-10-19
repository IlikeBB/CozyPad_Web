import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';

function attributes(value) { return { ...value, isFile: () => value.kind === 'file', isDirectory: () => value.kind === 'directory', isSymbolicLink: () => value.kind === 'link' }; }
export class LocalSftp extends EventEmitter {
  constructor(bridge, owner, id, platform) { super(); Object.assign(this, { bridge, owner, id, platform }); this.session = crypto.randomUUID(); this.closed = false; }
  call(method, params, callback, convert = value => value) {
    if (this.closed) { callback(new Error('Local file channel closed')); return; }
    void this.bridge.request(this.owner, this.id, `fs.${method}`, { ...params, session: this.session }).then(value => callback(null, convert(value)), callback);
  }
  realpath(file, callback) { this.call('realpath', { file }, callback); }
  stat(file, callback) { this.call('stat', { file }, callback, attributes); }
  lstat(file, callback) { this.call('lstat', { file }, callback, attributes); }
  fstat(handle, callback) { this.call('fstat', { handle: handle.toString() }, callback, attributes); }
  mkdir(file, options, callback) { this.call('mkdir', { file, mode: options.mode }, callback); }
  rmdir(file, callback) { this.call('rmdir', { file }, callback); }
  unlink(file, callback) { this.call('unlink', { file }, callback); }
  rename(source, target, callback) { this.call('rename', { file: source, target }, callback); }
  opendir(file, callback) { this.call('opendir', { file }, callback, value => Buffer.from(value)); }
  close(handle, callback) { this.call('close', { handle: handle.toString() }, callback); }
  open(file, flags, mode, callback) { if (typeof mode === 'function') { callback = mode; mode = 0o600; } this.call('open', { file, flags, mode }, callback, value => Buffer.from(value)); }
  read(handle, buffer, offset, length, position, callback) {
    this.call('read', { handle: handle.toString(), length: Math.min(length, 32768), position }, (error, value) => { if (error) callback(error); else { const data = Buffer.from(value, 'base64'); data.copy(buffer, offset); callback(null, data.length, buffer, position); } });
  }
  write(handle, buffer, offset, length, position, callback) { this.call('write', { handle: handle.toString(), data: buffer.subarray(offset, offset + length).toString('base64'), position }, callback); }
  readdir(where, callback) {
    if (Buffer.isBuffer(where)) { this.call('readdir', { handle: where.toString() }, callback, items => items.map(item => ({ filename: item.name, attrs: attributes(item) }))); return; }
    this.opendir(where, (error, handle) => {
      if (error) return callback(error);
      const items = [];
      const next = () => this.readdir(handle, (error, batch) => {
        if (error || !batch?.length) { this.close(handle, () => callback(error?.code === 1 ? null : error, items)); return; }
        items.push(...batch); if (items.length > 5000) { this.close(handle, () => callback(Object.assign(new Error('本機目錄超過 5,000 個項目。'), { status: 413 }))); return; } next();
      }); next();
    });
  }
  createReadStream(file) {
    const channel = this; let handle, position = 0;
    return Readable.from((async function* () {
      handle = await new Promise((resolve, reject) => channel.open(file, 'r', (error, value) => error ? reject(error) : resolve(value)));
      try {
        while (!channel.closed) {
          const buffer = Buffer.alloc(32768), length = await new Promise((resolve, reject) => channel.read(handle, buffer, 0, buffer.length, position, (error, value) => error ? reject(error) : resolve(value)));
          if (!length) break; position += length; yield buffer.subarray(0, length);
        }
      } finally { if (!channel.closed) await new Promise(resolve => channel.close(handle, resolve)); }
    })());
  }
  createWriteStream(file, options = {}) {
    const channel = this; let handle, position = 0;
    const opening = new Promise((resolve, reject) => channel.open(file, options.flags || 'w', options.mode || 0o600, (error, value) => error ? reject(error) : resolve(value)));
    void opening.catch(() => {});
    return new Writable({
      write(chunk, encoding, callback) {
        void (async () => {
          handle ||= await opening;
          for (let offset = 0; offset < chunk.length; offset += 32768) {
            const data = chunk.subarray(offset, offset + 32768);
            await new Promise((resolve, reject) => channel.call('write', { handle: handle.toString(), position, data: data.toString('base64') }, error => error ? reject(error) : resolve())); position += data.length;
          }
        })().then(() => callback(), callback);
      },
      final(callback) { void opening.then(value => new Promise((resolve, reject) => channel.close(value, error => error ? reject(error) : resolve()))).then(() => callback(), callback); },
      destroy(error, callback) { if (handle && !channel.closed) channel.close(handle, () => callback(error)); else callback(error); }
    });
  }
  end() { if (this.closed) return; this.closed = true; void this.bridge.request(this.owner, this.id, 'fs.end', { session: this.session }).catch(() => {}); this.emit('close'); }
}
