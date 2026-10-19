import { useState } from 'react';
import { Check, FileKey2, Laptop, Pencil, Plus, Save, Trash2, Upload, ArrowLeft } from 'lucide-react';
import type { ServerDraft, ServerProfile } from '@cozypad/contracts';
import { api, post, message } from '../api';
import { Busy, Dialog, IconButton } from './Controls';

const blank: ServerDraft = { name: '', host: '', port: 22, username: '', defaultPath: '~', privateKey: '', passphrase: '' };
export function ConnectionManager({ servers, onClose, onRefresh }: {
  servers: ServerProfile[]; onClose: () => void; onRefresh: (changedId?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [keyFiles, setKeyFiles] = useState<File[]>([]);
  const [keyName, setKeyName] = useState('');
  const update = (key: keyof ServerDraft, value: string | number) => setDraft(previous => previous ? { ...previous, [key]: value } : previous);
  const edit = (profile?: ServerProfile) => {
    setDraft(profile ? { ...profile, privateKey: '', passphrase: '' } : { ...blank }); setError(''); setNotice(''); setKeyName(''); setImporting(false);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!draft) return; setBusy(true); setError('');
    try {
      await api(draft.id ? `/servers/${encodeURIComponent(draft.id)}` : '/servers', { method: draft.id ? 'PUT' : 'POST', body: JSON.stringify({ ...draft, ...(keyName ? { keyName } : {}) }) });
      await onRefresh(draft.id); setDraft(null); setNotice('連線設定已儲存。');
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true); setError('');
    try { await api(`/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }); await onRefresh(id); setDeleting(null); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  const importConfig = async (event: React.FormEvent) => {
    event.preventDefault(); if (!configFile) return; setBusy(true); setError('');
    try {
      if (configFile.size > 1048576 || keyFiles.some(file => file.size > 131072)) throw new Error('設定檔或私鑰超過檔案大小上限。');
      const keys = await Promise.all(keyFiles.map(async file => ({ name: file.name, privateKey: await file.text() })));
      const result = await post<{ imported: number; skipped: number; warnings: string[] }>('/servers/import', { rawConfig: await configFile.text(), keyFiles: keys });
      await onRefresh(); setNotice(`已匯入 ${result.imported} 台，略過 ${result.skipped} 台。${result.warnings.join('；')}`); setImporting(false); setConfigFile(null); setKeyFiles([]);
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  return <Dialog title={draft ? (draft.id ? '編輯連線' : '新增連線') : '連線管理'} onClose={() => { if (!busy) onClose(); }}>
    {draft ? <form onSubmit={save} className="dialog-body form-grid">
      <label className="full">名稱<input autoFocus value={draft.name} onChange={event => update('name', event.target.value)} required /></label>
      <label>Host<input value={draft.host} onChange={event => update('host', event.target.value)} required /></label>
      <label>Port<input type="number" min={1} max={65535} value={draft.port} onChange={event => update('port', Number(event.target.value))} required /></label>
      <label className="full">Username<input value={draft.username} onChange={event => update('username', event.target.value)} autoComplete="off" required /></label>
      <label className="full">預設目錄<input value={draft.defaultPath} onChange={event => update('defaultPath', event.target.value)} required /></label>
      <label className="file-picker full"><FileKey2 size={17} /><span>{keyName || (draft.id ? '替換私鑰（選填）' : '選擇 SSH 私鑰')}</span><input type="file" aria-label="選擇 SSH 私鑰" onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        if (file.size > 131072) { setError('私鑰超過 128 KB 上限。'); return; }
        void file.text().then(value => { update('privateKey', value); setKeyName(file.name); }).catch(error => setError(message(error)));
      }} /></label>
      <label className="full">私鑰內容<textarea rows={4} value={draft.privateKey || ''} onChange={event => update('privateKey', event.target.value)} placeholder={draft.id ? '留空保留現有私鑰' : '-----BEGIN OPENSSH PRIVATE KEY-----'} spellCheck={false} /></label>
      <label className="full">Passphrase<input type="password" autoComplete="new-password" value={draft.passphrase || ''} onChange={event => update('passphrase', event.target.value)} /></label>
      {error && <p className="error full" role="alert">{error}</p>}
      <div className="dialog-actions full"><button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}><ArrowLeft size={16} />返回</button><button className="primary" disabled={busy}>{busy ? <Busy /> : <><Save size={16} />儲存</>}</button></div>
    </form> : <div className="dialog-body">
      <div className="toolbar"><button className="primary" onClick={() => edit()} disabled={busy}><Plus size={16} />新增連線</button><button className="secondary" onClick={() => { setImporting(!importing); setError(''); }} disabled={busy}><Upload size={16} />匯入 ssh_config</button></div>
      {importing && <form className="import-form" onSubmit={importConfig}>
        <label className="file-picker"><Upload size={16} /><span>{configFile?.name || '選擇 ssh_config'}</span><input type="file" aria-label="選擇 ssh_config" onChange={event => setConfigFile(event.target.files?.[0] || null)} /></label>
        <label className="file-picker"><FileKey2 size={16} /><span>{keyFiles.length ? `${keyFiles.length} 個私鑰檔案` : '選擇對應私鑰（可多選）'}</span><input type="file" multiple aria-label="選擇匯入私鑰" onChange={event => setKeyFiles(Array.from(event.target.files || []))} /></label>
        <button className="primary" disabled={!configFile || busy}>{busy ? <Busy /> : <><Upload size={16} />匯入</>}</button>
      </form>}
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status"><Check size={16} />{notice}</p>}
      <div className="profile-list">{servers.map(profile => <div className="profile-row" key={profile.id}>
        {profile.kind === 'local' ? <Laptop size={19} className="accent" /> : <FileKey2 size={19} className={profile.hasKey ? 'accent' : 'muted'} />}<div className="profile-detail"><strong>{profile.name}</strong><span>{profile.kind === 'local' ? profile.defaultPath : `${profile.username}@${profile.host}:${profile.port}`}</span><small>{profile.kind === 'local' ? profile.online ? '本機 · 已上線' : '本機 · 離線' : profile.hasKey ? 'SSH Key' : '未設定私鑰'}</small></div>
        {deleting === profile.id ? <><button className="danger" disabled={busy} onClick={() => void remove(profile.id)}><Trash2 size={15} />確定刪除</button><button className="secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</button></> : <>
          {profile.kind !== 'local' && <IconButton label={`編輯 ${profile.name}`} disabled={busy} onClick={() => edit(profile)}><Pencil size={17} /></IconButton>}
          <IconButton label={`刪除 ${profile.name}`} className="danger-icon" disabled={busy} onClick={() => setDeleting(profile.id)}><Trash2 size={17} /></IconButton>
        </>}
      </div>)}</div>
      {!servers.length && <p className="muted empty-list">尚無連線設定</p>}
    </div>}
  </Dialog>;
}
