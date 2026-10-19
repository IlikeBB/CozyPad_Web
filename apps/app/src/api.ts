export class ApiError extends Error {
  constructor(message: string, public status: number, public details: { code?: string; fingerprint?: string; changed?: boolean } = {}) { super(message); }
}
export async function api<T>(route: string, options: RequestInit = {}, timeoutMs = 35000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api${route}`, { ...options, credentials: 'same-origin', signal: options.signal || controller.signal,
      headers: { 'content-type': 'application/json', 'x-cozypad-request': '1', ...options.headers } });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) throw new ApiError('伺服器回傳非 JSON 回應，請檢查網頁代理與 API 連線。', response.status);
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !route.startsWith('/auth/')) window.dispatchEvent(new Event('cozypad:session-expired'));
      throw new ApiError(payload.error || '請求失敗。', response.status, payload);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('請求逾時。若正在送出工作，請先查看工作清單再重試。');
    throw error;
  } finally { window.clearTimeout(timer); }
}
export const post = <T,>(route: string, payload: unknown = {}, timeoutMs = 35000) => api<T>(route, { method: 'POST', body: JSON.stringify(payload) }, timeoutMs);
export const message = (error: unknown) => error instanceof Error ? error.message : '發生未知錯誤。';
export const serverQuery = (id: string, path?: string) => new URLSearchParams({ serverId: id, ...(path ? { path } : {}) }).toString();
