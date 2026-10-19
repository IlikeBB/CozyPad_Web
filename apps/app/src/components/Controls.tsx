import { X, LoaderCircle, PlugZap } from 'lucide-react';
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export function IconButton({ label, children, className = '', type = 'button', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title' | 'aria-label'> & {
  label: string; children: ReactNode;
}) {
  return <button {...props} className={`icon-button ${className}`} type={type} title={label} aria-label={label}>{children}</button>;
}
export function Dialog({ title, onClose, children, open = true }: { title: string; onClose: () => void; children: ReactNode; open?: boolean }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, [open]);
  return <div className="dialog-backdrop" style={open ? undefined : { display: 'none' }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]') || []);
        const first = targets[0], last = targets.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><h2>{title}</h2><IconButton label="關閉" onClick={onClose}><X size={18} /></IconButton></header>{children}
    </section>
  </div>;
}
export function Busy({ label = '讀取中' }: { label?: string }) { return <span className="busy"><LoaderCircle size={16} className="spin" />{label}</span>; }
export function EmptyConnection({ onManage }: { onManage: () => void }) {
  return <div className="empty-state"><PlugZap size={34} /><h2>尚未連線</h2><p>選擇一台伺服器</p><button className="primary" onClick={onManage}><PlugZap size={16} />連線管理</button></div>;
}
