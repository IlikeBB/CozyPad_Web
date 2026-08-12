import { useEffect, useRef, useState } from 'react';

interface EditSentMessageDialogProps {
  agentLabel: string;
  initialText: string;
  running?: boolean;
  onCancel(): void;
  onSubmit(text: string): void | Promise<void>;
}

export function EditSentMessageDialog({
  agentLabel,
  initialText,
  running = false,
  onCancel,
  onSubmit,
}: EditSentMessageDialogProps) {
  const [text, setText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  const submit = async () => {
    const nextText = text.trim();
    if (!nextText || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(nextText);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay edit-message-overlay" onClick={onCancel}>
      <div className="modal edit-message-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Edit message</h2>
            <span>
              {running
                ? `CozyPad 會先停止目前 ${agentLabel} 任務，再用編輯後內容重新執行。`
                : `CozyPad 會用編輯後內容重新執行新的 ${agentLabel} 任務。`}
            </span>
          </div>
          <button type="button" className="modal-close" onClick={onCancel}>
            x
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          rows={10}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        <div className="edit-message-note">
          已經送進 CLI 的內容無法可靠撤回；此操作會停止後續執行並開新任務。
        </div>
        <div className="edit-message-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={!text.trim() || submitting}
          >
            {submitting ? 'Running...' : running ? 'Stop and rerun' : 'Rerun'}
          </button>
        </div>
      </div>
    </div>
  );
}
