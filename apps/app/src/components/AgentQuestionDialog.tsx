import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from './Controls';

export function AgentQuestionDialog({ autoOpen, waiting, children }: { autoOpen: boolean; waiting: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => { setOpen(autoOpen); }, [autoOpen]);
  return <>
    <button type="button" className="agent-question-open" onClick={() => setOpen(true)}>開啟選擇視窗</button>
    <Dialog title="Codex 需要你的選擇" open={open} onClose={() => setOpen(false)}>
      <div className="dialog-body agent-question-dialog">
        <p className="muted">{waiting ? 'Codex 正在等待你的回覆。選擇後按確認才會繼續；關閉視窗不會代你回答。' : '請選擇後按確認，將答案送回這個對話。'}</p>
        {children}
      </div>
    </Dialog>
  </>;
}
