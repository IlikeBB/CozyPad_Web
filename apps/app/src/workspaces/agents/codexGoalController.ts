import type { CodexThreadItem } from './codexAppServerState';

export type ManagedGoalPolicy = {
  tokenBudget: number;
  maxMinutes: number;
  maxTurns: number;
  noProgressLimit: number;
  checkpointEvery: number;
  successCriteria: string;
  constraints: string;
  stopConditions: string;
};

export type ManagedGoalRuntime = {
  startedAt: number;
  turnsCompleted: number;
  noProgressTurns: number;
  lastProgressSignature: string;
  lastProgressAt: number;
  checkpoint: string;
  stopReason: string;
  nextStep: string;
};

export const DEFAULT_MANAGED_GOAL_POLICY: ManagedGoalPolicy = {
  tokenBudget: 100_000,
  maxMinutes: 60,
  maxTurns: 10,
  noProgressLimit: 3,
  checkpointEvery: 3,
  successCriteria: '',
  constraints: '',
  stopConditions: '',
};

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function normalizeManagedGoalPolicy(value: Partial<ManagedGoalPolicy>): ManagedGoalPolicy {
  return {
    tokenBudget: boundedInteger(value.tokenBudget, 100_000, 1_000, 10_000_000),
    maxMinutes: boundedInteger(value.maxMinutes, 60, 1, 24 * 60),
    maxTurns: boundedInteger(value.maxTurns, 10, 1, 1_000),
    noProgressLimit: boundedInteger(value.noProgressLimit, 3, 1, 20),
    checkpointEvery: boundedInteger(value.checkpointEvery, 3, 1, 100),
    successCriteria: String(value.successCriteria || '').trim(),
    constraints: String(value.constraints || '').trim(),
    stopConditions: String(value.stopConditions || '').trim(),
  };
}

export function buildManagedGoalObjective(
  objective: string,
  policy: ManagedGoalPolicy,
): string {
  const sections = [
    objective.trim(),
    policy.successCriteria ? `Done when:\n${policy.successCriteria}` : '',
    policy.constraints ? `Constraints:\n${policy.constraints}` : '',
    policy.stopConditions ? `Additional stop conditions:\n${policy.stopConditions}` : '',
    [
      'Managed Goal contract:',
      '- Work in verifiable checkpoints and state concrete evidence of progress.',
      '- Do not repeat the same failed action without a materially different approach.',
      `- Stop after ${policy.noProgressLimit} consecutive turns without measurable progress.`,
      '- Before stopping for no progress or a blocker, reply with: (1) why progress is impossible, (2) evidence, and (3) the most concrete next action for the user or a future turn.',
      '- If tokens remain, use the final turn to produce that blocker report and next step instead of silently stopping.',
      '- Mark the goal complete only when the stated success criteria are verified.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');

  // Codex goals currently reject objectives above 4,000 characters. Preserve the
  // controller contract at the end and leave a small protocol margin.
  if (sections.length <= 3_900) return sections;
  const contractIndex = sections.lastIndexOf('\n\nManaged Goal contract:');
  const contract = contractIndex >= 0 ? sections.slice(contractIndex) : '';
  const marker = '\n\n[Details truncated by CozyPad]';
  const headLength = Math.max(0, 3_900 - contract.length - marker.length);
  return `${sections.slice(0, headLength).trimEnd()}${marker}${contract}`;
}

function stableItemEvidence(item: CodexThreadItem): string {
  if (item.type === 'fileChange') {
    return `file:${JSON.stringify(item.changes || item.text || '')}`;
  }
  if (item.type === 'commandExecution') {
    const status = String(item.status || '');
    if (/fail|error|interrupt|cancel/i.test(status)) return '';
    return `command:${String(item.command || '')}:${String(item.aggregatedOutput || '').slice(-1_000)}`;
  }
  return '';
}

function hashText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}

export function goalProgressSignature(items: CodexThreadItem[]): string {
  const evidence = [...new Set(items.map(stableItemEvidence).filter(Boolean))].sort();
  return `${evidence.length}:${hashText(evidence.join('\n'))}`;
}

function latestAgentText(items: CodexThreadItem[]): string {
  const item = [...items].reverse().find((candidate) => candidate.type === 'agentMessage');
  return String(item?.text || '').trim();
}

export function createManagedGoalRuntime(items: CodexThreadItem[], now = Date.now()): ManagedGoalRuntime {
  return {
    startedAt: now,
    turnsCompleted: 0,
    noProgressTurns: 0,
    lastProgressSignature: goalProgressSignature(items),
    lastProgressAt: now,
    checkpoint: '',
    stopReason: '',
    nextStep: '',
  };
}

export function advanceManagedGoalRuntime(
  runtime: ManagedGoalRuntime,
  policy: ManagedGoalPolicy,
  items: CodexThreadItem[],
  now = Date.now(),
): ManagedGoalRuntime {
  const signature = goalProgressSignature(items);
  const progressed = signature !== runtime.lastProgressSignature;
  const turnsCompleted = runtime.turnsCompleted + 1;
  const noProgressTurns = progressed ? 0 : runtime.noProgressTurns + 1;
  const elapsedMinutes = (now - runtime.startedAt) / 60_000;
  let stopReason = '';
  let nextStep = '';

  if (noProgressTurns >= policy.noProgressLimit) {
    stopReason = `No measurable file or successful-command progress for ${noProgressTurns} consecutive turns.`;
    nextStep = 'Review the latest blocker report, resolve the named dependency or constraint, then resume the Goal.';
  } else if (turnsCompleted >= policy.maxTurns) {
    stopReason = `The managed Goal reached its ${policy.maxTurns}-turn safety limit.`;
    nextStep = 'Review the checkpoint and explicitly resume with a higher turn limit if the remaining work is still valid.';
  } else if (elapsedMinutes >= policy.maxMinutes) {
    stopReason = `The managed Goal reached its ${policy.maxMinutes}-minute safety limit.`;
    nextStep = 'Review the checkpoint and explicitly resume with more time if continued execution is appropriate.';
  }

  const shouldCheckpoint = progressed || turnsCompleted % policy.checkpointEvery === 0 || Boolean(stopReason);
  const agentSummary = latestAgentText(items);
  const checkpoint = shouldCheckpoint
    ? [
        `Turns completed: ${turnsCompleted}`,
        `Last measurable progress: ${new Date(progressed ? now : runtime.lastProgressAt).toLocaleString()}`,
        agentSummary ? `Latest report:\n${agentSummary.slice(-2_000)}` : '',
      ].filter(Boolean).join('\n')
    : runtime.checkpoint;

  return {
    ...runtime,
    turnsCompleted,
    noProgressTurns,
    lastProgressSignature: signature,
    lastProgressAt: progressed ? now : runtime.lastProgressAt,
    checkpoint,
    stopReason,
    nextStep,
  };
}

export function goalHasTokensRemaining(
  goal: { tokenBudget?: number | null; tokensUsed?: number } | null,
): boolean {
  if (!goal?.tokenBudget) return true;
  return Number(goal.tokensUsed || 0) < goal.tokenBudget;
}
