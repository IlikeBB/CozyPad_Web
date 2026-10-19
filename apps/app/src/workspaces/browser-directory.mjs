import { folderNameError } from '../../../../packages/contracts/src/folders.mjs';
import { browserDirectoryContext } from '../../../../packages/contracts/src/directory-context.mjs';
import { excludedDirectoryName, privateSearchName } from '../../../../packages/contracts/src/search-exclusions.mjs';

const validName = name => { if (folderNameError(name)) throw new Error('本機資料夾路徑不正確。'); return name; };
const cancelled = () => new DOMException('已停止讀取資料夾。', 'AbortError');
const timedOut = () => new DOMException('本機目錄讀取逾時。', 'TimeoutError');
function wait(operation, signal, deadline) {
  if (signal?.aborted) return Promise.reject(cancelled());
  if (Date.now() >= deadline) return Promise.reject(timedOut());
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(() => { cleanup(); reject(timedOut()); }, deadline - Date.now());
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export class BrowserDirectory {
  constructor(handle, incomplete = false) {
    validName(handle.name);
    if (handle.kind !== 'directory' || privateSearchName(handle.name)) throw new Error('不能選取敏感設定或金鑰資料夾。');
    this.root = handle; this.incomplete = incomplete;
  }
  async read(parts = [], signal, { timeoutMs = 30000, onProgress } = {}) {
    if (signal?.aborted) throw cancelled();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('本機目錄讀取期限不正確。');
    const deadline = Date.now() + timeoutMs;
    let directory = this.root;
    for (const name of parts) {
      validName(name);
      if (privateSearchName(name) || excludedDirectoryName(name)) throw new Error('此本機子目錄已排除。');
      directory = await wait(() => directory.getDirectoryHandle(name), signal, deadline);
    }
    const iterator = directory.values()[Symbol.asyncIterator](), items = [];
    let incomplete = this.incomplete, seen = 0, stopReason, lastProgress = 0;
    const snapshot = partial => {
      const ordered = [...items].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
      return { items: ordered, ...(stopReason ? { stopReason } : {}), context: browserDirectoryContext({ rootName: this.root.name, path: parts.join('/'), incomplete: incomplete || partial, entries: ordered.map(({ name, kind }) => ({ name, kind })) }) };
    };
    const progress = () => { lastProgress = Date.now(); onProgress?.(snapshot(true)); };
    try {
      // Once the target is open, every progress snapshot belongs to this directory.
      progress();
      while (true) {
        const next = await wait(() => iterator.next(), signal, deadline);
        if (next.done) break;
        if (++seen > 5000) { incomplete = true; stopReason = 'limit'; break; }
        const handle = next.value;
        if (folderNameError(handle.name) || privateSearchName(handle.name) || (handle.kind === 'directory' && excludedDirectoryName(handle.name))) { incomplete = true; continue; }
        if (!['file', 'directory'].includes(handle.kind)) { incomplete = true; continue; }
        items.push({ name: handle.name, kind: handle.kind, handle });
        if (items.length === 1 || Date.now() - lastProgress >= 100) progress();
        if (items.length >= 50) { incomplete = true; stopReason = 'limit'; break; }
      }
    } catch (error) {
      if (!(error instanceof DOMException) || !['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      incomplete = true; stopReason = error.name === 'TimeoutError' ? 'timeout' : 'cancelled';
    } finally { if (iterator.return) void Promise.resolve().then(() => iterator.return()).catch(() => {}); }
    return snapshot(false);
  }
}

export function directoryFromFiles(files) {
  if (!files.length) throw new Error('沒有取得本機資料夾檔案，請重新選取。');
  const rootName = files[0].webkitRelativePath?.split('/')[0]; validName(rootName);
  const node = name => ({ name, kind: 'directory', children: new Map(), async *values() { yield* this.children.values(); }, async getDirectoryHandle(name) { const child = this.children.get(name); if (child?.kind !== 'directory') throw new Error('本機子目錄不存在。'); return child; } });
  const root = node(rootName); let incomplete = files.length > 5000;
  // The fallback receives browser-selected metadata; never read any file body here.
  for (let index = 0; index < Math.min(files.length, 5000); index++) {
    const file = files[index], parts = file.webkitRelativePath?.split('/');
    if (!parts || parts.length < 2 || parts[0] !== rootName || parts.at(-1) !== file.name || parts.some(part => folderNameError(part))) throw new Error('瀏覽器未提供有效的本機資料夾相對路徑。');
    if (parts.some(privateSearchName) || parts.slice(1, -1).some(excludedDirectoryName)) { incomplete = true; continue; }
    let directory = root;
    for (const part of parts.slice(1, -1)) { if (!directory.children.has(part)) directory.children.set(part, node(part)); directory = directory.children.get(part); }
    directory.children.set(file.name, { name: file.name, kind: 'file', getFile: async () => file });
  }
  return new BrowserDirectory(root, incomplete);
}
