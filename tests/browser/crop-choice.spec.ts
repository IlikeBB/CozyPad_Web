import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';
import { cropOptions } from '../helpers/question-fixtures.mjs';

async function openQuestion(page: Page, context: BrowserContext, username: string) {
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
  await page.getByLabel('Codex 訊息').fill('[choice-crop-hold]');
  await page.getByLabel('Codex 訊息').press('Enter');
  const form = page.getByRole('form', { name: 'Codex 選擇題', exact: true });
  await expect(form).toBeVisible();
  return form;
}

test('the screenshot question offers choices and confirms mid-turn without losing the composer draft', async ({ page, context }) => {
  let starts = 0; const steers: { replyToEventId: number; prompt: string }[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/api/tasks')) starts++;
    if (request.url().endsWith('/steer')) steers.push(request.postDataJSON());
  });
  const form = await openQuestion(page, context, 'choice_crop');
  await expect(form.getByRole('radio')).toHaveCount(3);
  await expect(form.getByRole('button', { name: '確認', exact: true })).toBeDisabled();
  await page.getByLabel('Codex 訊息').fill('保留後續修改的草稿');
  await form.getByRole('radio', { name: cropOptions[1], exact: true }).check();
  await expect(form.getByRole('button', { name: '確認', exact: true })).toBeEnabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(form.getByRole('radio', { name: cropOptions[1], exact: true })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await form.getByRole('button', { name: '確認', exact: true }).scrollIntoViewIfNeeded();
    await expect(form.getByRole('button', { name: '確認', exact: true })).toBeInViewport();
    await page.screenshot({ path: `test-results/crop-choice-${width}.png`, fullPage: true });
  }
  const before = (await (await context.request.get('/api/tasks')).json())[0];
  await form.getByRole('button', { name: '確認', exact: true }).dblclick();
  await expect(form).toHaveCount(0);
  await expect(page.getByText(`已採用引導：${cropOptions[1]}`, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Codex 訊息')).toHaveValue('保留後續修改的草稿');
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toBeVisible();
  expect(starts).toBe(1); expect(steers).toHaveLength(1);
  const after = (await (await context.request.get('/api/tasks')).json())[0];
  expect(after.id).toBe(before.id); expect(after.threadId).toBe(before.threadId); expect(after.turnCount).toBe(1);
  expect(after.events.filter((event: { replyToEventId?: number }) => event.replyToEventId === steers[0].replyToEventId)).toHaveLength(1);
  await page.getByRole('button', { name: '停止回覆', exact: true }).click();
});

test('choice rejection preserves the selected answer and allows correction', async ({ page, context }) => {
  const form = await openQuestion(page, context, 'choice_crop_reject');
  await form.getByRole('radio', { name: '其他', exact: true }).check();
  await form.getByLabel('其他回覆', { exact: true }).fill('[reject] 保留選擇');
  await form.getByRole('button', { name: '確認', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('未接受引導');
  await expect(form.getByRole('radio', { name: '其他', exact: true })).toBeChecked();
  await expect(form.getByLabel('其他回覆', { exact: true })).toHaveValue('[reject] 保留選擇');
  await form.getByRole('radio', { name: cropOptions[1], exact: true }).check();
  await form.getByRole('button', { name: '確認', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText(`已採用引導：${cropOptions[1]}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止回覆', exact: true }).click();
});

test('an older backend still allows selection and explains when confirmation becomes available', async ({ page, context }) => {
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
    const response = await route.fetch(); const body = await response.json();
    for (const task of Array.isArray(body) ? body : [body]) { delete task.activeTurnId; if (task.events) task.events = task.events.filter((event: { type: string }) => event.type !== 'turn'); }
    await route.fulfill({ response, json: body });
  });
  const form = await openQuestion(page, context, 'choice_legacy');
  await form.getByRole('radio', { name: cropOptions[0], exact: true }).check();
  await expect(form.getByRole('radio', { name: cropOptions[0], exact: true })).toBeChecked();
  await expect(form.getByRole('button', { name: '確認', exact: true })).toBeDisabled();
  await expect(page.getByText('目前連線需等回覆結束後確認；這段文字提問尚未暫停工作。', { exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Codex 需要你的選擇', exact: true }).getByRole('button', { name: '關閉', exact: true }).click();
  await page.getByRole('button', { name: '停止回覆', exact: true }).click();
  await page.getByRole('button', { name: '開啟選擇視窗', exact: true }).click();
  await expect(form.getByRole('button', { name: '確認', exact: true })).toBeEnabled();
  await form.getByRole('button', { name: '確認', exact: true }).click();
  await expect(page.getByText(`SSH 測試完成：${cropOptions[0]}`, { exact: true })).toBeVisible();
  await expect(form).toHaveCount(0);
});
