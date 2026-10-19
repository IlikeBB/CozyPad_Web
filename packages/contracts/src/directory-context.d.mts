export type BrowserDirectoryContext = { rootName: string; path: string; incomplete: boolean; entries: { name: string; kind: 'file' | 'directory' }[] };
export function remoteDirectoryPath(value: string): string;
export function virtualDirectoryPath(value: string, platform?: string): string;
export function displayDirectoryPath(value: string, platform?: string): string;
export function browserDirectoryContext(value: unknown): BrowserDirectoryContext | undefined;
