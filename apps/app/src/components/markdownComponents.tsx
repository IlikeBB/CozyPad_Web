import { useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import katex from 'katex';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownMath,
} from './markdownPlugins';

export const OPEN_FILE_PATH_EVENT = 'cozypad-open-file-path';
const FILE_PATH_LINK_PREFIX = '#cozypad-file';
const REMOTE_PATH_PATTERN =
  /(^|[\s([{<])((?:~(?:\/[^\s`"'<>]*)?)|(?:\/(?:home|ssd\d*|mnt|data|workspace|work|project|projects|tmp|var|opt|root|usr|srv)(?:\/[^\s`"'<>]*)?))/g;
const TRAILING_PATH_PUNCTUATION = /[),.，。；;：:、\]}）】》」』]+$/;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

export type OpenFilePathEventDetail = {
  serverId: string;
  path: string;
};

export type OpenFilePathHandler = (target: OpenFilePathEventDetail) => void;

export function dispatchOpenFilePath(serverId: string, path: string): void {
  const detail: OpenFilePathEventDetail = {
    serverId: serverId.trim(),
    path: path.trim(),
  };
  if (!detail.serverId || !detail.path) return;
  window.dispatchEvent(new CustomEvent(OPEN_FILE_PATH_EVENT, { detail }));
}

export function filePathLinkDataset(serverId: string, path: string): {
  'data-cozypad-file-server-id': string;
  'data-cozypad-file-path': string;
} {
  return {
    'data-cozypad-file-server-id': serverId.trim(),
    'data-cozypad-file-path': path.trim(),
  };
}

function openFilePathTarget(
  event: { preventDefault(): void; stopPropagation(): void },
  serverId: string,
  path: string,
  onOpenFilesPath?: OpenFilePathHandler,
) {
  event.preventDefault();
  event.stopPropagation();
  const target = {
    serverId: serverId.trim(),
    path: path.trim(),
  };
  if (!target.serverId || !target.path) return;
  if (onOpenFilesPath) {
    onOpenFilesPath(target);
  } else {
    dispatchOpenFilePath(target.serverId, target.path);
  }
}

function renderFilePathButton(
  path: string,
  serverId: string,
  key: string,
  onOpenFilesPath?: OpenFilePathHandler,
) {
  return (
    <button
      className="legacy-codex-path-link"
      key={key}
      type="button"
      {...filePathLinkDataset(serverId, path)}
      onClick={(event) => openFilePathTarget(event, serverId, path, onOpenFilesPath)}
      title="在 File 開啟路徑"
    >
      {path}
    </button>
  );
}

export function renderInlineRemotePathLinks(
  line: string,
  serverId: string,
  onOpenFilesPath?: OpenFilePathHandler,
): ReactNode {
  if (!serverId.trim() || !line.trim()) return line || ' ';

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(REMOTE_PATH_PATTERN)) {
    const boundary = match[1] || '';
    const rawPath = match[2] || '';
    const start = (match.index ?? 0) + boundary.length;
    if (start > lastIndex) nodes.push(line.slice(lastIndex, start));

    const trailing = rawPath.match(TRAILING_PATH_PUNCTUATION)?.[0] || '';
    const path = trailing ? rawPath.slice(0, -trailing.length) : rawPath;
    if (!path || path === '/') {
      nodes.push(rawPath);
    } else {
      nodes.push(renderFilePathButton(path, serverId, `${start}-${path}`, onOpenFilesPath));
      if (trailing) nodes.push(trailing);
    }
    lastIndex = start + rawPath.length;
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes.length > 0 ? nodes : line || ' ';
}

const KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'class',
  'const',
  'continue',
  'def',
  'else',
  'export',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'let',
  'return',
  'try',
  'var',
  'while',
  'with',
]);

const BUILTINS = new Set([
  'False',
  'None',
  'True',
  'console',
  'dtype',
  'len',
  'nn',
  'print',
  'torch',
]);

const TOKEN_PATTERN =
  /(#.*$|\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[()[\]{}.,:;=+\-*/<>])/gm;

function tokenClass(token: string): string {
  if (token.startsWith('#') || token.startsWith('//')) return 'syntax-comment';
  if (/^["'`]/.test(token)) return 'syntax-string';
  if (/^\d/.test(token)) return 'syntax-number';
  if (KEYWORDS.has(token)) return 'syntax-keyword';
  if (BUILTINS.has(token)) return 'syntax-builtin';
  if (/^[()[\]{}.,:;=+\-*/<>]$/.test(token)) return 'syntax-punctuation';
  return 'syntax-identifier';
}

function renderHighlightedCode(value: string) {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(value.slice(lastIndex, index));
    nodes.push(
      <span className={tokenClass(token)} key={`${index}-${token}`}>
        {token}
      </span>,
    );
    lastIndex = index + token.length;
  }
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes;
}

function markdownEscapeLinkLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function filePathHref(serverId: string, path: string): string {
  const params = new URLSearchParams();
  params.set('serverId', serverId);
  params.set('path', path);
  return `${FILE_PATH_LINK_PREFIX}?${params.toString()}`;
}

function extensionOfPath(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] || '';
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOfPath(path));
}

function isRemotePathLike(path: string): boolean {
  return /^(?:~(?:\/|$)|\/(?:home|ssd\d*|mnt|data|workspace|work|project|projects|tmp|var|opt|root|usr|srv)(?:\/|$))/.test(
    path.trim(),
  );
}

function isExternalImageSource(src: string): boolean {
  return /^(?:https?:|data:image\/|blob:)/i.test(src.trim());
}

function exactRemotePathFromInlineCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\n')) return '';
  const trailing = trimmed.match(TRAILING_PATH_PUNCTUATION)?.[0] || '';
  const path = trailing ? trimmed.slice(0, -trailing.length) : trimmed;
  return path && path !== '/' && isRemotePathLike(path) ? path : '';
}

function textWithoutMarkdownImageReferences(value: string): string {
  return String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '');
}

export function extractRemoteImagePaths(value: string, maxImages = 6): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const scanText = textWithoutMarkdownImageReferences(value);

  for (const match of scanText.matchAll(REMOTE_PATH_PATTERN)) {
    const rawPath = match[2] || '';
    const trailing = rawPath.match(TRAILING_PATH_PUNCTUATION)?.[0] || '';
    const path = (trailing ? rawPath.slice(0, -trailing.length) : rawPath).trim();
    if (!path || seen.has(path) || !isRemotePathLike(path) || !isImagePath(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= maxImages) break;
  }

  return paths;
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = window.atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function fileTargetFromHref(href: string): OpenFilePathEventDetail | null {
  if (!href.startsWith(FILE_PATH_LINK_PREFIX)) return null;
  try {
    const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
    const params = new URLSearchParams(query);
    return {
      serverId: params.get('serverId') || '',
      path: params.get('path') || '',
    };
  } catch {
    return null;
  }
}

function RemoteMarkdownImage({
  serverId,
  path,
  alt,
  onOpenFilesPath,
}: {
  serverId: string;
  path: string;
  alt?: string;
  onOpenFilesPath?: OpenFilePathHandler;
}) {
  const [state, setState] = useState<{
    loading: boolean;
    error: string;
    objectUrl: string;
  }>({ loading: true, error: '', objectUrl: '' });
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const element = rootRef.current;
    if (!element || shouldLoad) return;

    if (!('IntersectionObserver' in window)) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    let objectUrl = '';

    const load = async () => {
      if (!serverId.trim() || !path.trim()) {
        setState({ loading: false, error: 'Missing server or image path.', objectUrl: '' });
        return;
      }

      setState({ loading: true, error: '', objectUrl: '' });
      try {
        const response = await fetch(
          `/api/ssh/servers/${encodeURIComponent(serverId.trim())}/file?path=${encodeURIComponent(path.trim())}`,
        );
        const payload = (await response.json().catch(() => null)) as
          | {
              kind?: string;
              mime?: string;
              contentBase64?: string;
              error?: string;
            }
          | null;

        if (!response.ok || !payload) {
          throw new Error(payload?.error || `Image preview failed (${response.status})`);
        }
        if (payload.kind !== 'image' || !payload.contentBase64) {
          throw new Error(payload.error || 'File is not an image preview.');
        }

        const blob = new Blob([arrayBufferFromBytes(bytesFromBase64(payload.contentBase64))], {
          type: payload.mime || 'image/*',
        });
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setState({ loading: false, error: '', objectUrl });
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            error: error instanceof Error ? error.message : 'Image preview failed.',
            objectUrl: '',
          });
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, serverId, shouldLoad]);

  const openFile = () => {
    const target = { serverId: serverId.trim(), path: path.trim() };
    if (!target.serverId || !target.path) return;
    if (onOpenFilesPath) {
      onOpenFilesPath(target);
    } else {
      dispatchOpenFilePath(target.serverId, target.path);
    }
  };

  return (
    <span className="agent-image-preview" ref={rootRef}>
      <button className="agent-image-preview-open" type="button" onClick={openFile}>
        {!shouldLoad ? (
          <span className="agent-image-preview-placeholder">Image preview is paused until visible.</span>
        ) : state.loading ? (
          <span className="agent-image-preview-placeholder">Loading image...</span>
        ) : state.error ? (
          <span className="agent-image-preview-error">{state.error}</span>
        ) : (
          <img alt={alt || path} src={state.objectUrl} />
        )}
      </button>
      <span className="agent-image-preview-caption">{alt || path}</span>
    </span>
  );
}

export function AgentImagePreviewStrip({
  text,
  serverId,
  onOpenFilesPath,
  maxImages = 6,
}: {
  text: string;
  serverId: string;
  onOpenFilesPath?: OpenFilePathHandler;
  maxImages?: number;
}) {
  const paths = extractRemoteImagePaths(text, maxImages);
  if (!serverId.trim() || paths.length === 0) return null;

  return (
    <div className="agent-image-preview-strip">
      {paths.map((path) => (
        <RemoteMarkdownImage
          alt={path}
          key={path}
          onOpenFilesPath={onOpenFilesPath}
          path={path}
          serverId={serverId}
        />
      ))}
    </div>
  );
}

function linkifyRemotePathLine(line: string, serverId: string): string {
  if (!serverId || !line.trim()) return line;
  if (/^\s{4,}/.test(line)) return line;
  if (/^\s*(?:[-*]\s+)?```/.test(line)) return line;

  return line.replace(REMOTE_PATH_PATTERN, (match, boundary: string, rawPath: string, offset: number) => {
    if (!rawPath || rawPath.includes('](')) return match;
    if (boundary === '(' && line[offset - 1] === ']') return match;

    const trailing = rawPath.match(TRAILING_PATH_PUNCTUATION)?.[0] || '';
    const path = trailing ? rawPath.slice(0, -trailing.length) : rawPath;
    if (!path || path === '/') return match;

    return `${boundary}[${markdownEscapeLinkLabel(path)}](${filePathHref(serverId, path)})${trailing}`;
  });
}

export function linkifyRemotePathLines(value: string, serverId = ''): string {
  const normalized = String(value || '');
  if (!serverId.trim()) return normalized;

  let inFence = false;
  return normalized
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return linkifyRemotePathLine(line, serverId.trim());
    })
    .join('\n');
}

function createCodeComponent(serverId = '', onOpenFilesPath?: OpenFilePathHandler) {
  function Code(props: ComponentProps<'code'>) {
    const { className = '', children, ...rest } = props;
    const value = String(children ?? '').replace(/\n$/, '');
    const language = className.match(/language-([A-Za-z0-9_-]+)/)?.[1] || '';
    const block = Boolean(language) || value.includes('\n');
    if (!block) {
      const path = serverId.trim() ? exactRemotePathFromInlineCode(value) : '';
      if (path) {
        return renderFilePathButton(path, serverId, `inline-code-${path}`, onOpenFilesPath);
      }
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }

    return (
      <code className={`${className} syntax-code${language ? ` syntax-code-${language}` : ''}`} {...rest}>
        {renderHighlightedCode(value)}
      </code>
    );
  }

  return Code;
}

function createAnchorComponent(onOpenFilesPath?: OpenFilePathHandler) {
  function Anchor(props: ComponentProps<'a'>) {
  const { href = '', onClick, children, ...rest } = props;
  const handleClick: ComponentProps<'a'>['onClick'] = (event) => {
    if (href.startsWith(FILE_PATH_LINK_PREFIX)) {
      event.preventDefault();
      event.stopPropagation();
      try {
        const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
        const params = new URLSearchParams(query);
        const target = {
          serverId: params.get('serverId') || '',
          path: params.get('path') || '',
        };
        if (onOpenFilesPath) {
          onOpenFilesPath(target);
        } else {
          dispatchOpenFilePath(target.serverId, target.path);
        }
      } catch {
        // Ignore malformed internal links; they should never leave the page.
      }
      return;
    }
    onClick?.(event);
  };

  const target = fileTargetFromHref(href);
  if (target) {
    return (
      <a
        href={href}
        onClick={handleClick}
        {...filePathLinkDataset(target.serverId, target.path)}
        {...rest}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      {...rest}
    >
      {children}
    </a>
  );
  }

  return Anchor;
}

function createImageComponent(serverId = '', onOpenFilesPath?: OpenFilePathHandler) {
  function Image(props: ComponentProps<'img'>) {
    const { src = '', alt = '', ...rest } = props;
    const source = String(src || '').trim();
    if (!source) return null;

    if (isExternalImageSource(source)) {
      return (
        <span className="agent-image-preview agent-image-preview-external">
          <a href={source} target="_blank" rel="noreferrer">
            <img alt={alt || 'Agent image'} src={source} {...rest} />
          </a>
          {alt ? <span className="agent-image-preview-caption">{alt}</span> : null}
        </span>
      );
    }

    if (serverId.trim() && isRemotePathLike(source) && isImagePath(source)) {
      return (
        <RemoteMarkdownImage
          alt={alt || source}
          onOpenFilesPath={onOpenFilesPath}
          path={source}
          serverId={serverId}
        />
      );
    }

    return <img alt={alt || 'Agent image'} src={source} {...rest} />;
  }

  return Image;
}

export function createMarkdownComponents(
  onOpenFilesPath?: OpenFilePathHandler,
  options: { serverId?: string } = {},
): Components {
  return {
    a: createAnchorComponent(onOpenFilesPath),
    code: createCodeComponent(options.serverId || '', onOpenFilesPath),
    img: createImageComponent(options.serverId || '', onOpenFilesPath),
  };
}

export const markdownComponents: Components = {
  a: createAnchorComponent(),
  code: createCodeComponent(),
  img: createImageComponent(),
};

type MathAwareMarkdownSegment =
  | { type: 'text'; value: string }
  | { type: 'math'; value: string };

type MathAwareMarkdownProps = {
  text: string;
  className?: string;
  serverId?: string;
  onOpenFilesPath?: OpenFilePathHandler;
  showImages?: boolean;
  maxImages?: number;
};

function splitDisplayMathSegments(text: string): MathAwareMarkdownSegment[] {
  const segments: MathAwareMarkdownSegment[] = [];
  const displayMathPattern = /\$\$\s*\n?([\s\S]*?)\n?\s*\$\$/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = displayMathPattern.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, match.index) });
    }
    const formula = (match[1] || '').trim();
    if (formula) {
      segments.push({ type: 'math', value: formula });
    }
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: text }];
}

function renderDisplayMath(formula: string, key: string) {
  try {
    return (
      <div
        className="legacy-codex-formula-block"
        dangerouslySetInnerHTML={{
          __html: katex.renderToString(formula, {
            displayMode: true,
            strict: 'ignore',
            throwOnError: false,
            trust: false,
          }),
        }}
        key={key}
      />
    );
  } catch {
    return (
      <code className="legacy-codex-formula-fallback" key={key}>
        {formula}
      </code>
    );
  }
}

export function MathAwareMarkdown({
  text,
  className = '',
  serverId = '',
  onOpenFilesPath,
  showImages = true,
  maxImages,
}: MathAwareMarkdownProps) {
  const normalizedText = normalizeMarkdownMath(linkifyRemotePathLines(String(text || ''), serverId));
  const segments = splitDisplayMathSegments(normalizedText);
  const components = onOpenFilesPath
    ? createMarkdownComponents(onOpenFilesPath, { serverId })
    : createMarkdownComponents(undefined, { serverId });

  return (
    <div className={`markdown legacy-codex-markdown${className ? ` ${className}` : ''}`}>
      {segments.map((segment, index) =>
        segment.type === 'math' ? (
          renderDisplayMath(segment.value, `math-${index}`)
        ) : segment.value.trim() ? (
          <Markdown
            components={components}
            key={`text-${index}`}
            remarkPlugins={markdownRemarkPlugins}
            rehypePlugins={markdownRehypePlugins}
          >
            {segment.value}
          </Markdown>
        ) : null,
      )}
      {showImages ? (
        <AgentImagePreviewStrip
          maxImages={maxImages}
          onOpenFilesPath={onOpenFilesPath}
          serverId={serverId}
          text={String(text || '')}
        />
      ) : null}
    </div>
  );
}
