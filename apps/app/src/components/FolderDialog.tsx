import { useRef, useState } from 'react';
import { FolderPlus, LoaderCircle, Pencil, Trash2, X } from 'lucide-react';
import { folderNameError, type FileEntry } from '@cozypad/contracts';
import { api, message } from '../api';
import { Dialog } from './Controls';

export type FolderAction = { kind: 'create' } | { kind: 'rename' | 'delete'; entry: FileEntry };
export function FolderDialog({ action, serverId, parent, onClose, onChanged }: { action: FolderAction; serverId: string; parent: string; onClose: () => void; onChanged: (notice: string) => Promise<void> }) {
  const [name, setName] = useState(action.kind === 'rename' ? action.entry.name : '');
  const [recursive, setRecursive] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const deleting = action.kind === 'delete';
  const title = action.kind === 'create' ? '新增資料夾' : action.kind === 'rename' ? '更名資料夾' : '刪除資料夾';
  const nameError = deleting ? '' : folderNameError(name.trim());
  const canSubmit = !busy && (deleting ? !recursive || confirmation === action.entry.name : !nameError && (action.kind !== 'rename' || name.trim() !== action.entry.name));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!canSubmit || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const payload = { serverId, parent, ...(action.kind === 'create' ? { name: name.trim() }
        : action.kind === 'rename' ? { name: action.entry.name, newName: name.trim() } : { name: action.entry.name, recursive, confirmation }) };
      await api('/files/folders', { method: action.kind === 'create' ? 'POST' : action.kind === 'rename' ? 'PUT' : 'DELETE', body: JSON.stringify(payload) }, 120000);
      await onChanged(action.kind === 'create' ? '資料夾已新增。' : action.kind === 'rename' ? '資料夾已更名。' : '資料夾已刪除。'); onClose();
    } catch (error) { setError(message(error)); } finally { pending.current = false; setBusy(false); }
  };
  return <Dialog title={title} onClose={() => { if (!busy) onClose(); }}><form className="dialog-body form-grid folder-dialog" onSubmit={submit}>
    <code className="folder-path full">{parent}{action.kind !== 'create' && `/${action.entry.name}`}</code>
    {deleting ? <>
      <p className="full">確定刪除「{action.entry.name}」？此操作無法復原。</p>
      <label className="folder-recursive full"><input type="checkbox" checked={recursive} disabled={busy} onChange={event => { setRecursive(event.target.checked); setConfirmation(''); setError(''); }} />一併刪除所有檔案與子資料夾</label>
      {recursive ? <label className="full">輸入資料夾名稱以確認刪除<input aria-label="刪除資料夾確認名稱" value={confirmation} disabled={busy} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label> : <p className="muted full">只刪除空資料夾。</p>}
    </> : <label className="full">資料夾名稱<input aria-label="資料夾名稱" autoFocus value={name} disabled={busy} required maxLength={255} autoComplete="off" onChange={event => setName(event.target.value)} /></label>}
    {!deleting && name.trim() && nameError && <p className="error full" role="alert">{nameError}</p>}
    {error && <p className="error full" role="alert">{error}</p>}
    <div className="dialog-actions full"><button className="secondary" type="button" disabled={busy} onClick={onClose}><X size={15} />取消</button><button className={deleting ? 'danger' : 'primary'} disabled={!canSubmit}>{busy ? <LoaderCircle size={15} className="spin" /> : deleting ? <Trash2 size={15} /> : action.kind === 'create' ? <FolderPlus size={15} /> : <Pencil size={15} />}{deleting ? '確定刪除' : action.kind === 'create' ? '新增' : '儲存'}</button></div>
  </form></Dialog>;
}
