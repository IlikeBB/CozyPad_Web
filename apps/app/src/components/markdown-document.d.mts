import type { Plugin } from 'unified';
export function isMarkdownFile(value: unknown): boolean;
export function markdownFileLink(href: unknown, filePath: string): { path: string; hash: string } | null;
export const markdownHeadingIds: Plugin;
