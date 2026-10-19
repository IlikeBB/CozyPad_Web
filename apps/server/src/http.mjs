import { allowedOrigin } from './config.mjs';

export function json(response, status, body, responseCookies = []) {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...(responseCookies.length ? { 'set-cookie': responseCookies } : {}) });
  response.end(JSON.stringify(body));
}
export function validateOrigin(request, websocket = false) {
  const origin = request.headers.origin;
  if ((origin && !allowedOrigin(origin)) || (websocket && !origin)) throw Object.assign(new Error('不允許此來源的請求。'), { status: 403 });
  if (!websocket && !['GET', 'HEAD'].includes(request.method) && request.headers['x-cozypad-request'] !== '1') {
    throw Object.assign(new Error('缺少請求驗證標頭。'), { status: 403 });
  }
}
export async function body(request, max = 15000000) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('請使用 JSON 請求。'), { status: 415 });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > max) throw Object.assign(new Error('請求內容超過上限。'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw Object.assign(new Error('JSON 格式不正確。'), { status: 400 }); }
}
export function failure(response, error) {
  json(response, error.status || 500, { error: error.message || '伺服器發生錯誤。', ...(error.code === 'HOST_KEY' ? { code: error.code, fingerprint: error.fingerprint, changed: error.changed } : {}) });
}
