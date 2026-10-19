import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Folder, LoaderCircle, Pencil, X } from 'lucide-react';
import type { ServerProfile } from '@cozypad/contracts';
import { displayDirectoryPath, remoteDirectoryPath, virtualDirectoryPath } from '@cozypad/contracts';
import { message, post } from '../api';
import { Dialog, IconButton } from './Controls';

export function AgentDirectorySelect({ server, path, disabled, onPath, onBusy }: { server: ServerProfile; path: string; disabled: boolean; onPath: (path: string) => void; onBusy: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(path);
  const generation = useRef(0), changing = useRef(false);
  const label = server.kind === 'local' ? '本機' : 'SSH';
  useEffect(() => {
    generation.current++; setError(''); setBusy(false); changing.current = false; onBusy(false); setEditing(false);
    // A peer directory picker can disappear while its request is in flight.
    // Release the parent's send lock as well as rejecting the old response.
    return () => { generation.current++; changing.current = false; onBusy(false); };
  }, [server.id, onBusy]);
  const closeEditor = () => {
    generation.current++; changing.current = false; setBusy(false); onBusy(false); setEditing(false); setError('');
  };
  const apply = async (target: string) => {
    if (disabled || changing.current) return;
    target = virtualDirectoryPath(target, server.platform);
    try { remoteDirectoryPath(target); } catch (error) { setError(message(error)); return; }
    const current = ++generation.current; changing.current = true; setBusy(true); onBusy(true); setError('');
    try {
      const result = await post<{ path: string }>('/agents/directories', { serverId: server.id, path: target });
      if (generation.current !== current) return;
      onPath(result.path); setEditing(false);
    } catch (error) { if (generation.current === current) setError(message(error)); }
    finally { if (generation.current === current) { changing.current = false; setBusy(false); onBusy(false); } }
  };
  return <div className="agent-directory-control">
    <div className="agent-directory-select"><Folder size={14} /><span>{label} pwd</span><output aria-label={`目前 ${label} pwd`} title={displayDirectoryPath(path, server.platform)}>{displayDirectoryPath(path, server.platform)}</output></div>
    <IconButton label={`更改 ${label} 工作目錄`} disabled={disabled || busy} onClick={() => { setDraft(displayDirectoryPath(path, server.platform)); setError(''); setEditing(true); }}>{busy ? <LoaderCircle className="spin" size={15} /> : <Pencil size={15} />}</IconButton>
    {error && !editing && <span className="error directory-error" role="alert">{error}</span>}
    {editing && createPortal(<Dialog title={`${label} 工作目錄`} onClose={closeEditor}><form className="dialog-body" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void apply(draft); }}>
      <label>路徑<input aria-label={`新的 ${label} 工作目錄`} value={draft} maxLength={4096} disabled={busy} required spellCheck={false} onChange={event => setDraft(event.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={closeEditor}><X size={15} />取消</button><button type="submit" className="primary" disabled={busy || disabled}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}套用</button></div>
    </form></Dialog>, document.body)}
  </div>;
}
