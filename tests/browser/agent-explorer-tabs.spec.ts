import { test, expect, type Page, type Route, type BrowserContext } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

const root = '/home/tester/explorer-project';
async function openWorkspace(page: Page, username: string) {
  await page.goto('/'); await page.getByLabel('帳號', { exact: true }).fill(username); await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByRole('tree', { name: '目前工作目錄檔案' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: '資料夾 src', exact: true })).toBeVisible();
}
async function selectDirectory(page: Page, name: string) {
  await page.getByRole('treeitem', { name: `資料夾 ${name}`, exact: true }).click();
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(`${root}/${name}`);
  await expect(page.getByRole('status', { name: '訊息送出狀態' })).toHaveCount(0);
}

test('Explorer previews files and independent conversation tabs retain their drafts, attachments and cwd', async ({ page, context }) => {
  const errors: string[] = [], reads: string[] = [], deletes: string[] = [], sends: { prompt: string; path: string }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/files/content' && request.method() === 'GET') reads.push(url.searchParams.get('path')!);
    if (request.method() === 'DELETE') deletes.push(request.url());
    if (url.pathname === '/api/tasks' && request.method() === 'POST') sends.push(request.postDataJSON());
  });
  await openWorkspace(page, 'explorer_tabs'); expect(reads).toEqual([]);
  await page.getByLabel('Codex 訊息').fill('第一個分頁的草稿');
  await page.getByLabel('選擇 Codex 附件').setInputFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('FIRST_ATTACHMENT') });
  await selectDirectory(page, 'src');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toBeHidden();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByRole('heading', { name: '帳號與登入', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: '問題回報', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toBeHidden();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('第一個分頁的草稿');
  await expect(page.locator('.pending-attachment')).toContainText('first.txt');
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(`${root}/src`);
  await page.getByRole('treeitem', { name: '檔案 tool.py', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'tool.py', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('檔案預覽內容')).toContainText('中文預覽');
  expect(reads).toEqual([`${root}/src/tool.py`]);
  await page.screenshot({ path: 'test-results/agent-explorer-file-preview.png', fullPage: true });
  await page.getByRole('tab', { name: '新對話 1', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('第一個分頁的草稿');
  await expect(page.locator('.pending-attachment')).toContainText('first.txt');
  await page.getByRole('button', { name: '新增 Codex 對話', exact: true }).click();
  await expect(page.getByRole('tab', { name: '新對話 2', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Codex 訊息')).toHaveValue(''); await expect(page.locator('.pending-attachment')).toHaveCount(0);
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(`${root}/src`);
  await page.getByRole('button', { name: '檔案總管上一層', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: '資料夾 notes', exact: true })).toBeVisible(); await selectDirectory(page, 'notes');
  await page.getByLabel('Codex 訊息').fill('第二個分頁的草稿');
  await page.getByLabel('選擇 Codex 附件').setInputFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('SECOND_ATTACHMENT') });
  await page.getByRole('tab', { name: '新對話 1', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('第一個分頁的草稿');
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(`${root}/src`);
  await expect(page.locator('.pending-attachment')).toContainText('first.txt');
  await page.getByRole('tab', { name: '新對話 1', exact: true }).press('ArrowRight');
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('第二個分頁的草稿');
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(`${root}/notes`);
  await expect(page.locator('.pending-attachment')).toContainText('second.txt');
  await page.getByRole('button', { name: '關閉分頁 新對話 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '關閉未送出的分頁' })).toBeVisible();
  await page.getByRole('button', { name: '保留分頁', exact: true }).click(); await expect(page.getByRole('tab', { name: '新對話 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.getByText('SSH 測試完成：第二個分頁的草稿', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toHaveCount(0);
  expect(sends[0].path).toBe(`${root}/notes`);
  await expect(page.getByRole('tab', { name: '對話 · 第二個分頁的草稿', exact: true })).toBeVisible();
  const before = await (await context.request.get('/api/tasks')).json();
  await page.getByRole('button', { name: '關閉分頁 對話 · 第二個分頁的草稿', exact: true }).click();
  const after = await (await context.request.get('/api/tasks')).json(); expect(after[0].id).toBe(before[0].id); expect(deletes).toEqual([]);
  await page.getByRole('button', { name: '工作階段抽屜', exact: true }).click();
  await page.locator('.task-select').filter({ hasText: '第二個分頁的草稿' }).click();
  await page.getByRole('button', { name: '收合工作階段抽屜', exact: true }).click();
  await expect(page.getByText('SSH 測試完成：第二個分頁的草稿', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/agent-tabs-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '檔案總管抽屜', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '檔案總管', exact: true })).toBeVisible();
  const note = page.getByRole('treeitem', { name: '檔案 筆記.md', exact: true }); await expect(note).toBeVisible();
  await page.getByRole('button', { name: '收合檔案總管抽屜', exact: true }).focus();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: '移動檔案 筆記.md', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '檔案總管抽屜', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('a directory selection from an old tab cannot change the new tab cwd or keep sending disabled', async ({ page }) => {
  let pending: Route | undefined;
  await openWorkspace(page, 'explorer_race');
  await page.route('**/api/agents/directories', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().path === `${root}/src`) { pending = route; return; }
    await route.continue();
  });
  await page.getByRole('treeitem', { name: '資料夾 src', exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole('button', { name: '新增 Codex 對話', exact: true }).click();
  await page.getByLabel('Codex 訊息').fill('新分頁不受舊請求影響');
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
  await pending!.fulfill({ json: { path: `${root}/src`, history: [] } });
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(root);
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
});

test('late file previews stay in their own tabs and inaccessible folders do not change cwd', async ({ page }) => {
  let pending: Route | undefined;
  await openWorkspace(page, 'explorer_files'); await selectDirectory(page, 'src');
  await page.route('**/api/files/content?**', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === `${root}/src/tool.py`) { pending = route; return; }
    await route.continue();
  });
  await page.getByRole('treeitem', { name: '檔案 tool.py', exact: true }).click(); await expect.poll(() => !!pending).toBe(true);
  await page.getByRole('treeitem', { name: '檔案 second.py', exact: true }).click();
  await expect(page.getByLabel('檔案預覽內容')).toContainText('SECOND_PREVIEW_MARKER');
  await pending!.fulfill({ json: { path: `${root}/src/tool.py`, content: 'LATE_FIRST_FILE\n' } });
  await expect(page.getByRole('tab', { name: 'second.py', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('檔案預覽內容')).toContainText('SECOND_PREVIEW_MARKER');
  await page.getByRole('tab', { name: 'tool.py', exact: true }).click(); await expect(page.getByLabel('檔案預覽內容')).toContainText('LATE_FIRST_FILE');
  await page.getByRole('tab', { name: '新對話 1', exact: true }).click();
  await page.getByRole('button', { name: 'explorer-project', exact: true }).click();
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(root);
  await expect(page.getByRole('treeitem', { name: '資料夾 blocked', exact: true })).toBeVisible();
  await page.route('**/api/agents/directories', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().path === `${root}/blocked`) { await route.fulfill({ status: 403, json: { error: 'SSH 帳號無權讀取此目錄。' } }); return; }
    await route.continue();
  });
  await page.getByRole('treeitem', { name: '資料夾 blocked', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('SSH 帳號無權讀取此目錄');
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText(root);
  await page.getByLabel('Codex 訊息').fill('保留原目錄'); await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
});
