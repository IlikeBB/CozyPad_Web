import { useMemo, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { serverQuery } from '../api';
import { isMarkdownFile, markdownFileLink, markdownHeadingIds } from './markdown-document.mjs';

export function MarkdownDocument({ content, path = '', serverId, onOpenFile }: { content: string; path?: string; serverId?: string; onOpenFile?: (path: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const jump = (hash: string) => {
    try { container.current?.querySelector<HTMLElement>(`[id="${CSS.escape(decodeURIComponent(hash))}"]`)?.scrollIntoView({ block: 'start' }); } catch { /* Ignore malformed anchors. */ }
  };
  const components = useMemo<Components>(() => ({
    a: ({ href, children, title }) => {
      if (!href) return <span>{children}</span>;
      if (href.startsWith('#')) return <a href={href} onClick={event => { event.preventDefault(); jump(href.slice(1)); }}>{children}</a>;
      if (/^(?:https?:|mailto:)/i.test(href)) return <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>;
      const file = serverId ? markdownFileLink(href, path) : null;
      if (!file) return <span title={href}>{children}</span>;
      if (file.path === path && file.hash) return <a href={`#${file.hash}`} onClick={event => { event.preventDefault(); jump(file.hash); }}>{children}</a>;
      if (isMarkdownFile(file.path) && onOpenFile) return <a href={`/api/files/content?${serverQuery(serverId!, file.path)}`} title={file.path} onClick={event => { event.preventDefault(); onOpenFile(file.path); }}>{children}</a>;
      return <a href={`/api/files/download?${serverQuery(serverId!, file.path)}`} title={file.path} download>{children}</a>;
    },
    img: ({ src, alt }) => {
      const file = serverId ? markdownFileLink(src, path) : null;
      if (file && /\.(?:png|jpe?g|gif|webp)$/i.test(file.path)) return <img src={`/api/files/download?${serverQuery(serverId!, file.path)}`} alt={alt || ''} loading="lazy" />;
      return <span className="markdown-image-placeholder">{src && /^https?:/i.test(src) ? <a href={src} target="_blank" rel="noopener noreferrer">圖片：{alt || '開啟圖片'}</a> : `圖片：${alt || src || '未提供來源'}`}</span>;
    },
    table: ({ children }) => <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Markdown 表格"><table>{children}</table></div>,
    pre: ({ children }) => <pre tabIndex={0}>{children as ReactNode}</pre>
  }), [path, serverId, onOpenFile]);
  return <div ref={container} className="markdown markdown-document" role="region" aria-label="Markdown 預覽" tabIndex={0}>
    {content.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm, markdownHeadingIds]} skipHtml components={components}>{content.replace(/^\uFEFF/, '')}</ReactMarkdown> : <p className="muted">這個 Markdown 檔案沒有內容。</p>}
  </div>;
}
