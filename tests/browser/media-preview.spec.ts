import { test, expect, type Page } from '@playwright/test';
import { generateTotp } from '../../apps/server/src/auth/totp.mjs';
import { mediaImageName, mediaVideoName, mediaMp4Name, mediaPngName, mediaRoot } from '../helpers/media-fixtures.mjs';

async function login(page: Page, username: string) {
  await page.goto('/'); await page.getByLabel('帳號', { exact: true }).fill(username); await page.getByLabel('密碼', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await page.getByLabel('驗證碼', { exact: true }).fill(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
  await page.getByRole('button', { name: '驗證並登入' }).click(); await page.getByRole('button', { name: '連線', exact: true }).click();
  await expect(page.getByText('已連線', { exact: true })).toBeVisible();
}
async function readyImage(page: Page) {
  const image = page.getByRole('img', { name: `圖片預覽 ${mediaImageName}`, exact: true });
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(640);
  return image;
}

test('Files previews an image and real playable video, supports zoom, seeking, downloads and responsive layouts', async ({ page }) => {
  const errors: string[] = [], binaryTextReads: string[] = []; let logins = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/files/content' && /\.(?:SVG|webm|png|mp4)$/.test(url.searchParams.get('path') || '')) binaryTextReads.push(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/connect')) logins++;
  });
  await login(page, 'media_files'); await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: mediaImageName, exact: true }).click();
  const image = await readyImage(page); await expect(page.getByRole('region', { name: '圖片檢視器', exact: true })).toContainText('640 × 360');
  await page.getByRole('button', { name: '實際大小', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(image).toHaveCSS('width', '640px');
  await page.getByRole('button', { name: '放大圖片', exact: true }).click(); await expect(image).toHaveCSS('width', '800px');
  await page.getByRole('button', { name: '符合視窗', exact: true }).click();
  for (const width of [1440, 1024, 768, 320]) {
    await page.setViewportSize({ width, height: 900 }); await expect(image).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const fits = await image.evaluate(element => { const box = element.getBoundingClientRect(), parent = element.parentElement!.getBoundingClientRect(); return box.width <= parent.width && box.height <= parent.height; });
    expect(fits).toBe(true); await page.screenshot({ path: `test-results/media-image-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `下載預覽檔案 ${mediaImageName}`, exact: true }).click()]);
  expect(download.suggestedFilename()).toBe(mediaImageName);
  await page.getByRole('button', { name: mediaPngName, exact: true }).click();
  await expect.poll(() => page.getByRole('img', { name: `圖片預覽 ${mediaPngName}`, exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const video = page.locator('video');
  for (const name of [mediaMp4Name, mediaVideoName]) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(video).toHaveAttribute('aria-label', `影片預覽 ${name}`);
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
    await expect(video).toHaveAttribute('controls', '');
    await video.evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; await video.play(); });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
    await video.evaluate(element => { const video = element as HTMLVideoElement; video.pause(); video.currentTime = 2; });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(1.9);
  }
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 900 }); await expect(video).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/media-video-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '關閉媒體預覽', exact: true }).click(); await expect(video).toHaveCount(0);
  await page.getByRole('button', { name: 'plain.txt', exact: true }).click(); await expect(page.getByLabel('檔案內容', { exact: true })).toContainText('MEDIA_TEXT_EDITOR_REGRESSION');
  await page.getByRole('button', { name: 'README.md', exact: true }).click(); await expect(page.getByRole('heading', { name: '媒體預覽說明', exact: true })).toBeVisible();
  expect(binaryTextReads).toEqual([]); expect(errors).toEqual([]); expect(logins).toBe(1);
});

test('Codex file tabs preview media without text reads and pause video when hidden', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, 'media_agents');
  await page.getByRole('treeitem', { name: `檔案 ${mediaImageName}`, exact: true }).click(); await readyImage(page);
  await expect(page.getByRole('tab', { name: mediaImageName, exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '重新載入檔案預覽', exact: true }).click(); await readyImage(page);
  await page.getByRole('treeitem', { name: `檔案 ${mediaVideoName}`, exact: true }).click();
  const video = page.getByLabel(`影片預覽 ${mediaVideoName}`, { exact: true });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; await video.play(); });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('tab', { name: mediaImageName, exact: true }).click(); await readyImage(page);
  await page.getByRole('button', { name: `關閉分頁 ${mediaImageName}`, exact: true }).click();
  await expect(page.getByRole('tab', { name: mediaImageName, exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('media errors offer retry and download, and the endpoint enforces login and owner isolation', async ({ page, context, playwright }) => {
  await login(page, 'media_errors'); await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: '損壞的影片.mp4', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('影片無法播放');
  await expect(page.getByRole('button', { name: '重新載入媒體', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '損壞的圖片.png', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('圖片無法顯示');
  await page.getByRole('button', { name: mediaImageName, exact: true }).click(); await readyImage(page);
  const servers = await (await context.request.get('/api/servers')).json();
  const url = `/api/files/media?${new URLSearchParams({ serverId: servers[0].id, path: `${mediaRoot}/${mediaVideoName}` })}`;
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5684' });
  expect((await anonymous.get(url)).status()).toBe(401); await anonymous.dispose();
  const partial = await context.request.get(url, { headers: { range: 'bytes=4-10' } });
  expect(partial.status()).toBe(206); expect((await partial.body()).length).toBe(7);
  const other = await context.request.get(url.replace(servers[0].id, 'another-users-server'));
  expect(other.status()).toBe(409);
  let failOnce = true;
  await page.route('**/api/files/media?**', async route => {
    if (failOnce && route.request().method() === 'HEAD') { failOnce = false; await route.fulfill({ status: 404 }); } else await route.continue();
  });
  await page.getByRole('button', { name: '重新載入檔案預覽', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('找不到此媒體檔案');
  await page.getByRole('button', { name: '重新載入媒體', exact: true }).click(); await readyImage(page);
});
