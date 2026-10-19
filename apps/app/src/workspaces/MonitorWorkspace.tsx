import { useState } from 'react';
import { Activity } from 'lucide-react';
import type { ServerProfile } from '@cozypad/contracts';
import { TerminalWorkspace } from './TerminalWorkspace';

export function MonitorWorkspace({ server }: { server: ServerProfile }) {
  const [view, setView] = useState<'both' | 'nvtop' | 'htop'>('both');
  return <section className="monitor-workspace">
    <div className="workspace-toolbar monitor-toolbar"><Activity size={17} className="accent" /><strong>{server.name}</strong><div className="toolbar-spacer" />
      <div className="monitor-views" role="group" aria-label="監看面板">
        <button type="button" className={view === 'both' ? 'active' : ''} aria-pressed={view === 'both'} onClick={() => setView('both')}>雙面板</button>
        <button type="button" className={view === 'nvtop' ? 'active' : ''} aria-pressed={view === 'nvtop'} onClick={() => setView('nvtop')}>GPU · nvtop</button>
        <button type="button" className={view === 'htop' ? 'active' : ''} aria-pressed={view === 'htop'} onClick={() => setView('htop')}>CPU · htop</button>
      </div>
    </div>
    <div className={`monitor-terminal-grid ${view === 'both' ? 'dual' : 'single'}`}>
      <section className="monitor-terminal-pane" aria-label="GPU 監看 nvtop" hidden={view === 'htop'}><TerminalWorkspace server={server} tool="nvtop" /></section>
      <section className="monitor-terminal-pane" aria-label="CPU 與記憶體監看 htop" hidden={view === 'nvtop'}><TerminalWorkspace server={server} tool="htop" /></section>
    </div>
    <div className="workspace-bottom"><span>即時互動 · 點選面板可使用快捷鍵，窄螢幕可橫向捲動</span><span>nvtop + htop</span></div>
  </section>;
}
