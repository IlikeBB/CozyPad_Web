import path from 'node:path';
import { virtualDirectoryPath } from '../../../../packages/contracts/src/directory-context.mjs';

const invoke = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
export class FilesService {
  constructor(ssh) { this.ssh = ssh; }
  async location(sftp, requested = '~', base = '~') {
    requested = virtualDirectoryPath(requested, sftp.platform); base = virtualDirectoryPath(base, sftp.platform);
    if ([requested, base].some(value => typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) throw Object.assign(new Error('檔案路徑不正確。'), { status: 400 });
    const home = await invoke(sftp, 'realpath', '.');
    const resolve = value => value === '~' ? home : value.startsWith('~/') ? path.posix.join(home, value.slice(2)) : path.posix.resolve(home, value);
    return requested === '~' || requested.startsWith('~/') ? resolve(requested) : path.posix.resolve(resolve(base), requested);
  }
  async list(owner, id, requested) {
    const sftp = await this.ssh.sftp(owner, id);
    try {
      const directory = await this.location(sftp, requested);
      const entries = await invoke(sftp, 'readdir', directory);
      return { path: directory, entries: entries.filter(item => !['.', '..'].includes(item.filename)).map(item => ({
        name: item.filename, path: path.posix.join(directory, item.filename), directory: item.attrs.isDirectory(),
        size: item.attrs.size, modified: item.attrs.mtime * 1000
      })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
    } finally { sftp.end(); }
  }
  async read(owner, id, requested, max = 2097152, base = '~') {
    const sftp = await this.ssh.sftp(owner, id);
    try {
      const file = await this.location(sftp, requested, base);
      const attributes = await invoke(sftp, 'stat', file);
      if (!attributes.isFile()) throw Object.assign(new Error('此路徑不是一般檔案，無法下載或編輯。'), { status: 400 });
      if (attributes.size > max) throw Object.assign(new Error(`檔案超過 ${max / 1048576} MB 上限。`), { status: 413 });
      const chunks = [];
      let size = 0;
      const data = await new Promise((resolve, reject) => {
        const stream = sftp.createReadStream(file);
        stream.on('data', chunk => { size += chunk.length; if (size > max) stream.destroy(new Error('檔案超過上限。')); else chunks.push(chunk); });
        stream.once('error', reject);
        stream.once('end', () => resolve(Buffer.concat(chunks)));
      });
      return { path: file, data };
    } finally { sftp.end(); }
  }
  async write(owner, id, requested, content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    if (data.length > 10485760) throw Object.assign(new Error('上傳檔案超過 10 MB。'), { status: 413 });
    const sftp = await this.ssh.sftp(owner, id);
    try {
      const file = await this.location(sftp, requested);
      await new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(file);
        stream.once('error', reject); stream.once('close', resolve); stream.end(data);
      });
      return { path: file };
    } finally { sftp.end(); }
  }
}
