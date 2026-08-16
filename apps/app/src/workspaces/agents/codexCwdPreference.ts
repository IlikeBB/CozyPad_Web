const CODEX_CWD_STORAGE_KEY = 'cozypad3.codexCwdByServer.v1';
const CODEX_CWD_EVENT = 'cozypad:codex-cwd-changed';

type CodexCwdMap = Record<string, string>;

function normalize(value: string, fallback = '~'): string {
  return value.trim() || fallback;
}

function readMap(): CodexCwdMap {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CODEX_CWD_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CodexCwdMap
      : {};
  } catch {
    return {};
  }
}

export function readCodexCwd(serverId: string, fallback = '~'): string {
  if (!serverId) return normalize(fallback);
  const stored = readMap()[serverId];
  return typeof stored === 'string' ? normalize(stored, fallback) : normalize(fallback);
}

export function rememberCodexCwd(serverId: string, remotePath: string): string {
  const path = normalize(remotePath);
  if (typeof window === 'undefined' || !serverId) return path;
  const next = { ...readMap(), [serverId]: path };
  window.localStorage.setItem(CODEX_CWD_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(CODEX_CWD_EVENT, {
    detail: { serverId, path },
  }));
  return path;
}

export function subscribeCodexCwd(
  serverId: string,
  listener: (path: string) => void,
): () => void {
  if (typeof window === 'undefined' || !serverId) return () => undefined;
  const onPreference = (event: Event) => {
    const detail = (event as CustomEvent<{ serverId?: string; path?: string }>).detail;
    if (detail?.serverId === serverId && typeof detail.path === 'string') {
      listener(normalize(detail.path));
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === CODEX_CWD_STORAGE_KEY) listener(readCodexCwd(serverId));
  };
  window.addEventListener(CODEX_CWD_EVENT, onPreference);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CODEX_CWD_EVENT, onPreference);
    window.removeEventListener('storage', onStorage);
  };
}

export function codexCwdForPath(path: string, isDirectory: boolean): string {
  const clean = normalize(path).replace(/\/+$/u, '') || '/';
  if (isDirectory || clean === '/' || clean === '~') return clean;
  if (clean.startsWith('~/')) {
    const index = clean.lastIndexOf('/');
    return index <= 1 ? '~' : clean.slice(0, index);
  }
  const index = clean.lastIndexOf('/');
  return index <= 0 ? '/' : clean.slice(0, index);
}
