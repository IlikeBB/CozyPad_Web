import type { ComponentProps, ReactNode } from 'react';
import type { Components } from 'react-markdown';

export const OPEN_FILE_PATH_EVENT = 'cozypad-open-file-path';
const FILE_PATH_LINK_PREFIX = '#cozypad-file';
const REMOTE_PATH_PATTERN =
  /(^|[\s([{<])((?:~(?:\/[^\s`"'<>]*)?)|(?:\/(?:home|ssd\d*|mnt|data|workspace|work|project|projects|tmp|var|opt|root|usr|srv)(?:\/[^\s`"'<>]*)?))/g;
const TRAILING_PATH_PUNCTUATION = /[),.，。；;：:、\]}）】》」』]+$/;

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

function linkifyRemotePathLine(line: string, serverId: string): string {
  if (!serverId || !line.trim()) return line;
  if (/^\s{4,}/.test(line)) return line;
  if (/^\s*(?:[-*]\s+)?```/.test(line)) return line;

  return line.replace(REMOTE_PATH_PATTERN, (match, boundary: string, rawPath: string) => {
    if (!rawPath || rawPath.includes('](')) return match;

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

function Code(props: ComponentProps<'code'>) {
  const { className = '', children, ...rest } = props;
  const value = String(children ?? '').replace(/\n$/, '');
  const language = className.match(/language-([A-Za-z0-9_-]+)/)?.[1] || '';
  const block = Boolean(language) || value.includes('\n');
  if (!block) {
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

  return (
    <a
      href={href}
      onClick={handleClick}
      {...(href.startsWith(FILE_PATH_LINK_PREFIX)
        ? (() => {
            const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
            const params = new URLSearchParams(query);
            return filePathLinkDataset(
              params.get('serverId') || '',
              params.get('path') || '',
            );
          })()
        : {})}
      {...rest}
    >
      {children}
    </a>
  );
  }

  return Anchor;
}

export function createMarkdownComponents(onOpenFilesPath?: OpenFilePathHandler): Components {
  return {
    a: createAnchorComponent(onOpenFilesPath),
    code: Code,
  };
}

export const markdownComponents: Components = {
  a: createAnchorComponent(),
  code: Code,
};
