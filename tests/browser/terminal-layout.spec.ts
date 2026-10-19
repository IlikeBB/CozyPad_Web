import { test, expect } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

test('the final terminal row stays fully visible above the bottom edge across viewport sizes', async ({ page }) => {
  let connections = 0, outputs = 0;
  await page.routeWebSocket('**/api/terminal?**', socket => {
    connections++;
    socket.onMessage(raw => {
      const packet = JSON.parse(String(raw));
      if (packet.type !== 'resize') return;
      outputs++;
      socket.send(JSON.stringify({ type: 'output', data: `\x1b[2J\x1b[H${Array.from({ length: packet.rows - 1 }, (_, index) => `Training epoch 1/400 | output line ${index + 1}`).join('\r\n')}\r\nLAST_VISIBLE_ROW | progress 44% | Loss=1.257 | 中文完整顯示` }));
    });
    socket.send(JSON.stringify({ type: 'ready' }));
  });
  await page.goto('/'); await page.getByLabel('帳號', { exact: true }).fill('terminal_bottom'); await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toBeVisible();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('status', { name: '終端機連線狀態' })).toHaveText('已連線');
  await expect.poll(() => outputs).toBeGreaterThan(0);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1680, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 640 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => page.locator('.terminal-container').evaluate(element => {
      const screen = element.querySelector('.xterm-screen')!.getBoundingClientRect();
      const panel = element.getBoundingClientRect();
      return Math.min(panel.bottom, innerHeight) - screen.bottom;
    })).toBeGreaterThanOrEqual(23);
    await expect(page.getByRole('status', { name: '終端機連線狀態' })).toHaveText('已連線');
    if (viewport.width === 1680) await page.screenshot({ path: 'test-results/terminal-bottom-desktop.png', fullPage: true });
  }
  expect(connections).toBe(1);
  await page.screenshot({ path: 'test-results/terminal-bottom-mobile.png', fullPage: true });
});
