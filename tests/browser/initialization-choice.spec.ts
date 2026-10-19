import { test, expect } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';
import { initializationOptions } from '../helpers/question-fixtures.mjs';

test('the exact initialization screenshot is selectable and submits through the existing backend API', async ({ page, context }) => {
  const errors: string[] = [], submissions: { prompt: string; replyToEventId?: number }[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/tasks')) submissions.push(request.postDataJSON()); });
  // Keep the client on the older backend contract used by the production process.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('message', event => { if (JSON.parse(event.data).type === 'turn') event.stopImmediatePropagation(); });
      }
    };
  });
  await page.route('**/api/tasks', async route => {
    const response = await route.fetch(), data = await response.json();
    for (const task of Array.isArray(data) ? data : [data]) {
      delete task.activeTurnId;
      if (task.events) {
        task.events = task.events.filter((event: { type: string }) => event.type !== 'turn');
        for (const event of task.events) delete event.itemCompleted;
      }
    }
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill('choice_initialization');
  await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
  const servers = await (await context.request.get('/api/servers')).json();
  await page.getByLabel('選擇伺服器').selectOption(servers[0].id);
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await page.getByLabel('Codex 訊息').fill('[choice-initialization]');
  await page.getByLabel('Codex 訊息').press('Enter');
  const form = page.getByRole('form', { name: 'Codex 選擇題', exact: true });
  await expect(form).toBeVisible();
  for (const label of initializationOptions) await expect(form.getByRole('radio', { name: label, exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toHaveCount(0);
  await page.getByLabel('Codex 訊息').fill('保留我尚未送出的草稿');
  await form.getByRole('radio', { name: initializationOptions[1], exact: true }).check();
  await expect(form.getByRole('button', { name: '確認', exact: true })).toBeEnabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await form.getByRole('button', { name: '確認', exact: true }).scrollIntoViewIfNeeded();
    await expect(form.getByRole('radio', { name: initializationOptions[1], exact: true })).toBeChecked();
    await expect(form.getByRole('button', { name: '確認', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/initialization-choice-${width}.png`, fullPage: true });
  }
  await form.getByRole('button', { name: '確認', exact: true }).dblclick();
  await expect(page.getByText(`SSH 測試完成：${initializationOptions[1]}`, { exact: true })).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('保留我尚未送出的草稿');
  expect(submissions).toHaveLength(2);
  expect(submissions[1].prompt).toBe(initializationOptions[1]); expect(submissions[1].replyToEventId).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
