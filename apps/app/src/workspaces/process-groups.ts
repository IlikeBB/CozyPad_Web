import { parse } from 'shell-quote';
import type { AgentEvent } from '@cozypad/contracts';

export type ProcessGroup = { kind: 'process'; key: string | number; label: string; events: AgentEvent[]; signature: string | null };
export type TimelineEntry = ProcessGroup | { kind: 'event'; key: string | number; event: AgentEvent };
export const eventKey = (event: AgentEvent) => event.messageId || event.order || event.id;
const basename = (value: string) => value.split('/').at(-1) || value;

function commandTool(command: string, depth = 0): { signature: string; label: string } | null {
  if (!command || depth > 3) return null;
  try {
    const tokens = parse(command, name => `$${name}`);
    // A leading directory change is setup, not the operation being grouped.
    if (tokens[0] === 'cd') {
      const next = tokens.findIndex(token => typeof token === 'object' && 'op' in token && token.op === '&&');
      if (next < 0) return null;
      tokens.splice(0, next + 1);
    }
    while (typeof tokens[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (typeof tokens[0] !== 'string') return null;
    const program = tokens[0], name = basename(program);
    if (['bash', 'sh', 'zsh', 'dash'].includes(name)) {
      const option = tokens.findIndex(token => typeof token === 'string' && /^-[a-z]*c[a-z]*$/.test(token));
      const script = tokens[option + 1];
      return option > 0 && typeof script === 'string' ? commandTool(script, depth + 1) : null;
    }
    // Compound scripts must remain separate rather than being mislabeled as one tool.
    if (tokens.some(token => typeof token !== 'string') || /[$`]/.test(program)) return null;
    const args = tokens.slice(1) as string[];
    if (/^(python[\d.]*|node|ruby|perl)$/.test(name)) {
      if (!args[0] || args[0].startsWith('-')) return null;
      return { signature: `${program}:${args[0]}`, label: `${name} ${basename(args[0])}` };
    }
    const action = ['git', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl'].includes(name) ? args[0] : undefined;
    if (action?.startsWith('-')) return null;
    return { signature: `${program}:${action || ''}`, label: `${name}${action ? ` ${action}` : ''}` };
  } catch { return null; }
}

export function groupProcessEvents(events: AgentEvent[]): TimelineEntry[] {
  const result: TimelineEntry[] = [];
  let previous: ProcessGroup | undefined;
  for (const event of [...events].sort((a, b) => (a.order || a.id) - (b.order || b.id))) {
    if (!['command', 'process'].includes(event.type)) {
      previous = undefined;
      if (!['status', 'usage', 'turn'].includes(event.type)) result.push({ kind: 'event', key: eventKey(event), event });
      continue;
    }
    const firstLine = event.text.split('\n')[0] || '';
    const tool = event.type === 'command' ? commandTool(firstLine) : null;
    const signature = event.type === 'command' ? (tool ? `command:${tool.signature}` : null) : (firstLine ? `process:${firstLine}` : null);
    if (previous && signature && previous.signature === signature) { previous.events.push(event); continue; }
    previous = { kind: 'process', key: eventKey(event), label: tool?.label || firstLine, events: [event], signature };
    result.push(previous);
  }
  return result;
}
