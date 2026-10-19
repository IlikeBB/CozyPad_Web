import { useEffect, useRef, useState } from 'react';
import { attachmentLimits, attachmentType, attachmentNameError, type AgentAttachment } from '@cozypad/contracts';
import { message } from '../api';

export type PendingAttachment = AgentAttachment & { content: string; preview?: string };
let localSequence = 0;

export function useAgentAttachments(disabled: boolean) {
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<PendingAttachment[]>([]);
  const generation = useRef(0);
  const preparing = useRef(false);
  const pending = useRef<File[]>([]);
  useEffect(() => () => { generation.current++; }, []);
  const clear = () => {
    generation.current++; current.current = []; preparing.current = false; pending.current = [];
    setFiles([]); setReading(false); setError('');
  };
  const remove = (id: string) => {
    current.current = current.current.filter(file => file.id !== id); setFiles(current.current);
  };
  const restore = (value: PendingAttachment[]) => {
    generation.current++; preparing.current = false; pending.current = [];
    current.current = [...value]; setFiles(current.current); setReading(false); setError('');
  };
  const add = async (incoming: FileList | File[]) => {
    if (disabled || !incoming.length) return;
    const selected = Array.from(incoming), previous = current.current;
    setError('');
    if (previous.length + pending.current.length + selected.length > attachmentLimits.count) { setError('每次最多附加 5 個檔案。'); return; }
    if (previous.reduce((size, file) => size + file.size, 0) + [...pending.current, ...selected].reduce((size, file) => size + file.size, 0) > attachmentLimits.bytes) { setError('附件合計超過 30 MB 上限。'); return; }
    for (const file of selected) {
      const invalid = attachmentNameError(file.name);
      if (invalid || !file.size) { setError(invalid || `附件「${file.name}」是空檔案。`); return; }
    }
    const request = generation.current;
    pending.current.push(...selected);
    if (preparing.current) return;
    preparing.current = true; setReading(true);
    try {
      while (pending.current.length && request === generation.current) {
        const batch = [...pending.current];
        const added = await Promise.all(batch.map(async file => {
          const type = attachmentType(file.name)!;
          const content = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(reader.error || new Error('無法讀取附件。'));
            reader.readAsDataURL(file);
          });
          return { id: globalThis.crypto?.randomUUID?.() || `attachment-${request}-${++localSequence}`, name: file.name, size: file.size, ...type, content,
            ...(type.kind === 'image' ? { preview: `data:${type.mimeType};base64,${content}` } : {}) };
        }));
        if (request !== generation.current) return;
        pending.current.splice(0, batch.length);
        current.current = [...current.current, ...added]; setFiles(current.current);
      }
    } catch (error) { if (request === generation.current) setError(message(error)); }
    finally { if (request === generation.current) { preparing.current = false; pending.current = []; setReading(false); } }
  };
  return { files, reading, error, clear, remove, add, restore };
}
