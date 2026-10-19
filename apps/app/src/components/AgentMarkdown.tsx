import { useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remoteFilePath } from '@cozypad/contracts';
import { downloadFile } from '../download';
import { message } from '../api';

function RemoteFileLink({ taskId, path, cwd, children }: { taskId: string; path: string; cwd: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  const filename = path.split('/').at(-1) || 'download';
  const href = `/api/tasks/${encodeURIComponent(taskId)}/files/download?${new URLSearchParams({ path, cwd })}`;
  return <span className="remote-file-link"><a href={href} download={filename} title={path} aria-busy={busy} aria-disabled={busy} onClick={event => {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    void downloadFile(href, filename).catch(error => setError(message(error))).finally(() => { pending.current = false; setBusy(false); });
  }}>{children}</a>{error && <span className="error file-download-error" role="alert">{error}</span>}</span>;
}

export function AgentMarkdown({ taskId, cwd, text }: { taskId: string; cwd: string; text: string }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children, title }) => {
      const path = remoteFilePath(href);
      if (path) return <RemoteFileLink taskId={taskId} path={path} cwd={cwd}>{children}</RemoteFileLink>;
      if (!href) return <span>{children}</span>;
      return <a href={href} title={title} {...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>{children}</a>;
    }
  }), [taskId, cwd]);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url, key) => key === 'href' && remoteFilePath(url) ? url : defaultUrlTransform(url)}>{text}</ReactMarkdown>;
}
