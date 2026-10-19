import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';
import { markdownContent } from '../helpers/markdown-browser-fixtures.mjs';

async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill(username);
  await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await expect(page.getByRole('button', { name: 'Markdown', exact: true })).toBeVisible();
}
async function connect(page: Page, context: BrowserContext) {
  const servers = await (await context.request.get('/api/servers')).json();
  await page.getByLabel('選擇伺服器').selectOption(servers[0].id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByText('已連線', { exact: true })).toBeVisible();
}

test('SSH Markdown browser renders formatted documents by default and follows relative documents safely on all screen sizes', async ({ page, context }) => {
  const errors: string[] = [], writes: string[] = []; let connections = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'PUT') writes.push(request.url());
    if (request.method() === 'POST' && request.url().endsWith('/connect')) connections++;
  });
  await login(page, 'md_browser_remote'); await connect(page, context);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const browser = page.getByRole('region', { name: 'SSH Markdown 瀏覽器', exact: true });
  await expect(browser.getByRole('button', { name: 'README.md', exact: true })).toBeVisible();
  await expect(browser.getByRole('button', { name: 'plain.txt', exact: true })).toHaveCount(0);
  await browser.getByRole('button', { name: 'README.md', exact: true }).click();
  const preview = browser.getByRole('region', { name: 'Markdown 預覽', exact: true });
  await expect(preview.getByRole('heading', { name: 'CozyPad 使用說明', exact: true })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('粗體重點'); await expect(preview.locator('em')).toHaveText('斜體說明');
  await expect(preview.locator('blockquote')).toContainText('開啟檔案即可看到排版');
  await expect(preview.getByRole('table')).toHaveCount(1);
  await expect(preview.getByRole('checkbox')).toHaveCount(2);
  await expect(preview.getByRole('checkbox').first()).toBeChecked(); await expect(preview.getByRole('checkbox').first()).toBeDisabled();
  await expect(preview.locator('pre code')).toContainText('Write-Output');
  await expect(preview.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { MARKDOWN_SCRIPT_EXECUTED?: boolean }).MARKDOWN_SCRIPT_EXECUTED)).toBeUndefined();
  await expect(preview.getByRole('link', { name: '危險連結', exact: true })).toHaveCount(0);
  await expect(preview.getByRole('link', { name: '外部文件', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  const image = preview.getByRole('img', { name: '範例圖片', exact: true });
  await image.scrollIntoViewIfNeeded(); await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await preview.evaluate(element => { element.scrollTop = 0; });
    await expect(preview.getByRole('heading', { name: 'CozyPad 使用說明', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/markdown-browser-ssh-${width}.png`, fullPage: true });
  }
  await browser.getByRole('button', { name: '原始碼', exact: true }).click();
  await expect(browser.getByLabel('Markdown 原始碼', { exact: true })).toContainText('# CozyPad 使用說明');
  await expect(browser.getByRole('button', { name: '儲存檔案', exact: true })).toHaveCount(0);
  await browser.getByRole('button', { name: '預覽', exact: true }).click();
  await preview.getByRole('link', { name: '下一份設計文件', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '設計段落', exact: true })).toBeVisible();
  await preview.getByRole('link', { name: '回到使用說明', exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'CozyPad 使用說明', exact: true })).toBeVisible();
  await preview.getByRole('link', { name: '回到功能', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '功能', exact: true })).toBeInViewport();
  await browser.getByRole('button', { name: 'empty.MD', exact: true }).click();
  await expect(preview).toContainText('這個 Markdown 檔案沒有內容。');
  expect(connections).toBe(1); expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test('local Markdown opens without SSH, supports multiple files and source mode, preserves reading across navigation and rejects oversized files', async ({ page }) => {
  const networkWrites: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (['POST', 'PUT'].includes(request.method()) && /\/api\/(?:files|tasks|servers)/.test(request.url())) networkWrites.push(request.url()); });
  await login(page, 'md_browser_local');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(page.getByRole('heading', { name: '閱讀 Markdown', exact: true })).toBeVisible();
  await page.getByLabel('開啟本機 Markdown 檔案', { exact: true }).setInputFiles([
    { name: '本機說明.MD', mimeType: 'text/markdown', buffer: Buffer.from(markdownContent, 'utf8') },
    { name: '其他筆記.md', mimeType: 'text/markdown', buffer: Buffer.from('# 其他筆記\n\n另外一份檔案。', 'utf8') }
  ]);
  const preview = page.getByRole('region', { name: 'Markdown 預覽', exact: true });
  await expect(preview.getByRole('heading', { name: 'CozyPad 使用說明', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '其他筆記.md', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '其他筆記', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '原始碼', exact: true }).click();
  await expect(page.getByLabel('Markdown 原始碼', { exact: true })).toContainText('# 其他筆記');
  await page.getByRole('button', { name: '預覽', exact: true }).click();
  await page.getByRole('button', { name: '問題回報', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '其他筆記', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/markdown-browser-local-320.png', fullPage: true });
  await page.getByLabel('開啟本機 Markdown 檔案', { exact: true }).setInputFiles({ name: 'too-large.md', mimeType: 'text/markdown', buffer: Buffer.alloc(2097153, 65) });
  await expect(page.getByRole('alert')).toContainText('超過 2 MB');
  await expect(preview.getByRole('heading', { name: '其他筆記', exact: true })).toBeVisible();
  expect(networkWrites).toEqual([]); expect(errors).toEqual([]);
});

test('Files defaults Markdown to formatted preview and preserves source edits through preview and saving', async ({ page, context }) => {
  await login(page, 'md_browser_edit'); await connect(page, context);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  const files = page.getByRole('region', { name: '檔案瀏覽器', exact: true });
  await files.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(files.getByRole('heading', { name: 'CozyPad 使用說明', exact: true })).toBeVisible();
  await files.getByRole('button', { name: '原始碼', exact: true }).click();
  await files.getByLabel('檔案內容', { exact: true }).fill('# 更新後的說明\n\n保留預覽與原始碼切換。');
  await files.getByRole('button', { name: '預覽', exact: true }).click();
  await expect(files.getByRole('heading', { name: '更新後的說明', exact: true })).toBeVisible();
  await files.getByRole('button', { name: '儲存檔案', exact: true }).click();
  await expect(page.getByText('已儲存。', { exact: true })).toBeVisible();
  await files.getByRole('button', { name: '關閉編輯器', exact: true }).click();
  await files.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(files.getByRole('heading', { name: '更新後的說明', exact: true })).toBeVisible();
  await files.getByRole('button', { name: 'plain.txt', exact: true }).click();
  await expect(files.getByLabel('檔案內容', { exact: true })).toHaveValue('PLAIN_TEXT_FILE\n');
});

test('Agents Markdown file tabs open in formatted preview and can switch to original text', async ({ page, context }) => {
  await login(page, 'md_agent_preview'); await connect(page, context);
  await page.getByRole('treeitem', { name: '檔案 README.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: '專案說明', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '原始碼', exact: true }).click();
  await expect(page.getByLabel('檔案預覽內容', { exact: true })).toContainText('# 專案說明');
  await page.getByRole('treeitem', { name: '資料夾 notes', exact: true }).click();
  await page.getByRole('treeitem', { name: '檔案 筆記.md', exact: true }).click();
  await expect(page.getByRole('heading', { name: '筆記', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '原始碼', exact: true }).click();
  await expect(page.getByLabel('檔案預覽內容', { exact: true })).toContainText('# 筆記');
  await page.getByRole('button', { name: '預覽', exact: true }).click();
  await expect(page.getByRole('heading', { name: '筆記', exact: true })).toBeVisible();
});
