import { useState } from 'react';
import { Download, FileText, X } from 'lucide-react';
import type { AgentAttachment } from '@cozypad/contracts';
import type { PendingAttachment } from '../workspaces/use-agent-attachments';
import { Dialog, IconButton } from './Controls';

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const attachmentUrl = (taskId: string, id: string) => `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(id)}`;

export function AgentAttachmentTray({ files, disabled, onRemove }: { files: PendingAttachment[]; disabled: boolean; onRemove: (id: string) => void }) {
  if (!files.length) return null;
  return <div className="attachment-tray" aria-label="待送出的附件">{files.map(file => <div className="pending-attachment" key={file.id}>
    {file.preview ? <img src={file.preview} alt={file.name} /> : <FileText size={24} className="muted" />}
    <span className="attachment-name"><strong title={file.name}>{file.name}</strong><small>{size(file.size)}</small></span>
    <IconButton label={`移除附件 ${file.name}`} disabled={disabled} onClick={() => onRemove(file.id)}><X size={15} /></IconButton>
  </div>)}</div>;
}

export function AgentMessageAttachments({ taskId, files }: { taskId: string; files: AgentAttachment[] }) {
  const [preview, setPreview] = useState<AgentAttachment | null>(null);
  return <>
    <div className="message-attachments">{files.map(file => file.kind === 'image'
      ? <button type="button" className="message-image" title={`預覽 ${file.name}`} aria-label={`預覽 ${file.name}`} onClick={() => setPreview(file)} key={file.id}><img src={attachmentUrl(taskId, file.id)} alt={file.name} /><span title={file.name}>{file.name}</span></button>
      : <a className="message-document" href={`${attachmentUrl(taskId, file.id)}?download=1`} aria-label={`下載附件 ${file.name}`} key={file.id}><FileText size={20} /><span className="attachment-name"><strong title={file.name}>{file.name}</strong><small>{size(file.size)}</small></span><Download size={15} /></a>
    )}</div>
    {preview && <Dialog title={preview.name} onClose={() => setPreview(null)}><div className="dialog-body">
      <img className="attachment-lightbox" src={attachmentUrl(taskId, preview.id)} alt={preview.name} />
      <div className="dialog-actions"><a className="secondary" href={`${attachmentUrl(taskId, preview.id)}?download=1`}><Download size={15} />下載</a></div>
    </div></Dialog>}
  </>;
}
