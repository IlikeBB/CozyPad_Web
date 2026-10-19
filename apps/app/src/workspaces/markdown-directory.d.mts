import type { BrowserDirectory } from './browser-directory.mjs';
export type MarkdownSnapshot = { rootName: string; path: string; incomplete: boolean; limitations: string[]; files: { path: string; content: string }[] };
export type MarkdownBundle = { name: string; content: string; size: number; count: number; incomplete: boolean };
export type LocalMarkdownReader = ((signal: AbortSignal) => Promise<MarkdownBundle | undefined>) & { ready?: boolean };
export const markdownLimits: Readonly<{ files: number; entries: number; directories: number; depth: number; fileBytes: number; totalBytes: number; textChars: number }>;
export function collectMarkdown(directory: BrowserDirectory, parts?: string[], options?: { signal?: AbortSignal; timeoutMs?: number; limits?: typeof markdownLimits }): Promise<MarkdownSnapshot>;
export function prepareMarkdownDirectory(directory: BrowserDirectory, parts?: string[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<MarkdownBundle | undefined>;
export function preloadMarkdownDirectory(directory: BrowserDirectory, parts?: string[], options?: { timeoutMs?: number }): { result: Promise<MarkdownBundle | undefined>; abort: () => void; read: LocalMarkdownReader };
