import { describe, expect, it } from 'vitest';
import {
  codexActivitySummary,
  codexActivityKindLabel,
  codexExecutionSnapshot,
  codexDiffLineKind,
  groupCodexActivity,
  readableItemText,
  visibleCodexActivityItems,
} from '../src/workspaces/agents/CodexAppServerPanel';

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

describe('Codex activity details', () => {
  it('reports the latest confirmed CLI action and per-turn work counts', () => {
    const snapshot = codexExecutionSnapshot({
      items: [
        { id: 'user-1', type: 'userMessage', text: 'Fix it' },
        { id: 'reasoning-1', type: 'reasoning', text: 'Inspecting the code' },
        { id: 'command-1', type: 'commandExecution', command: 'pnpm test', status: 'inProgress' },
        {
          id: 'files-1',
          type: 'fileChange',
          changes: [{ path: 'src/App.tsx' }, { path: 'src/App.test.ts' }],
        },
        { id: 'command-2', type: 'commandExecution', command: 'pnpm test', status: 'inProgress' },
      ],
      turnStatus: 'inProgress',
      busy: true,
      approvalCount: 0,
      connected: true,
      runtimeStatus: 'ready',
    });

    expect(snapshot).toMatchObject({
      label: 'Running command',
      detail: 'pnpm test',
      tone: 'running',
      active: true,
      commands: 2,
      files: 2,
      tools: 0,
    });
  });

  it('shows approvals and disconnection ahead of inferred activity', () => {
    const base = {
      items: [{ id: 'command-1', type: 'commandExecution', command: 'deploy', status: 'inProgress' }],
      turnStatus: 'inProgress',
      busy: true,
      runtimeStatus: 'ready' as const,
    };
    expect(codexExecutionSnapshot({ ...base, approvalCount: 1, connected: true }).label)
      .toBe('Waiting for approval');
    expect(codexExecutionSnapshot({ ...base, approvalCount: 1, connected: false }).label)
      .toBe('SSH disconnected');
  });

  it('uses compact semantic labels for the current running action', () => {
    expect(codexActivityKindLabel({
      id: 'command-1',
      type: 'commandExecution',
      command: 'pnpm test',
    }, true)).toBe('Running command');
    expect(codexActivityKindLabel({
      id: 'change-1',
      type: 'fileChange',
      changes: [{ path: 'src/App.tsx' }],
    }, true)).toBe('Editing files');
    expect(codexActivityKindLabel({
      id: 'reasoning-1',
      type: 'reasoning',
      text: 'Checking the result',
    }, true)).toBe('Thinking');
    expect(codexActivityKindLabel({
      id: 'command-2',
      type: 'commandExecution',
      command: 'pnpm test',
    })).toBe('Command');
  });

  it('reads command execution fields instead of looking only at item.text', () => {
    const text = readableItemText({
      id: 'command-1',
      type: 'commandExecution',
      command: 'git status --short',
      cwd: '/workspace/project',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: ' M src/App.tsx',
    });

    expect(text).toContain('git status --short');
    expect(text).toContain('/workspace/project');
    expect(text).toContain('completed');
    expect(text).toContain('Exit code:** 0');
    expect(text).toContain(' M src/App.tsx');
  });

  it('hides empty activity lifecycle items instead of rendering placeholder rows', () => {
    const visible = visibleCodexActivityItems([
      { id: 'reasoning-empty', type: 'reasoning' },
      { id: 'command-empty', type: 'commandExecution' },
      { id: 'command-visible', type: 'commandExecution', command: 'pwd' },
      { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'Inspecting.' },
    ]);

    expect(visible.map((item) => item.id)).toEqual(['command-visible', 'commentary']);
  });

  it('keeps the collapsed command summary stable as output streams', () => {
    const item = {
      id: 'command-1',
      type: 'commandExecution',
      command: 'git status --short',
      status: 'inProgress',
      aggregatedOutput: 'x'.repeat(50_000),
    };

    expect(codexActivitySummary(item)).toBe('inProgress · git status --short');
    expect(codexActivitySummary({ ...item, aggregatedOutput: 'y'.repeat(100_000) }))
      .toBe('inProgress · git status --short');
  });

  it('bounds long commentary in the collapsed activity header', () => {
    const summary = codexActivitySummary({
      id: 'comment-1',
      type: 'agentMessage',
      phase: 'commentary',
      text: 'a'.repeat(500),
    });

    expect(summary.length).toBe(220);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('classifies unified diff lines without treating file headers as edits', () => {
    expect(codexDiffLineKind('+++ b/src/App.tsx')).toBe('metadata');
    expect(codexDiffLineKind('--- a/src/App.tsx')).toBe('metadata');
    expect(codexDiffLineKind('@@ -1,2 +1,2 @@')).toBe('metadata');
    expect(codexDiffLineKind('\\ No newline at end of file')).toBe('metadata');
    expect(codexDiffLineKind('+const enabled = true;')).toBe('addition');
    expect(codexDiffLineKind('-const enabled = false;')).toBe('deletion');
    expect(codexDiffLineKind(' const stable = true;')).toBe('context');
  });
});
