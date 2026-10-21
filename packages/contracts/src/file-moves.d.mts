export type PathMove = { source: string; path: string; directory: string; moved: boolean; kind?: 'file' | 'directory' };
export function withinPath(value: string, parent: string): boolean;
export function pathAfterMove(value: string, move: PathMove): string;
export function treeAfterMove<T extends { path: string; name: string; directory: boolean }>(tree: Record<string, T[]>, move: PathMove): Record<string, T[]>;
