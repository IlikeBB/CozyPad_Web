import { ChevronDown, Clock3, TerminalSquare } from 'lucide-react';
import type { ProcessGroup } from '../workspaces/process-groups';
import { eventKey } from '../workspaces/process-groups';

export function AgentProcessGroup({ group }: { group: ProcessGroup }) {
  const first = group.events[0];
  if (!first) return null;
  const multiple = group.events.length > 1;
  return <details className={`process-bubble ${multiple ? 'process-group' : ''}`}>
    <summary>{first.type === 'command' ? <TerminalSquare size={14} /> : <Clock3 size={14} />}
      <span title={group.label}>{multiple ? group.label : first.text.split('\n')[0]?.slice(0, 150)}</span>
      {multiple && <b className="process-count">{group.events.length} 個步驟</b>}<ChevronDown size={14} />
    </summary>
    {multiple ? <ol className="process-steps">{group.events.map((event, index) => {
      const [heading, ...output] = event.text.split('\n');
      return <li key={eventKey(event)}><div className="process-step-heading"><span>{index + 1}</span><code>{heading}</code></div>
        {!!output.length && <pre>{output.join('\n')}</pre>}
      </li>;
    })}</ol> : <pre>{first.text}</pre>}
  </details>;
}
