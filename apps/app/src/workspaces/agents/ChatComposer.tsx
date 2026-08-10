import { useEffect, useRef, useState } from 'react';
import type { SlashCommand } from '@cozypad/contracts';

export interface ChatComposerAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
}

interface ChatComposerProps {
  agentLabel: string;
  value: string;
  commands: SlashCommand[];
  disabled?: boolean;
  attachDisabled?: boolean;
  attachTitle?: string;
  attachments?: ChatComposerAttachment[];
  placeholder?: string;
  showAttachButton?: boolean;
  onChange(value: string): void;
  onSend(text: string): void;
  onAttach?(): void;
  onFilesAttached?(files: File[]): void;
  onRemoveAttachment?(id: string): void;
}

export function ChatComposer({
  agentLabel,
  value,
  commands,
  disabled = false,
  attachDisabled = true,
  attachTitle = 'Attach images',
  attachments = [],
  placeholder,
  onChange,
  onSend,
  onAttach,
  showAttachButton = Boolean(onAttach),
  onFilesAttached,
  onRemoveAttachment,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);

  const slashQuery =
    value.startsWith('/') && !value.includes(' ') && !value.includes('\n')
      ? value.slice(1).toLowerCase()
      : null;
  const matches =
    slashQuery !== null && !slashDismissed
      ? commands.filter((command) => command.name.toLowerCase().startsWith(slashQuery))
      : [];
  const menuOpen = matches.length > 0;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (slashQuery === null) setSlashDismissed(false);
  }, [slashQuery]);

  const accept = (command: SlashCommand) => {
    onChange(`/${command.name} `);
    textareaRef.current?.focus();
  };

  const addFiles = (files: FileList | File[]) => {
    if (!onFilesAttached) return false;
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return false;
    onFilesAttached(imageFiles);
    textareaRef.current?.focus();
    return true;
  };

  const send = () => {
    const text = value.trim();
    if ((text === '' && attachments.length === 0) || disabled) return;
    onSend(text);
    textareaRef.current?.focus();
  };

  return (
    <div
      className={`composer-wrap${draggingFiles ? ' composer-wrap-dragging' : ''}`}
      onDragEnter={(event) => {
        if (!onFilesAttached || !Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!onFilesAttached || !Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setDraggingFiles(false);
        }
      }}
      onDrop={(event) => {
        if (!onFilesAttached) return;
        event.preventDefault();
        setDraggingFiles(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      {menuOpen ? (
        <div className="slash-menu">
          {matches.map((command, index) => (
            <button
              key={command.name}
              className={`slash-item${index === slashIndex ? ' slash-item-active' : ''}`}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => accept(command)}
            >
              <span className="slash-name">/{command.name}</span>
              <span className="slash-desc">{command.description}</span>
            </button>
          ))}
          <div className="slash-hint hint">↑/↓ 選擇 · Tab/Enter 套用 · Esc 關閉</div>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <div className="composer-attachment" key={attachment.id}>
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt={attachment.name} />
              ) : null}
              <span>{attachment.name}</span>
              <button
                type="button"
                title="移除附件"
                onClick={() => onRemoveAttachment?.(attachment.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer">
        <textarea
          ref={textareaRef}
          rows={Math.min(6, Math.max(1, value.split('\n').length))}
          placeholder={placeholder || `Message ${agentLabel}...（Enter 送出 · Shift+Enter 換行 · / 指令）`}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onPaste={(event) => {
            if (addFiles(event.clipboardData.files)) {
              event.preventDefault();
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (menuOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSlashIndex((index) => (index + 1) % matches.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSlashIndex((index) => (index - 1 + matches.length) % matches.length);
                return;
              }
              if (event.key === 'Tab' || event.key === 'Enter') {
                event.preventDefault();
                accept(matches[slashIndex] ?? matches[0]!);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setSlashDismissed(true);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          {showAttachButton ? (
            <button
              className="composer-attach"
              title={attachTitle}
              disabled={attachDisabled || disabled}
              onClick={onAttach}
            >
              +
            </button>
          ) : null}
          <button
            className="composer-send"
            onClick={send}
            disabled={(value.trim() === '' && attachments.length === 0) || disabled}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
