import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

test('Markdown preloads before sending, cached turns never reread disk, refresh updates content and cancellation keeps the draft', async ({ page, context }) => {
  const errors: string[] = [], posts: unknown[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/tasks')) posts.push(request.postDataJSON()); });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => {
      if (sessionStorage.getItem('cancel-markdown-picker')) throw new DOMException('Cancelled', 'AbortError');
      const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle('markdown_bank', { create: true });
      for (let index = 0; index < 6; index++) {
        const file = await directory.getFileHandle(`note-${index}.md`, { create: true }), writer = await file.createWritable();
        await writer.write(`# 筆記 ${index}\nNATIVE_MARKDOWN_${index}\n中文內容`); await writer.close();
      }
      const sub = await directory.getDirectoryHandle('sub', { create: true }), nested = await sub.getFileHandle('nested.md', { create: true }), writer = await nested.createWritable();
      await writer.write('# 子資料夾\nNATIVE_NESTED_MARKDOWN'); await writer.close();
      return directory;
    } });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'queryPermission', { value: async () => 'granted' });
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'requestPermission', { value: async () => 'granted' });
    const getFile = FileSystemFileHandle.prototype.getFile;
    Object.defineProperty(FileSystemFileHandle.prototype, 'getFile', { value: function(this: FileSystemFileHandle) {
      if (/\.(md|markdown)$/i.test(this.name)) {
        sessionStorage.setItem('md-preload-reads', String(Number(sessionStorage.getItem('md-preload-reads') || 0) + 1));
        if (sessionStorage.getItem('stall-markdown-file')) return new Promise<File>(() => {});
      }
      return getFile.call(this);
    } });
    const original = FileSystemDirectoryHandle.prototype.values;
    Object.defineProperty(FileSystemDirectoryHandle.prototype, 'values', { value: function(this: FileSystemDirectoryHandle) {
      if (this.name !== 'markdown_bank' || !sessionStorage.getItem('stall-markdown')) return original.call(this);
      return { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); }, async return() { return { done: true }; } };
    } });
  });
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill('markdown_reader'); await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '本機參考資料夾' });
  await dialog.getByRole('button', { name: '選取資料夾', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '預先載入本機 MD' })).toBeChecked();
  await expect(dialog.getByLabel('重新讀取本機目錄')).toBeEnabled();
  await expect(dialog.getByText('已預載入 7 個 MD', { exact: true })).toBeVisible();
  const reads = () => page.evaluate(() => Number(sessionStorage.getItem('md-preload-reads') || 0));
  expect(await reads()).toBe(7); // Full contents were loaded before the first send.
  await page.screenshot({ path: 'test-results/local-markdown-options.png', fullPage: true });
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  const send = async (text: string) => {
    await page.getByLabel('Codex 訊息').fill(text);
    const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/tasks'), { timeout: 5000 });
    await page.getByRole('button', { name: '送出訊息', exact: true }).click();
    const payload = (await sent).postDataJSON();
    await expect(page.getByText(`SSH 測試完成：${text}`, { exact: true })).toBeVisible();
    return payload;
  };
  const first = await send('read native Markdown');
  expect(first.attachments).toHaveLength(1);
  const native = JSON.parse(Buffer.from(first.attachments[0].content, 'base64').toString('utf8'));
  expect(native.files).toHaveLength(7); expect(native.incomplete).toBe(false);
  expect(native.files.find((file: { path: string }) => file.path === 'note-5.md').content).toContain('NATIVE_MARKDOWN_5');
  expect(native.files.find((file: { path: string }) => file.path === 'sub/nested.md').content).toContain('NATIVE_NESTED_MARKDOWN');
  expect(await reads()).toBe(7);
  let tasks = await (await context.request.get('/api/tasks')).json(), task = tasks[0];
  const downloaded = JSON.parse(await (await context.request.get(`/api/tasks/${task.id}/attachments/${task.attachmentManifest[0].id}`)).text());
  expect(downloaded.files).toEqual(native.files);
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.locator('.browser-directory-label')).toHaveText('本機 · markdown_bank/');
  const unchanged = await send('read remembered Markdown'); expect(unchanged.attachments).toHaveLength(0);
  expect(await reads()).toBe(14); // Restoring the page preloads once, not once per turn.
  tasks = await (await context.request.get('/api/tasks')).json(); expect(tasks[0].attachmentManifest).toHaveLength(1);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle('markdown_bank'), file = await directory.getFileHandle('note-0.md'), writer = await file.createWritable();
    await writer.write('# 最新版本\nUPDATED_MARKDOWN_CONTENT'); await writer.close();
  });
  // Even a stalled directory cannot delay cached sends. Edits are loaded only
  // when explicitly refreshed, rather than by walking the tree on every turn.
  await page.evaluate(() => sessionStorage.setItem('cancel-markdown-picker', '1'));
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await dialog.getByRole('button', { name: '選取資料夾', exact: true }).click();
  await expect(dialog.getByLabel('重新讀取本機目錄')).toBeEnabled();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.evaluate(() => sessionStorage.removeItem('cancel-markdown-picker'));
  await page.evaluate(() => sessionStorage.setItem('stall-markdown', '1'));
  const cached = await send('reuse preloaded Markdown'); expect(cached.attachments).toHaveLength(0);
  expect(await reads()).toBe(14);
  await page.evaluate(() => sessionStorage.removeItem('stall-markdown'));
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await dialog.getByRole('button', { name: '重新載入 MD 內容', exact: true }).click();
  await expect(dialog.getByText('已預載入 7 個 MD', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  const changed = await send('read changed Markdown'); expect(changed.attachments).toHaveLength(1);
  expect(await reads()).toBe(21);
  expect(Buffer.from(changed.attachments[0].content, 'base64').toString('utf8')).toContain('UPDATED_MARKDOWN_CONTENT');
  expect(changed.attachments[0].name).not.toBe(first.attachments[0].name);
  await page.getByRole('button', { name: '新增 Codex 對話', exact: true }).click();
  const newChat = await send('new chat uses preloaded Markdown'); expect(newChat.attachments).toHaveLength(1);
  expect(newChat.attachments[0].name).toBe(changed.attachments[0].name);
  expect(await reads()).toBe(21);
  // Failed content reads must never silently send only the directory's name.
  const sentCount = posts.length;
  await page.evaluate(() => sessionStorage.setItem('stall-markdown-file', '1'));
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await dialog.getByRole('button', { name: '重新載入 MD 內容', exact: true }).click();
  await expect(dialog.getByText('正在預載入本機 MD…', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.getByLabel('Codex 訊息').fill('do not send without Markdown');
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await page.getByRole('button', { name: '停止讀取本機 MD', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('訊息尚未送出');
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('do not send without Markdown');
  expect(posts).toHaveLength(sentCount);
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  const fixture = JSON.parse(await readFile('.run-logs/browser-fixture.json', 'utf8'));
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: '改用資料夾檔案讀取', exact: true }).click();
  await (await chooser).setFiles(fixture.markdownRoot);
  await expect(dialog.getByLabel('重新讀取本機目錄')).toBeEnabled();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  const physical = await send('read physical Markdown folder');
  const actual = JSON.parse(Buffer.from(physical.attachments[0].content, 'base64').toString('utf8'));
  expect(actual.files).toHaveLength(7); expect(actual.files.find((file: { path: string }) => file.path === '筆記-5.md').content).toContain('PHYSICAL_MARKDOWN_5');
  expect(actual.files.find((file: { path: string }) => file.path === 'sub/nested.md').content).toContain('PHYSICAL_NESTED_MARKDOWN');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/local-markdown-options-mobile.png', fullPage: true });
  await dialog.getByRole('checkbox', { name: '預先載入本機 MD' }).uncheck();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await page.getByRole('button', { name: '本機參考資料夾', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '預先載入本機 MD' })).not.toBeChecked();
  await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  const disabled = await send('MD read disabled'); expect(disabled.attachments).toHaveLength(0);
  expect(errors).toEqual([]);
});
