export type CodexUsageStats = {
  hasData: boolean;
  total: number | null;
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  currentContext: number | null;
  contextLimit: number | null;
  contextRemainingTokens: number | null;
  contextRemainingPercent: number | null;
};

function normalizeUsageOutput(output: string): string {
  return String(output || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '\n');
}

function emptyCodexUsage(): CodexUsageStats {
  return {
    hasData: false,
    total: null,
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    currentContext: null,
    contextLimit: null,
    contextRemainingTokens: null,
    contextRemainingPercent: null,
  };
}

export function parseCodexUsage(output: string): CodexUsageStats {
  const stats = emptyCodexUsage();
  const normalizedOutput = normalizeUsageOutput(output);
  const lines = normalizedOutput.split('\n');
  let found = false;
  const readTokenNumber = (value: string | undefined): number | null => {
    const parsed = Number(String(value || '').replaceAll(',', '').trim());
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  };
  const setObservedValue = (key: string, value: number) => {
    stats.hasData = true;
    switch (key) {
      case 'total':
        stats.total = value;
        break;
      case 'input':
        stats.input = value;
        break;
      case 'cachedInput':
        stats.cachedInput = value;
        break;
      case 'output':
        stats.output = value;
        break;
      case 'reasoning':
        stats.reasoning = value;
        break;
      case 'currentContext':
        stats.currentContext = value;
        break;
      case 'contextLimit':
        stats.contextLimit = value;
        break;
      case 'contextRemainingTokens':
        stats.contextRemainingTokens = value;
        break;
      case 'contextRemainingPercent':
        stats.contextRemainingPercent = value;
        break;
    }
  };
  for (const line of lines) {
    const match = line.match(/^\s*\[CozyPad\]\s+usage\s+(.+)$/i);
    if (!match) continue;
    const values = new Map<string, number>();
    for (const token of (match[1] ?? '').split(/\s+/)) {
      const [key, raw] = token.split('=');
      const value = Number(raw);
      if (key && Number.isFinite(value) && value >= 0) {
        values.set(key.toLowerCase(), Math.floor(value));
      }
    }
    if (values.size === 0) continue;
    found = true;
    stats.hasData = true;
    if (values.has('total')) stats.total = (stats.total ?? 0) + (values.get('total') ?? 0);
    stats.input += values.get('input') ?? 0;
    stats.cachedInput += values.get('cached_input') ?? 0;
    stats.output += values.get('output') ?? 0;
    stats.reasoning += values.get('reasoning') ?? 0;
    if (values.has('context')) stats.currentContext = values.get('context') ?? null;
    if (values.has('context_limit')) stats.contextLimit = values.get('context_limit') ?? null;
    if (values.has('context_remaining')) {
      stats.contextRemainingTokens = values.get('context_remaining') ?? null;
    }
    if (values.has('context_remaining_percent')) {
      stats.contextRemainingPercent = values.get('context_remaining_percent') ?? null;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line || /^unavailable$/i.test(line)) continue;

    const totalInline = line.match(/^(?:total\s+)?tokens\s+used\s*[:：=]?\s*(\d[\d,]*)\s*$/i);
    if (totalInline) {
      const total = readTokenNumber(totalInline[1]);
      if (total !== null) setObservedValue('total', total);
      continue;
    }

    if (/^(?:total\s+)?tokens\s+used\s*[:：=]?\s*$/i.test(line)) {
      const total = readTokenNumber(lines[index + 1]?.trim());
      if (total !== null) setObservedValue('total', total);
      continue;
    }

    const metricMatch = line.match(
      /^(total\s+tokens|input|cached\s+input|output|reasoning|current\s+context|context\s+limit|context\s+remaining)\s*[:：=]?\s*(\d[\d,]*)(?:\s*(%|tokens?))?\s*$/i,
    );
    if (metricMatch) {
      const metricName = (metricMatch[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
      const value = readTokenNumber(metricMatch[2]);
      if (value === null) continue;
      if (metricName === 'total tokens') setObservedValue('total', value);
      if (metricName === 'input') setObservedValue('input', value);
      if (metricName === 'cached input') setObservedValue('cachedInput', value);
      if (metricName === 'output') setObservedValue('output', value);
      if (metricName === 'reasoning') setObservedValue('reasoning', value);
      if (metricName === 'current context') setObservedValue('currentContext', value);
      if (metricName === 'context limit') setObservedValue('contextLimit', value);
      if (metricName === 'context remaining') {
        if ((metricMatch[3] ?? '').trim() === '%') {
          setObservedValue('contextRemainingPercent', value);
        } else {
          setObservedValue('contextRemainingTokens', value);
        }
      }
    }
  }

  const contextPercentMatch = normalizedOutput.match(
    /context\s+remaining\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*%/i,
  );
  if (contextPercentMatch) {
    const percent = Number(contextPercentMatch[1]);
    if (Number.isFinite(percent)) {
      stats.hasData = true;
      stats.contextRemainingPercent = percent;
    }
  }

  if (!found && !stats.hasData) {
    const compactMatch = normalizedOutput.match(
      /(?:usage|tokens\s+used)?\s*[—-]?\s*in\s+(\d[\d,]*)\s*\/\s*out\s+(\d[\d,]*)\s+tokens?/i,
    );
    if (compactMatch) {
      const input = readTokenNumber(compactMatch[1]);
      const outputTokens = readTokenNumber(compactMatch[2]);
      if (input !== null && outputTokens !== null) {
        stats.hasData = true;
        stats.total = input + outputTokens;
        stats.input = input;
        stats.output = outputTokens;
      }
    }
  }
  return stats;
}

export function parseCodexUsageControlMessage(value: string): string | null {
  const text = String(value || '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const message = JSON.parse(text) as { type?: unknown; usage?: unknown };
    if (message.type !== 'cozypad.usage' || typeof message.usage !== 'string') return null;
    return message.usage.trim() || null;
  } catch {
    return null;
  }
}

export function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

export function contextRemainingPercent(stats: CodexUsageStats): number | null {
  if (stats.contextRemainingPercent !== null) {
    const percent =
      stats.contextRemainingPercent <= 1
        ? stats.contextRemainingPercent * 100
        : stats.contextRemainingPercent;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }
  if (stats.contextRemainingTokens !== null && stats.contextLimit && stats.contextLimit > 0) {
    return Math.max(
      0,
      Math.min(100, Math.round((stats.contextRemainingTokens / stats.contextLimit) * 100)),
    );
  }
  if (!stats.contextLimit || stats.contextLimit <= 0 || stats.currentContext === null) return null;
  return Math.max(
    0,
    Math.min(
      100,
      Math.round(((stats.contextLimit - stats.currentContext) / stats.contextLimit) * 100),
    ),
  );
}

export function mergeCodexUsageStats(
  primary: CodexUsageStats,
  secondary: CodexUsageStats,
): CodexUsageStats {
  if (!primary.hasData) return secondary;
  if (!secondary.hasData) return primary;
  return {
    hasData: true,
    total: primary.total ?? secondary.total,
    input: primary.input || secondary.input,
    cachedInput: primary.cachedInput || secondary.cachedInput,
    output: primary.output || secondary.output,
    reasoning: primary.reasoning || secondary.reasoning,
    currentContext: primary.currentContext ?? secondary.currentContext,
    contextLimit: primary.contextLimit ?? secondary.contextLimit,
    contextRemainingTokens: primary.contextRemainingTokens ?? secondary.contextRemainingTokens,
    contextRemainingPercent: primary.contextRemainingPercent ?? secondary.contextRemainingPercent,
  };
}

export function CodexUsageRow({
  stats,
  totalTokens,
  unavailable,
}: {
  stats: CodexUsageStats;
  totalTokens: number;
  unavailable: boolean;
}) {
  const remainingContext = contextRemainingPercent(stats);
  const value = (reported: boolean, number: number) =>
    reported
      ? formatTokenCount(number)
      : unavailable
        ? 'Unavailable'
        : 'Not reported';

  return (
    <div className="legacy-codex-usage-row" aria-label="Codex token usage">
      <div className="legacy-codex-usage-stat legacy-codex-usage-total">
        <span>Total tokens</span>
        <strong>
          {stats.hasData ? formatTokenCount(totalTokens) : unavailable ? 'Unavailable' : 'Not reported'}
        </strong>
      </div>
      <div className="legacy-codex-usage-stat legacy-codex-usage-context">
        <div className="legacy-codex-usage-stat-heading">
          <span>Context remaining</span>
          <strong>
            {stats.hasData && remainingContext !== null
              ? `${remainingContext}%`
              : unavailable
                ? 'Unavailable'
                : 'Not reported'}
          </strong>
          <small>
            {stats.hasData && stats.currentContext !== null
              ? `Used ${stats.currentContext.toLocaleString()} / ${stats.contextLimit?.toLocaleString() || 'unknown'}`
              : stats.hasData && stats.contextRemainingTokens !== null
                ? `Remaining ${stats.contextRemainingTokens.toLocaleString()} tokens`
                : unavailable
                  ? 'CLI did not return usage data'
                  : 'CLI has not reported usage yet'}
          </small>
        </div>
      </div>
      <div className="legacy-codex-usage-stat">
        <span>Input</span>
        <strong>{value(stats.hasData, stats.input)}</strong>
      </div>
      <div className="legacy-codex-usage-stat">
        <span>Cached input</span>
        <strong>{value(stats.hasData, stats.cachedInput)}</strong>
      </div>
      <div className="legacy-codex-usage-stat">
        <span>Output</span>
        <strong>{value(stats.hasData, stats.output)}</strong>
      </div>
      <div className="legacy-codex-usage-stat">
        <span>Reasoning</span>
        <strong>{value(stats.hasData, stats.reasoning)}</strong>
      </div>
      <div className="legacy-codex-usage-stat">
        <span>Current context</span>
        <strong>
          {stats.hasData && stats.currentContext !== null
            ? formatTokenCount(stats.currentContext)
            : unavailable
              ? 'Unavailable'
              : 'Not reported'}
        </strong>
      </div>
    </div>
  );
}
