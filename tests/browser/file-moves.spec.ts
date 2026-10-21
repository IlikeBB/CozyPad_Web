import { test, expect, type Page } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';
import { moveFileName } from '../helpers/file-move-fixtures.mjs';

async function login(page: Page, username: string) {
  await page.goto('/'); await page.getByLabel('帳號', { exact: true }).fill(username); await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByText('已連線', { exact: true })).toBeVisible();
}

test('Files drag moves remote files and retains unsaved editor content at the new path', async ({ page, context }) => {
  const errors: string[] = [], moves: unknown[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/files/move') moves.push(request.postDataJSON()); });
  await login(page, 'move_files'); await page.getByRole('button', { name: 'Files', exact: true }).click();
  const source = page.getByRole('button', { name: moveFileName, exact: true }), destination = page.getByRole('button', { name: 'archive', exact: true });
  await source.click(); await page.getByLabel('檔案內容', { exact: true }).fill('UNSAVED_CONTENT_PRESERVED');
  await expect(source).toHaveAttribute('draggable', 'true'); await source.dragTo(destination);
  await expect(source).toHaveCount(0); await expect(page.getByRole('status')).toContainText('已將');
  await expect(page.getByLabel('檔案內容', { exact: true })).toHaveValue('UNSAVED_CONTENT_PRESERVED');
  await page.getByRole('button', { name: '儲存檔案', exact: true }).click();
  const profile = (await (await context.request.get('/api/servers')).json())[0];
  const saved = await context.request.get(`/api/files/content?${new URLSearchParams({ serverId: profile.id, path: `${profile.defaultPath}/archive/${moveFileName}` })}`);
  expect((await saved.json()).content).toBe('UNSAVED_CONTENT_PRESERVED'); expect(moves).toHaveLength(1);
  await page.screenshot({ path: 'test-results/file-move-files-editor.png', fullPage: true });
  await page.getByRole('button', { name: '關閉編輯器', exact: true }).click(); await destination.click();
  await expect(page.getByRole('button', { name: moveFileName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: moveFileName, exact: true }).dragTo(page.getByRole('button', { name: '上一層目錄', exact: true }));
  await expect(page.getByRole('button', { name: moveFileName, exact: true })).toHaveCount(0);
  expect(moves).toHaveLength(2); expect(errors).toEqual([]);
});

test('Codex explorer drops into folders, retargets open previews and keeps cwd and drafts intact', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, 'move_agents');
  const source = page.getByRole('treeitem', { name: `檔案 ${moveFileName}`, exact: true });
  await page.getByLabel('Codex 訊息', { exact: true }).fill('保留這份對話草稿'); await source.click();
  await expect(page.getByLabel('檔案預覽內容')).toContainText('FILE_MOVE_CONTENT');
  await source.dragTo(page.getByRole('treeitem', { name: '資料夾 archive', exact: true }));
  const tab = page.getByRole('tab', { name: moveFileName, exact: true });
  await expect(tab).toHaveAttribute('title', `/home/tester/move_agents/archive/${moveFileName}`);
  await expect(page.getByLabel('檔案預覽內容')).toContainText('FILE_MOVE_CONTENT');
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText('/home/tester/move_agents');
  await page.getByRole('tab', { name: '新對話 1', exact: true }).click(); await expect(page.getByLabel('Codex 訊息', { exact: true })).toHaveValue('保留這份對話草稿');
  await page.getByRole('treeitem', { name: '檔案 preview.svg', exact: true }).click();
  await expect.poll(() => page.getByRole('img', { name: '圖片預覽 preview.svg', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(640);
  await expect(page.getByRole('treeitem', { name: '檔案 preview.svg', exact: true })).toHaveAttribute('draggable', 'true');
  await page.getByRole('treeitem', { name: '檔案 preview.svg', exact: true }).dragTo(page.getByRole('treeitem', { name: '資料夾 archive', exact: true }));
  await expect(page.getByRole('tab', { name: 'preview.svg', exact: true })).toHaveAttribute('title', '/home/tester/move_agents/archive/preview.svg');
  await expect.poll(() => page.getByRole('img', { name: '圖片預覽 preview.svg', exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(640);
  await page.screenshot({ path: 'test-results/file-move-explorer.png', fullPage: true }); expect(errors).toEqual([]);
});

test('collisions retain both files, keyboard move works on mobile and foreign drags are rejected', async ({ page, context }) => {
  await login(page, 'move_errors'); await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'duplicate.txt', exact: true }).dragTo(page.getByRole('button', { name: 'archive', exact: true }));
  await expect(page.getByRole('alert')).toContainText('同名檔案'); await expect(page.getByRole('button', { name: 'duplicate.txt', exact: true })).toBeVisible();
  const transfer = await page.evaluateHandle(() => { const value = new DataTransfer(); value.setData('application/x-cozypad-file', JSON.stringify({ serverId: 'foreign-server', source: '/home/other/key.txt' })); return value; });
  await page.getByRole('button', { name: 'archive', exact: true }).dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByRole('alert')).toContainText('只能移動目前伺服器');
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: `移動檔案 ${moveFileName}`, exact: true }).focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '移動檔案', exact: true });
  await dialog.getByLabel('移動目的地資料夾').fill('/home/tester/move_errors/other'); await dialog.getByRole('button', { name: '移動', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: moveFileName, exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const profile = (await (await context.request.get('/api/servers')).json())[0];
  const foreign = await context.request.post('/api/files/move', { headers: { 'x-cozypad-request': '1' }, data: { serverId: 'foreign-server', source: '/home/tester/readme.txt', destination: '~' } }); expect(foreign.status()).toBe(409);
  const original = await context.request.get(`/api/files/content?${new URLSearchParams({ serverId: profile.id, path: '/home/tester/move_errors/duplicate.txt' })}`);
  const target = await context.request.get(`/api/files/content?${new URLSearchParams({ serverId: profile.id, path: '/home/tester/move_errors/archive/duplicate.txt' })}`);
  expect((await original.json()).content).toBe('SOURCE_RETAINED'); expect((await target.json()).content).toBe('TARGET_RETAINED');
  await page.screenshot({ path: 'test-results/file-move-mobile.png', fullPage: true });
});

test('a delayed drop remains single-submit and exposes a folder drop target', async ({ page, context }) => {
  await login(page, 'move_slow'); await page.getByRole('button', { name: 'Files', exact: true }).click();
  const profile = (await (await context.request.get('/api/servers')).json())[0];
  const transfer = await page.evaluateHandle(value => { const data = new DataTransfer(); data.setData('application/x-cozypad-file', JSON.stringify(value)); return data; }, { serverId: profile.id, source: `/home/tester/move_slow/${moveFileName}` });
  const target = page.getByRole('button', { name: 'archive', exact: true }).locator('..').locator('..');
  await target.dispatchEvent('dragover', { dataTransfer: transfer }); await expect(target).toHaveClass(/file-drop-target/);
  await page.screenshot({ path: 'test-results/file-move-drop-target.png', fullPage: true });
  let requests = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/files/move', async route => { requests++; await gate; await route.continue(); });
  await target.dispatchEvent('drop', { dataTransfer: transfer }); await expect.poll(() => requests).toBe(1);
  await target.dispatchEvent('drop', { dataTransfer: transfer }); expect(requests).toBe(1); release();
  await expect(page.getByRole('button', { name: moveFileName, exact: true })).toHaveCount(0); expect(requests).toBe(1);
});

test('Files moves complete folders without rereading the list and offers a mobile folder action', async ({ page, context }) => {
  const errors: string[] = [], lists: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/files') lists.push(url.searchParams.get('path')!); });
  await login(page, 'folder_files'); await page.getByRole('button', { name: 'Files', exact: true }).click();
  const folder = page.getByRole('button', { name: 'bundle', exact: true }), archive = page.getByRole('button', { name: 'archive', exact: true });
  await expect(folder).toHaveAttribute('draggable', 'true'); const before = lists.length;
  await folder.dragTo(archive); await expect(folder).toHaveCount(0); await expect(page.getByRole('status')).toContainText('已將');
  expect(lists).toHaveLength(before);
  const profile = (await (await context.request.get('/api/servers')).json())[0];
  const nested = await context.request.get(`/api/files/content?${new URLSearchParams({ serverId: profile.id, path: `${profile.defaultPath}/archive/bundle/nested/note.txt` })}`);
  expect((await nested.json()).content).toContain('NESTED_CONTENT_PRESERVED');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '移動資料夾 other', exact: true }).focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '移動資料夾', exact: true });
  await dialog.getByLabel('移動目的地資料夾').fill(`${profile.defaultPath}/other`); await dialog.getByRole('button', { name: '移動', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('不能將資料夾移入自己');
  await dialog.getByLabel('移動目的地資料夾').fill(`${profile.defaultPath}/archive`); await dialog.getByRole('button', { name: '移動', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: 'other', exact: true })).toHaveCount(0);
  expect(lists).toHaveLength(before); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/folder-move-mobile.png', fullPage: true });
  await archive.click(); await expect(page.getByRole('button', { name: 'bundle', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'bundle', exact: true }).click();
  await page.getByRole('button', { name: 'nested', exact: true }).click(); await page.getByRole('button', { name: 'note.txt', exact: true }).click();
  await expect(page.getByLabel('檔案內容', { exact: true })).toHaveValue(/NESTED_CONTENT_PRESERVED/); expect(errors).toEqual([]);
});

test('moving an expanded folder retargets descendant previews, cwd, drafts and cached child listings', async ({ page }) => {
  const errors: string[] = [], reads: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (['/api/files', '/api/files/content'].includes(url.pathname)) reads.push(url.pathname + ':' + url.searchParams.get('path')); });
  await login(page, 'folder_agents');
  await page.getByRole('treeitem', { name: '資料夾 bundle', exact: true }).click(); await page.getByRole('treeitem', { name: '資料夾 nested', exact: true }).click();
  await page.getByLabel('Codex 訊息', { exact: true }).fill('資料夾移動後保留草稿');
  await page.getByRole('treeitem', { name: '檔案 note.txt', exact: true }).click(); await expect(page.getByLabel('檔案預覽內容')).toContainText('NESTED_CONTENT_PRESERVED');
  const before = reads.length;
  await page.getByRole('treeitem', { name: '資料夾 bundle', exact: true }).dragTo(page.getByRole('treeitem', { name: '資料夾 archive', exact: true }));
  await expect(page.getByRole('tab', { name: 'note.txt', exact: true })).toHaveAttribute('title', '/home/tester/folder_agents/archive/bundle/nested/note.txt');
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText('/home/tester/folder_agents/archive/bundle/nested');
  await expect(page.getByLabel('檔案預覽內容')).toContainText('NESTED_CONTENT_PRESERVED'); expect(reads).toHaveLength(before);
  await page.getByRole('tab', { name: '新對話 1', exact: true }).click(); await expect(page.getByLabel('Codex 訊息', { exact: true })).toHaveValue('資料夾移動後保留草稿');
  await page.getByRole('treeitem', { name: '資料夾 archive', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: '檔案 duplicate.txt', exact: true })).toHaveCount(2);
  await expect(page.getByRole('treeitem', { name: '檔案 note.txt', exact: true })).toBeVisible();
  expect(reads).toHaveLength(before + 1);
  await page.screenshot({ path: 'test-results/folder-move-explorer.png', fullPage: true }); expect(errors).toEqual([]);
});

test('directory listing starts alongside cwd validation and repeated clicks share the in-flight read', async ({ page }) => {
  await login(page, 'explorer_fast'); const bundle = page.getByRole('treeitem', { name: '資料夾 bundle', exact: true }); await expect(bundle).toBeVisible();
  let selections = 0, listings = 0, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/agents/directories', async route => { if (route.request().method() === 'POST') { selections++; await gate; } await route.continue(); });
  await page.route('**/api/files?*', async route => { if (new URL(route.request().url()).searchParams.get('path')?.endsWith('/bundle')) { listings++; await gate; } await route.continue(); });
  try {
    await bundle.click(); await expect.poll(() => selections).toBe(1); await expect.poll(() => listings).toBe(1);
    await bundle.click(); await expect.poll(() => selections).toBe(2); expect(listings).toBe(1);
  } finally { release(); }
  await expect(page.getByRole('treeitem', { name: '資料夾 nested', exact: true })).toBeVisible();
  await expect(page.getByLabel('目前 SSH pwd', { exact: true })).toHaveText('/home/tester/explorer_fast/bundle'); expect(listings).toBe(1);
});
