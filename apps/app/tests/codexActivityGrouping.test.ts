import { describe, expect, it } from 'vitest';
import { groupCodexActivity } from '../src/workspaces/agents/CodexAppServerPanel';

describe('groupCodexActivity', () => {
  it('places one combined activity panel between the user message and final response', () => {
    const entries = groupCodexActivity([
      { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Summarize the work' }] },
      { id: 'comment-1', type: 'agentMessage', phase: 'commentary', text: 'Inspecting commits.' },
      { id: 'command-1', type: 'commandExecution', command: 'git log' },
      { id: 'comment-2', type: 'agentMessage', phase: 'commentary', text: 'Reading experiments.' },
      { id: 'answer-1', type: 'agentMessage', phase: 'final', text: 'Here is the summary.' },
    ]);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'item', item: { id: 'user-1' } });
    expect(entries[1]).toMatchObject({
      kind: 'activity',
      items: [{ id: 'comment-1' }, { id: 'command-1' }, { id: 'comment-2' }],
    });
    expect(entries[2]).toMatchObject({ kind: 'item', item: { id: 'answer-1' } });
  });

  it('keeps in-progress activity visible before a final response exists', () => {
    const entries = groupCodexActivity([
      { id: 'user-1', type: 'userMessage' },
      { id: 'comment-1', type: 'agentMessage', phase: 'commentary', text: 'Still working.' },
    ]);

    expect(entries.at(-1)).toMatchObject({ kind: 'activity', items: [{ id: 'comment-1' }] });
  });
});
