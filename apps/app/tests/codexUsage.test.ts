import { describe, expect, it } from 'vitest';

import {
  contextRemainingPercent,
  mergeCodexUsageStats,
  parseCodexUsage,
} from '../src/workspaces/agents/codexUsage';

describe('parseCodexUsage', () => {
  it('reads structured CozyPad usage control lines', () => {
    const stats = parseCodexUsage(
      '[CozyPad] usage total=6383322 input=6361575 cached_input=570880 output=21747 reasoning=4683 context=171600 context_limit=246400 context_remaining_percent=30',
    );

    expect(stats.hasData).toBe(true);
    expect(stats.total).toBe(6383322);
    expect(stats.input).toBe(6361575);
    expect(stats.cachedInput).toBe(570880);
    expect(stats.output).toBe(21747);
    expect(stats.reasoning).toBe(4683);
    expect(stats.currentContext).toBe(171600);
    expect(stats.contextLimit).toBe(246400);
    expect(contextRemainingPercent(stats)).toBe(30);
  });

  it('reads current Codex summary text', () => {
    const stats = parseCodexUsage(
      [
        'Total tokens 6,383,322',
        'Context remaining 30%',
        'Input 6,361,575',
        'Cached input 570,880',
        'Output 21,747',
        'Reasoning 4,683',
        'Current context 183,600',
      ].join('\n'),
    );

    expect(stats.hasData).toBe(true);
    expect(stats.total).toBe(6383322);
    expect(stats.input).toBe(6361575);
    expect(stats.cachedInput).toBe(570880);
    expect(stats.output).toBe(21747);
    expect(stats.reasoning).toBe(4683);
    expect(stats.currentContext).toBe(183600);
    expect(contextRemainingPercent(stats)).toBe(30);
  });

  it('falls back to compact token output', () => {
    const stats = parseCodexUsage('usage — in 25 / out 257 tokens');

    expect(stats.hasData).toBe(true);
    expect(stats.total).toBe(282);
    expect(stats.input).toBe(25);
    expect(stats.output).toBe(257);
  });

  it('merges visible totals with control-message context data', () => {
    const visibleStats = parseCodexUsage('tokens used 6,383,322');
    const controlStats = parseCodexUsage('[CozyPad] usage context=171600 context_limit=246400 context_remaining_percent=30');
    const merged = mergeCodexUsageStats(controlStats, visibleStats);

    expect(merged.total).toBe(6383322);
    expect(merged.currentContext).toBe(171600);
    expect(merged.contextLimit).toBe(246400);
    expect(contextRemainingPercent(merged)).toBe(30);
  });

  it('keeps context fields optional when CLI usage omits them', () => {
    const stats = parseCodexUsage(
      '[CozyPad] usage total=15444 input=15418 cached_input=10624 output=26 reasoning=19',
    );

    expect(stats.hasData).toBe(true);
    expect(contextRemainingPercent(stats)).toBeNull();
  });
});
