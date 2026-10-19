import { realpath, lstat, stat, open, opendir, mkdir, rmdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { privateSearchName } from '../../packages/contracts/src/search-exclusions.mjs';

const problem = (message, code = 3) => Object.assign(new Error(message), { code, status: code === 2 ? 404 : 403 });
export class ConnectorFilesystem {
  handles = new Map();
  ended = new Map();
  constructor(roots, platform = process.platform) { this.roots = roots; this.platform = platform; }
  static async create(roots) {
    if (!Array.isArray(roots) || !roots.length || roots.length > 10) throw new Error('Specify 1-10 project directories.');
    const resolved = [];
    for (const root of roots) {
      const actual = await realpath(path.resolve(root));
      if (actual.startsWith('\\\\') || actual === path.parse(actual).root || actual === await realpath(os.homedir()) || !(await stat(actual)).isDirectory()) throw new Error('Use a local project folder, not a UNC share, disk root or entire user home.');
      resolved.push(actual);
    }
    return new ConnectorFilesystem([...new Set(resolved)]);
  }
  virtual(native) { return this.platform === 'win32' ? `/${native.replaceAll('\\', '/')}` : native; }
  native(virtual) {
    if (typeof virtual !== 'string' || virtual.length > 4096 || /[\x00-\x1f\x7f]/.test(virtual)) throw problem('Invalid local path');
    return this.platform === 'win32' && /^\/[A-Za-z]:\//.test(virtual) ? virtual.slice(1).replaceAll('/', '\\') : virtual;
  }
  contains(native) {
    return this.roots.some(root => { const relative = path.relative(root, native); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); });
  }
  async location(file, missing = false) {
    const requested = file === '.' || file === '~' ? this.roots[0] : this.native(file);
    if (!path.isAbsolute(requested)) throw problem('An absolute granted local path is required');
    const target = path.resolve(requested);
    if (!this.contains(target) || target.split(path.sep).some(privateSearchName)) throw problem('Local path is outside the granted project or is sensitive');
    // Recheck ancestors and real paths, but do not claim this is an atomic filesystem sandbox.
    const canonical = missing ? path.join(await realpath(path.dirname(target)), path.basename(target)) : await realpath(target);
    if (!this.contains(canonical)) throw problem('Local path redirects outside the granted project');
    const root = this.roots.find(root => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); });
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw problem('Local links and junctions are not followed'); }
      catch (error) { if (missing && cursor === target && error.code === 'ENOENT') break; throw error; }
    }
    return canonical;
  }
  attrs(value) { return { kind: value.isSymbolicLink() ? 'link' : value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other', size: value.size, mtime: Math.floor(value.mtimeMs / 1000), mode: value.mode }; }
  handle(session, value) { if (this.ended.has(session) || this.handles.size >= 64) throw problem('Local file session closed or handle limit reached'); const id = crypto.randomUUID(); this.handles.set(`${session}:${id}`, value); return id; }
  get(session, handle) { const value = this.handles.get(`${session}:${handle}`); if (!value) throw problem('Local handle expired', 2); return value; }
  async call(method, params) {
    const { session } = params;
    if (typeof session !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(session)) throw problem('Invalid file session');
    try {
      for (const [key, time] of this.ended) if (Date.now() - time > 300000) this.ended.delete(key);
      if (method === 'end') { this.ended.set(session, Date.now()); for (const [key, value] of this.handles) if (key.startsWith(`${session}:`)) { this.handles.delete(key); await value.handle.close().catch(() => {}); } return true; }
      if (this.ended.has(session) && method !== 'close') throw problem('Local file session closed');
      if (method === 'close') { const key = `${session}:${params.handle}`, value = this.handles.get(key); if (value) { this.handles.delete(key); await value.handle.close(); } return true; }
      if (['fstat', 'read', 'write', 'readdir'].includes(method)) {
        const value = this.get(session, params.handle);
        await this.location(this.virtual(value.file));
        if (method === 'fstat') return this.attrs(await value.handle.stat());
        if (method === 'read') {
          if (!Number.isSafeInteger(params.length) || params.length < 1 || params.length > 32768 || !Number.isSafeInteger(params.position) || params.position < 0 || value.kind !== 'file') throw problem('Invalid local read');
          const buffer = Buffer.alloc(params.length), { bytesRead } = await value.handle.read(buffer, 0, buffer.length, params.position); return buffer.subarray(0, bytesRead).toString('base64');
        }
        if (method === 'write') {
          if (value.kind !== 'file' || typeof params.data !== 'string' || params.data.length > 43692 || !Number.isSafeInteger(params.position) || params.position < 0 || params.position > 31457280) throw problem('Invalid local write');
          const data = Buffer.from(params.data, 'base64'); if (data.length > 32768 || params.position + data.length > 31457280) throw problem('Local write exceeds 30 MB');
          let offset = 0;
          while (offset < data.length) { const { bytesWritten } = await value.handle.write(data, offset, data.length - offset, params.position + offset); if (!bytesWritten) throw problem('Local write stopped'); offset += bytesWritten; }
          return true;
        }
        if (value.kind !== 'directory') throw problem('Invalid local directory handle');
        const entries = [];
        for (let count = 0; count < 64; count++) {
          const item = await value.handle.read(); if (!item) break;
          const file = path.join(value.file, item.name);
          const attrs = this.attrs(await lstat(file)); entries.push({ name: item.name, ...attrs });
        }
        if (!entries.length) throw Object.assign(new Error('End of directory'), { code: 1 }); return entries;
      }
      const missing = ['mkdir', 'open', 'rename'].includes(method), file = await this.location(params.file, missing);
      if (method === 'realpath') return this.virtual(file);
      if (method === 'stat' || method === 'lstat') return this.attrs(await (method === 'stat' ? stat(file) : lstat(file)));
      if (['opendir', 'open'].includes(method) && this.handles.size >= 64) throw problem('Too many local file handles');
      if (method === 'opendir') { const handle = await opendir(file); try { return this.handle(session, { kind: 'directory', file, handle }); } catch (error) { await handle.close(); throw error; } }
      if (method === 'open') {
        if (!['r', 'w', 'wx'].includes(params.flags)) throw problem('Invalid local open flags');
        const handle = await open(file, params.flags, 0o600);
        try { if (!(await handle.stat()).isFile()) throw problem('Only regular local files are supported'); return this.handle(session, { kind: 'file', file, handle }); } catch (error) { await handle.close(); throw error; }
      }
      if (this.roots.includes(file)) throw problem('Granted project roots cannot be removed or renamed');
      if (method === 'mkdir') { await mkdir(file, { mode: 0o700 }); return true; }
      if (method === 'unlink') { await unlink(file); return true; }
      if (method === 'rmdir') { await rmdir(file); return true; }
      if (method === 'rename') {
        const target = await this.location(params.target, true);
        try { await lstat(target); throw problem('Local rename never overwrites an existing target'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await rename(file, target); return true;
      }
      throw problem('Unknown local filesystem method');
    } catch (error) { if (error.code === 'ENOENT') error.code = 2; else if (error.code === 'EACCES' || error.code === 'EPERM') error.code = 3; throw error; }
  }
  async close() { for (const value of this.handles.values()) await value.handle.close().catch(() => {}); this.handles.clear(); }
}
