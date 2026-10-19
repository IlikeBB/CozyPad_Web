import { test, expect, type Page } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

async function openMonitor(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill(username);
  await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toBeVisible();
  await page.getByRole('button', { name: 'Monitor', exact: true }).click();
}

test('nvtop and htop run in separate interactive PTYs and panel switching preserves their sessions', async ({ page }) => {
  const packets: { tool: string | null; type: string; data?: string }[] = [], sizes: { tool: string | null; cols: number }[] = [], urls: string[] = [], connects: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/connect')) connects.push(request.url()); });
  await page.routeWebSocket('**/api/terminal?**', socket => {
    urls.push(socket.url()); const tool = new URL(socket.url()).searchParams.get('tool'); const upstream = socket.connectToServer();
    socket.onMessage(raw => { const payload = JSON.parse(String(raw)); if (payload.type === 'resize') sizes.push({ tool, cols: payload.cols }); upstream.send(raw); });
    upstream.onMessage(raw => { packets.push({ tool, ...JSON.parse(String(raw)) }); socket.send(raw); });
  });
  await openMonitor(page, 'monitor_user');
  await expect(page.getByRole('status', { name: 'nvtop 連線狀態' })).toHaveText('已連線');
  await expect(page.getByRole('status', { name: 'htop 連線狀態' })).toHaveText('已連線');
  await expect.poll(() => packets.some(packet => packet.tool === 'nvtop' && packet.data?.includes('NVIDIA A100'))).toBe(true);
  await expect.poll(() => packets.some(packet => packet.tool === 'htop' && packet.data?.includes('Load average'))).toBe(true);
  await page.screenshot({ path: 'test-results/monitor-nvtop-htop-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'GPU · nvtop', exact: true }).click();
  await expect(page.getByRole('region', { name: 'CPU 與記憶體監看 htop', includeHidden: true })).toBeHidden();
  await page.getByRole('button', { name: 'CPU · htop', exact: true }).click();
  await expect(page.getByRole('region', { name: 'GPU 監看 nvtop', includeHidden: true })).toBeHidden();
  await page.getByRole('button', { name: '雙面板', exact: true }).click();
  expect(urls).toHaveLength(2); expect(connects).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => sizes.filter(size => size.tool === 'htop').at(-1)?.cols).toBe(80);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'CPU · htop', exact: true }).click();
  await expect(page.getByRole('region', { name: 'CPU 與記憶體監看 htop' })).toBeVisible();
  await page.screenshot({ path: 'test-results/monitor-htop-mobile.png', fullPage: true });
  await page.getByRole('region', { name: 'CPU 與記憶體監看 htop' }).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('q');
  await expect(page.getByRole('status', { name: 'htop 連線狀態' })).toHaveText('已中斷');
  expect(errors).toEqual([]);
});

test('a missing nvtop install leaves htop usable and shows a specific recovery message', async ({ page }) => {
  await page.routeWebSocket('**/api/terminal?**', socket => {
    const tool = new URL(socket.url()).searchParams.get('tool');
    if (tool === 'nvtop') {
      socket.send(JSON.stringify({ type: 'error', code: 'TERMINAL_ENDED', text: '遠端尚未安裝 nvtop。請安裝後重新開啟。' }));
      void socket.close({ code: 1000 });
    } else socket.connectToServer();
  });
  await openMonitor(page, 'monitor_missing');
  await expect(page.getByRole('alert')).toContainText('遠端尚未安裝 nvtop');
  await expect(page.getByRole('status', { name: 'htop 連線狀態' })).toHaveText('已連線');
  await expect(page.getByRole('button', { name: '重新開啟 nvtop', exact: true })).toBeVisible();
});
