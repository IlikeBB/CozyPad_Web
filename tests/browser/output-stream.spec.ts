import { test, expect } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

test('Codex completes output above 4 MB and can continue in the same browser conversation', async ({ page, context }) => {
  const errors: string[] = [], starts: unknown[] = []; let connections = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/connect')) connections++;
    if (request.url().endsWith('/api/tasks')) starts.push(request.postDataJSON());
  });
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill('stream_output');
  await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
  const servers = await (await context.request.get('/api/servers')).json();
  await page.getByLabel('選擇伺服器').selectOption(servers[0].id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  const composer = page.getByLabel('Codex 訊息');
  await composer.fill('[large-stream]'); await composer.press('Enter');
  await expect(page.getByText('大型串流已完成，後續回覆仍可收到。', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toHaveCount(0);
  const before = (await (await context.request.get('/api/tasks')).json())[0];
  expect(before.status).toBe('completed'); expect(before.events.every((event: { text: string }) => event.text.length <= 131072)).toBe(true);
  await composer.fill('接續大量輸出後的工作'); await composer.press('Enter');
  await expect(page.getByText('SSH 測試完成：接續大量輸出後的工作', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toHaveCount(0);
  const after = (await (await context.request.get('/api/tasks')).json())[0];
  expect(after.id).toBe(before.id); expect(after.threadId).toBe(before.threadId); expect(after.turnCount).toBe(2);
  expect(starts).toHaveLength(2); expect(connections).toBe(1); expect(errors).toEqual([]);
  await expect(page.getByText('遠端輸出超過 4 MB。', { exact: true })).toHaveCount(0);
});
