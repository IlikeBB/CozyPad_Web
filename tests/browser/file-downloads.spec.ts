import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';
import { downloadFolderName, downloadFileName, nestedText } from '../helpers/folder-download-fixtures.mjs';

async function login(page: Page, username: string) {
  await page.goto('/'); await page.getByLabel('帳號', { exact: true }).fill(username); await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByText('已連線', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Files', exact: true }).click();
}

test('Files downloads large binary files and a complete folder archive without leaving the workspace', async ({ page }) => {
  const errors: string[] = []; let logins = 0; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/connect')) logins++; });
  await login(page, 'file_downloader'); const initialUrl = page.url();
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `下載 ${downloadFileName}`, exact: true }).click()]);
  expect(file.suggestedFilename()).toBe(downloadFileName); expect(await file.failure()).toBeNull();
  expect(await readFile((await file.path())!)).toEqual(Buffer.alloc(11 * 1048576 + 5, 42));
  const folderLink = page.getByRole('link', { name: `下載資料夾 ${downloadFolderName}`, exact: true });
  await folderLink.focus();
  const [folder] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(folder.suggestedFilename()).toBe(`${downloadFolderName}.tar.gz`); expect(await folder.failure()).toBeNull();
  const bytes = await readFile((await folder.path())!); expect(bytes.length).toBeGreaterThan(4 * 1048576);
  const text = execFileSync('tar', ['-xOzf', '-', '--', `${downloadFolderName}/nested/筆記.txt`], { input: bytes, encoding: 'utf8' }); expect(text).toBe(nestedText);
  expect(page.url()).toBe(initialUrl); await expect(page.getByRole('region', { name: '檔案瀏覽器', exact: true })).toBeVisible();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await expect(folderLink).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const row = folderLink.locator('..');
    const buttons = await row.locator('.icon-button').evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    for (let index = 0; index < buttons.length; index++) for (const other of buttons.slice(index + 1)) {
      const current = buttons[index]; expect(current.right <= other.x || other.right <= current.x || current.bottom <= other.y || other.bottom <= current.y).toBe(true);
    }
    await page.screenshot({ path: `test-results/files-downloads-${width}.png`, fullPage: true });
  }
  expect(logins).toBe(1); expect(errors).toEqual([]);
});

test('a folder download failure is shown in Files and another download still works', async ({ page }) => {
  await login(page, 'file_download_other'); const url = page.url();
  await page.route('**/api/files/archive?*', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: '沒有權限讀取此資料夾。' }) }));
  await page.getByRole('link', { name: `下載資料夾 ${downloadFolderName}`, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('沒有權限讀取此資料夾'); expect(page.url()).toBe(url);
  await page.unroute('**/api/files/archive?*');
  const [empty] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: '下載 empty.txt', exact: true }).click()]);
  expect(await empty.failure()).toBeNull(); expect((await readFile((await empty.path())!)).length).toBe(0); await expect(page.getByRole('alert')).toHaveCount(0);
});
