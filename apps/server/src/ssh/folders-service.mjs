import path from 'node:path';
import { folderNameError } from '../../../../packages/contracts/src/folders.mjs';

const invoke = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
function validName(name) { const error = folderNameError(name); if (error) throw problem(error); return name; }
async function missing(sftp, target) {
  try { await invoke(sftp, 'lstat', target); }
  catch (error) { if (error.code === 2) return; throw error; }
  throw problem('同名檔案或資料夾已存在，不會覆寫。', 409);
}
async function directory(sftp, target) {
  const attributes = await invoke(sftp, 'lstat', target);
  if (!attributes.isDirectory() || attributes.isSymbolicLink()) throw problem('此路徑不是一般資料夾，不能操作符號連結。');
  if (await invoke(sftp, 'realpath', target) !== target) throw problem('遠端資料夾路徑已變更，請重新整理後再試。', 409);
}

export class FoldersService {
  queues = new Map();
  constructor(files) { this.files = files; }
  async operate(owner, id, parent, action) {
    if (typeof id !== 'string' || !id || typeof parent !== 'string' || !parent || parent.length > 4096 || /[\x00-\x1f\x7f]/.test(parent)) throw problem('伺服器或資料夾路徑不正確。');
    const key = this.files.ssh.key(owner, id);
    const operation = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      const sftp = await this.files.ssh.sftp(owner, id);
      try {
        const home = await invoke(sftp, 'realpath', '.');
        const resolvedParent = await invoke(sftp, 'realpath', await this.files.location(sftp, parent));
        await directory(sftp, resolvedParent);
        return await action(sftp, resolvedParent, home);
      } catch (error) {
        if (error.status) throw error;
        if (error.code === 2) throw problem('資料夾不存在或已被移動，請重新整理。', 404);
        if (error.code === 3) throw problem('SSH 帳號沒有操作此資料夾的權限。', 403);
        throw problem('遠端資料夾操作失敗，請檢查權限、資料夾內容與 SSH 連線。', 502);
      } finally { sftp.end(); }
    });
    this.queues.set(key, operation);
    try { return await operation; } finally { if (this.queues.get(key) === operation) this.queues.delete(key); }
  }
  protected(target, home) {
    if (target === '/' || target === home) throw problem('不能刪除或更名根目錄及 SSH 家目錄。', 403);
  }
  async create(owner, id, parent, name) {
    validName(name);
    return this.operate(owner, id, parent, async (sftp, parent) => {
      const target = path.posix.join(parent, name);
      await missing(sftp, target); await invoke(sftp, 'mkdir', target, { mode: 0o755 });
      return { path: target };
    });
  }
  async rename(owner, id, parent, name, newName) {
    validName(name); validName(newName);
    return this.operate(owner, id, parent, async (sftp, parent, home) => {
      const source = path.posix.join(parent, name), target = path.posix.join(parent, newName);
      this.protected(source, home); this.protected(target, home); await directory(sftp, source);
      if (source === target) return { path: source };
      await missing(sftp, target);
      // Use ordinary SFTP rename, not the overwriting OpenSSH POSIX extension.
      await invoke(sftp, 'rename', source, target);
      return { path: target };
    });
  }
  async delete(owner, id, parent, name, recursive = false, confirmation = '') {
    validName(name);
    if (typeof recursive !== 'boolean' || (recursive && confirmation !== name)) throw problem('刪除所有內容前，請輸入完整資料夾名稱確認。');
    return this.operate(owner, id, parent, async (sftp, parent, home) => {
      const root = path.posix.join(parent, name);
      this.protected(root, home); await directory(sftp, root);
      const plan = [];
      let visited = 0;
      const visit = async (target, depth) => {
        if (++visited > 2000 || depth > 32) throw problem('資料夾超過 2,000 個項目或 32 層上限，尚未刪除任何內容。', 413);
        const attributes = await invoke(sftp, 'lstat', target);
        if (attributes.isDirectory() && !attributes.isSymbolicLink()) {
          await directory(sftp, target);
          const children = (await invoke(sftp, 'readdir', target)).filter(item => !['.', '..'].includes(item.filename));
          if (!recursive && children.length) throw problem('資料夾不是空的；若確定要刪除內容，請勾選一併刪除並輸入名稱確認。', 409);
          if (children.length + visited > 2000) throw problem('資料夾超過 2,000 個項目上限，尚未刪除任何內容。', 413);
          for (const child of children) {
            validName(child.filename);
            const next = path.posix.join(target, child.filename);
            if (!next.startsWith(`${root}/`)) throw problem('遠端資料夾包含不安全的路徑。');
            await visit(next, depth + 1);
          }
          plan.push({ path: target, kind: 'directory' });
        } else if (attributes.isFile() || attributes.isSymbolicLink()) plan.push({ path: target, kind: attributes.isSymbolicLink() ? 'link' : 'file' });
        else throw problem('資料夾包含特殊檔案，尚未刪除任何內容。');
      };
      await visit(root, 0);
      let removed = 0;
      try {
        // Preflight the entire tree, then recheck parents before each removal; never follow links.
        for (const entry of plan) {
          await directory(sftp, root);
          await directory(sftp, path.posix.dirname(entry.path));
          const attributes = await invoke(sftp, 'lstat', entry.path);
          const kind = attributes.isSymbolicLink() ? 'link' : attributes.isDirectory() ? 'directory' : attributes.isFile() ? 'file' : 'other';
          if (kind !== entry.kind) throw problem('資料夾內容已變更，已停止刪除，請重新整理。', 409);
          await invoke(sftp, entry.kind === 'directory' ? 'rmdir' : 'unlink', entry.path); removed++;
        }
      } catch (error) {
        if (removed) throw problem('刪除中途停止，部分內容可能已刪除；請重新整理後確認剩餘檔案。', error.status || 502);
        throw error;
      }
      return { path: root, removed };
    });
  }
}
