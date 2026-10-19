import type { BrowserDirectoryContext } from '@cozypad/contracts';
export type BrowserFileHandle = { name: string; kind: 'file'; getFile(): Promise<File> };
export type BrowserDirectoryHandle = { name: string; kind: 'directory'; values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>; getDirectoryHandle(name: string): Promise<BrowserDirectoryHandle>; queryPermission?(options: { mode: 'read' }): Promise<PermissionState>; requestPermission?(options: { mode: 'read' }): Promise<PermissionState> };
export type BrowserDirectoryItem = { name: string; kind: 'file' | 'directory'; handle: BrowserFileHandle | BrowserDirectoryHandle };
export type BrowserDirectoryResult = { items: BrowserDirectoryItem[]; context: BrowserDirectoryContext; stopReason?: 'timeout' | 'cancelled' | 'limit' };
export class BrowserDirectory {
  root: BrowserDirectoryHandle;
  constructor(handle: BrowserDirectoryHandle, incomplete?: boolean);
  read(parts?: string[], signal?: AbortSignal, options?: { timeoutMs?: number; onProgress?: (result: BrowserDirectoryResult) => void }): Promise<BrowserDirectoryResult>;
}
export function directoryFromFiles(files: FileList | File[]): BrowserDirectory;
