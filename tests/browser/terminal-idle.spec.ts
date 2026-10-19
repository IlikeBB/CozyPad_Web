import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';

async function openTerminal(page: Page, username = 'terminal_idle') {
  await page.goto('/');
  await page.getByLabel('帳號', { exact: true }).fill(username);
  await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click();
  await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByLabel('Codex 訊息')).toBeVisible();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
}

test('idle and hidden terminals keep the existing WebSocket alive without writing keepalives into the SSH shell', async ({ page }) => {
  const errors: string[] = [], sent: { type: string }[] = [], received: { type: string; data?: string }[] = [];
  let connections = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.routeWebSocket('**/api/terminal?**', socket => {
    connections++;
    const upstream = socket.connectToServer();
    socket.onMessage(raw => { sent.push(JSON.parse(String(raw))); upstream.send(raw); });
    upstream.onMessage(raw => { received.push(JSON.parse(String(raw))); socket.send(raw); });
  });
  await page.clock.install();
  await openTerminal(page);
  const status = page.getByRole('status', { name: '終端機連線狀態' });
  await expect(status).toHaveText('已連線');
  await expect.poll(() => received.some(packet => packet.data?.includes('SSH fixture ready'))).toBe(true);
  const initialOutputs = received.filter(packet => packet.type === 'output').length;
  await page.clock.fastForward(21000);
  await expect.poll(() => sent.filter(packet => packet.type === 'ping').length).toBeGreaterThanOrEqual(1);
  await expect.poll(() => received.filter(packet => packet.type === 'pong').length).toBeGreaterThanOrEqual(1);
  expect(sent.filter(packet => packet.type === 'input')).toHaveLength(0);
  expect(received.filter(packet => packet.type === 'output')).toHaveLength(initialOutputs);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.retained-terminal')).toBeHidden();
  const pings = sent.filter(packet => packet.type === 'ping').length;
  for (let tick = 0; tick < 3; tick++) {
    const replies = received.filter(packet => packet.type === 'pong').length;
    await page.clock.fastForward(21000);
    await expect.poll(() => received.filter(packet => packet.type === 'pong').length).toBeGreaterThan(replies);
  }
  await expect.poll(() => sent.filter(packet => packet.type === 'ping').length).toBeGreaterThan(pings);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(status).toHaveText('已連線'); expect(connections).toBe(1);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('pwd'); await page.keyboard.press('Enter');
  await expect.poll(() => received.some(packet => packet.data?.includes('fixture:/home/tester'))).toBe(true);
  expect(errors).toEqual([]);
});

test('closed terminal channels can reopen without reconnecting SSH and retain the original error after close', async ({ page }) => {
  const sockets: WebSocketRoute[] = [], errors: string[] = [], connects: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/connect')) connects.push(request.url()); });
  await page.routeWebSocket('**/api/terminal?**', socket => {
    sockets.push(socket); socket.send(JSON.stringify({ type: 'ready' }));
  });
  await openTerminal(page, 'terminal_recovery');
  const status = page.getByRole('status', { name: '終端機連線狀態' });
  await expect(status).toHaveText('已連線');
  await sockets[0].close({ code: 1011 });
  await expect(status).toHaveText('已中斷');
  await expect(page.getByRole('alert')).toContainText('WebSocket 1011');
  await page.getByRole('button', { name: '重新開啟終端機', exact: true }).click();
  await expect(status).toHaveText('已連線'); await expect(page.getByRole('alert')).toHaveCount(0);
  expect(sockets).toHaveLength(2); expect(connects).toHaveLength(1);
  sockets[1].send(JSON.stringify({ type: 'error', text: 'PTY fixture rejected the channel' }));
  await sockets[1].close({ code: 1000 });
  await expect(status).toHaveText('連線失敗');
  await expect(page.getByRole('alert')).toContainText('PTY fixture rejected the channel');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: '重新開啟終端機', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/terminal-idle-recovery-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('terminal startup timeouts show a recoverable error and never retry SSH authentication automatically', async ({ page }) => {
  let connections = 0;
  await page.routeWebSocket('**/api/terminal?**', () => { connections++; });
  await page.clock.install();
  await openTerminal(page, 'terminal_timeout');
  const status = page.getByRole('status', { name: '終端機連線狀態' });
  await expect(status).toHaveText('連線中');
  await expect.poll(() => connections).toBe(1);
  await page.clock.fastForward(21000);
  await expect(status).toHaveText('連線失敗');
  await expect(page.getByRole('alert')).toContainText('終端機通道啟動逾時');
  await page.clock.fastForward(61000); expect(connections).toBe(1);
});

test('a transient tunnel drop automatically resumes the real shell while preserving the screen and command input', async ({ page }) => {
  const transports: WebSocketRoute[] = [], clients: WebSocketRoute[] = [], packets: { type: string; data?: string; sessionId?: string; resumed?: boolean }[] = [], urls: string[] = [], inputs: string[] = [], connects: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/connect')) connects.push(request.url()); });
  await page.routeWebSocket('**/api/terminal?**', socket => {
    urls.push(socket.url());
    clients.push(socket);
    const upstream = socket.connectToServer(); transports.push(upstream);
    socket.onMessage(raw => { const packet = JSON.parse(String(raw)); if (packet.type === 'input') inputs.push(packet.data); upstream.send(raw); });
    upstream.onMessage(raw => { packets.push(JSON.parse(String(raw))); socket.send(raw); });
  });
  await openTerminal(page, 'terminal_resume');
  const status = page.getByRole('status', { name: '終端機連線狀態' });
  await expect(status).toHaveText('已連線');
  await expect.poll(() => packets.some(packet => packet.data?.includes('SSH fixture ready'))).toBe(true);
  const sessionId = packets.find(packet => packet.type === 'ready')!.sessionId!;
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('run_once_marker'); await page.keyboard.press('Enter');
  await expect.poll(() => packets.some(packet => packet.data?.includes('run_once_marker'))).toBe(true);
  const before = inputs.join('');
  await page.locator('.xterm').evaluate(element => { (element as HTMLElement).dataset.retained = 'same-terminal'; });
  await transports[0].close({ code: 1012 });
  await clients[0].close({ code: 1012 });
  await expect(status).toHaveText('重新接回中');
  await expect(status).toHaveText('已連線', { timeout: 10000 });
  expect(urls).toHaveLength(2);
  expect(new URL(urls[1]).searchParams.get('sessionId')).toBe(sessionId);
  expect(Number(new URL(urls[1]).searchParams.get('after'))).toBeGreaterThan(0);
  expect(packets.filter(packet => packet.type === 'ready').at(-1)?.resumed).toBe(true);
  expect(packets.filter(packet => packet.data?.includes('SSH fixture ready'))).toHaveLength(1);
  expect(inputs.join('')).toBe(before); expect(connects).toHaveLength(1);
  await expect(page.locator('.xterm')).toHaveAttribute('data-retained', 'same-terminal');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('resume retries are bounded and a lost shell requires an explicit new session', async ({ page }) => {
  const sockets: WebSocketRoute[] = [], urls: string[] = [], connects: string[] = [];
  const sessionId = '1d919b36-2fd0-48b3-951c-726d44c136d0';
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/connect')) connects.push(request.url()); });
  await page.routeWebSocket('**/api/terminal?**', socket => {
    sockets.push(socket); urls.push(socket.url());
    if (sockets.length === 1) socket.send(JSON.stringify({ type: 'ready', sessionId }));
  });
  await page.clock.install(); await openTerminal(page, 'terminal_retries');
  const status = page.getByRole('status', { name: '終端機連線狀態' });
  await expect(status).toHaveText('已連線');
  await sockets[0].close({ code: 1012 });
  for (const [index, wait] of [1000, 2000, 4000, 8000, 10000].entries()) {
    await page.clock.fastForward(wait);
    await expect.poll(() => sockets.length).toBe(index + 2);
    await sockets.at(-1)!.close({ code: 1012 });
    await page.waitForTimeout(30);
  }
  await expect(status).toHaveText('已中斷');
  expect(sockets).toHaveLength(6);
  await page.clock.fastForward(61000); expect(sockets).toHaveLength(6);
  expect(connects).toHaveLength(1);
  await page.getByRole('button', { name: '重新開啟終端機', exact: true }).click();
  await expect.poll(() => sockets.length).toBe(7);
  sockets[6].send(JSON.stringify({ type: 'error', code: 'TERMINAL_MISSING', text: '原終端機已結束或保留時間已到。' }));
  await sockets[6].close({ code: 1000 });
  await expect(status).toHaveText('連線失敗');
  await expect(page.getByRole('alert')).toContainText('原終端機已結束');
  await page.getByRole('button', { name: '重新開啟終端機', exact: true }).click();
  await expect.poll(() => sockets.length).toBe(8);
  expect(new URL(urls[7]).searchParams.has('sessionId')).toBe(false);
  expect(connects).toHaveLength(1);
});
