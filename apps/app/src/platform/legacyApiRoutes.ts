const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function shouldUsePublicApiAlias(): boolean {
  if (typeof window === 'undefined') return false;
  return !LOCAL_HOSTNAMES.has(window.location.hostname);
}

export function resolveLegacyHttpPath(path: string): string {
  if (!path.startsWith('/api/')) return path;
  if (!shouldUsePublicApiAlias()) return path;
  return `/cozypad-agent/${path.slice('/api/'.length)}`;
}

export function createLegacyWebSocketUrl(path: string): URL {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new URL(resolveLegacyHttpPath(path), `${protocol}//${window.location.host}`);
}
