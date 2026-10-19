import type { BrowserDirectory, BrowserDirectoryHandle } from './browser-directory.mjs';
export type RememberedBrowserDirectory = { version: 1; rootName: string; parts: string[]; handle?: BrowserDirectoryHandle; directory?: BrowserDirectory; autoMarkdown?: boolean };
export function loadBrowserDirectory(scope: string): Promise<RememberedBrowserDirectory | null>;
export function saveBrowserDirectory(scope: string, directory: BrowserDirectory, parts: string[], options?: { autoMarkdown?: boolean }): Promise<unknown>;
export function forgetBrowserDirectory(scope: string): Promise<unknown>;
