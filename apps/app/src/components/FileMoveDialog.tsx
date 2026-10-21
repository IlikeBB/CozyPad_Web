import { useState } from 'react';
import { FolderInput, LoaderCircle, X } from 'lucide-react';
import type { FileEntry } from '@cozypad/contracts';
import { Dialog } from './Controls';
import { parentDirectory } from './use-file-move';

export function FileMoveDialog({ file, onMove, onClose }: { file: FileEntry; onMove: (destination: string) => Promise<string>; onClose: () => void }) {
  const [destination, setDestination] = useState(parentDirectory(file.path)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Dialog title="移動檔案" onClose={() => { if (!busy) onClose(); }}><form className="dialog-body form-grid" onSubmit={async event => {
    event.preventDefault(); if (busy || !destination.trim()) return;
    setBusy(true); setError('');
    try { const failure = await onMove(destination); if (failure) setError(failure); else onClose(); }
    finally { setBusy(false); }
  }}><code className="folder-path full">{file.path}</code><label className="full">目的地資料夾<input aria-label="移動目的地資料夾" autoFocus autoComplete="off" required maxLength={4096} value={destination} disabled={busy} onChange={event => setDestination(event.target.value)} /></label>
    <p className="muted full">輸入目的地路徑，例如 ~/archive。同名檔案會保留，並提示衝突。</p>
    {error && <p className="error full" role="alert">{error}</p>}
    <div className="dialog-actions full"><button type="button" className="secondary" disabled={busy} onClick={onClose}><X size={15} />取消</button><button type="submit" className="primary" disabled={busy || !destination.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <FolderInput size={15} />}移動</button></div>
  </form></Dialog>;
}
