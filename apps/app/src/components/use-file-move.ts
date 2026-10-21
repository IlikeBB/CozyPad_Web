import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { FileEntry } from '@cozypad/contracts';
import { message, post } from '../api';
import { withinPath, type PathMove } from '../../../../packages/contracts/src/file-moves.mjs';

export const fileDragType = 'application/x-cozypad-file';
export const parentDirectory = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
export type FileMove = PathMove;
type MoveOptions = { serverId: string; disabled: boolean; onMoved: (result: FileMove) => Promise<void>; onError: (message: string) => void; onNotice: (message: string) => void; onBusy?: (busy: boolean) => void };

export function useFileMove(options: MoveOptions) {
  const [moving, setMoving] = useState(false), [dragPath, setDragPath] = useState(''), [dropTarget, setDropTarget] = useState('');
  const pending = useRef(false), alive = useRef(true), latest = useRef(options); latest.current = options;
  const dragged = useRef<FileEntry | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; latest.current.onBusy?.(false); }; }, []);
  const clearDrag = () => { dragged.current = null; setDragPath(''); setDropTarget(''); };
  const moveFile = async (source: string, destination: string, reportError = true): Promise<string> => {
    if (pending.current || options.disabled) return '目前正在處理其他檔案操作。';
    if (!destination.trim()) return '請輸入目的地資料夾。';
    if (parentDirectory(source) === destination) { options.onNotice('項目已在這個資料夾內。'); return ''; }
    const captured = options;
    pending.current = true; setMoving(true); captured.onBusy?.(true); captured.onError(''); captured.onNotice('');
    try {
      const result = await post<FileMove>('/files/move', { serverId: captured.serverId, source, destination });
      if (!alive.current || latest.current.serverId !== captured.serverId) return '';
      captured.onNotice(result.moved ? `已將「${result.path.split('/').at(-1)}」移至 ${result.directory}` : '項目已在這個資料夾內。');
      try { await captured.onMoved(result); }
      catch { if (alive.current) captured.onError('項目已移動，目錄更新失敗；請重新整理後確認。'); }
      return '';
    } catch (error) { const text = message(error); if (alive.current && latest.current.serverId === captured.serverId && reportError) captured.onError(text); return text; }
    finally { pending.current = false; captured.onBusy?.(false); if (alive.current) { setMoving(false); clearDrag(); } }
  };
  const available = (event: DragEvent) => !options.disabled && !pending.current && event.dataTransfer.types.includes(fileDragType);
  const sourceProps = (entry: FileEntry) => ({
    draggable: !options.disabled && !moving,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (options.disabled || pending.current) { event.preventDefault(); return; }
      // Keep existing feedback in place during dragging so folder targets do not
      // jump when an alert above the list disappears. Clear it after dropping.
      dragged.current = entry; setDragPath(entry.path);
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(fileDragType, JSON.stringify({ serverId: options.serverId, source: entry.path, directory: entry.directory }));
    },
    onDragEnd: clearDrag
  });
  const targetProps = (directory: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!available(event) || dragged.current && (parentDirectory(dragged.current.path) === directory || dragged.current.directory && withinPath(directory, dragged.current.path))) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(directory);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(value => value === directory ? '' : value); },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!available(event)) return;
      event.preventDefault(); event.stopPropagation(); clearDrag();
      try {
        const raw = event.dataTransfer.getData(fileDragType);
        if (raw.length > 16384) throw new Error();
        const value = JSON.parse(raw);
        if (value.serverId !== options.serverId || typeof value.source !== 'string' || !value.source.startsWith('/')) { options.onError('只能移動目前伺服器內的檔案。'); return; }
        if (value.directory === true && withinPath(directory, value.source)) { options.onError('不能將資料夾移入自己或自己的子資料夾。'); return; }
        void moveFile(value.source, directory);
      } catch { options.onError('無法辨識拖曳的檔案，請從檔案清單重新拖曳。'); }
    }
  });
  return { moving, dragPath, dropTarget, moveFile, sourceProps, targetProps };
}
