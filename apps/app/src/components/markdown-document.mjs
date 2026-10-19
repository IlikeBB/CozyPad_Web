export const isMarkdownFile = value => typeof value === 'string' && /\.(?:md|markdown|mdown|mkd)$/i.test(value);

export function markdownFileLink(href, filePath) {
  if (typeof href !== 'string' || !href.trim() || href.length > 4096 || /[\x00-\x1f\x7f\\]/.test(href) || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href) || !filePath?.startsWith('/')) return null;
  try {
    const base = new URL('https://markdown.invalid'); base.pathname = filePath;
    const url = new URL(href, base);
    if (url.origin !== base.origin) return null;
    const path = decodeURIComponent(url.pathname);
    if (/[\x00-\x1f\x7f]/.test(path)) return null;
    return { path, hash: decodeURIComponent(url.hash.slice(1)) };
  } catch { return null; }
}

export function markdownHeadingIds() {
  return tree => {
    const counts = new Map();
    const text = node => typeof node.value === 'string' ? node.value : (node.children || []).map(text).join('');
    const visit = node => {
      if (node.type === 'heading') {
        const slug = text(node).trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
        const count = counts.get(slug) || 0; counts.set(slug, count + 1);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: count ? `${slug}-${count}` : slug } };
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}
