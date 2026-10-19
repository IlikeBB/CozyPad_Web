import { ApiError } from './api';

export async function downloadFile(href: string, fallbackName: string) {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) throw new Error('下載網址不正確。');
  const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { credentials: 'same-origin', headers: { 'x-cozypad-request': '1' }, signal: controller.signal });
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('cozypad:session-expired'));
      let error = '檔案下載失敗，請檢查 API 與 SSH 連線。';
      if (response.headers.get('content-type')?.includes('application/json')) {
        const payload = await response.json(); if (typeof payload.error === 'string') error = payload.error;
      }
      throw new ApiError(error, response.status);
    }
    const disposition = response.headers.get('content-disposition') || '';
    if (!/^attachment(?:;|$)/i.test(disposition) || response.headers.get('content-type')?.includes('text/html')) throw new Error('下載服務回傳網頁而非檔案，請檢查 API 代理設定。');
    const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    let name = fallbackName;
    if (encodedName) { try { name = decodeURIComponent(encodedName); } catch { /* Keep the known file name if the header is malformed. */ } }
    name = name.split(/[\\/]/).at(-1)?.replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_') || 'download';
    const blob = await response.blob(), objectUrl = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = objectUrl; anchor.download = name; anchor.hidden = true;
    document.body.append(anchor); anchor.click(); anchor.remove();
    // Allow the browser to consume the blob before releasing its backing memory.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('檔案下載逾時，請稍後重試。');
    throw error;
  } finally { window.clearTimeout(timer); }
}
