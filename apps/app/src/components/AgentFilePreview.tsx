import { useEffect, useState } from 'react';
import { Download, RotateCw, X } from 'lucide-react';
import { Busy, IconButton } from './Controls';
import { serverQuery } from '../api';
import { MarkdownDocument } from './MarkdownDocument';
import { MarkdownViewSwitch } from './MarkdownViewSwitch';
import { isMarkdownFile } from './markdown-document.mjs';
import { mediaType } from '../../../../packages/contracts/src/media-types.mjs';
import { MediaPreview, mediaFileUrl } from './MediaPreview';

export type FilePreview = { path: string; name: string; content: string; loading: boolean; error: string; version?: number };
export function AgentFilePreview({ file, serverId, onRefresh, onClose }: { file: FilePreview; serverId: string; onRefresh: () => void; onClose?: () => void }) {
  const [rendered, setRendered] = useState(true);
  useEffect(() => { setRendered(true); }, [file.path]);
  const markdown = isMarkdownFile(file.name);
  const media = mediaType(file.path);
  return <section className="agent-file-preview" aria-label={`檔案預覽 ${file.name}`}>
    <div className="workspace-toolbar preview-toolbar"><span className="preview-path" title={file.path}>{file.path}</span><span className="muted">唯讀</span><div className="toolbar-spacer" />
      {markdown && <MarkdownViewSwitch preview={rendered} onChange={setRendered} />}
      <a className="icon-button" aria-label={`下載預覽檔案 ${file.name}`} title="下載檔案" href={media ? mediaFileUrl(serverId, file.path, true) : `/api/files/download?${serverQuery(serverId, file.path)}`}><Download size={16} /></a>
      <IconButton label="重新載入檔案預覽" disabled={file.loading} onClick={onRefresh}><RotateCw size={16} /></IconButton>
      {onClose && <IconButton label="關閉媒體預覽" onClick={onClose}><X size={16} /></IconButton>}
    </div>
    {file.loading ? <div className="preview-message"><Busy label="讀取檔案預覽" /></div> : file.error ? <p className="error preview-message" role="alert">{file.error}</p> : media ? <MediaPreview key={`${file.path}:${file.version || 0}`} path={file.path} name={file.name} serverId={serverId} version={file.version} /> : rendered && markdown
      ? <MarkdownDocument content={file.content} path={file.path} serverId={serverId} />
      : <div className="preview-code"><pre className="preview-lines" aria-hidden="true">{file.content.split('\n').map((_, index) => index + 1).join('\n')}</pre><pre aria-label="檔案預覽內容"><code>{file.content}</code></pre></div>}
  </section>;
}
