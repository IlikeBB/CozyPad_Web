// Markdown destinations are URLs; convert only local file references to remote paths.
export function remoteFilePath(href) {
  if (typeof href !== 'string' || !href || href.startsWith('#') || href.startsWith('?') || href.startsWith('//')) return null;
  let value = href;
  if (value.startsWith('sandbox:')) value = value.slice(8);
  else if (value.startsWith('file:')) {
    try { const url = new URL(value); if (url.hostname) return null; value = url.pathname; } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  value = value.split(/[?#]/, 1)[0];
  try { value = decodeURIComponent(value); } catch { return null; }
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  // Codex source citations may append a line/column suffix to a file path.
  value = value.replace(/:\d+(?::\d+)?$/, '');
  if (value === '~' || value.endsWith('/') || /^\/api(?:\/|$)/.test(value)) return null;
  return value;
}
