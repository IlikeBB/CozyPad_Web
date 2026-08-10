import type { ComponentProps, ReactNode } from 'react';
import type { Components } from 'react-markdown';

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

export function linkifyRemotePathLines(value: string, _serverId = ''): string {
  return String(value || '');
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

function Anchor(props: ComponentProps<'a'>) {
  const { href = '', onClick, children, ...rest } = props;
  return (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}

export const markdownComponents: Components = {
  a: Anchor,
  code: Code,
};
