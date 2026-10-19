import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';
import { professionOptions, professionQuestion } from '../helpers/question-fixtures.mjs';

async function login(page: Page, context: BrowserContext, username: string) {
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
}

test('profession decision opens a modal and holds commands until one manual confirmation, including reload and dismissal', async ({ page, context }) => {
  const answers: unknown[] = [], starts: unknown[] = [];
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/answer')) answers.push(request.postDataJSON());
    if (request.url().endsWith('/api/tasks')) starts.push(request.postDataJSON());
  });
  await login(page, context, 'question_modal');
  const composer = page.getByLabel('Codex 訊息');
  await composer.fill('[question-profession]'); await composer.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Codex 需要你的選擇', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText(professionQuestion);
  await expect(dialog).toContainText('Codex 正在等待你的回覆');
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  for (const label of professionOptions) await expect(dialog.getByRole('radio', { name: label, exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: '確認', exact: true })).toBeDisabled();
  const history = () => context.request.get('/api/tasks').then(response => response.json());
  const before = (await history())[0];
  expect(before.status).toBe('running'); expect(before.events.filter((event: { type: string }) => event.type === 'command')).toHaveLength(0);
  await dialog.getByRole('radio', { name: professionOptions[1], exact: true }).check();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await composer.fill('保留後續設計草稿');
  await page.getByRole('button', { name: '開啟選擇視窗', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: professionOptions[1], exact: true })).toBeChecked();
  await page.waitForTimeout(800); expect(answers).toHaveLength(0);
  expect((await history())[0].events.filter((event: { type: string }) => event.type === 'command')).toHaveLength(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })).toBe(true);
    await dialog.getByRole('button', { name: '確認', exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: '確認', exact: true })).toBeInViewport();
    await page.screenshot({ path: `test-results/question-dialog-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: '確認', exact: true })).toBeDisabled();
  expect((await history())[0].events.filter((event: { type: string }) => event.type === 'command')).toHaveLength(0);
  await dialog.getByRole('radio', { name: professionOptions[1], exact: true }).check();
  await dialog.getByRole('button', { name: '確認', exact: true }).dblclick();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('已回覆', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止回覆', exact: true })).toHaveCount(0);
  expect(answers).toHaveLength(1); expect(starts).toHaveLength(1);
  const after = (await history())[0]; expect(after.id).toBe(before.id); expect(after.threadId).toBe(before.threadId); expect(after.turnCount).toBe(1);
  expect(after.events.filter((event: { type: string }) => event.type === 'command')).toHaveLength(1);
  // The Markdown preview must not reopen a second question after the native answer.
  await expect(page.getByRole('button', { name: '開啟選擇視窗', exact: true })).toHaveCount(0);
});

test('stopping a dismissed question cancels it without sending an answer', async ({ page, context }) => {
  let answers = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/answer')) answers++; });
  await login(page, context, 'question_modal_cancel');
  await page.getByLabel('Codex 訊息').fill('[question-profession]'); await page.getByLabel('Codex 訊息').press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Codex 需要你的選擇', exact: true });
  await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: '關閉', exact: true }).click();
  await page.getByRole('button', { name: '停止回覆', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Codex 提問', exact: true })).toContainText('已結束');
  await expect(dialog).toHaveCount(0); expect(answers).toBe(0);
  const task = (await (await context.request.get('/api/tasks')).json())[0]; expect(task.status).toBe('cancelled');
  expect(task.events.filter((event: { type: string }) => event.type === 'command')).toHaveLength(0);
});
