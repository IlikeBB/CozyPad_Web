import { BrowserDirectory } from './browser-directory.mjs';
import { folderNameError } from '../../../../packages/contracts/src/folders.mjs';
import { excludedDirectoryName, privateSearchName } from '../../../../packages/contracts/src/search-exclusions.mjs';

const databaseName = 'cozypad-tt-local-directories', storeName = 'directories';
const currentDirectories = new Map();
let pending = Promise.resolve();

// Serialize storage operations so a slow save cannot undo a later removal.
function queued(operation) {
  const result = pending.catch(() => {}).then(operation);
  pending = result;
  return result;
}

async function access(mode, operation) {
  if (!globalThis.indexedDB) throw new Error('瀏覽器無法保存本機目錄，下次開啟仍需重新選取。');
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('目錄設定被其他頁面占用，請關閉舊頁面後再試。')); };
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      let request;
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onabort = () => reject(transaction.error || new Error('本機目錄設定未保存。'));
      transaction.onerror = () => {}; // onabort reports the final transaction result.
      try { request = operation(transaction.objectStore(storeName)); }
      catch (error) { transaction.abort(); reject(error); }
    });
  } finally { database.close(); }
}

function valid(value) {
  return value?.version === 1 && !folderNameError(value.rootName) && !privateSearchName(value.rootName)
    && Array.isArray(value.parts) && value.parts.length <= 128
    && value.parts.every(name => !folderNameError(name) && !privateSearchName(name) && !excludedDirectoryName(name));
}

export async function loadBrowserDirectory(scope) {
  await pending.catch(() => {});
  if (currentDirectories.has(scope)) return currentDirectories.get(scope);
  const value = await queued(() => access('readonly', store => store.get(scope)));
  if (!valid(value)) return null;
  // File input fallbacks save only the last location, never stale file contents.
  const directory = value.handle ? new BrowserDirectory(value.handle) : undefined;
  if (directory && directory.root.name !== value.rootName) return null;
  const remembered = { ...value, directory };
  currentDirectories.set(scope, remembered);
  return remembered;
}

export function saveBrowserDirectory(scope, directory, parts, { autoMarkdown = true } = {}) {
  const root = directory.root;
  const value = { version: 1, rootName: root.name, parts: [...parts], autoMarkdown,
    ...(typeof root.queryPermission === 'function' && typeof root.requestPermission === 'function' ? { handle: root } : {}) };
  if (!valid(value)) return Promise.reject(new Error('本機目錄設定不正確。'));
  currentDirectories.set(scope, { ...value, directory });
  return queued(() => access('readwrite', store => store.put(value, scope)));
}

export function forgetBrowserDirectory(scope) {
  currentDirectories.delete(scope);
  return queued(() => access('readwrite', store => store.delete(scope)));
}
