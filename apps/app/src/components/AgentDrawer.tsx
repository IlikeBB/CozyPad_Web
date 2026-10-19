import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { IconButton } from './Controls';

type Props = {
  side: 'left' | 'right';
  title: string;
  open: boolean;
  overlay: boolean;
  interactive: boolean;
  onOpen: () => void;
  onClose: () => void;
  onHover: () => void;
  onLeave: () => void;
  children: ReactNode;
};

export function AgentDrawer({ side, title, open, overlay, interactive, onOpen, onClose, onHover, onLeave, children }: Props) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || !interactive) return;
    const trigger = panel.current?.closest('.agents-workspace')?.querySelector<HTMLButtonElement>(`button[aria-controls="agent-drawer-${side}"][aria-expanded="true"]`);
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab' || !overlay) return;
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter(element => element.getClientRects().length && !element.closest('[hidden]'));
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    panel.current?.addEventListener('keydown', keyboard);
    const element = panel.current;
    return () => { element?.removeEventListener('keydown', keyboard); if (trigger?.isConnected) trigger.focus(); };
  }, [open, overlay, side, interactive, title]);
  return <div className={`agent-drawer drawer-${side} ${open ? 'is-open' : ''}`} onPointerEnter={event => { if (event.pointerType === 'mouse') onHover(); }}
    onPointerLeave={() => { if (!panel.current?.contains(document.activeElement)) onLeave(); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) onLeave(); }}>
    {!open && <button className="drawer-rail" title={`展開${title}抽屜`} aria-label={`展開${title}抽屜`} aria-expanded={false} aria-controls={`agent-drawer-${side}`} onClick={onOpen}>
      {side === 'left' ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
    </button>}
    <aside ref={panel} id={`agent-drawer-${side}`} className="drawer-panel" hidden={!open} aria-label={title} role={overlay && interactive ? 'dialog' : undefined} aria-modal={overlay && open && interactive ? true : undefined}>
      <header className="drawer-title"><strong>{title}</strong><IconButton label={`收合${title}抽屜`} onClick={onClose}><X size={16} /></IconButton></header>
      {children}
    </aside>
  </div>;
}
