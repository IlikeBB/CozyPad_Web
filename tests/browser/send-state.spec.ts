import { test, expect, type Page, type BrowserContext, type Route } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

async function openComposer(page: Page, context: BrowserContext, username: string) {
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill(username);
  await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
  const servers = await (await context.request.get('/api/servers')).json();
  const primary = servers.find((server: { name: string }) => server.name === 'Send Primary');
  const peer = servers.find((server: { name: string }) => server.name === 'Send Peer');
  await page.getByLabel('選擇伺服器').selectOption(primary.id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toBeEnabled();
  return { primary, peer };
}

test('cancelling a pending peer directory releases the send lock and ignores its late response after switching', async ({ page, context }) => {
  const { peer } = await openComposer(page, context, 'send_state');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let pending: Route | undefined;
  await page.route('**/api/agents/directories**', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().serverId === peer.id) { pending = route; return; }
    await route.continue();
  });
  const draft = '切換對話後仍可送出';
  await page.getByLabel('Codex 訊息').fill(draft);
  await page.getByLabel('Codex 執行模式').selectOption('cooperative');
  await page.getByLabel('協同 Codex 來源').selectOption(peer.id);
  await page.locator('.cooperation-controls').getByRole('button', { name: '更改 SSH 工作目錄', exact: true }).click();
  await page.getByLabel('新的 SSH 工作目錄', { exact: true }).fill('/home/tester/projects');
  await page.getByRole('button', { name: '套用', exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeDisabled();
  await page.getByRole('dialog', { name: 'SSH 工作目錄', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '工作階段抽屜', exact: true }).click();
  await page.locator('.task-row').filter({ hasText: '已完成的一般對話' }).locator('.task-select').click();
  await expect(page.getByLabel('Codex 執行模式')).toHaveValue('general');
  await expect(page.getByLabel('協同 Codex 來源')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Codex 訊息')).toHaveValue(draft);
  await pending!.fulfill({ json: { path: '/home/tester/projects', history: [] } });
  await expect(page.getByLabel('目前 SSH pwd')).toHaveText('/home/tester');
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '收合工作階段抽屜', exact: true }).click();
  await page.getByRole('button', { name: '送出訊息', exact: true }).click();
  await expect(page.getByText(`SSH 測試完成：${draft}`, { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('disabled sends explain a missing cooperative target and changing to general restores submission', async ({ page, context }) => {
  await openComposer(page, context, 'send_feedback');
  await page.getByLabel('Codex 訊息').fill('保留未送出的草稿');
  await page.getByLabel('Codex 執行模式').selectOption('cooperative');
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeDisabled();
  await expect(page.getByRole('status', { name: '訊息送出狀態' })).toHaveText('請選擇協同端，或改用一般處理。');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/send-disabled-reason-mobile.png', fullPage: true });
  await page.getByLabel('Codex 執行模式').selectOption('general');
  await expect(page.getByRole('status', { name: '訊息送出狀態' })).toHaveCount(0);
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('保留未送出的草稿');
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
});
