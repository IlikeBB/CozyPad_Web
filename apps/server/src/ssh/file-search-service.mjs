import path from 'node:path';
import picomatch from 'picomatch';
import { searchOptions, searchLimits } from '../../../../packages/contracts/src/search.mjs';
import { excludedDirectoryName, privateSearchName as privateName } from '../../../../packages/contracts/src/search-exclusions.mjs';

const problem = (message, status = 400) => Object.assign(new Error(message), { status });

export class FileSearchService {
  active = new Set();
  constructor(files) { this.files = files; }
  async search(owner, id, input, signal) {
    const options = searchOptions(input);
    if (typeof id !== 'string' || !id) throw problem('請指定伺服器。');
    const key = this.files.ssh.key(owner, id);
    if (this.active.has(key)) throw problem('此伺服器已有搜尋進行中，請等待或取消後再試。', 409);
    this.active.add(key);
    let sftp, timer, timedOut = false;
    const controller = new AbortController();
    const cancel = () => { controller.abort(); sftp?.end(); };
    const check = () => {
      if (signal?.aborted) throw problem('搜尋已取消。', 499);
      if (timedOut) throw problem('搜尋時間已達上限。', 408);
    };
    const invoke = async (method, ...args) => {
      check();
      const value = await new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(problem(timedOut ? '搜尋時間已達上限。' : signal?.aborted ? '搜尋已取消。' : '搜尋連線已中斷。', timedOut ? 408 : signal?.aborted ? 499 : 502)); };
        const cleanup = () => { controller.signal.removeEventListener('abort', abort); sftp.removeListener('close', abort); };
        controller.signal.addEventListener('abort', abort, { once: true }); sftp.once('close', abort);
        sftp[method](...args, (error, value) => { cleanup(); error ? reject(error) : resolve(value); });
      });
      check(); return value;
    };
    let result;
    const notices = new Set();
    try {
      check();
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs);
      sftp = await new Promise((resolve, reject) => {
        const abort = () => { controller.signal.removeEventListener('abort', abort); reject(problem(timedOut ? '搜尋時間已達上限。' : '搜尋已取消。', timedOut ? 408 : 499)); };
        controller.signal.addEventListener('abort', abort, { once: true });
        this.files.ssh.sftp(owner, id).then(channel => {
          controller.signal.removeEventListener('abort', abort);
          if (controller.signal.aborted) { channel.end(); return; }
          resolve(channel);
        }, error => { controller.signal.removeEventListener('abort', abort); reject(error); });
      });
      check();
      const home = await invoke('realpath', '.');
      const root = options.root === '~' ? home : options.root.startsWith('~/') ? path.posix.join(home, options.root.slice(2)) : path.posix.resolve(home, options.root);
      if (root === '/' || root === home) throw problem('搜尋不能從根目錄或整個 SSH 家目錄開始，請指定專案子目錄。', 403);
      if (root.split('/').some(privateName)) throw problem('不允許搜尋敏感設定或金鑰目錄。', 403);
      const attributes = await invoke('lstat', root);
      if (!attributes.isDirectory() || attributes.isSymbolicLink() || await invoke('realpath', root) !== root) throw problem('搜尋目錄不能是符號連結或重新導向的路徑。');
      const match = picomatch(options.glob, { dot: true, nobrace: true, noext: true, nonegate: true, nocase: false });
      const counts = { entries: 0, candidateFiles: 0, bytes: 0 }, results = [];
      result = { root, glob: options.glob, ...(options.text !== undefined ? { text: options.text } : {}), complete: false, counts, budget: Object.fromEntries(Object.keys(searchLimits).map(key => [key, options[key]])), limitations: [], results };
      let stopped = false;
      const stop = code => { notices.add(code); stopped = true; };
      const stack = [{ directory: root, depth: 0 }];
      const add = item => { results.push(item); if (results.length >= options.maxResults) stop('max_results'); };
      const read = async file => {
        const handle = await invoke('open', file, 'r');
        try {
          const attrs = await invoke('fstat', handle);
          if (!attrs.isFile()) { notices.add('entry_read_error'); return null; }
          if (attrs.size > options.maxBytes) { notices.add('large_files_skipped'); return null; }
          if (counts.bytes + attrs.size > options.maxTotalBytes) { stop('max_total_bytes'); return null; }
          const chunks = []; let offset = 0;
          while (!stopped) {
            const remaining = Math.min(options.maxBytes + 1 - offset, options.maxTotalBytes - counts.bytes);
            if (remaining <= 0) { stop('max_total_bytes'); return null; }
            const buffer = Buffer.alloc(Math.min(32768, remaining));
            const length = await invoke('read', handle, buffer, 0, buffer.length, offset);
            if (!length) return Buffer.concat(chunks);
            offset += length; counts.bytes += length;
            if (offset > options.maxBytes) { notices.add('large_files_skipped'); return null; }
            chunks.push(buffer.subarray(0, length));
          }
          return null;
        } finally { await invoke('close', handle).catch(() => {}); }
      };
      // Read directory handles one packet at a time; never materialize an entire tree.
      while (stack.length && !stopped) {
        const { directory, depth } = stack.pop();
        let handle;
        try {
          const attrs = await invoke('lstat', directory);
          if (!attrs.isDirectory() || attrs.isSymbolicLink()) { notices.add('links_skipped'); continue; }
          if (await invoke('realpath', directory) !== directory) { notices.add('outside_root_skipped'); continue; }
          handle = await invoke('opendir', directory);
          while (!stopped) {
            let items;
            try { items = await invoke('readdir', handle); } catch (error) { if (error.code === 1) break; throw error; }
            if (!items?.length) break;
            for (const item of items) {
              if (['.', '..'].includes(item.filename)) continue;
              if (counts.entries >= options.maxEntries) { stop('max_entries'); break; }
              counts.entries++;
              const name = item.filename;
              if (typeof name !== 'string' || !name || /[\/\\\x00-\x1f\x7f]/.test(name)) { notices.add('outside_root_skipped'); continue; }
              const file = path.posix.join(directory, name);
              if (file.length > 4096 || !file.startsWith(`${root}/`)) { notices.add('outside_root_skipped'); continue; }
              if (privateName(name)) { notices.add('private_names_skipped'); continue; }
              try {
                const attrs = await invoke('lstat', file);
                if (attrs.isSymbolicLink()) { notices.add('links_skipped'); continue; }
                if (await invoke('realpath', file) !== file) { notices.add('outside_root_skipped'); continue; }
                if (attrs.isDirectory()) {
                  if (excludedDirectoryName(name)) notices.add('excluded_directories');
                  else if (depth >= options.maxDepth) notices.add('max_depth');
                  else stack.push({ directory: file, depth: depth + 1 });
                  continue;
                }
                if (!attrs.isFile() || !match(name)) continue;
                if (counts.candidateFiles >= options.maxFiles) { stop('max_files'); break; }
                counts.candidateFiles++;
                const entry = { name, path: file, directory: false, size: attrs.size, modified: attrs.mtime * 1000 };
                if (options.text === undefined) add(entry);
                else {
                  if (attrs.size > options.maxBytes) { notices.add('large_files_skipped'); continue; }
                  const raw = await read(file);
                  if (!raw) continue;
                  if (raw.includes(0)) { notices.add('binary_files_skipped'); continue; }
                  let content;
                  try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { notices.add('non_utf8_files_skipped'); continue; }
                  let line = 0;
                  for (const text of content.split(/\r\n|[\n\r]/)) {
                    line++;
                    if (text.includes(options.text)) add({ ...entry, line, excerpt: text.slice(0, 240) });
                    if (stopped) break;
                  }
                }
              } catch (error) { check(); notices.add('entry_read_error'); }
              if (stopped) break;
            }
          }
        } catch (error) { check(); notices.add('directory_read_error'); }
        finally { if (handle) await invoke('close', handle).catch(() => {}); }
      }
      result.limitations = [...notices].sort(); result.complete = notices.size === 0;
      return result;
    } catch (error) {
      if (timedOut && result) { result.limitations = [...new Set([...notices, 'timeout'])].sort(); return result; }
      if (error.status || error.code === 'SSH_DISCONNECTED' || error.code === 'HOST_KEY') throw error;
      throw problem(error.code === 2 ? '搜尋目錄不存在。' : '遠端搜尋失敗，請確認目錄權限與 SSH 連線。', error.code === 2 ? 404 : 502);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); sftp?.end(); this.active.delete(key);
    }
  }
}
