export type SearchOptions = { root: string; glob: string; text?: string; maxDepth?: number; maxEntries?: number; maxFiles?: number; maxResults?: number; maxBytes?: number; maxTotalBytes?: number; timeoutMs?: number };
export const searchLimits: Readonly<{ maxDepth: number; maxEntries: number; maxFiles: number; maxResults: number; maxBytes: number; maxTotalBytes: number; timeoutMs: number }>;
export const searchLimitLabels: Readonly<Record<string, string>>;
export function searchOptions(input: SearchOptions): SearchOptions & typeof searchLimits;
