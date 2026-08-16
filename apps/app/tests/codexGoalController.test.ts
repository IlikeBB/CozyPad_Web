import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANAGED_GOAL_POLICY,
  advanceManagedGoalRuntime,
  buildManagedGoalObjective,
  createManagedGoalRuntime,
  goalHasTokensRemaining,
  goalProgressSignature,
} from '../src/workspaces/agents/codexGoalController';

describe('managed Codex goals', () => {
  it('keeps the objective within the app-server limit and retains the blocker contract', () => {
    const objective = buildManagedGoalObjective('x'.repeat(5_000), DEFAULT_MANAGED_GOAL_POLICY);
    expect(objective.length).toBeLessThanOrEqual(3_900);
    expect(objective).toContain('why progress is impossible');
    expect(objective).toContain('most concrete next action');
  });

  it('does not count repeated command evidence as new progress', () => {
    const command = {
      id: 'one',
      type: 'commandExecution',
      command: 'pnpm test',
      status: 'completed',
      aggregatedOutput: 'all tests passed',
    };
    expect(goalProgressSignature([command])).toBe(goalProgressSignature([
      command,
      { ...command, id: 'two' },
    ]));
  });

  it('pauses after the configured number of no-progress turns', () => {
    const policy = { ...DEFAULT_MANAGED_GOAL_POLICY, noProgressLimit: 2 };
    const initial = createManagedGoalRuntime([], 0);
    const first = advanceManagedGoalRuntime(initial, policy, [], 1_000);
    const second = advanceManagedGoalRuntime(first, policy, [], 2_000);
    expect(second.stopReason).toContain('No measurable');
    expect(second.nextStep).toContain('blocker report');
  });

  it('distinguishes finite token budgets from unlimited goals', () => {
    expect(goalHasTokensRemaining(null)).toBe(true);
    expect(goalHasTokensRemaining({ tokenBudget: 10, tokensUsed: 9 })).toBe(true);
    expect(goalHasTokensRemaining({ tokenBudget: 10, tokensUsed: 10 })).toBe(false);
  });
});
