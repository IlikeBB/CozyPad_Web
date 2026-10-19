import { test, expect, type Page, type BrowserContext } from '@playwright/test';
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
  await page.getByLabel('選擇伺服器').selectOption(servers[0].id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  const input = page.getByLabel('Codex 訊息');
  await expect(input).toBeEnabled();
  await input.fill('[steer-hold]'); await input.press('Enter');
  await expect(page.getByText('正在編寫，等待補充設計方向。', { exact: true })).toBeVisible();
  return input;
}

test('mid-turn guidance uses the active conversation, supports Enter and retains stop on mobile', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const starts: unknown[] = [], steers: Record<string, string>[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/tasks')) starts.push(request.postDataJSON());
    if (request.url().endsWith('/steer')) steers.push(request.postDataJSON());
  });
  const input = await openComposer(page, context, 'steering_user');
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '送出引導', exact: true })).toBeDisabled();
  await input.fill('請優先調整版面'); await input.press('Shift+Enter');
  await expect(input).toHaveValue('請優先調整版面\n'); expect(steers).toHaveLength(0);
  await input.press('Enter');
  await expect(page.locator('.user-message').filter({ hasText: '途中引導' })).toHaveCount(1);
  await expect(page.getByText('已採用引導：請優先調整版面', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await input.fill('保留目前的工作流程'); await page.getByRole('button', { name: '送出引導', exact: true }).click();
  await expect(page.locator('.user-message').filter({ hasText: '途中引導' })).toHaveCount(2);
  expect(starts).toHaveLength(1); expect(steers).toHaveLength(2);
  expect(steers[0].expectedTurnId).toBe(steers[1].expectedTurnId);
  expect(Object.keys(steers[0]).sort()).toEqual(['expectedTurnId', 'prompt', 'requestId']);
  await expect(page.locator('.composer-meta')).toContainText('1 輪對話');
  await page.screenshot({ path: 'test-results/mid-turn-guidance-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '停止回覆', exact: true }).click();
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeVisible();
});

test('rejected guidance preserves the draft and leaves the original job running', async ({ page, context }) => {
  const input = await openComposer(page, context, 'steering_reject');
  await input.fill('[reject] 保留草稿'); await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('未接受引導');
  await expect(input).toHaveValue('[reject] 保留草稿');
  await expect(page.locator('.user-message').filter({ hasText: '途中引導' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '送出引導', exact: true })).toBeEnabled();
  await input.fill('請改為上下排列'); await input.press('Enter');
  await expect(page.getByText('已採用引導：請改為上下排列', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止回覆', exact: true }).click();
});

test('a completion race preserves text and never starts an automatic replacement turn', async ({ page, context }) => {
  let starts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/tasks')) starts++; });
  const input = await openComposer(page, context, 'steering_race');
  await input.fill('[finish-race] 先確認設計'); await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('草稿已保留');
  await expect(input).toHaveValue('[finish-race] 先確認設計');
  await expect(page.getByRole('button', { name: '送出訊息', exact: true })).toBeEnabled();
  expect(starts).toBe(1);
});

test('lost HTTP acknowledgement reuses the guidance ID and does not duplicate accepted input', async ({ page, context }) => {
  const input = await openComposer(page, context, 'steering_retry');
  const ids: string[] = []; let loseFirst = true;
  await page.route('**/api/tasks/*/steer', async route => {
    ids.push(route.request().postDataJSON().requestId);
    const response = await route.fetch();
    if (loseFirst) { loseFirst = false; await route.abort('failed'); } else await route.fulfill({ response });
  });
  await input.fill('重新確認設計約束'); await input.press('Enter');
  await expect(input).toBeEnabled(); await expect(input).toHaveValue('重新確認設計約束');
  await expect(page.locator('.user-message').filter({ hasText: '途中引導' })).toHaveCount(1);
  await input.press('Enter'); await expect(input).toHaveValue('');
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  await expect(page.locator('.user-message').filter({ hasText: '途中引導' })).toHaveCount(1);
  await page.getByRole('button', { name: '停止回覆', exact: true }).click();
});
