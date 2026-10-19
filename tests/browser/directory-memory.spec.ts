import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

async function login(page: Page, username = 'directory_user') {
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill(username);
  await page.getByLabel('密碼', { exact: true }).fill('test-password');
  const response = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  if ((await (await response).json()).challengeId) {
    await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
    await page.getByRole('button', { name: '驗證並登入' }).click();
  }
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
}

test('local directory handles survive reload, preserve subfolders, renew permissions and forget removed selections', async ({ page, context }) => {
  const errors: string[] = [], uploads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/tasks')) uploads.push(request.url()); });
  await page.addInitScript(() => {
    // OPFS supplies real, structured-cloneable FileSystemDirectoryHandles without
    // automating the OS picker or reading any user's files.
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => {
      sessionStorage.setItem('pick-count', String(Number(sessionStorage.getItem('pick-count') || '0') + 1));
      if (sessionStorage.getItem('cancel-picker')) throw new DOMException('Cancelled', 'AbortError');
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('remembered-project', { create: true });
      const sub = await directory.getDirectoryHandle('sub', { create: true });
      await sub.getFileHandle('note.txt', { create: true });
      return directory;
    } });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'queryPermission', { value: async () => sessionStorage.getItem('permission') || 'granted' });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'requestPermission', { value: async () => {
      sessionStorage.setItem('permission-request-count', String(Number(sessionStorage.getItem('permission-request-count') || '0') + 1));
      sessionStorage.setItem('permission-had-activation', String(navigator.userActivation.isActive));
      const permission = sessionStorage.getItem('deny-permission') ? 'denied' : 'granted';
      sessionStorage.setItem('permission', permission); return permission;
    } });
  });
  await login(page);
  const servers = await (await context.request.get('/api/servers')).json();
  const primary = servers.find((server: { name: string }) => server.name === 'Directory Fixture');
  const other = servers.find((server: { name: string }) => server.name === 'Other Directory Fixture');
  await page.getByLabel('選擇伺服器').selectOption(primary.id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '本機參考資料夾' });
  await dialog.getByRole('button', { name: '選取資料夾', exact: true }).click();
  await dialog.getByRole('button', { name: 'sub', exact: true }).click();
  await expect(dialog.getByLabel('附加本機檔案 note.txt')).toBeEnabled();
  await expect(dialog.locator('.local-directory-path')).toHaveText('remembered-project/sub');
  await expect(dialog.getByText('已記住此目錄與所在子資料夾，下次開啟會自動恢復。')).toBeVisible();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · remembered-project/sub');
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · remembered-project/sub');
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await expect(dialog.getByLabel('附加本機檔案 note.txt')).toBeEnabled();
  // A cancelled replacement must retain the previous remembered directory.
  await page.evaluate(() => sessionStorage.setItem('cancel-picker', '1'));
  await dialog.getByRole('button', { name: '選取資料夾', exact: true }).click();
  await expect(dialog.getByLabel('重新讀取本機目錄')).toBeEnabled();
  await expect(dialog.locator('.local-directory-path')).toHaveText('remembered-project/sub');
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.getByLabel('選擇伺服器').selectOption(other.id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByRole('button', { name: '本機參考資料夾', exact: true })).toBeEnabled();
  await expect(page.locator('.browser-directory-label')).toHaveCount(0);
  await page.getByLabel('選擇伺服器').selectOption(primary.id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · remembered-project/sub');
  // Permission prompts are initiated only by a click, never on page load.
  await page.evaluate(() => { sessionStorage.setItem('permission', 'prompt'); sessionStorage.setItem('deny-permission', '1'); });
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toContainText('待恢復');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem('permission-request-count'))).toBeNull();
  await page.getByRole('button', { name: '恢復存取', exact: true }).click();
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('尚未取得讀取權限');
  await page.screenshot({ path: 'test-results/local-directory-restore-permission.png', fullPage: true });
  await expect(dialog.locator('.local-directory-list li')).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem('deny-permission'));
  await dialog.getByRole('button', { name: '恢復存取', exact: true }).click();
  await expect(dialog.getByLabel('附加本機檔案 note.txt')).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('permission-had-activation'))).toBe('true');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/remembered-local-directory.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  // Removed subfolders fall back to the existing root, instead of losing it.
  await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const directory = await root.getDirectoryHandle('remembered-project'); await directory.removeEntry('sub', { recursive: true }); });
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · remembered-project/');
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('上次的子目錄已不存在');
  await dialog.getByLabel('移除本機參考資料夾').click();
  await expect(dialog.getByRole('button', { name: '選取資料夾', exact: true })).toBeEnabled();
  await expect(dialog.locator('.local-directory-path')).toHaveCount(0);
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByRole('button', { name: '本機參考資料夾', exact: true })).toBeEnabled();
  await expect(page.locator('.browser-directory-label')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('pick-count'))).toBe('2');
  expect(uploads).toEqual([]); expect(errors).toEqual([]);
});

test('file-input fallback keeps navigation in memory, remembers only metadata after reload and isolates accounts', async ({ page, context }) => {
  await login(page, 'directory_fallback');
  const directoryTrust = (await context.cookies()).filter(cookie => cookie.name === 'cozypad_tt_trust');
  const servers = await (await context.request.get('/api/servers')).json();
  const primary = servers.find((server: { name: string }) => server.name === 'Directory Fixture');
  await page.getByLabel('選擇伺服器').selectOption(primary.id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  const fixture = JSON.parse(await readFile('.run-logs/browser-fixture.json', 'utf8'));
  await page.getByLabel('選取本機資料夾檔案').setInputFiles(fixture.localRoot);
  const dialog = page.getByRole('dialog', { name: '本機參考資料夾' });
  await dialog.getByRole('button', { name: 'sub', exact: true }).click();
  await expect(dialog.getByLabel('附加本機檔案 note.txt')).toBeEnabled();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · local-project/sub');
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · local-project/sub（待恢復）');
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('此瀏覽器需重新選取資料夾');
  await expect(dialog.locator('.local-directory-list li')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢復存取', exact: true })).toHaveCount(0);
  const saved = await page.evaluate(async scope => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('cozypad-tt-local-directories'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<Record<string, unknown>>((resolve, reject) => { const request = database.transaction('directories').objectStore('directories').get(scope); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { database.close(); }
  }, `directory_fallback:${primary.id}`);
  expect(Object.keys(saved).sort()).toEqual(['autoMarkdown', 'parts', 'rootName', 'version']);
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await login(page, 'tester'); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByRole('button', { name: '本機參考資料夾', exact: true })).toBeEnabled();
  await expect(page.locator('.browser-directory-label')).toHaveCount(0);
  await page.getByRole('button', { name: '登出', exact: true }).click();
  await context.addCookies(directoryTrust);
  await login(page, 'directory_fallback'); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toContainText('local-project/sub');
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await dialog.getByLabel('移除本機參考資料夾').click();
  await expect(dialog.getByRole('button', { name: '選取資料夾', exact: true })).toBeEnabled();
});

test('slow local Markdown scans keep partial results, can stop and retry, and preserve the chosen handle before the first batch', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => {
      sessionStorage.setItem('pick-count', String(Number(sessionStorage.getItem('pick-count') || '0') + 1));
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('slow-markdown-project', { create: true });
      await directory.getFileHandle('notes.md', { create: true });
      const sub = await directory.getDirectoryHandle('sub', { create: true });
      await sub.getFileHandle('plan.md', { create: true });
      return directory;
    } });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'queryPermission', { value: async () => 'granted' });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'requestPermission', { value: async () => 'granted' });
    const values = FileSystemDirectoryHandle.prototype.values;
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'values', { value: function(this: FileSystemDirectoryHandle) {
      const mode = sessionStorage.getItem('scan-mode') || 'partial';
      if (this.name !== 'slow-markdown-project' || mode === 'normal') return values.call(this);
      let emitted = false; const root = this;
      return { [Symbol.asyncIterator]() { return this; }, async next() {
        if (!emitted && mode !== 'empty') { emitted = true; return { done: false, value: await root.getDirectoryHandle('sub') }; }
        return new Promise(() => {});
      }, async return() { return { done: true }; } };
    } });
  });
  await login(page, 'directory_slow'); await page.getByRole('button', { name: '連線', exact: true }).click();
  await page.clock.install();
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '本機參考資料夾' });
  await dialog.getByRole('button', { name: '選取資料夾', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'sub', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '停止讀取', exact: true })).toBeEnabled();
  // Passing the old 15 second limit must retain the current progress.
  await page.clock.fastForward(15010);
  await expect(dialog.getByRole('button', { name: '停止讀取', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.clock.fastForward(16000);
  await expect(dialog.getByLabel('重新讀取本機目錄')).toBeEnabled();
  await expect(dialog.getByRole('status')).toContainText('已保留取得的 1 個項目');
  await dialog.getByRole('button', { name: 'sub', exact: true }).click();
  await expect(dialog.getByLabel('附加本機檔案 plan.md')).toBeEnabled();
  await dialog.getByLabel('本機上一層目錄').click();
  await expect(dialog.getByRole('button', { name: '停止讀取', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '停止讀取', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已停止讀取，保留目前取得的 1 個項目');
  await page.evaluate(() => sessionStorage.setItem('scan-mode', 'normal'));
  await dialog.getByLabel('重新讀取本機目錄').click();
  await expect(dialog.getByLabel('附加本機檔案 notes.md')).toBeEnabled();
  // A new attempt stalled before its first entry is still saved and cancellable.
  await page.evaluate(() => sessionStorage.setItem('scan-mode', 'empty'));
  await dialog.getByRole('button', { name: '選取資料夾', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '停止讀取', exact: true })).toBeEnabled();
  await page.clock.fastForward(30010);
  await expect(dialog.getByRole('status')).toContainText('已保留取得的 0 個項目');
  await expect(dialog.getByLabel('重新讀取本機目錄')).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/local-directory-slow-read.png', fullPage: true });
  await page.evaluate(() => sessionStorage.setItem('scan-mode', 'normal'));
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · slow-markdown-project/');
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await expect(dialog.getByLabel('附加本機檔案 notes.md')).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem('pick-count'))).toBe('2');
  expect((await (await context.request.get('/api/tasks')).json()).length).toBe(0);
  expect(errors).toEqual([]);
});
