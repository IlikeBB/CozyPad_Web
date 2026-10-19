import { folderNameError } from './folders.mjs';

const problem = message => Object.assign(new Error(message), { status: 400 });
export function virtualDirectoryPath(value, platform) { return platform === 'win32' && typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) ? `/${value.replaceAll('\\', '/')}` : value; }
export function displayDirectoryPath(value, platform) { return platform === 'win32' && /^\/[a-z]:\//i.test(value) ? value.slice(1).replaceAll('/', '\\') : value; }
export function remoteDirectoryPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || /^[a-z]:[\\/]/i.test(value)) throw problem('請輸入 SSH 伺服器上的工作目錄。');
  return value;
}

export function browserDirectoryContext(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || folderNameError(value.rootName) || typeof value.path !== 'string' || value.path.length > 2048 || (value.path && value.path.split('/').some(part => folderNameError(part))) || typeof value.incomplete !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 50) throw problem('本機資料夾資訊不正確。');
  const names = new Set();
  const entries = value.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || folderNameError(entry.name) || !['file', 'directory'].includes(entry.kind) || names.has(entry.name)) throw problem('本機目錄項目不正確。');
    names.add(entry.name); return { name: entry.name, kind: entry.kind };
  });
  const context = { rootName: value.rootName, path: value.path, incomplete: value.incomplete, entries };
  if (new TextEncoder().encode(JSON.stringify(context)).length > 16384) throw problem('本機資料夾資訊超過上限。');
  return context;
}
