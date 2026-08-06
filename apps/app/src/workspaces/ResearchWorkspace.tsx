import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  analyzeLegacyResearchFlowchartBatch,
  createLegacyCodexHistory,
  listLegacyServers,
  openLegacyRemoteAgentStream,
  serializeLegacyRemoteAgentStreamPayload,
  type LegacyRemoteAgentStreamKind,
  type LegacyResearchFlowchartBatchResult,
  type LegacyResearchFlowchartMarkdownResponse,
  type LegacySshServer,
} from './agents/legacySshApi';
import { queueCodexTrainingTask, type QueuedTrainingAgent } from './agents/codexTaskQueue';
import { findRememberedLegacyServer } from './sshServerPreference';

const PIPELINE_NODES_STORAGE_KEY = 'cozypad3.researchPipelineNodes.v1';
const PIPELINE_EDGES_STORAGE_KEY = 'cozypad3.researchPipelineEdges.v1';
const RESEARCH_FLOWCHARTS_STORAGE_KEY = 'cozypad3.researchFlowcharts.v2';
const RESEARCH_ACTIVE_FLOWCHART_STORAGE_KEY = 'cozypad3.researchActiveFlowchart.v1';
const RESEARCH_MARKDOWN_STORAGE_KEY = 'cozypad3.researchRemoteMarkdown.v1';
const RESEARCH_MIX_MARKDOWN_STORAGE_KEY = 'cozypad3.researchMixMarkdown.v1';
const RESEARCH_MARKDOWN_BY_FLOWCHART_STORAGE_KEY = 'cozypad3.researchRemoteMarkdownByFlowchart.v1';
const RESEARCH_MIX_MARKDOWN_BY_FLOWCHART_STORAGE_KEY = 'cozypad3.researchMixMarkdownByFlowchart.v1';
const RESEARCH_AGENT_MODEL_STORAGE_KEYS: Partial<Record<ResearchAnalysisAgent, string>> = {
  claude: 'cozypad3.remoteClaude.model.v1',
  codex: 'cozypad3.remoteCodex.model.v1',
  agy: 'cozypad3.remoteAgy.model.v1',
  bailian: 'cozypad3.remoteBailian.model.v1',
};
const RESEARCH_AGENT_MODEL_FALLBACKS: Partial<Record<ResearchAnalysisAgent, string>> = {
  claude: 'opus',
  bailian: 'qwen-plus',
};
const INACCESSIBLE_BAILIAN_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-pro-us', 'deepseek-v4-flash', 'deepseek-v4-flash-us']);
const RESEARCH_MD_ANALYSIS_TIMEOUT_MS = 6 * 60 * 1000;

interface ResearchWorkspaceProps {
  connected?: boolean;
}

type PipelineNodeKind = 'source' | 'operation' | 'model' | 'command' | 'output' | 'application';
type PipelineNodeRole = 'factor' | 'control' | 'runner' | 'outcome' | 'input' | 'application';

type PipelineNode = {
  id: string;
  kind: PipelineNodeKind;
  title: string;
  subtitle: string;
  role: PipelineNodeRole;
  x: number;
  y: number;
};

type PipelinePortSide = 'top' | 'right' | 'bottom' | 'left';

type PipelineEdge = {
  id: string;
  from: string;
  to: string;
  fromSide?: PipelinePortSide;
  toSide?: PipelinePortSide;
};

type ResearchFlowchart = {
  id: string;
  title: string;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  updatedAt: string;
};

type ResearchFlowchartLibrary = {
  flowcharts: ResearchFlowchart[];
  activeFlowchartId: string;
};

type ResearchView = 'flow' | 'markdown' | 'markdownMix';

type ConnectionDraft = {
  from: string;
  fromSide: PipelinePortSide;
  x: number;
  y: number;
  pointerId: number;
};

type NodeMenuState = {
  x: number;
  y: number;
};

type SelectionBoxState = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type DragGroupState = {
  pointerId: number;
  nodeIds: string[];
  startX: number;
  startY: number;
  initial: Record<string, { x: number; y: number }>;
};

type MarkdownAnalysisState = {
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  startedAt?: number;
  elapsedMs?: number;
};

type MixAnalysisFile = {
  id: string;
  title: string;
  fileName: string;
  markdown: string;
  updatedAt: string;
};

type FlowchartMarkdownEntry = {
  markdown: string;
  userDraft: boolean;
  updatedAt: string;
};

type FlowchartMarkdownStore = Record<string, FlowchartMarkdownEntry>;
type FlowchartMixMarkdownStore = Record<string, MixAnalysisFile[]>;

type MixAnalysisTopic = {
  id: string;
  title: string;
  fileName: string;
  instruction: string;
};

type TrainingPromptDialogState = {
  projectName: string;
  datasetLocation: string;
  fileLocation: string;
  epoch: string;
  userPrompt: string;
  otherPrompt: string;
  dataSource: string;
  modelSource: string;
};

type TrainingPromptSource = 'markdown' | 'markdownMix';
type ResearchAnalysisAgent = '' | 'claude' | 'codex' | 'agy' | 'bailian';

const RESEARCH_ANALYSIS_AGENT_LABELS: Record<Exclude<ResearchAnalysisAgent, ''>, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'agy',
  bailian: 'baillian',
};

const TRAINING_AGENT_LABELS: Record<QueuedTrainingAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'agy',
  bailian: 'baillian',
};

function normalizeResearchAgentModel(value: string): string {
  const model = value.trim().slice(0, 80);
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(model) ? model : '';
}

function readResearchAgentModel(agent: ResearchAnalysisAgent): string {
  const storageKey = RESEARCH_AGENT_MODEL_STORAGE_KEYS[agent];
  let model = '';
  if (storageKey) {
    try {
      model = normalizeResearchAgentModel(window.localStorage.getItem(storageKey) || '');
    } catch {
      model = '';
    }
  }
  if (INACCESSIBLE_BAILIAN_MODELS.has(model)) {
    return RESEARCH_AGENT_MODEL_FALLBACKS[agent] || '';
  }
  return model || RESEARCH_AGENT_MODEL_FALLBACKS[agent] || '';
}

type NodeTemplate = {
  label: string;
  kind: PipelineNodeKind;
  title: string;
  subtitle: string;
  role: PipelineNodeRole;
};

type GraphSize = {
  width: number;
  height: number;
};

type GraphPoint = {
  x: number;
  y: number;
};

type CodexDiagramDraft = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
};

const NODE_CARD_WIDTH_PX = 152;
const NODE_CARD_HEIGHT_PX = 88;
const GRAPH_BASE_WIDTH_PX = 1120;
const GRAPH_BASE_HEIGHT_PX = 860;
const GRAPH_COLUMN_WIDTH_PX = 220;
const GRAPH_ROW_HEIGHT_PX = 170;
const GRAPH_EXTRA_PADDING_PX = 180;
const GRAPH_FALLBACK_SIZE: GraphSize = { width: 100, height: 100 };
const NODE_PORT_SIDES: PipelinePortSide[] = ['top', 'right', 'bottom', 'left'];

const NODE_TEMPLATES: NodeTemplate[] = [
  { label: 'Input', kind: 'source', title: 'Input', subtitle: 'Input', role: 'input' },
  { label: 'Output', kind: 'output', title: 'Output', subtitle: 'Output', role: 'outcome' },
  { label: 'Dataset', kind: 'source', title: 'Dataset', subtitle: 'Data source', role: 'input' },
  { label: 'Model', kind: 'model', title: 'Model', subtitle: 'Model', role: 'runner' },
  { label: 'Train', kind: 'command', title: 'Train', subtitle: 'Training step', role: 'runner' },
  { label: 'Evaluate', kind: 'command', title: 'Evaluate', subtitle: 'Evaluation', role: 'outcome' },
  {
    label: 'Application',
    kind: 'application',
    title: 'Application',
    subtitle: 'Application',
    role: 'application',
  },
];

const MIX_ANALYSIS_TOPICS: MixAnalysisTopic[] = [
  {
    id: 'model',
    title: '\u6a21\u578b\u5efa\u8b70',
    fileName: 'model-advice.md',
    instruction:
      '請以研究方法角度分析模型選擇：說明推薦架構、base model、checkpoint strategy 與可比較 baseline，指出模型容量、收斂風險、資料適配性，並提出可驗證的 ablation 與 validation checks。',
  },
  {
    id: 'hyperparameter',
    title: '\u8d85\u53c3\u6578\u5efa\u8b70',
    fileName: 'hyperparameter-advice.md',
    instruction:
      '請針對超參數提出具學術可重現性的建議：涵蓋 batch size、learning rate、optimizer、scheduler、epoch、seed 與 early stopping，說明調整理由、搜尋範圍、風險與建議紀錄的實驗表格欄位。',
  },
  {
    id: 'preprocess',
    title: '\u8cc7\u6599\u524d\u8655\u7406\u5efa\u8b70',
    fileName: 'preprocess-advice.md',
    instruction:
      '請分析資料前處理流程是否足以支撐可靠訓練：檢查 data cleaning、split policy、augmentation、normalization、label consistency 與 dataloader 設計，補充可能偏差、資料洩漏風險與必要的品質檢查。',
  },
  {
    id: 'evaluation',
    title: '\u6a21\u578b\u8a55\u4f30\u5efa\u8b70',
    fileName: 'evaluation-advice.md',
    instruction:
      '請規劃模型評估方案：說明 validation/test setup、主要與輔助 metrics、baseline、ablation、error analysis 與 result artifacts，並指出如何避免過度依賴單一指標，讓結果能支撐論文式比較。',
  },
  {
    id: 'overall',
    title: '\u6574\u9ad4\u5efa\u8b70',
    fileName: 'overall-advice.md',
    instruction:
      '請整合完整流程圖形成研究執行計畫：依序整理訓練流程、相依關係、資源需求、主要風險、檢查點與下一步行動，並用學術實驗觀點說明哪些結果可驗證假設、哪些需要補強。',
  },
];

const MIX_ANALYSIS_MIN_CONCURRENCY = 2;
const MIX_ANALYSIS_MAX_CONCURRENCY = 3;
const MAX_RESEARCH_FLOWCHARTS = 50;

const PIPELINE_NODES: PipelineNode[] = [
  {
    id: 'dataset',
    kind: 'source',
    title: 'Dataset snapshot',
    subtitle: 'Input',
    role: 'input',
    x: 4,
    y: 38,
  },
  {
    id: 'split',
    kind: 'operation',
    title: 'Split dataset',
    subtitle: 'Locked control',
    role: 'control',
    x: 20,
    y: 38,
  },
  {
    id: 'subset',
    kind: 'operation',
    title: 'Select subset',
    subtitle: 'Factor',
    role: 'factor',
    x: 36,
    y: 16,
  },
  {
    id: 'transform',
    kind: 'operation',
    title: 'Transform',
    subtitle: 'Factor',
    role: 'factor',
    x: 52,
    y: 16,
  },
  {
    id: 'model',
    kind: 'model',
    title: 'Build model',
    subtitle: 'Runner',
    role: 'runner',
    x: 68,
    y: 16,
  },
  {
    id: 'train',
    kind: 'command',
    title: 'Train',
    subtitle: 'Runner',
    role: 'runner',
    x: 84,
    y: 16,
  },
  {
    id: 'validation',
    kind: 'operation',
    title: 'Validation / test',
    subtitle: 'Locked control',
    role: 'control',
    x: 36,
    y: 58,
  },
  {
    id: 'evaluate',
    kind: 'command',
    title: 'Evaluate',
    subtitle: 'Outcome',
    role: 'outcome',
    x: 68,
    y: 58,
  },
  {
    id: 'metrics',
    kind: 'output',
    title: 'Metrics + artifacts',
    subtitle: 'Outcome',
    role: 'outcome',
    x: 84,
    y: 58,
  },
];

const DEFAULT_PIPELINE_EDGES: PipelineEdge[] = [
  { id: 'dataset-split', from: 'dataset', to: 'split' },
  { id: 'split-subset', from: 'split', to: 'subset' },
  { id: 'subset-transform', from: 'subset', to: 'transform' },
  { id: 'transform-model', from: 'transform', to: 'model' },
  { id: 'model-train', from: 'model', to: 'train' },
  { id: 'split-validation', from: 'split', to: 'validation' },
  { id: 'validation-evaluate', from: 'validation', to: 'evaluate' },
  { id: 'train-evaluate', from: 'train', to: 'evaluate' },
  { id: 'evaluate-metrics', from: 'evaluate', to: 'metrics' },
];

const NODE_MIN_X = 8;
const NODE_MAX_X = 92;
const NODE_MIN_Y = 8;
const NODE_MAX_Y = 92;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nodeById(nodes: PipelineNode[], id: string): PipelineNode | undefined {
  return nodes.find((node) => node.id === id);
}

function edgeId(from: string, to: string, fromSide: PipelinePortSide = 'right', toSide: PipelinePortSide = 'left'): string {
  return `${from}-${fromSide}-${to}-${toSide}`;
}

function isPipelineNodeKind(value: unknown): value is PipelineNodeKind {
  return (
    value === 'source' ||
    value === 'operation' ||
    value === 'model' ||
    value === 'command' ||
    value === 'output' ||
    value === 'application'
  );
}

function isPipelineNodeRole(value: unknown): value is PipelineNodeRole {
  return (
    value === 'factor' ||
    value === 'control' ||
    value === 'runner' ||
    value === 'outcome' ||
    value === 'input' ||
    value === 'application'
  );
}

function isPipelinePortSide(value: unknown): value is PipelinePortSide {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

function normalizeNodeLabel(value: unknown, fallback: string): string {
  const label = typeof value === 'string' ? value.trim() : '';
  return label || fallback;
}

function createNodeId(title: string, existingNodes: PipelineNode[]): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'node';
  const used = new Set(existingNodes.map((node) => node.id));
  let index = 1;
  let id = base;
  while (used.has(id)) {
    index += 1;
    id = `${base}-${index}`;
  }
  return id;
}

function sanitizeNodeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node'
  );
}

function inferPipelineNodeKind(title: string, fallback: unknown): PipelineNodeKind {
  if (isPipelineNodeKind(fallback)) return fallback;
  if (/input|dataset|data|source/i.test(title)) return 'source';
  if (/model|checkpoint|weight/i.test(title)) return 'model';
  if (/train|fit|evaluate|eval|command|run/i.test(title)) return 'command';
  if (/output|metric|artifact|result|report/i.test(title)) return 'output';
  if (/app|deploy|service|application/i.test(title)) return 'application';
  return 'operation';
}

function inferPipelineNodeRole(title: string, kind: PipelineNodeKind, fallback: unknown): PipelineNodeRole {
  if (isPipelineNodeRole(fallback)) return fallback;
  if (kind === 'source') return 'input';
  if (kind === 'model' || kind === 'command') return 'runner';
  if (kind === 'output') return 'outcome';
  if (kind === 'application') return 'application';
  if (/select|ablation|factor|variant|augment|transform/i.test(title)) return 'factor';
  return 'control';
}

function normalizeDiagramPercent(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  const normalizedFallback = Math.round(clamp(fallback, min, max) * 10) / 10;
  if (!Number.isFinite(number)) return normalizedFallback;
  const percent = Math.abs(number) <= 1 ? number * 100 : number;
  if (percent < min || percent > max) return normalizedFallback;
  return Math.round(clamp(percent, min, max) * 10) / 10;
}

function graphColumnCount(nodeCount: number): number {
  if (nodeCount <= 0) return 1;
  return Math.min(8, Math.max(3, Math.ceil(Math.sqrt(nodeCount * 1.25))));
}

function graphRowCount(nodeCount: number): number {
  return Math.max(1, Math.ceil(Math.max(1, nodeCount) / graphColumnCount(nodeCount)));
}

function fallbackDiagramPoint(index: number, nodeCount: number): GraphPoint {
  const columns = graphColumnCount(nodeCount);
  const rows = graphRowCount(nodeCount);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const xRange = NODE_MAX_X - NODE_MIN_X;
  const yRange = NODE_MAX_Y - NODE_MIN_Y;
  const x = columns <= 1 ? 50 : NODE_MIN_X + (xRange * column) / (columns - 1);
  const y = rows <= 1 ? 50 : NODE_MIN_Y + (yRange * row) / (rows - 1);
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

function graphCanvasPixels(nodeCount: number): GraphSize {
  const columns = graphColumnCount(nodeCount);
  const rows = graphRowCount(nodeCount);
  return {
    width: Math.max(GRAPH_BASE_WIDTH_PX, columns * GRAPH_COLUMN_WIDTH_PX + GRAPH_EXTRA_PADDING_PX),
    height: Math.max(GRAPH_BASE_HEIGHT_PX, rows * GRAPH_ROW_HEIGHT_PX + GRAPH_EXTRA_PADDING_PX),
  };
}

function spreadCrowdedBoundaryNodes(nodes: PipelineNode[]): PipelineNode[] {
  if (nodes.length < 12) return nodes;
  const bottomCount = nodes.filter((node) => node.y >= NODE_MAX_Y - 0.1).length;
  const rightCount = nodes.filter((node) => node.x >= NODE_MAX_X - 0.1).length;
  const crowdedThreshold = Math.max(4, Math.ceil(nodes.length * 0.25));
  if (bottomCount < crowdedThreshold && rightCount < crowdedThreshold) return nodes;
  return nodes.map((node, index) => {
    const fallbackPoint = fallbackDiagramPoint(index, nodes.length);
    return {
      ...node,
      x: fallbackPoint.x,
      y: fallbackPoint.y,
    };
  });
}

function tryParseJsonValue(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function cleanAgentJsonOutput(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .trim();
}

function previewAgentOutput(value: string): string {
  return cleanAgentJsonOutput(value)
    .replace(/\s+/g, ' ')
    .slice(0, 220)
    .trim();
}

function balancedJsonCandidates(value: string): unknown[] {
  const candidates: unknown[] = [];
  for (let start = 0; start < value.length; start += 1) {
    const first = value[start];
    if (first !== '{' && first !== '[') continue;

    const stack: string[] = [first === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        stack.push(char === '{' ? '}' : ']');
        continue;
      }
      if (char === '}' || char === ']') {
        if (stack[stack.length - 1] !== char) break;
        stack.pop();
        if (stack.length === 0) {
          const parsed = tryParseJsonValue(value.slice(start, index + 1));
          if (parsed.ok) candidates.push(parsed.value);
          start = index;
          break;
        }
      }
    }
  }
  return candidates.slice(0, 80);
}

function codexEventTextCandidates(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const item = record.item && typeof record.item === 'object' ? (record.item as Record<string, unknown>) : {};
  const rawCandidates = [
    record.text,
    record.message,
    record.output,
    record.content,
    item.text,
    item.message,
    item.output,
    item.content,
  ];
  return rawCandidates.filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
}

function extractJsonPayloadCandidates(value: string): unknown[] {
  const trimmed = cleanAgentJsonOutput(value);
  if (!trimmed) {
    throw new Error('Paste diagram JSON first.');
  }

  const candidates: unknown[] = [];
  const seenText = new Set<string>();
  const seenJson = new Set<string>();

  const pushValue = (parsed: unknown) => {
    const key = JSON.stringify(parsed);
    if (!seenJson.has(key)) {
      seenJson.add(key);
      candidates.push(parsed);
    }
    for (const text of codexEventTextCandidates(parsed)) pushText(text);
  };

  const pushText = (candidate: string) => {
    const text = candidate.trim();
    if (!text || seenText.has(text)) return;
    seenText.add(text);

    const exact = tryParseJsonValue(text);
    if (exact.ok) pushValue(exact.value);
    for (const parsed of balancedJsonCandidates(text)) pushValue(parsed);

    for (const line of text.split(/\r?\n/)) {
      const parsedLine = tryParseJsonValue(line.trim());
      if (parsedLine.ok) pushValue(parsedLine.value);
    }
  };

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) pushText(match[1]);
  }
  pushText(trimmed);

  if (candidates.length === 0) {
    const preview = previewAgentOutput(trimmed);
    throw new Error(
      preview
        ? `Diagram output is not valid JSON. Received: ${preview}`
        : 'Diagram output is not valid JSON.',
    );
  }
  return candidates;
}

function parseCodexDiagramDraft(value: string): CodexDiagramDraft {
  const candidates = extractJsonPayloadCandidates(value);
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      return parseCodexDiagramDraftPayload(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Diagram output is not valid JSON.');
    }
  }
  throw lastError || new Error('Diagram output is not valid JSON.');
}

function parseCodexDiagramDraftPayload(parsed: unknown): CodexDiagramDraft {
  const payload = parsed as {
    diagram?: unknown;
    flowchart?: unknown;
    nodes?: unknown;
    edges?: unknown;
  };
  const root =
    payload && typeof payload === 'object' && 'diagram' in payload
      ? (payload.diagram as { nodes?: unknown; edges?: unknown })
      : payload && typeof payload === 'object' && 'flowchart' in payload
        ? (payload.flowchart as { nodes?: unknown; edges?: unknown })
        : payload;
  const rawNodes = root && typeof root === 'object' && Array.isArray((root as { nodes?: unknown }).nodes)
    ? ((root as { nodes: unknown[] }).nodes)
    : [];

  if (rawNodes.length === 0) {
    throw new Error('Diagram JSON must contain at least one node.');
  }

  const usedIds = new Set<string>();
  const rawIdToId = new Map<string, string>();
  const titleToId = new Map<string, string>();
  const nodes: PipelineNode[] = [];

  const diagramNodes = rawNodes.slice(0, 60);
  diagramNodes.forEach((item, index) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const title = normalizeNodeLabel(record.title ?? record.label ?? record.name, `Node ${index + 1}`);
    const kind = inferPipelineNodeKind(title, record.kind ?? record.type);
    const role = inferPipelineNodeRole(title, kind, record.role);
    const rawId = typeof record.id === 'string' ? record.id.trim() : '';
    const baseId = sanitizeNodeId(rawId || title);
    let id = baseId;
    let suffix = 1;
    while (usedIds.has(id)) {
      suffix += 1;
      id = `${baseId}-${suffix}`;
    }
    usedIds.add(id);
    if (rawId) rawIdToId.set(rawId, id);
    rawIdToId.set(id, id);
    titleToId.set(title, id);
    const fallbackPoint = fallbackDiagramPoint(index, diagramNodes.length);
    nodes.push({
      id,
      kind,
      title,
      subtitle: normalizeNodeLabel(record.subtitle ?? record.note ?? record.description, kind),
      role,
      x: normalizeDiagramPercent(record.x, fallbackPoint.x, NODE_MIN_X, NODE_MAX_X),
      y: normalizeDiagramPercent(record.y, fallbackPoint.y, NODE_MIN_Y, NODE_MAX_Y),
    });
  });

  const nodeIds = new Set(nodes.map((node) => node.id));
  const rawEdges = root && typeof root === 'object' && Array.isArray((root as { edges?: unknown }).edges)
    ? ((root as { edges: unknown[] }).edges)
    : [];
  const usedEdges = new Set<string>();
  const edges: PipelineEdge[] = [];

  const resolveRef = (value: unknown): string => {
    const key = String(value || '').trim();
    return rawIdToId.get(key) || titleToId.get(key) || sanitizeNodeId(key);
  };

  rawEdges.forEach((item) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const from = resolveRef(record.from ?? record.source ?? record.fromId ?? record.sourceId);
    const to = resolveRef(record.to ?? record.target ?? record.toId ?? record.targetId);
    if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) return;
    const fromSide = isPipelinePortSide(record.fromSide) ? record.fromSide : 'right';
    const toSide = isPipelinePortSide(record.toSide) ? record.toSide : 'left';
    const id = edgeId(from, to, fromSide, toSide);
    if (usedEdges.has(id)) return;
    usedEdges.add(id);
    edges.push({ id, from, to, fromSide, toSide });
  });

  if (edges.length === 0 && nodes.length > 1) {
    const sortedNodes = [...nodes].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    sortedNodes.slice(0, -1).forEach((node, index) => {
      const nextNode = sortedNodes[index + 1];
      if (!nextNode) return;
      const id = edgeId(node.id, nextNode.id);
      edges.push({ id, from: node.id, to: nextNode.id, fromSide: 'right', toSide: 'left' });
    });
  }

  return { nodes, edges };
}

function describeDiagramDraftError(error: unknown, agentLabel = 'Agent'): string {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  if (normalized.includes('paste diagram json first')) {
    return 'Please paste Diagram JSON first, or use Agent Draw to generate one.';
  }
  if (normalized.includes('must contain at least one node')) {
    return `${agentLabel} did not return usable Diagram nodes. Ask it to output JSON with a non-empty "nodes" array, or paste valid Diagram JSON in Advanced JSON.`;
  }
  if (normalized.includes('not valid json')) {
    return `${agentLabel} did not return valid Diagram JSON. Try a more direct prompt, for example: "Return only JSON with nodes and edges."`;
  }
  return message || `${agentLabel} diagram drawing failed.`;
}

function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function readResearchMarkdown(): string {
  try {
    return window.localStorage.getItem(RESEARCH_MARKDOWN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function normalizeFlowchartMarkdownEntry(value: unknown): FlowchartMarkdownEntry {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    markdown: typeof record.markdown === 'string' ? record.markdown : '',
    userDraft: typeof record.userDraft === 'boolean' ? record.userDraft : typeof record.markdown === 'string' && record.markdown.length > 0,
    updatedAt:
      typeof record.updatedAt === 'string' && record.updatedAt.trim()
        ? record.updatedAt
        : new Date().toISOString(),
  };
}

function readResearchMarkdownByFlowchart(activeFlowchartId: string): FlowchartMarkdownStore {
  const byFlowchart: FlowchartMarkdownStore = {};
  try {
    const raw = window.localStorage.getItem(RESEARCH_MARKDOWN_BY_FLOWCHART_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [flowchartId, value] of Object.entries(parsed)) {
        if (!flowchartId.trim()) continue;
        byFlowchart[flowchartId] = normalizeFlowchartMarkdownEntry(value);
      }
    }
  } catch {
    // Fall through to legacy fallback below.
  }

  if (activeFlowchartId && !byFlowchart[activeFlowchartId]) {
    const legacyMarkdown = readResearchMarkdown();
    if (legacyMarkdown) {
      byFlowchart[activeFlowchartId] = {
        markdown: legacyMarkdown,
        userDraft: true,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  return byFlowchart;
}

function markdownEntryForFlowchart(
  byFlowchart: FlowchartMarkdownStore,
  flowchartId: string,
): FlowchartMarkdownEntry {
  return byFlowchart[flowchartId] || { markdown: '', userDraft: false, updatedAt: new Date().toISOString() };
}

function readResearchMixMarkdown(): MixAnalysisFile[] {
  try {
    const raw = window.localStorage.getItem(RESEARCH_MIX_MARKDOWN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return sortMixMarkdownFiles(
      parsed
      .map((item): MixAnalysisFile | null => {
        if (!item || typeof item.id !== 'string' || typeof item.markdown !== 'string') return null;
        const topic = MIX_ANALYSIS_TOPICS.find((candidate) => candidate.id === item.id);
        return {
          id: item.id,
          title: typeof item.title === 'string' && item.title.trim() ? item.title : topic?.title || item.id,
          fileName:
            typeof item.fileName === 'string' && item.fileName.trim()
              ? item.fileName
              : topic?.fileName || `${item.id}.md`,
          markdown: item.markdown,
          updatedAt:
            typeof item.updatedAt === 'string' && item.updatedAt.trim()
              ? item.updatedAt
              : new Date().toISOString(),
        };
      })
      .filter((item): item is MixAnalysisFile => item !== null),
    );
  } catch {
    return [];
  }
}

function normalizeMixMarkdownFiles(value: unknown): MixAnalysisFile[] {
  if (!Array.isArray(value)) return [];
  return sortMixMarkdownFiles(
    value
      .map((item): MixAnalysisFile | null => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        if (typeof record.id !== 'string' || typeof record.markdown !== 'string') return null;
        const topic = MIX_ANALYSIS_TOPICS.find((candidate) => candidate.id === record.id);
        return {
          id: record.id,
          title:
            typeof record.title === 'string' && record.title.trim()
              ? record.title
              : topic?.title || record.id,
          fileName:
            typeof record.fileName === 'string' && record.fileName.trim()
              ? record.fileName
              : topic?.fileName || `${record.id}.md`,
          markdown: record.markdown,
          updatedAt:
            typeof record.updatedAt === 'string' && record.updatedAt.trim()
              ? record.updatedAt
              : new Date().toISOString(),
        };
      })
      .filter((item): item is MixAnalysisFile => item !== null),
  );
}

function readResearchMixMarkdownByFlowchart(activeFlowchartId: string): FlowchartMixMarkdownStore {
  const byFlowchart: FlowchartMixMarkdownStore = {};
  try {
    const raw = window.localStorage.getItem(RESEARCH_MIX_MARKDOWN_BY_FLOWCHART_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [flowchartId, value] of Object.entries(parsed)) {
        if (!flowchartId.trim()) continue;
        byFlowchart[flowchartId] = normalizeMixMarkdownFiles(value);
      }
    }
  } catch {
    // Fall through to legacy fallback below.
  }

  if (activeFlowchartId && !byFlowchart[activeFlowchartId]) {
    const legacyMix = readResearchMixMarkdown();
    if (legacyMix.length) byFlowchart[activeFlowchartId] = legacyMix;
  }

  return byFlowchart;
}

function sortMixMarkdownFiles(files: MixAnalysisFile[]): MixAnalysisFile[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  return MIX_ANALYSIS_TOPICS.map((topic) => byId.get(topic.id)).filter(
    (file): file is MixAnalysisFile => Boolean(file),
  );
}

function hasUsableMixMarkdown(file: MixAnalysisFile | undefined): boolean {
  return Boolean(file?.markdown.trim());
}

function upsertMixMarkdownFiles(current: MixAnalysisFile[], incoming: MixAnalysisFile[]): MixAnalysisFile[] {
  const byId = new Map(current.map((file) => [file.id, file]));
  for (const file of incoming) {
    byId.set(file.id, file);
  }
  return sortMixMarkdownFiles([...byId.values()]);
}

function buildMixTrainingMarkdown(files: MixAnalysisFile[]): string {
  const byId = new Map(files.map((file) => [file.id, file]));
  return MIX_ANALYSIS_TOPICS.map((topic) => {
    const file = byId.get(topic.id);
    const markdown = file?.markdown.trim();
    if (!markdown) return '';
    return [
      `# ${topic.title}`,
      '',
      `File: ${file?.fileName || topic.fileName}`,
      '',
      markdown,
    ].join('\n');
  })
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function markdownFromAnalysisResult(result: LegacyResearchFlowchartMarkdownResponse): string {
  if (typeof result.markdown === 'string') return result.markdown;
  if (typeof result.summary === 'string') return result.summary;
  if (typeof result.content === 'string') return result.content;
  if (typeof result.result === 'string') return result.result;
  return '';
}

function markdownFromBatchResultItem(result: LegacyResearchFlowchartBatchResult | undefined): string {
  if (!result) return '';
  if (typeof result.markdown === 'string') return result.markdown;
  if (typeof result.summary === 'string') return result.summary;
  if (typeof result.content === 'string') return result.content;
  if (typeof result.result === 'string') return result.result;
  return '';
}

function batchItemsFromAnalysisResult(
  result: LegacyResearchFlowchartMarkdownResponse,
): LegacyResearchFlowchartBatchResult[] {
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.results)) return result.results;
  return [];
}

function clampMixAnalysisConcurrency(value: number): number {
  if (!Number.isFinite(value)) return MIX_ANALYSIS_MIN_CONCURRENCY;
  return Math.max(
    MIX_ANALYSIS_MIN_CONCURRENCY,
    Math.min(MIX_ANALYSIS_MAX_CONCURRENCY, Math.floor(value)),
  );
}

function mixConcurrencyFromAnalysisResult(
  result?: LegacyResearchFlowchartMarkdownResponse,
): number {
  if (!result) return MIX_ANALYSIS_MIN_CONCURRENCY;
  const candidates = [
    result.concurrency,
    result.idleGpuCount,
    result.availableGpuCount,
    result.freeGpuCount,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return clampMixAnalysisConcurrency(candidate);
    }
  }
  return MIX_ANALYSIS_MIN_CONCURRENCY;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatNodeReference(node: PipelineNode): string {
  return node.subtitle && node.subtitle !== node.title
    ? `${node.title} - ${node.subtitle}`
    : node.title;
}

function inferDataSourceFromNodes(nodes: PipelineNode[]): string {
  return nodes
    .filter((node) => node.role === 'input' || node.kind === 'source' || /data|dataset|input/i.test(node.title))
    .map(formatNodeReference)
    .filter(Boolean)
    .join('\n');
}

function inferModelSourceFromNodes(nodes: PipelineNode[]): string {
  return nodes
    .filter((node) => node.kind === 'model' || /model|checkpoint|weight/i.test(node.title))
    .map(formatNodeReference)
    .filter(Boolean)
    .join('\n');
}

function markdownLinesMatching(markdown: string, pattern: RegExp, limit = 6): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s\d.]+/, '').trim())
    .filter((line) => line && pattern.test(line))
    .slice(0, limit)
    .join('\n');
}

function inferDataSourceFromMarkdownAndNodes(markdown: string, nodes: PipelineNode[]): string {
  return [
    inferDataSourceFromNodes(nodes),
    markdownLinesMatching(markdown, /dataset|data source|資料|數據|訓練集|validation|test|split|label|標註|\/ssd|\/home/i),
  ]
    .filter(Boolean)
    .join('\n');
}

function inferModelSourceFromMarkdownAndNodes(markdown: string, nodes: PipelineNode[]): string {
  return [
    inferModelSourceFromNodes(nodes),
    markdownLinesMatching(markdown, /model|checkpoint|weight|backbone|base model|模型|權重|架構|\/ssd|\/home/i),
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAutoTrainingUserPrompt(
  markdown: string,
  nodes: PipelineNode[],
  _edges: PipelineEdge[],
  sourceLabel: string,
): string {
  const inputNodes = nodes.filter((node) => node.role === 'input' || node.kind === 'source');
  const runnerNodes = nodes.filter((node) => node.role === 'runner' || node.kind === 'command' || node.kind === 'model');
  const outputNodes = nodes.filter((node) => node.role === 'outcome' || node.kind === 'output');
  const stageSummary = nodes
    .map((node) => `${node.title}${node.subtitle && node.subtitle !== node.title ? ` (${node.subtitle})` : ''}`)
    .slice(0, 12)
    .join(' -> ');
  const markdownHints = markdownLinesMatching(
    markdown,
    /train|epoch|metric|accuracy|loss|dataset|model|checkpoint|log|result|gpu|batch|learning rate|lr|訓練|模型|資料|指標|紀錄|結果/i,
    8,
  );

  return [
    `請依照 ${sourceLabel} 自動建立並執行訓練任務。`,
    '',
    '目標：先確認專案能安全啟動訓練流程，再以 early stopping 為訓練停止策略執行，最後整理可驗證的 metric、log、result 與後續修正建議。',
    '',
    '執行要求：',
    '1. 先檢查目前工作目錄、README、設定檔、訓練入口、資料路徑與既有輸出資料夾。',
    '2. 優先使用專案或 Markdown 既有的 early stopping 設定；若未指定，先提出需要確認的 monitor metric、patience、min_delta 與 checkpoint 規則。',
    '3. 訓練前確認 GPU、CUDA、Python/conda 環境與必要套件。',
    '4. 保存 stdout/stderr、train log、metric/result 檔案與重要 command。',
    '5. 回覆時列出執行命令、修改檔案、主要結果、失敗原因與下一步。',
    '',
    '流程圖重點：',
    stageSummary || '請依照 Diagram 和 Markdown 自行判斷流程。',
    '',
    inputNodes.length ? `資料相關節點：${inputNodes.map(formatNodeReference).join('；')}` : '資料來源請從 Markdown 與專案檔案推斷。',
    runnerNodes.length ? `模型/訓練相關節點：${runnerNodes.map(formatNodeReference).join('；')}` : '模型與訓練入口請從 Markdown 與專案檔案推斷。',
    outputNodes.length ? `輸出相關節點：${outputNodes.map(formatNodeReference).join('；')}` : '輸出結果請保存到合理的 result/log 位置。',
    '',
    markdownHints ? `Markdown 摘要線索：\n${markdownHints}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildTrainingPromptFromMarkdown(
  markdown: string,
  nodes: PipelineNode[],
  _edges: PipelineEdge[],
  options: Partial<TrainingPromptDialogState> = {},
): string {
  const projectName = options.projectName?.trim();
  const datasetLocation = options.datasetLocation?.trim();
  const fileLocation = options.fileLocation?.trim();
  const epoch = options.epoch?.trim();
  const userPrompt = options.userPrompt?.trim();
  const otherPrompt = options.otherPrompt?.trim();
  const dataSource = options.dataSource?.trim();
  const modelSource = options.modelSource?.trim();
  const nodeSummary = nodes
    .slice(0, 20)
    .map((node, index) =>
      `${index + 1}. ${node.title}${node.subtitle && node.subtitle !== node.title ? ` (${node.subtitle})` : ''} - ${node.kind}/${node.role}`,
    )
    .join('\n');
  return [
    'Start Training',
    '',
    'Use the Markdown below as the primary training schedule. Follow the project name, dataset location, file location, user prompt, data source, and model source. Work on the selected remote server.',
    '',
    '## Project Name',
    '',
    projectName || 'Infer a safe project folder name from MD.md. If unclear, ask before creating folders.',
    '',
    '## Dataset Location',
    '',
    datasetLocation || 'Infer the dataset location from MD.md, Data Source, and the project files. If unclear, ask before training.',
    '',
    '## File Location',
    '',
    fileLocation || 'Use the selected SSH server default path as the save/output location. If unclear, ask before writing files.',
    '',
    '## Epoch',
    '',
    epoch || 'No fixed epoch target was provided. Use early stopping and the project default maximum epoch setting.',
    '',
    '## User Prompt',
    '',
    userPrompt || 'Use the Markdown plan, inspect the project, train with early stopping, and report metrics plus required logs.',
    ...(otherPrompt ? ['', '## Other Prompt', '', otherPrompt] : []),
    '',
    '## Data Source',
    '',
    dataSource || 'Infer from Dataset Location, MD.md, and the flowchart. If unclear, inspect the project and ask before destructive work.',
    '',
    '## Model Source',
    '',
    modelSource || 'Infer from MD.md and the flowchart. Check model config, checkpoint, and training script before running.',
    '',
    '## Execution Rules',
    '',
    '1. Work only on the selected SSH server.',
    '2. Use File Location as the save/output location. Create it if missing. If Project Name is also provided and File Location is a parent/root path, create or reuse a dedicated Project Name folder under it.',
    '3. If File Location or Project Name contains unsafe filesystem characters, normalize them and report the final output folder path.',
    '4. Use Dataset Location as the primary dataset path. If it points to a file, inspect the parent folder too.',
    '5. Inspect README, config, dataset notes, and existing logs/results before training.',
    '6. Use early stopping as the stopping strategy. If Epoch is provided, treat it as the maximum epoch budget, not as a short dry-run request.',
    '7. Reuse existing monitor metric, patience, min_delta, and checkpoint settings when present; if missing, report the needed early-stop parameters before running.',
    '8. Run the actual training command inside a GNU screen session. Use a deterministic screen name derived from Project Name, and record the screen name plus log path.',
    '9. If screen is not available, stop and report the blocker; do not run training directly outside screen.',
    '10. After training completes, or if any error stops the run, always close/terminate the screen session before finishing the task. Do not leave detached screen sessions alive.',
    '11. Save stdout/stderr, screen logs, and result metrics to the project output directory before closing the screen session.',
    '12. Report changed files, commands, screen session name, metrics, and next actions.',
    '',
    '## Markdown Plan',
    '',
    markdown,
    '',
    '## Diagram Summary',
    '',
    nodeSummary ? `Nodes:\n${nodeSummary}` : 'No diagram nodes were provided.',
  ].join('\n');
}

function describeFlowchartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || 'flowchart analysis failed.');
  const message = raw.replace(/\s+/g, ' ').trim();
  if (/bailian api request failed/i.test(message)) {
    return message;
  }
  if (/cuda out of memory|not enough eligible gpu memory|eligible gpu|--min-gpus|gpu memory|out of memory/i.test(message)) {
    return 'Flowchart analysis resources are not available. Try again later.';
  }
  if (/timeout|timed out|waiting/i.test(message)) {
    return 'Flowchart analysis timed out. Check the selected agent, API key, model, and network path.';
  }
  if (/^(?:batch endpoint returned HTTP\s*)?403\b|HTTP 403\b|\(403\)/i.test(message)) {
    return `${message} Check that the imported key has permission for the selected model and that Cloudflare is not blocking /api/* POST.`;
  }
  return message || 'flowchart analysis failed.';
}

function shouldSilenceFlowchartFallbackError(message: string): boolean {
  return /connection closed by .+ port \d+|read from remote host|kex_exchange_identification|getsockname failed|not a socket/i.test(
    message,
  );
}

function flowchartToLocalMarkdown(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  note: string,
  reason = '',
): string {
  const nodeLines = nodes.map((node, index) => {
    const inputs = edges.filter((edge) => edge.to === node.id).length;
    const outputs = edges.filter((edge) => edge.from === node.id).length;
    return `${index + 1}. **${node.title}** (${node.subtitle || node.kind}) - role: ${node.role}, inputs: ${inputs}, outputs: ${outputs}`;
  });
  const inputNodes = nodes.filter((node) => !edges.some((edge) => edge.to === node.id));
  const outputNodes = nodes.filter((node) => !edges.some((edge) => edge.from === node.id));

  return [
    '# Training Flowchart Draft',
    '',
    reason ? `> ${reason}` : null,
    reason ? '' : null,
    '## Overview',
    '',
    `The current diagram has ${nodes.length} nodes.`,
    inputNodes.length
      ? `Primary inputs: ${inputNodes.map((node) => node.title).join(', ')}.`
      : 'Primary inputs: none selected.',
    outputNodes.length
      ? `Primary outputs: ${outputNodes.map((node) => node.title).join(', ')}.`
      : 'Primary outputs: none selected.',
    '',
    '## Nodes',
    '',
    ...(nodeLines.length ? nodeLines : ['No nodes yet.']),
    '',
    '## Training Notes',
    '',
    '- Confirm the dataset source, splits, and labels before training.',
    '- Confirm model checkpoints, training command, and expected outputs.',
    '- Before executing, verify compute availability and output log paths.',
    '',
    note.trim() ? '## Extra Notes' : null,
    note.trim() ? '' : null,
    note.trim() || null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function flowchartJsonForAgentPrompt(nodes: PipelineNode[], edges: PipelineEdge[]): string {
  return JSON.stringify(
    {
      nodes: nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        title: node.title,
        subtitle: node.subtitle,
        role: node.role,
        x: node.x,
        y: node.y,
        inputs: edges.filter((edge) => edge.to === node.id).length,
        outputs: edges.filter((edge) => edge.from === node.id).length,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        fromTitle: nodeById(nodes, edge.from)?.title || edge.from,
        toTitle: nodeById(nodes, edge.to)?.title || edge.to,
      })),
    },
    null,
    2,
  );
}

function buildAgentFlowchartMarkdownPrompt(
  nodes: PipelineNode[],
  edges: PipelineEdge[],
  instruction: string,
): string {
  return [
    'You are analyzing a CozyPad research flowchart.',
    'Return only Markdown for MD.md. Do not include JSON unless it is inside a fenced code block.',
    '',
    'Required content: training schedule, checkpoints, required logs, metrics, risk notes, and concrete next actions.',
    '',
    'Instruction:',
    instruction,
    '',
    'Local draft context:',
    flowchartToLocalMarkdown(nodes, edges, '', ''),
    '',
    'Flowchart JSON:',
    '```json',
    flowchartJsonForAgentPrompt(nodes, edges),
    '```',
  ].join('\n');
}

function buildAgentAllMixFlowchartPrompt(
  topics: MixAnalysisTopic[],
  nodes: PipelineNode[],
  edges: PipelineEdge[],
): string {
  return [
    'You are generating MD.mix Markdown files from a CozyPad research flowchart.',
    'Return only Markdown. Generate exactly the requested files below.',
    'Wrap every file with the exact HTML markers shown here so CozyPad can import the result automatically.',
    '',
    'Output format for each file:',
    '<!-- COZYPAD_MIX_FILE id="topic-id" fileName="topic-file.md" -->',
    '# Topic title',
    '',
    'Markdown content here.',
    '<!-- /COZYPAD_MIX_FILE -->',
    '',
    'Requested files:',
    ...topics.flatMap((topic, index) => [
      `${index + 1}. id="${topic.id}" fileName="${topic.fileName}" title="${topic.title}"`,
      topic.instruction,
      '',
    ]),
    'Each file should be about 500 Chinese characters and include concrete research/training recommendations.',
    'Do not combine files. Do not omit markers. Do not return raw JSON.',
    '',
    'Flowchart JSON:',
    '```json',
    flowchartJsonForAgentPrompt(nodes, edges),
    '```',
  ].join('\n');
}

function buildAgentDiagramJsonPrompt(
  prompt: string,
  nodes: PipelineNode[],
  edges: PipelineEdge[],
): string {
  return [
    'You are a JSON-only diagram generator for CozyPad.',
    'Do not inspect files. Do not run tools. Do not ask follow-up questions.',
    'Your entire response must be one raw valid JSON object. Do not use Markdown fences, bullets, comments, or prose.',
    'The JSON shape must be exactly: {"nodes":[...],"edges":[...]}.',
    'The nodes array must contain at least one node. Never return an empty nodes array or an empty object.',
    'Each node must include id, title, kind, role, x, y. x/y are percentages from 0 to 100.',
    'Allowed kinds: source, operation, model, command, output, application.',
    'Allowed roles: factor, control, runner, outcome, input, application.',
    'Each edge must include from and to, referencing node ids.',
    'Use short lowercase ASCII node ids.',
    'Prefer a readable left-to-right workflow. Keep x/y between 8 and 92.',
    'If the request is ambiguous, still return a reasonable diagram JSON object.',
    '',
    'Example response shape:',
    '{"nodes":[{"id":"dataset","title":"Dataset","kind":"source","role":"input","x":12,"y":35}],"edges":[]}',
    '',
    'User request:',
    prompt,
    '',
    'Current diagram JSON:',
    '```json',
    flowchartJsonForAgentPrompt(nodes, edges),
    '```',
  ].join('\n');
}

function markdownFromAgentOutput(output: string): string {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  return (fenced?.[1] || trimmed).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseMixMarkdownFilesFromAgentOutput(
  output: string,
  topics: MixAnalysisTopic[],
): MixAnalysisFile[] {
  const markdown = markdownFromAgentOutput(output);
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const files: MixAnalysisFile[] = [];
  const markerPattern =
    /<!--\s*COZYPAD_MIX_FILE\s+id=["']?([A-Za-z0-9_-]+)["']?(?:\s+fileName=["']?([^"'\s>]+)["']?)?.*?-->\s*([\s\S]*?)<!--\s*\/COZYPAD_MIX_FILE\s*-->/gi;
  let markerMatch: RegExpExecArray | null;
  while ((markerMatch = markerPattern.exec(markdown)) !== null) {
    const topicId = markerMatch[1] || '';
    const topic = byId.get(topicId);
    const fileMarkdown = String(markerMatch[3] || '').trim();
    if (!topic || !fileMarkdown) continue;
    files.push({
      id: topic.id,
      title: topic.title,
      fileName: topic.fileName,
      markdown: fileMarkdown,
      updatedAt: new Date().toISOString(),
    });
  }
  if (files.length > 0) return sortMixMarkdownFiles(files);

  const headings: Array<{ topic: MixAnalysisTopic; index: number }> = [];
  for (const topic of topics) {
    const pattern = new RegExp(
      `^#{1,6}\\s*(?:\\d+[.)]\\s*)?(?:${escapeRegExp(topic.fileName)}|${escapeRegExp(topic.title)})(?:\\s|$|[:：-])`,
      'gmi',
    );
    const match = pattern.exec(markdown);
    if (match) headings.push({ topic, index: match.index });
  }
  headings.sort((a, b) => a.index - b.index);
  if (headings.length === 0 && topics.length === 1 && markdown.trim()) {
    const [topic] = topics;
    if (!topic) return [];
    return [{
      id: topic.id,
      title: topic.title,
      fileName: topic.fileName,
      markdown: markdown.trim(),
      updatedAt: new Date().toISOString(),
    }];
  }

  return sortMixMarkdownFiles(
    headings
      .map((heading, index) => {
        const next = headings[index + 1];
        const fileMarkdown = markdown.slice(heading.index, next?.index ?? markdown.length).trim();
        if (!fileMarkdown) return null;
        return {
          id: heading.topic.id,
          title: heading.topic.title,
          fileName: heading.topic.fileName,
          markdown: fileMarkdown,
          updatedAt: new Date().toISOString(),
        };
      })
      .filter((file): file is MixAnalysisFile => file !== null),
  );
}

function describeAgentModelIssue(output: string, label: string): string {
  const text = cleanAgentJsonOutput(output);
  if (
    !/selected model|model .*not exist|not have access|invalid model|model .*not found|access denied|forbidden/i.test(
      text,
    )
  ) {
    return '';
  }
  const model =
    text.match(/selected model \(([^)]+)\)/i)?.[1] ||
    text.match(/model[:\s]+([A-Za-z0-9._:/+-]+)/i)?.[1] ||
    '';
  const modelText = model ? ` "${model}"` : '';
  return `${label} model${modelText} is not available for this account or backend. Pick another model in the agent Runtime selector.`;
}

type AgentRunOutputResult = {
  output?: string;
  stderr?: string;
  status?: string;
};

function agentRunOutput(result: AgentRunOutputResult, label: string): string {
  const output = (result.output || result.stderr || '').trim();
  const modelIssue = describeAgentModelIssue(output, label);
  if (modelIssue) {
    throw new Error(modelIssue);
  }
  if (result.status === 'failed') {
    throw new Error(output || `${label} analysis failed.`);
  }
  if (!output) {
    throw new Error(`${label} returned an empty response.`);
  }
  return output;
}

function researchStreamAgentLabel(agent: LegacyRemoteAgentStreamKind): string {
  if (agent === 'claude') return 'Claude';
  if (agent === 'bailian') return 'bailian';
  return 'agy';
}

function normalizedResearchStreamText(value: string): string {
  return value.replace(/\r/g, '').toLowerCase();
}

function isResearchAgentStreamDone(value: string, agent: LegacyRemoteAgentStreamKind): boolean {
  return normalizedResearchStreamText(value).includes(
    `[cozypad] remote ${researchStreamAgentLabel(agent).toLowerCase()} ready`,
  );
}

function isResearchAgentStreamFailed(value: string, agent: LegacyRemoteAgentStreamKind): boolean {
  const lower = normalizedResearchStreamText(value);
  const label = researchStreamAgentLabel(agent).toLowerCase();
  return (
    lower.includes(`[cozypad] remote ${label} failed`) ||
    lower.includes(`[cozypad] remote ${label} exited with code`) ||
    lower.includes('[cozypad] remote agent failed') ||
    lower.includes('[cozypad] remote agent is still running')
  );
}

function isHiddenResearchAgentStreamLine(line: string, agent: LegacyRemoteAgentStreamKind): boolean {
  const clean = line.trim();
  const lower = clean.toLowerCase();
  const label = researchStreamAgentLabel(agent).toLowerCase();
  if (!clean) return false;
  return (
    lower === '[cozypad] remote agent stream ready' ||
    lower.startsWith(`[cozypad] remote ${label} starting`) ||
    lower.startsWith(`[cozypad] remote ${label} ready`) ||
    lower.startsWith(`[cozypad] remote ${label} failed`) ||
    lower.startsWith(`[cozypad] remote ${label} exited with code`) ||
    lower.startsWith(`[cozypad] remote ${label} worker ready`) ||
    lower.startsWith('[cozypad] remote agent failed') ||
    lower.startsWith('[cozypad] remote agent is still running') ||
    lower.startsWith('[cozypad] agent prompt transfer incomplete') ||
    lower.startsWith('[cozypad] agent prompt decode failed') ||
    lower.startsWith('[cozypad] base64 not found on remote host') ||
    lower.startsWith(`[cozypad] remote ${label} cli not found`) ||
    /^__cozypad_agent_job_(?:start|end)__:/i.test(clean)
  );
}

function visibleResearchAgentStreamText(value: string, agent: LegacyRemoteAgentStreamKind): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => {
      const clean = line.trim();
      if (!clean) return true;
      return !isHiddenResearchAgentStreamLine(line, agent);
    })
    .join('\n');
}

function runResearchAgentStreamPrompt(options: {
  agent: LegacyRemoteAgentStreamKind;
  serverId: string;
  prompt: string;
  remotePath?: string;
  allowedDirs?: string[];
  model?: string;
}): Promise<AgentRunOutputResult> {
  return new Promise((resolve, reject) => {
    const socket = openLegacyRemoteAgentStream();
    let output = '';
    let lastMessage = '';
    let settled = false;

    const settle = (result: AgentRunOutputResult, error?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // The socket may already be closed by the server.
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    socket.addEventListener('open', () => {
      socket.send(serializeLegacyRemoteAgentStreamPayload(options));
    });

    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : '';
      if (!text) return;
      lastMessage = text;
      const visible = visibleResearchAgentStreamText(text, options.agent);
      if (visible) {
        output += visible;
      }
      if (isResearchAgentStreamFailed(text, options.agent)) {
        settle({ output, stderr: output || text, status: 'failed' });
        return;
      }
      if (isResearchAgentStreamDone(text, options.agent)) {
        settle({ output, status: 'completed' });
      }
    });

    socket.addEventListener('error', () => {
      settle(
        { output, stderr: output || lastMessage, status: 'failed' },
        new Error('Remote agent WebSocket connection failed.'),
      );
    });

    socket.addEventListener('close', () => {
      if (settled) return;
      settle({
        output,
        stderr: output || lastMessage || 'Remote agent WebSocket closed before completion.',
        status: 'failed',
      });
    });
  });
}

function createResearchCodexTaskId(): string {
  try {
    if (window.crypto?.randomUUID) return `research-codex:${window.crypto.randomUUID()}`;
  } catch {
    // Fall back below.
  }
  return `research-codex:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizedResearchCodexText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r/g, '\n');
}

function isResearchCodexStreamDone(value: string): boolean {
  const text = normalizedResearchCodexText(value).toLowerCase();
  return (
    text.includes('[cozypad] codex ready') ||
    text.includes('[cozypad local codex] ready') ||
    text.includes('[cozypad] remote codex ready')
  );
}

function isResearchCodexStreamFailed(value: string): boolean {
  const text = normalizedResearchCodexText(value).toLowerCase();
  return (
    text.includes('[cozypad] remote codex failed') ||
    text.includes('[cozypad] codex failed') ||
    text.includes('permission denied') ||
    text.includes('host key verification failed') ||
    text.includes('connection timed out') ||
    text.includes('connection reset') ||
    text.includes('remote codex cli not found') ||
    text.includes('codex cli not found') ||
    text.includes('401 unauthorized')
  );
}

function isResearchCodexStreamStarted(value: string): boolean {
  const text = normalizedResearchCodexText(value).toLowerCase();
  return text.includes('[codex] turn started') || text.includes('[codex] started ');
}

function isHiddenResearchCodexTransportLine(line: string): boolean {
  const clean = line.trim();
  const lower = clean.toLowerCase();
  return (
    lower === '[cozypad] codex ready' ||
    lower === '[cozypad local codex] ready' ||
    lower === '[cozypad] remote codex ready' ||
    lower === '[cozypad] codex heartbeat' ||
    lower === '[cozypad] codex is still running in background' ||
    lower === '[cozypad] remote codex websocket error' ||
    lower === '[remote codex]' ||
    lower === 'reading additional input from stdin...' ||
    lower.startsWith('[cozypad] codex attached') ||
    lower.startsWith('[cozypad] queued follow-up') ||
    lower.startsWith('[cozypad] running queued follow-up') ||
    lower.startsWith('[codex] turn started') ||
    lower.startsWith('[codex] turn complete') ||
    lower.startsWith('[codex] completed ') ||
    lower.includes('remote codex retry scheduled') ||
    lower.includes('remote codex ssh transport was interrupted') ||
    lower.includes('cozypad will retry automatically') ||
    lower.includes('cozypad will continue this task automatically') ||
    /^connection closed by .+ port \d+$/i.test(clean) ||
    /^banner exchange:/i.test(clean) ||
    /^connection timed out during banner exchange/i.test(clean) ||
    /^connection to .+ port \d+ timed out$/i.test(clean) ||
    /^read from remote host .+: unknown error$/i.test(clean) ||
    /^getsockname failed: not a socket$/i.test(clean) ||
    /^codex exited with code 255$/i.test(clean) ||
    lower.includes('remote ssh worker ended with code') ||
    lower.includes('connection to unknown port -1') ||
    lower.includes('kex_exchange_identification: read: connection reset') ||
    lower.includes('timed out during banner exchange')
  );
}

function visibleResearchCodexStreamText(value: string): string {
  return normalizedResearchCodexText(value)
    .split('\n')
    .filter((line) => {
      const clean = line.trim();
      if (!clean) return true;
      return !isHiddenResearchCodexTransportLine(line);
    })
    .join('\n');
}

async function runResearchCodexStreamPrompt(options: {
  serverId: string;
  prompt: string;
  remotePath?: string;
  model?: string;
}): Promise<string> {
  const history = await createLegacyCodexHistory(options.serverId, 'Research diagram draw');
  return new Promise((resolve, reject) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/codex/session`);
    url.searchParams.set('serverId', options.serverId);
    if (options.remotePath) url.searchParams.set('remotePath', options.remotePath);
    url.searchParams.set('taskId', createResearchCodexTaskId());
    url.searchParams.set('historyId', history.id);
    const socket = new WebSocket(url.toString());
    let output = '';
    let lastMessage = '';
    let promptStarted = false;
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // The socket may already be closing.
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(output.trim());
    };

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          prompt: options.prompt,
          remotePath: options.remotePath,
          model: options.model,
        }),
      );
    });

    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : '';
      if (!text) return;
      lastMessage = text;
      const visible = visibleResearchCodexStreamText(text);
      if (isResearchCodexStreamStarted(text)) promptStarted = true;
      if (visible.trim()) promptStarted = true;
      if (visible) output = `${output}${visible}`;
      if (isResearchCodexStreamFailed(text)) {
        settle(new Error((output || visible || text).trim() || 'Codex diagram drawing failed.'));
        return;
      }
      if (isResearchCodexStreamDone(text)) {
        if (promptStarted) {
          settle(output.trim() ? undefined : new Error('Codex did not return diagram JSON.'));
        }
      }
    });

    socket.addEventListener('error', () => {
      settle(new Error('Codex WebSocket connection failed.'));
    });

    socket.addEventListener('close', () => {
      if (settled) return;
      settle(new Error((output || lastMessage || 'Codex WebSocket closed before completion.').trim()));
    });
  });
}

function readPipelineNodes(): PipelineNode[] {
  try {
    const raw = window.localStorage.getItem(PIPELINE_NODES_STORAGE_KEY);
    if (!raw) return PIPELINE_NODES;
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return PIPELINE_NODES;
    if (parsed.length === 0) return [];
    const hasFullNodePayload = parsed.some(
      (item) => item && isPipelineNodeKind(item.kind) && isPipelineNodeRole(item.role),
    );
    if (hasFullNodePayload) {
      const used = new Set<string>();
      const nodes = parsed
        .map((item): PipelineNode | null => {
          if (!item || typeof item.id !== 'string' || used.has(item.id)) return null;
          if (
            !isPipelineNodeKind(item.kind) ||
            !isPipelineNodeRole(item.role) ||
            !Number.isFinite(item.x) ||
            !Number.isFinite(item.y)
          ) {
            return null;
          }
          const baseNode = PIPELINE_NODES.find((node) => node.id === item.id);
          used.add(item.id);
          return {
            id: item.id,
            kind: item.kind,
            title: normalizeNodeLabel(item.title, baseNode?.title || item.id),
            subtitle: normalizeNodeLabel(item.subtitle, baseNode?.subtitle || item.kind),
            role: item.role,
            x: clamp(Number(item.x), NODE_MIN_X, NODE_MAX_X),
            y: clamp(Number(item.y), NODE_MIN_Y, NODE_MAX_Y),
          };
        })
        .filter((node): node is PipelineNode => node !== null);
      return nodes.length > 0 ? spreadCrowdedBoundaryNodes(nodes) : PIPELINE_NODES;
    }

    const savedById = new Map(
      parsed
        .filter((item) => item && typeof item.id === 'string')
        .map((item) => [item.id as string, item]),
    );
    const defaultNodes = PIPELINE_NODES.map((node) => {
      const saved = savedById.get(node.id);
      if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return node;
      return {
        ...node,
        kind: isPipelineNodeKind(saved.kind) ? saved.kind : node.kind,
        title: normalizeNodeLabel(saved.title, node.title),
        subtitle: normalizeNodeLabel(saved.subtitle, node.subtitle),
        role: isPipelineNodeRole(saved.role) ? saved.role : node.role,
        x: clamp(Number(saved.x), NODE_MIN_X, NODE_MAX_X),
        y: clamp(Number(saved.y), NODE_MIN_Y, NODE_MAX_Y),
      };
    });
    const customNodes = parsed
      .map((item): PipelineNode | null => {
        if (!item || typeof item.id !== 'string') return null;
        const baseNode = PIPELINE_NODES.find((node) => node.id === item.id);
        if (baseNode) return null;
        const kind = isPipelineNodeKind(item.kind) ? item.kind : null;
        const role = isPipelineNodeRole(item.role) ? item.role : null;
        if (!kind || !role || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return null;
        return {
          id: item.id,
          kind,
          title: normalizeNodeLabel(item.title, item.id),
          subtitle: normalizeNodeLabel(item.subtitle, kind),
          role,
          x: clamp(Number(item.x), NODE_MIN_X, NODE_MAX_X),
          y: clamp(Number(item.y), NODE_MIN_Y, NODE_MAX_Y),
        };
      })
      .filter((node): node is PipelineNode => node !== null);

    return spreadCrowdedBoundaryNodes([...defaultNodes, ...customNodes]);
  } catch {
    return PIPELINE_NODES;
  }
}

function readPipelineEdges(nodes: PipelineNode[]): PipelineEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  try {
    const raw = window.localStorage.getItem(PIPELINE_EDGES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PIPELINE_EDGES.filter(
        (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
      );
    }
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return DEFAULT_PIPELINE_EDGES.filter(
        (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
      );
    }
    const used = new Set<string>();
    const edges = parsed
      .map((item): PipelineEdge | null => {
        if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') return null;
        if (item.from === item.to || !nodeIds.has(item.from) || !nodeIds.has(item.to)) return null;
        const fromSide = isPipelinePortSide(item.fromSide) ? item.fromSide : undefined;
        const toSide = isPipelinePortSide(item.toSide) ? item.toSide : undefined;
        const id = typeof item.id === 'string' ? item.id : edgeId(item.from, item.to, fromSide, toSide);
        if (used.has(id)) return null;
        used.add(id);
        return { id, from: item.from, to: item.to, fromSide, toSide };
      })
      .filter((edge): edge is PipelineEdge => edge !== null);

    return edges;
  } catch {
    return DEFAULT_PIPELINE_EDGES.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  }
}

function createResearchFlowchartId(): string {
  try {
    if (window.crypto?.randomUUID) return `flow:${window.crypto.randomUUID()}`;
  } catch {
    // Fall back below.
  }
  return `flow:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function serializePipelineNodes(nodes: PipelineNode[]): PipelineNode[] {
  return nodes.map(({ id, kind, title, subtitle, role, x, y }) => ({
    id,
    kind,
    title,
    subtitle,
    role,
    x,
    y,
  }));
}

function serializePipelineEdges(edges: PipelineEdge[]): PipelineEdge[] {
  return edges.map(({ id, from, to, fromSide, toSide }) => ({ id, from, to, fromSide, toSide }));
}

function normalizeStoredPipelineNodes(value: unknown): PipelineNode[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value
    .map((item): PipelineNode | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const rawId = typeof record.id === 'string' ? record.id.trim() : '';
      if (!rawId || used.has(rawId)) return null;
      if (
        !isPipelineNodeKind(record.kind) ||
        !isPipelineNodeRole(record.role) ||
        !Number.isFinite(record.x) ||
        !Number.isFinite(record.y)
      ) {
        return null;
      }
      used.add(rawId);
      return {
        id: rawId,
        kind: record.kind,
        title: normalizeNodeLabel(record.title, rawId),
        subtitle: normalizeNodeLabel(record.subtitle, record.kind),
        role: record.role,
        x: clamp(Number(record.x), NODE_MIN_X, NODE_MAX_X),
        y: clamp(Number(record.y), NODE_MIN_Y, NODE_MAX_Y),
      };
    })
    .filter((node): node is PipelineNode => node !== null);
}

function normalizeStoredPipelineEdges(value: unknown, nodes: PipelineNode[]): PipelineEdge[] {
  if (!Array.isArray(value)) return [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const used = new Set<string>();
  return value
    .map((item): PipelineEdge | null => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      if (typeof record.from !== 'string' || typeof record.to !== 'string') return null;
      if (record.from === record.to || !nodeIds.has(record.from) || !nodeIds.has(record.to)) return null;
      const fromSide = isPipelinePortSide(record.fromSide) ? record.fromSide : undefined;
      const toSide = isPipelinePortSide(record.toSide) ? record.toSide : undefined;
      const id = typeof record.id === 'string' ? record.id : edgeId(record.from, record.to, fromSide, toSide);
      if (!id || used.has(id)) return null;
      used.add(id);
      return { id, from: record.from, to: record.to, fromSide, toSide };
    })
    .filter((edge): edge is PipelineEdge => edge !== null);
}

function defaultResearchFlowchart(): ResearchFlowchart {
  const nodes = readPipelineNodes();
  return {
    id: createResearchFlowchartId(),
    title: 'Flowchart 1',
    nodes,
    edges: readPipelineEdges(nodes),
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeFlowchartTitle(value: unknown, fallback: string): string {
  const title = String(value || '').trim().slice(0, 80);
  return title || fallback;
}

function readResearchFlowchartLibrary(): ResearchFlowchartLibrary {
  let flowcharts: ResearchFlowchart[] = [];
  try {
    const raw = window.localStorage.getItem(RESEARCH_FLOWCHARTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      const used = new Set<string>();
      flowcharts = parsed
        .map((item, index): ResearchFlowchart | null => {
          if (!item || typeof item !== 'object') return null;
          const record = item as Record<string, unknown>;
          const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : createResearchFlowchartId();
          if (used.has(id)) return null;
          const nodes = normalizeStoredPipelineNodes(record.nodes);
          const edges = normalizeStoredPipelineEdges(record.edges, nodes);
          used.add(id);
          return {
            id,
            title: sanitizeFlowchartTitle(record.title, `Flowchart ${index + 1}`),
            nodes,
            edges,
            updatedAt:
              typeof record.updatedAt === 'string' && record.updatedAt.trim()
                ? record.updatedAt
                : new Date().toISOString(),
          };
        })
        .filter((flowchart): flowchart is ResearchFlowchart => flowchart !== null)
        .slice(0, MAX_RESEARCH_FLOWCHARTS);
    }
  } catch {
    flowcharts = [];
  }

  if (flowcharts.length === 0) {
    flowcharts = [defaultResearchFlowchart()];
  }

  let activeFlowchartId = '';
  try {
    activeFlowchartId = window.localStorage.getItem(RESEARCH_ACTIVE_FLOWCHART_STORAGE_KEY) || '';
  } catch {
    activeFlowchartId = '';
  }
  if (!flowcharts.some((flowchart) => flowchart.id === activeFlowchartId)) {
    activeFlowchartId = flowcharts[0]?.id || '';
  }
  return { flowcharts, activeFlowchartId };
}

export function ResearchWorkspace({ connected = false }: ResearchWorkspaceProps) {
  const [flowchartLibrary, setFlowchartLibrary] = useState<ResearchFlowchartLibrary>(() =>
    readResearchFlowchartLibrary(),
  );
  const initialFlowchart =
    flowchartLibrary.flowcharts.find((flowchart) => flowchart.id === flowchartLibrary.activeFlowchartId) ||
    flowchartLibrary.flowcharts[0];
  const initialFlowchartId = initialFlowchart?.id || '';
  const [nodes, setNodes] = useState<PipelineNode[]>(() => initialFlowchart?.nodes || []);
  const [markdownByFlowchart, setMarkdownByFlowchart] = useState<FlowchartMarkdownStore>(() =>
    readResearchMarkdownByFlowchart(initialFlowchartId),
  );
  const [mixMarkdownByFlowchart, setMixMarkdownByFlowchart] = useState<FlowchartMixMarkdownStore>(() =>
    readResearchMixMarkdownByFlowchart(initialFlowchartId),
  );
  const [remoteMarkdown, setRemoteMarkdown] = useState(() =>
    markdownEntryForFlowchart(readResearchMarkdownByFlowchart(initialFlowchartId), initialFlowchartId).markdown,
  );
  const [remoteMarkdownUserDraft, setRemoteMarkdownUserDraft] = useState(
    () => markdownEntryForFlowchart(readResearchMarkdownByFlowchart(initialFlowchartId), initialFlowchartId).userDraft,
  );
  const [mixMarkdownFiles, setMixMarkdownFiles] = useState<MixAnalysisFile[]>(() =>
    readResearchMixMarkdownByFlowchart(initialFlowchartId)[initialFlowchartId] || [],
  );
  const [markdownAnalysis, setMarkdownAnalysis] = useState<MarkdownAnalysisState>({
    status: 'idle',
    message: '',
  });
  const [analysisNow, setAnalysisNow] = useState(() => Date.now());
  const [activeView, setActiveView] = useState<ResearchView>('flow');
  const [selectedNodeId, setSelectedNodeId] = useState('subset');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(['subset']);
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const [edges, setEdges] = useState<PipelineEdge[]>(() => initialFlowchart?.edges || []);
  const [draggingNodeId, setDraggingNodeId] = useState('');
  const [dragGroup, setDragGroup] = useState<DragGroupState | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBoxState | null>(null);
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null);
  const [showNodePorts, setShowNodePorts] = useState(false);
  const [trainingPromptDialog, setTrainingPromptDialog] = useState<TrainingPromptDialogState | null>(null);
  const [trainingDialogSource, setTrainingDialogSource] = useState<TrainingPromptSource | null>(null);
  const [markdownTrainingDraft, setMarkdownTrainingDraft] = useState<TrainingPromptDialogState | null>(null);
  const [mixTrainingDraft, setMixTrainingDraft] = useState<TrainingPromptDialogState | null>(null);
  const [trainingTargetAgent, setTrainingTargetAgent] = useState<QueuedTrainingAgent>('codex');
  const [trainingSubmitting, setTrainingSubmitting] = useState(false);
  const [selectedMixFileId, setSelectedMixFileId] = useState('');
  const [markdownSourceOpen, setMarkdownSourceOpen] = useState(false);
  const [mixSourceOpen, setMixSourceOpen] = useState(false);
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);
  const [graphSize, setGraphSize] = useState<GraphSize>(GRAPH_FALLBACK_SIZE);
  const [codexDiagramOpen, setCodexDiagramOpen] = useState(false);
  const [codexDiagramPrompt, setCodexDiagramPrompt] = useState('');
  const [codexDiagramJson, setCodexDiagramJson] = useState('');
  const [analysisAgent, setAnalysisAgent] = useState<ResearchAnalysisAgent>('');
  const [codexDiagramStatus, setCodexDiagramStatus] = useState<MarkdownAnalysisState>({
    status: 'idle',
    message: '',
  });
  const graphRef = useRef<HTMLDivElement | null>(null);
  const mixAnalysisInFlightRef = useRef(false);
  const trainingSubmitInFlightRef = useRef(false);
  const activeFlowchart =
    flowchartLibrary.flowcharts.find((flowchart) => flowchart.id === flowchartLibrary.activeFlowchartId) ||
    flowchartLibrary.flowcharts[0];
  const activeFlowchartIndex = Math.max(
    0,
    flowchartLibrary.flowcharts.findIndex((flowchart) => flowchart.id === flowchartLibrary.activeFlowchartId),
  );

  useEffect(() => {
    setNodes((current) => spreadCrowdedBoundaryNodes(current));
  }, []);

  useEffect(() => {
    const serializedNodes = serializePipelineNodes(nodes);
    const serializedEdges = serializePipelineEdges(edges);
    try {
      window.localStorage.setItem(
        PIPELINE_NODES_STORAGE_KEY,
        JSON.stringify(serializedNodes),
      );
      window.localStorage.setItem(PIPELINE_EDGES_STORAGE_KEY, JSON.stringify(serializedEdges));
    } catch {
      // Ignore quota or private-mode storage failures.
    }
    setFlowchartLibrary((current) => ({
      ...current,
      flowcharts: current.flowcharts.map((flowchart) =>
        flowchart.id === current.activeFlowchartId
          ? {
              ...flowchart,
              nodes: serializedNodes,
              edges: serializedEdges,
              updatedAt: new Date().toISOString(),
            }
          : flowchart,
      ),
    }));
  }, [edges, nodes]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        RESEARCH_FLOWCHARTS_STORAGE_KEY,
        JSON.stringify(flowchartLibrary.flowcharts.slice(0, MAX_RESEARCH_FLOWCHARTS)),
      );
      window.localStorage.setItem(RESEARCH_ACTIVE_FLOWCHART_STORAGE_KEY, flowchartLibrary.activeFlowchartId);
    } catch {
      // Ignore quota or private-mode storage failures.
    }
  }, [flowchartLibrary]);

  useEffect(() => {
    if (!showNodePorts) {
      setConnectionDraft(null);
    }
  }, [showNodePorts]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNodeMenu(null);
        setConnectionDraft(null);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    if (markdownAnalysis.status !== 'running' || !markdownAnalysis.startedAt) return undefined;
    setAnalysisNow(Date.now());
    const timer = window.setInterval(() => setAnalysisNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [markdownAnalysis.startedAt, markdownAnalysis.status]);

  useEffect(() => {
    const graphElement = graphRef.current;
    if (!graphElement) return undefined;

    const updateGraphSize = () => {
      const rect = graphElement.getBoundingClientRect();
      setGraphSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };

    updateGraphSize();
    const resizeObserver = new ResizeObserver(updateGraphSize);
    resizeObserver.observe(graphElement);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const activeFlowchartId = flowchartLibrary.activeFlowchartId;
    if (!activeFlowchartId) return;
    setMarkdownByFlowchart((current) => {
      const currentEntry = current[activeFlowchartId];
      if (
        currentEntry &&
        currentEntry.markdown === remoteMarkdown &&
        currentEntry.userDraft === remoteMarkdownUserDraft
      ) {
        return current;
      }
      return {
        ...current,
        [activeFlowchartId]: {
          markdown: remoteMarkdown,
          userDraft: remoteMarkdownUserDraft,
          updatedAt: new Date().toISOString(),
        },
      };
    });
    try {
      window.localStorage.setItem(RESEARCH_MARKDOWN_STORAGE_KEY, remoteMarkdown);
    } catch {
      // Ignore quota or private-mode storage failures.
    }
  }, [flowchartLibrary.activeFlowchartId, remoteMarkdown, remoteMarkdownUserDraft]);

  useEffect(() => {
    const activeFlowchartId = flowchartLibrary.activeFlowchartId;
    if (!activeFlowchartId) return;
    setMixMarkdownByFlowchart((current) => {
      const currentFiles = current[activeFlowchartId] || [];
      if (JSON.stringify(currentFiles) === JSON.stringify(mixMarkdownFiles)) return current;
      return {
        ...current,
        [activeFlowchartId]: mixMarkdownFiles,
      };
    });
    try {
      window.localStorage.setItem(
        RESEARCH_MIX_MARKDOWN_STORAGE_KEY,
        JSON.stringify(mixMarkdownFiles),
      );
    } catch {
      // Ignore quota or private-mode storage failures.
    }
  }, [flowchartLibrary.activeFlowchartId, mixMarkdownFiles]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        RESEARCH_MARKDOWN_BY_FLOWCHART_STORAGE_KEY,
        JSON.stringify(markdownByFlowchart),
      );
    } catch {
      // Ignore quota or private-mode storage failures.
    }
  }, [markdownByFlowchart]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        RESEARCH_MIX_MARKDOWN_BY_FLOWCHART_STORAGE_KEY,
        JSON.stringify(mixMarkdownByFlowchart),
      );
    } catch {
      // Ignore quota or private-mode storage failures.
    }
  }, [mixMarkdownByFlowchart]);

  useEffect(() => {
    if (!mixMarkdownFiles.length) {
      if (selectedMixFileId) setSelectedMixFileId('');
      return;
    }
    if (!mixMarkdownFiles.some((file) => file.id === selectedMixFileId)) {
      const firstFile = mixMarkdownFiles[0];
      if (firstFile) setSelectedMixFileId(firstFile.id);
    }
  }, [mixMarkdownFiles, selectedMixFileId]);

  const selectedNode = nodeById(nodes, selectedNodeId) ?? nodes[0] ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedMixFile =
    mixMarkdownFiles.find((file) => file.id === selectedMixFileId) ?? mixMarkdownFiles[0] ?? null;
  const localMarkdownDraft = useMemo(
    () => flowchartToLocalMarkdown(nodes, edges, '', ''),
    [edges, nodes],
  );
  const pipelineMarkdown = useMemo(
    () => (remoteMarkdownUserDraft || remoteMarkdown.length > 0 ? remoteMarkdown : localMarkdownDraft),
    [localMarkdownDraft, remoteMarkdown, remoteMarkdownUserDraft],
  );
  const hasRemoteMarkdown = remoteMarkdown.trim().length > 0;
  const hasMixMarkdownFiles = mixMarkdownFiles.length > 0;
  const mixTrainingMarkdown = useMemo(() => buildMixTrainingMarkdown(mixMarkdownFiles), [mixMarkdownFiles]);
  const analysisElapsedMs =
    markdownAnalysis.elapsedMs ??
    (markdownAnalysis.status === 'running' && markdownAnalysis.startedAt
      ? analysisNow - markdownAnalysis.startedAt
      : 0);
  const isMixAnalysisMessage =
    markdownAnalysis.message.startsWith('mix analysis diagram') ||
    markdownAnalysis.message.startsWith('MD.mix');
  const visibleMarkdownAnalysisMessage = shouldSilenceFlowchartFallbackError(markdownAnalysis.message) || isMixAnalysisMessage
    ? ''
    : markdownAnalysis.message;
  const visibleMixAnalysisMessage =
    isMixAnalysisMessage && !shouldSilenceFlowchartFallbackError(markdownAnalysis.message)
      ? markdownAnalysis.message
      : '';
  const mixAnalysisCount = mixMarkdownFiles.filter(hasUsableMixMarkdown).length;
  const mixAnalysisTotal = MIX_ANALYSIS_TOPICS.length;
  const hasCompleteMixMarkdown = mixAnalysisCount === mixAnalysisTotal;
  const hasAnalysisAgent = analysisAgent.length > 0;
  const analysisAgentLabel = analysisAgent ? RESEARCH_ANALYSIS_AGENT_LABELS[analysisAgent] : 'agent';
  const graphCanvasSize = useMemo(() => graphCanvasPixels(nodes.length), [nodes.length]);
  const graphCanvasStyle = useMemo<CSSProperties>(
    () => ({
      width: `max(100%, ${graphCanvasSize.width}px)`,
      height: `max(100%, ${graphCanvasSize.height}px)`,
    }),
    [graphCanvasSize.height, graphCanvasSize.width],
  );

  const nodeCenterPoint = useCallback(
    (node: PipelineNode): GraphPoint => ({
      x: (node.x / 100) * graphSize.width,
      y: (node.y / 100) * graphSize.height,
    }),
    [graphSize.height, graphSize.width],
  );

  const portPoint = useCallback(
    (node: PipelineNode, side: PipelinePortSide): GraphPoint => {
      const center = nodeCenterPoint(node);
      if (side === 'top') return { x: center.x, y: center.y - NODE_CARD_HEIGHT_PX / 2 };
      if (side === 'bottom') return { x: center.x, y: center.y + NODE_CARD_HEIGHT_PX / 2 };
      if (side === 'left') return { x: center.x - NODE_CARD_WIDTH_PX / 2, y: center.y };
      return { x: center.x + NODE_CARD_WIDTH_PX / 2, y: center.y };
    },
    [nodeCenterPoint],
  );

  const resolveAnalysisServer = useCallback(async (): Promise<LegacySshServer> => {
    if (!connected) {
      throw new Error('Press Connect before using SSH agents.');
    }

    const servers = await listLegacyServers();
    const server = findRememberedLegacyServer(servers) ?? servers[0] ?? null;
    if (!server) {
      throw new Error('Select an SSH server in Agents, Terminal, or File before using Claude, Codex, or agy analysis.');
    }
    return server;
  }, [connected]);

  const runSelectedTextAnalysisAgent = useCallback(
    async (prompt: string): Promise<string> => {
      const server = await resolveAnalysisServer();
      const remotePath = server.defaultPath || '~';
      const model = readResearchAgentModel(analysisAgent);
      if (analysisAgent === 'claude' || analysisAgent === 'agy' || analysisAgent === 'bailian') {
        const result = await runResearchAgentStreamPrompt({
          agent: analysisAgent,
          serverId: server.id,
          prompt,
          remotePath,
          allowedDirs: analysisAgent === 'claude' ? [remotePath] : undefined,
          model,
        });
        return agentRunOutput(result, analysisAgentLabel);
      }
      if (analysisAgent === 'codex') {
        return runResearchCodexStreamPrompt({
          serverId: server.id,
          prompt,
          remotePath,
          model,
        });
      }
      throw new Error(`${analysisAgentLabel} is not available for direct text analysis.`);
    },
    [analysisAgent, analysisAgentLabel, resolveAnalysisServer],
  );

  const deleteNodeIds = useCallback((nodeIds: string[]) => {
    const ids = new Set(nodeIds.filter(Boolean));
    if (ids.size === 0) return;
    setNodes((current) => current.filter((node) => !ids.has(node.id)));
    setEdges((current) => current.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)));
    setConnectionDraft((current) => (current && ids.has(current.from) ? null : current));
    setNodeMenu(null);
    setSelectionBox(null);
    setSelectedEdgeId('');
    setSelectedNodeId((current) => (ids.has(current) ? '' : current));
    setSelectedNodeIds((current) => current.filter((id) => !ids.has(id)));
  }, []);

  useEffect(() => {
    const handleGraphKeyboard = (event: KeyboardEvent) => {
      if (activeView !== 'flow' || isEditableKeyTarget(event.target)) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const allIds = nodes.map((node) => node.id);
        setSelectedNodeIds(allIds);
        setSelectedNodeId(allIds[0] || '');
        setSelectedEdgeId('');
        setNodeMenu(null);
        setSelectionBox(null);
        return;
      }

      const arrowDelta: Record<string, { x: number; y: number }> = {
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
      };
      const delta = arrowDelta[event.key];
      if (delta && selectedNodeIds.length > 0) {
        event.preventDefault();
        const step = event.shiftKey ? 4 : 1;
        const selected = new Set(selectedNodeIds);
        setNodes((current) =>
          current.map((node) =>
            selected.has(node.id)
              ? {
                  ...node,
                  x: Math.round(clamp(node.x + delta.x * step, NODE_MIN_X, NODE_MAX_X) * 10) / 10,
                  y: Math.round(clamp(node.y + delta.y * step, NODE_MIN_Y, NODE_MAX_Y) * 10) / 10,
                }
              : node,
          ),
        );
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') return;

      if (selectedNodeIds.length > 0) {
        event.preventDefault();
        deleteNodeIds(selectedNodeIds);
        return;
      }

      if (selectedEdgeId) {
        event.preventDefault();
        setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
        setSelectedEdgeId('');
      }
    };

    window.addEventListener('keydown', handleGraphKeyboard);
    return () => window.removeEventListener('keydown', handleGraphKeyboard);
  }, [activeView, deleteNodeIds, nodes, selectedEdgeId, selectedNodeIds]);

  const autoPortSide = useCallback(
    (from: PipelineNode, to: PipelineNode, endpoint: 'from' | 'to'): PipelinePortSide => {
      const fromPoint = nodeCenterPoint(from);
      const toPoint = nodeCenterPoint(to);
      const dx = toPoint.x - fromPoint.x;
      const dy = toPoint.y - fromPoint.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        if (endpoint === 'from') return dx >= 0 ? 'right' : 'left';
        return dx >= 0 ? 'left' : 'right';
      }
      if (endpoint === 'from') return dy >= 0 ? 'bottom' : 'top';
      return dy >= 0 ? 'top' : 'bottom';
    },
    [nodeCenterPoint],
  );

  const nearestPortSide = useCallback(
    (node: PipelineNode, clientX: number, clientY: number): PipelinePortSide => {
      const rect = graphRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return 'left';
      const center = nodeCenterPoint(node);
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const dx = px - center.x;
      const dy = py - center.y;
      if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
      return dy >= 0 ? 'bottom' : 'top';
    },
    [nodeCenterPoint],
  );

  const moveNodeToPointer = useCallback((nodeId: string, clientX: number, clientY: number) => {
    const rect = graphRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x = clamp(((clientX - rect.left) / rect.width) * 100, NODE_MIN_X, NODE_MAX_X);
    const y = clamp(((clientY - rect.top) / rect.height) * 100, NODE_MIN_Y, NODE_MAX_Y);
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              x: Math.round(x * 10) / 10,
              y: Math.round(y * 10) / 10,
            }
          : node,
      ),
    );
  }, []);

  const pointerToGraphPercent = useCallback((clientX: number, clientY: number) => {
    const rect = graphRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp(((clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((clientY - rect.top) / rect.height) * 100, 0, 100),
    };
  }, []);

  const moveDragGroupToPointer = useCallback((drag: DragGroupState, clientX: number, clientY: number) => {
    const point = pointerToGraphPercent(clientX, clientY);
    if (!point) return;
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    const selected = new Set(drag.nodeIds);
    setNodes((current) =>
      current.map((node) => {
        if (!selected.has(node.id)) return node;
        const initial = drag.initial[node.id];
        if (!initial) return node;
        return {
          ...node,
          x: Math.round(clamp(initial.x + dx, NODE_MIN_X, NODE_MAX_X) * 10) / 10,
          y: Math.round(clamp(initial.y + dy, NODE_MIN_Y, NODE_MAX_Y) * 10) / 10,
        };
      }),
    );
  }, [pointerToGraphPercent]);

  const createConnection = (from: string, to: string, fromSide: PipelinePortSide, toSide: PipelinePortSide) => {
    if (from === to) return;
    const id = edgeId(from, to, fromSide, toSide);
    setEdges((current) => {
      if (current.some((edge) => edge.from === from && edge.to === to)) return current;
      return [...current, { id, from, to, fromSide, toSide }];
    });
    setSelectedEdgeId(id);
  };

  const openNodeMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const point = pointerToGraphPercent(event.clientX, event.clientY);
    if (!point) return;
    setNodeMenu({
      x: Math.round(point.x * 10) / 10,
      y: Math.round(point.y * 10) / 10,
    });
    setSelectedEdgeId('');
  };

  const updateSelectionBox = useCallback((box: SelectionBoxState) => {
    const minX = Math.min(box.startX, box.currentX);
    const maxX = Math.max(box.startX, box.currentX);
    const minY = Math.min(box.startY, box.currentY);
    const maxY = Math.max(box.startY, box.currentY);
    const halfNodeWidth = graphSize.width > 0 ? (NODE_CARD_WIDTH_PX / 2 / graphSize.width) * 100 : 0;
    const halfNodeHeight = graphSize.height > 0 ? (NODE_CARD_HEIGHT_PX / 2 / graphSize.height) * 100 : 0;
    const selectedIds = nodes
      .filter((node) => {
        const nodeLeft = node.x - halfNodeWidth;
        const nodeRight = node.x + halfNodeWidth;
        const nodeTop = node.y - halfNodeHeight;
        const nodeBottom = node.y + halfNodeHeight;
        return nodeRight >= minX && nodeLeft <= maxX && nodeBottom >= minY && nodeTop <= maxY;
      })
      .map((node) => node.id);
    setSelectedNodeIds(selectedIds);
    if (selectedIds[0]) {
      setSelectedNodeId(selectedIds[0]);
      setSelectedEdgeId('');
    } else {
      setSelectedNodeId('');
    }
  }, [graphSize.height, graphSize.width, nodes]);

  const handleGraphPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    setNodeMenu(null);
    if (event.button !== 0 || connectionDraft) return;
    event.currentTarget.focus();
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest('[data-research-node-id]') ||
      target?.closest('.research-edge-hit') ||
      target?.closest('[data-research-node-port-side]')
    ) {
      return;
    }
    const point = pointerToGraphPercent(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedEdgeId('');
    const box = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    };
    setSelectionBox(box);
    setSelectedNodeIds([]);
  };

  const handleGraphPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!selectionBox || selectionBox.pointerId !== event.pointerId) return;
    const point = pointerToGraphPercent(event.clientX, event.clientY);
    if (!point) return;
    const nextBox = { ...selectionBox, currentX: point.x, currentY: point.y };
    setSelectionBox(nextBox);
    updateSelectionBox(nextBox);
  };

  const finishGraphSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (!selectionBox || selectionBox.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const point = pointerToGraphPercent(event.clientX, event.clientY);
    updateSelectionBox(point ? { ...selectionBox, currentX: point.x, currentY: point.y } : selectionBox);
    setSelectionBox(null);
    event.currentTarget.focus();
  };

  const addNodeFromTemplate = (template: NodeTemplate) => {
    if (!nodeMenu) return;
    const customTitle =
      template.role === 'application'
        ? window.prompt('隢撓??Application ?迂', template.title)
        : template.title;
    if (customTitle === null) return;
    const title = customTitle.trim() || template.title;
    const id = createNodeId(title, nodes);
    const node: PipelineNode = {
      id,
      kind: template.kind,
      title,
      subtitle: template.subtitle,
      role: template.role,
      x: clamp(nodeMenu.x, NODE_MIN_X, NODE_MAX_X),
      y: clamp(nodeMenu.y, NODE_MIN_Y, NODE_MAX_Y),
    };
    setNodes((current) => [...current, node]);
    setSelectedNodeId(id);
    setSelectedNodeIds([id]);
    setSelectedEdgeId('');
    setNodeMenu(null);
  };

  const updateSelectedApplicationTitle = (title: string) => {
    if (!selectedNode) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNode.id && node.role === 'application'
          ? { ...node, title }
          : node,
      ),
    );
  };

  const normalizeSelectedApplicationTitle = () => {
    if (!selectedNode) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNode.id && node.role === 'application'
          ? { ...node, title: node.title.trim() || 'Application' }
          : node,
      ),
    );
  };

  const deleteNode = (nodeId: string) => {
    deleteNodeIds([nodeId]);
  };

  const clearFlowchartInteractionState = () => {
    setSelectedNodeId('');
    setSelectedNodeIds([]);
    setSelectedEdgeId('');
    setConnectionDraft(null);
    setNodeMenu(null);
    setSelectionBox(null);
    setDragGroup(null);
    setDraggingNodeId('');
  };

  const saveCurrentFlowchartMarkdownState = () => {
    const activeFlowchartId = flowchartLibrary.activeFlowchartId;
    if (!activeFlowchartId) return;
    setMarkdownByFlowchart((current) => ({
      ...current,
      [activeFlowchartId]: {
        markdown: remoteMarkdown,
        userDraft: remoteMarkdownUserDraft,
        updatedAt: new Date().toISOString(),
      },
    }));
    setMixMarkdownByFlowchart((current) => ({
      ...current,
      [activeFlowchartId]: mixMarkdownFiles,
    }));
  };

  const loadFlowchartMarkdownState = (flowchartId: string) => {
    const markdownEntry = markdownEntryForFlowchart(markdownByFlowchart, flowchartId);
    const mixFiles = mixMarkdownByFlowchart[flowchartId] || [];
    setRemoteMarkdown(markdownEntry.markdown);
    setRemoteMarkdownUserDraft(markdownEntry.userDraft);
    setMixMarkdownFiles(mixFiles);
    setSelectedMixFileId(mixFiles[0]?.id || '');
    setMarkdownSourceOpen(false);
    setMixSourceOpen(false);
    setTrainingPromptDialog(null);
    setTrainingDialogSource(null);
    setMarkdownTrainingDraft(null);
    setMixTrainingDraft(null);
    setMarkdownAnalysis({ status: 'idle', message: '' });
  };

  const selectFlowchart = (flowchartId: string) => {
    if (flowchartId === flowchartLibrary.activeFlowchartId) return;
    const target = flowchartLibrary.flowcharts.find((flowchart) => flowchart.id === flowchartId);
    if (!target) return;
    const currentNodes = serializePipelineNodes(nodes);
    const currentEdges = serializePipelineEdges(edges);
    saveCurrentFlowchartMarkdownState();
    setFlowchartLibrary((current) => ({
      activeFlowchartId: flowchartId,
      flowcharts: current.flowcharts.map((flowchart) =>
        flowchart.id === current.activeFlowchartId
          ? { ...flowchart, nodes: currentNodes, edges: currentEdges, updatedAt: new Date().toISOString() }
          : flowchart,
      ),
    }));
    setNodes(target.nodes);
    setEdges(target.edges);
    loadFlowchartMarkdownState(flowchartId);
    clearFlowchartInteractionState();
    setActiveView('flow');
  };

  const renameActiveFlowchart = () => {
    if (!activeFlowchart) return;
    const title = window.prompt('Flowchart name', activeFlowchart.title);
    if (title === null) return;
    const nextTitle = sanitizeFlowchartTitle(title, activeFlowchart.title);
    setFlowchartLibrary((current) => ({
      ...current,
      flowcharts: current.flowcharts.map((flowchart) =>
        flowchart.id === current.activeFlowchartId
          ? { ...flowchart, title: nextTitle, updatedAt: new Date().toISOString() }
          : flowchart,
      ),
    }));
  };

  const deleteActiveFlowchart = () => {
    if (!activeFlowchart) return;
    if (flowchartLibrary.flowcharts.length <= 1) {
      if (!window.confirm('Clear this flowchart?')) return;
      setNodes([]);
      setEdges([]);
      setRemoteMarkdown('');
      setRemoteMarkdownUserDraft(false);
      setMixMarkdownFiles([]);
      setSelectedMixFileId('');
      setMarkdownSourceOpen(false);
      setMixSourceOpen(false);
      setTrainingPromptDialog(null);
      setTrainingDialogSource(null);
      setMarkdownTrainingDraft(null);
      setMixTrainingDraft(null);
      setMarkdownAnalysis({ status: 'idle', message: '' });
      setMarkdownByFlowchart((current) => ({
        ...current,
        [activeFlowchart.id]: { markdown: '', userDraft: false, updatedAt: new Date().toISOString() },
      }));
      setMixMarkdownByFlowchart((current) => ({
        ...current,
        [activeFlowchart.id]: [],
      }));
      clearFlowchartInteractionState();
      setFlowchartLibrary((current) => ({
        ...current,
        flowcharts: current.flowcharts.map((flowchart) =>
          flowchart.id === current.activeFlowchartId
            ? { ...flowchart, nodes: [], edges: [], updatedAt: new Date().toISOString() }
            : flowchart,
        ),
      }));
      return;
    }

    if (!window.confirm(`Delete "${activeFlowchart.title}"?`)) return;
    const nextFlowcharts = flowchartLibrary.flowcharts.filter((flowchart) => flowchart.id !== activeFlowchart.id);
    const nextActive = nextFlowcharts[Math.min(activeFlowchartIndex, nextFlowcharts.length - 1)] || nextFlowcharts[0];
    if (!nextActive) return;
    setMarkdownByFlowchart((current) => {
      const next = { ...current };
      delete next[activeFlowchart.id];
      return next;
    });
    setMixMarkdownByFlowchart((current) => {
      const next = { ...current };
      delete next[activeFlowchart.id];
      return next;
    });
    setFlowchartLibrary({
      flowcharts: nextFlowcharts,
      activeFlowchartId: nextActive.id,
    });
    setNodes(nextActive.nodes);
    setEdges(nextActive.edges);
    loadFlowchartMarkdownState(nextActive.id);
    clearFlowchartInteractionState();
  };

  const removeSelectedConnection = () => {
    if (!selectedEdgeId) return;
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId('');
  };

  const resetConnections = () => {
    setEdges(DEFAULT_PIPELINE_EDGES);
    setNodes(PIPELINE_NODES);
    setSelectedNodeId(PIPELINE_NODES[0]?.id || '');
    setSelectedNodeIds(PIPELINE_NODES[0] ? [PIPELINE_NODES[0].id] : []);
    setSelectedEdgeId('');
    setConnectionDraft(null);
    setNodeMenu(null);
  };

  const applyDiagramDraft = (draft: CodexDiagramDraft, message: string, requireConfirm = false) => {
    if (
      requireConfirm &&
      (nodes.length > 0 || edges.length > 0) &&
      !window.confirm('Apply diagram JSON and replace the current canvas?')
    ) {
      return false;
    }
    setNodes(draft.nodes);
    setEdges(draft.edges);
    setSelectedNodeId(draft.nodes[0]?.id || '');
    setSelectedNodeIds(draft.nodes[0] ? [draft.nodes[0].id] : []);
    setSelectedEdgeId('');
    setConnectionDraft(null);
    setNodeMenu(null);
    setRemoteMarkdown('');
    setRemoteMarkdownUserDraft(false);
    setMixMarkdownFiles([]);
    setSelectedMixFileId('');
    setMarkdownSourceOpen(false);
    setMixSourceOpen(false);
    setTrainingPromptDialog(null);
    setTrainingDialogSource(null);
    setMarkdownTrainingDraft(null);
    setMixTrainingDraft(null);
    setMarkdownAnalysis({ status: 'idle', message: '' });
    setCodexDiagramStatus({
      status: 'done',
      message,
    });
    return true;
  };

  const sendDiagramPromptToCodex = async (): Promise<boolean> => {
    if (!hasAnalysisAgent) {
      setCodexDiagramStatus({
        status: 'error',
        message: 'Select an analysis agent first.',
      });
      return false;
    }
    const prompt = codexDiagramPrompt.trim();
    if (!prompt) {
      setCodexDiagramStatus({
        status: 'error',
        message: 'Add a natural-language diagram request first.',
      });
      return false;
    }

    setCodexDiagramStatus({
      status: 'running',
      message: `${analysisAgentLabel} is drawing the diagram...`,
      startedAt: Date.now(),
    });
    try {
      if (analysisAgent === 'codex') {
        const server = await resolveAnalysisServer();
        const raw = await runResearchCodexStreamPrompt({
          serverId: server.id,
          prompt: buildAgentDiagramJsonPrompt(prompt, nodes, edges),
          remotePath: server.defaultPath || '~',
          model: readResearchAgentModel('codex'),
        });
        setCodexDiagramJson(raw);
        const draft = parseCodexDiagramDraft(raw);
        applyDiagramDraft(draft, `Codex drew ${draft.nodes.length} nodes / ${draft.edges.length} edges.`);
        return true;
      }

      const raw = await runSelectedTextAnalysisAgent(buildAgentDiagramJsonPrompt(prompt, nodes, edges));
      setCodexDiagramJson(raw);
      const draft = parseCodexDiagramDraft(raw);
      applyDiagramDraft(
        draft,
        `${analysisAgentLabel} drew ${draft.nodes.length} nodes / ${draft.edges.length} edges.`,
      );
      return true;
    } catch (error) {
      setCodexDiagramStatus({
        status: 'error',
        message: describeDiagramDraftError(error, analysisAgentLabel),
      });
      return false;
    }
  };

  const applyCodexDiagramJson = () => {
    try {
      const draft = parseCodexDiagramDraft(codexDiagramJson);
      applyDiagramDraft(
        draft,
        `Applied ${draft.nodes.length} nodes / ${draft.edges.length} edges.`,
        true,
      );
    } catch (error) {
      setCodexDiagramStatus({
        status: 'error',
        message: describeDiagramDraftError(error, 'Advanced JSON'),
      });
    }
  };

  const createNewFlowchart = () => {
    if (flowchartLibrary.flowcharts.length >= MAX_RESEARCH_FLOWCHARTS) {
      window.alert(`Flowchart limit reached: ${MAX_RESEARCH_FLOWCHARTS}`);
      return;
    }
    const nextIndex = flowchartLibrary.flowcharts.length + 1;
    const nextFlowchart: ResearchFlowchart = {
      id: createResearchFlowchartId(),
      title: `Flowchart ${nextIndex}`,
      nodes: [],
      edges: [],
      updatedAt: new Date().toISOString(),
    };
    const currentNodes = serializePipelineNodes(nodes);
    const currentEdges = serializePipelineEdges(edges);
    saveCurrentFlowchartMarkdownState();
    setMarkdownByFlowchart((current) => ({
      ...current,
      [nextFlowchart.id]: { markdown: '', userDraft: false, updatedAt: new Date().toISOString() },
    }));
    setMixMarkdownByFlowchart((current) => ({
      ...current,
      [nextFlowchart.id]: [],
    }));
    setFlowchartLibrary((current) => ({
      activeFlowchartId: nextFlowchart.id,
      flowcharts: [
        ...current.flowcharts.map((flowchart) =>
          flowchart.id === current.activeFlowchartId
            ? { ...flowchart, nodes: currentNodes, edges: currentEdges, updatedAt: new Date().toISOString() }
            : flowchart,
        ),
        nextFlowchart,
      ].slice(0, MAX_RESEARCH_FLOWCHARTS),
    }));
    setNodes([]);
    setEdges([]);
    setRemoteMarkdown('');
    setRemoteMarkdownUserDraft(false);
    setMixMarkdownFiles([]);
    setSelectedMixFileId('');
    setMarkdownSourceOpen(false);
    setMixSourceOpen(false);
    setTrainingPromptDialog(null);
    setTrainingDialogSource(null);
    setMarkdownTrainingDraft(null);
    setMixTrainingDraft(null);
    setMarkdownAnalysis({ status: 'idle', message: '' });
    clearFlowchartInteractionState();
    setActiveView('flow');
  };

  const analyzeFlowchartWithBailian = async () => {
    if (!hasAnalysisAgent) {
      setMarkdownAnalysis({ status: 'error', message: 'Select an analysis agent first.' });
      return;
    }
    if (nodes.length === 0) {
      setMarkdownAnalysis({ status: 'error', message: 'Add at least one node before running analysis.' });
      return;
    }

    const instruction =
      'Analyze this research flowchart and return Markdown for MD.md. Include a training schedule, checkpoints, required logs, metrics, and risk notes.';

    const startedAt = Date.now();
    setMarkdownAnalysis({
      status: 'running',
      message: `Sending flowchart to ${analysisAgentLabel} for Markdown analysis...`,
      startedAt,
    });
    setTrainingPromptDialog(null);
    setTrainingDialogSource(null);
    setMarkdownTrainingDraft(null);
    setActiveView('markdown');
    try {
      const markdown = markdownFromAgentOutput(
        await withTimeout(
          runSelectedTextAnalysisAgent(buildAgentFlowchartMarkdownPrompt(nodes, edges, instruction)),
          RESEARCH_MD_ANALYSIS_TIMEOUT_MS,
          `${analysisAgentLabel} analysis timed out after ${formatDuration(RESEARCH_MD_ANALYSIS_TIMEOUT_MS)}.`,
        ),
      );
      if (!markdown) {
        throw new Error(`${analysisAgentLabel} did not return Markdown content.`);
      }

      setRemoteMarkdown(markdown);
      setRemoteMarkdownUserDraft(true);
      setMarkdownAnalysis({
        status: 'done',
        message: `Received ${analysisAgentLabel} Markdown: ${nodes.length} nodes / ${edges.length} edges.`,
        startedAt,
        elapsedMs: Date.now() - startedAt,
      });
      setActiveView('markdown');
    } catch (error) {
      const message = describeFlowchartError(error);
      const silenceFallbackError = shouldSilenceFlowchartFallbackError(message);
      const fallbackMarkdown = flowchartToLocalMarkdown(nodes, edges, '', silenceFallbackError ? '' : message);
      setRemoteMarkdown(fallbackMarkdown);
      setRemoteMarkdownUserDraft(true);
      setMarkdownAnalysis({
        status: silenceFallbackError ? 'done' : 'error',
        message: `${message} Local MD.md draft was generated.`,
        startedAt,
        elapsedMs: Date.now() - startedAt,
      });
      setActiveView('markdown');
    }
  };

  const analyzeMixFlowchartWithBailianInner = async () => {
    if (!hasAnalysisAgent) {
      setMarkdownAnalysis({
        status: 'error',
        message: 'MD.mix needs an analysis agent first.',
      });
      setActiveView('markdownMix');
      return;
    }
    if (nodes.length === 0) {
      setMarkdownAnalysis({
        status: 'error',
        message: 'mix analysis diagram failed: add at least one node before running analysis.',
      });
      setActiveView('markdownMix');
      return;
    }

    const startedAt = Date.now();
    let nextFiles = sortMixMarkdownFiles(mixMarkdownFiles.filter(hasUsableMixMarkdown));
    const existingById = new Map(nextFiles.map((file) => [file.id, file]));
    const missingTopics = MIX_ANALYSIS_TOPICS.filter((topic) => !hasUsableMixMarkdown(existingById.get(topic.id)));

    if (missingTopics.length === 0) {
      setMixMarkdownFiles(nextFiles);
      setMarkdownAnalysis({
        status: 'done',
        message: `mix analysis diagram completed: ${nextFiles.length} / ${MIX_ANALYSIS_TOPICS.length}`,
        startedAt,
        elapsedMs: 0,
      });
      setActiveView('markdownMix');
      return;
    }

    if (
      analysisAgent === 'claude' ||
      analysisAgent === 'codex' ||
      analysisAgent === 'agy' ||
      analysisAgent === 'bailian'
    ) {
      setMixMarkdownFiles(nextFiles);
      setTrainingPromptDialog(null);
      setTrainingDialogSource(null);
      setMixTrainingDraft(null);
      setMarkdownAnalysis({
        status: 'running',
        message: `mix analysis diagram running: ${nextFiles.length} / ${MIX_ANALYSIS_TOPICS.length}`,
        startedAt,
      });
      setActiveView('markdownMix');

      try {
        setMarkdownAnalysis({
          status: 'running',
          message: `mix analysis diagram running: ${nextFiles.length} / ${MIX_ANALYSIS_TOPICS.length} - ${analysisAgentLabel} single SSH pass`,
          startedAt,
        });
        const output = await runSelectedTextAnalysisAgent(
          buildAgentAllMixFlowchartPrompt(missingTopics, nodes, edges),
        );
        const generatedFiles = parseMixMarkdownFilesFromAgentOutput(output, missingTopics).filter(
          hasUsableMixMarkdown,
        );
        const generatedIds = new Set(generatedFiles.map((file) => file.id));
        const missingGenerated = missingTopics.filter((topic) => !generatedIds.has(topic.id));
        if (missingGenerated.length > 0) {
          throw new Error(
            `${analysisAgentLabel} returned ${generatedFiles.length} / ${missingTopics.length} MD.mix files. ` +
              `Missing: ${missingGenerated.map((topic) => topic.fileName).join(', ')}. ` +
              'No extra SSH retries were attempted to avoid IP lockout.',
          );
        }
        nextFiles = upsertMixMarkdownFiles(nextFiles, generatedFiles);
        setMixMarkdownFiles(nextFiles);
        setMarkdownAnalysis({
          status: 'done',
          message: `mix analysis diagram completed: ${nextFiles.length} / ${MIX_ANALYSIS_TOPICS.length}`,
          startedAt,
          elapsedMs: Date.now() - startedAt,
        });
        setActiveView('markdownMix');
      } catch (error) {
        const message = describeFlowchartError(error);
        setMarkdownAnalysis({
          status: 'error',
          message: `mix analysis diagram failed: ${message}`,
          startedAt,
          elapsedMs: Date.now() - startedAt,
        });
        setActiveView('markdownMix');
      }
      return;
    }

    setMixMarkdownFiles(nextFiles);
    setTrainingPromptDialog(null);
    setTrainingDialogSource(null);
    setMixTrainingDraft(null);
    setMarkdownAnalysis({
      status: 'running',
      message: `mix analysis diagram running: ${nextFiles.length} / 5`,
      startedAt,
    });
    setActiveView('markdownMix');

    try {
      let cursor = 0;
      let concurrency = MIX_ANALYSIS_MIN_CONCURRENCY;
      const flowchartNodes = nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        title: node.title,
        subtitle: node.subtitle,
        role: node.role,
        x: node.x,
        y: node.y,
        inputs: edges.filter((edge) => edge.to === node.id).length,
        outputs: edges.filter((edge) => edge.from === node.id).length,
      }));
      const flowchartEdges = edges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        fromTitle: nodeById(nodes, edge.from)?.title || edge.from,
        toTitle: nodeById(nodes, edge.to)?.title || edge.to,
      }));

      while (cursor < missingTopics.length) {
        const remaining = missingTopics.length - cursor;
        const batchSize = remaining === 3 ? 3 : Math.min(concurrency, remaining);
        const requestedTopics = missingTopics.slice(cursor, cursor + batchSize);
        const requestedIds = new Set(requestedTopics.map((topic) => topic.id));
        let batch = requestedTopics;
        if (batch.length < MIX_ANALYSIS_MIN_CONCURRENCY) {
          const companion = MIX_ANALYSIS_TOPICS.find((topic) => !requestedIds.has(topic.id));
          if (companion) batch = [...batch, companion];
        }
        if (batch.length < MIX_ANALYSIS_MIN_CONCURRENCY) {
          throw new Error('mix analysis diagram requires at least 2 files per batch.');
        }
        setMarkdownAnalysis({
          status: 'running',
          message: `mix analysis diagram running: ${nextFiles.length} / ${MIX_ANALYSIS_TOPICS.length} - ${batch
            .map((topic) => topic.title)
            .join(', ')} (${batch.length} batch files)`,
          startedAt,
        });
        const result = await analyzeLegacyResearchFlowchartBatch({
          model: readResearchAgentModel(analysisAgent),
          items: batch.map((topic) => ({
            id: topic.id,
            title: topic.title,
            fileName: topic.fileName,
            nodes: flowchartNodes,
            edges: flowchartEdges,
            note: '',
            instruction: [
              topic.instruction,
              'Return only Markdown.',
              `The output should be one Markdown file named ${topic.fileName}.`,
              'Each file should be about 500 Chinese characters and include: 模型建議, 超參數建議, 資料前處理建議, 模型評估建議, 整體建議.',
              'Do not return raw JSON unless it is inside a fenced code block.',
            ].join('\n'),
          })),
        });
        const resultItems = batchItemsFromAnalysisResult(result);
        const batchFiles = batch.map((topic, index) => {
          const item =
            resultItems.find((candidate) => candidate.id === topic.id || candidate.fileName === topic.fileName) ||
            resultItems[index];
          const markdown = markdownFromBatchResultItem(item).trim();
          if (!markdown) {
            if (!requestedIds.has(topic.id)) {
              return (
                nextFiles.find((file) => file.id === topic.id) || {
                  id: topic.id,
                  title: topic.title,
                  fileName: topic.fileName,
                  markdown: '',
                  updatedAt: new Date().toISOString(),
                }
              );
            }
            throw new Error(`${topic.title} did not return Markdown content.`);
          }
          return {
            id: topic.id,
            title: topic.title,
            fileName: topic.fileName,
            markdown,
            updatedAt: new Date().toISOString(),
          };
        });
        nextFiles = upsertMixMarkdownFiles(
          nextFiles,
          batchFiles.filter((file) => requestedIds.has(file.id)),
        );
        setMixMarkdownFiles(nextFiles);
        concurrency = mixConcurrencyFromAnalysisResult(result);
        cursor += requestedTopics.length;
      }
      setMarkdownAnalysis({
        status: 'done',
        message: `mix analysis diagram completed: ${nextFiles.length} / ${MIX_ANALYSIS_TOPICS.length}`,
        startedAt,
        elapsedMs: Date.now() - startedAt,
      });
      setActiveView('markdownMix');
    } catch (error) {
      const message = describeFlowchartError(error);
      setMarkdownAnalysis({
        status: 'error',
        message: `mix analysis diagram failed: ${message}`,
        startedAt,
        elapsedMs: Date.now() - startedAt,
      });
      setActiveView('markdownMix');
    }
  };

  const analyzeMixFlowchartWithBailian = async () => {
    if (mixAnalysisInFlightRef.current) return;
    mixAnalysisInFlightRef.current = true;
    try {
      await analyzeMixFlowchartWithBailianInner();
    } finally {
      mixAnalysisInFlightRef.current = false;
    }
  };

  const updateSelectedMixMarkdown = (markdown: string) => {
    if (!selectedMixFile) return;
    setMixMarkdownFiles((current) =>
      current.map((file) =>
        file.id === selectedMixFile.id
          ? { ...file, markdown, updatedAt: new Date().toISOString() }
          : file,
      ),
    );
  };

  const updateTrainingDialogField = (field: keyof TrainingPromptDialogState, value: string) => {
    if (!trainingPromptDialog) return;
    const next = { ...trainingPromptDialog, [field]: value };
    setTrainingPromptDialog(next);
    if (trainingDialogSource === 'markdown') setMarkdownTrainingDraft(next);
    if (trainingDialogSource === 'markdownMix') setMixTrainingDraft(next);
  };

  const startTrainingFromMarkdown = () => {
    const markdown = pipelineMarkdown.trim();
    if (!markdown) {
      setMarkdownAnalysis({
        status: 'error',
        message: 'MD.md does not contain usable Markdown yet.',
      });
      return;
    }

    if (trainingDialogSource === 'markdown' && trainingPromptDialog) return;

    const nextDialog =
      markdownTrainingDraft ?? {
        projectName: '',
        datasetLocation: '',
        fileLocation: '',
        epoch: '',
        otherPrompt: '',
        userPrompt: buildAutoTrainingUserPrompt(markdown, nodes, edges, 'MD.md'),
        dataSource: inferDataSourceFromMarkdownAndNodes(markdown, nodes),
        modelSource: inferModelSourceFromMarkdownAndNodes(markdown, nodes),
      };
    if (!markdownTrainingDraft) setMarkdownTrainingDraft(nextDialog);
    setTrainingDialogSource('markdown');
    setTrainingPromptDialog(nextDialog);
  };

  const startTrainingFromMixMarkdown = () => {
    const markdown = mixTrainingMarkdown.trim();
    if (!hasCompleteMixMarkdown || !markdown) {
      setMarkdownAnalysis({
        status: 'error',
        message: 'MD.mix needs all five Markdown files before Start Training.',
      });
      return;
    }

    if (trainingDialogSource === 'markdownMix' && trainingPromptDialog) return;

    const nextDialog =
      mixTrainingDraft ?? {
        projectName: '',
        datasetLocation: '',
        fileLocation: '',
        epoch: '',
        otherPrompt: '',
        userPrompt: buildAutoTrainingUserPrompt(
          markdown,
          nodes,
          edges,
          `MD.mix all ${MIX_ANALYSIS_TOPICS.length} files`,
        ),
        dataSource: inferDataSourceFromMarkdownAndNodes(markdown, nodes),
        modelSource: inferModelSourceFromMarkdownAndNodes(markdown, nodes),
      };
    if (!mixTrainingDraft) setMixTrainingDraft(nextDialog);
    setTrainingDialogSource('markdownMix');
    setTrainingPromptDialog(nextDialog);
  };

  const submitTrainingPrompt = async () => {
    const markdown = (trainingDialogSource === 'markdownMix' ? mixTrainingMarkdown : pipelineMarkdown).trim();
    if (!markdown || !trainingPromptDialog) return;
    if (trainingSubmitInFlightRef.current) return;
    if (!connected) {
      setMarkdownAnalysis({
        status: 'error',
        message: 'Press Connect before sending training work to SSH agents.',
      });
      return;
    }

    trainingSubmitInFlightRef.current = true;
    setTrainingSubmitting(true);
    try {
      const servers = await listLegacyServers().catch(() => []);
      const server = findRememberedLegacyServer(servers) ?? servers[0] ?? null;
      queueCodexTrainingTask({
        agent: trainingTargetAgent,
        title: 'Start Training',
        prompt: buildTrainingPromptFromMarkdown(markdown, nodes, edges, trainingPromptDialog),
        serverId: server?.id,
        remotePath: server?.defaultPath || undefined,
      });
      const targetLabel = TRAINING_AGENT_LABELS[trainingTargetAgent];
      setTrainingPromptDialog(null);
      setTrainingDialogSource(null);
      setMarkdownAnalysis({
        status: 'done',
        message: `Start Training prompt was sent to ${targetLabel}. Open Agents / ${targetLabel} to inspect it.`,
      });
    } finally {
      trainingSubmitInFlightRef.current = false;
      setTrainingSubmitting(false);
    }
  };

  return (
    <div className={`research-workspace${activeView === 'flow' ? ' research-flow-active' : ''}`}>
      <div className="card research-summary-card">
        <div className="study-head">
          <h2>Research Lab</h2>
          <span className="chip chip-ready">Pipeline</span>
        </div>
        <div className="study-meta">
          <span>editable pipeline</span>
          <span>natural language to markdown</span>
        </div>
      </div>

      <div className="research-fixed-tabs" role="tablist" aria-label="Research workspace tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'flow'}
          className={activeView === 'flow' ? 'research-fixed-tab-active' : ''}
          onClick={() => setActiveView('flow')}
        >
          Diagram
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'markdown'}
          className={activeView === 'markdown' ? 'research-fixed-tab-active' : ''}
          onClick={() => setActiveView('markdown')}
        >
          MD.md
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'markdownMix'}
          className={activeView === 'markdownMix' ? 'research-fixed-tab-active' : ''}
          onClick={() => setActiveView('markdownMix')}
        >
          MD.mix
        </button>
      </div>

      <section className="research-pipeline-shell" hidden={activeView !== 'flow'}>
            <aside className="research-flow-panel">
              <div>
                <span className="eyebrow">Research</span>
                <strong>Flowcharts</strong>
                <small>
                  {flowchartLibrary.flowcharts.length} total / {nodes.length} nodes
                </small>
              </div>
              <button type="button" className="research-new-flow-button" onClick={createNewFlowchart}>
                + New flowchart
              </button>
              <div className="research-flow-list" aria-label="Flowchart list">
                {flowchartLibrary.flowcharts.map((flowchart, index) => {
                  const selected = flowchart.id === flowchartLibrary.activeFlowchartId;
                  const nodeCount = selected ? nodes.length : flowchart.nodes.length;
                  const edgeCount = selected ? edges.length : flowchart.edges.length;
                  return (
                    <button
                      type="button"
                      key={flowchart.id}
                      className={`research-flow-list-item${selected ? ' research-flow-list-item-active' : ''}`}
                      onClick={() => selectFlowchart(flowchart.id)}
                      aria-pressed={selected}
                    >
                      <span>{flowchart.title || `Flowchart ${index + 1}`}</span>
                      <small>
                        {nodeCount} nodes / {edgeCount} edges
                      </small>
                    </button>
                  );
                })}
              </div>
              <div className="research-flow-actions">
                <button type="button" onClick={renameActiveFlowchart} disabled={!activeFlowchart}>
                  Rename
                </button>
                <button type="button" onClick={deleteActiveFlowchart} disabled={!activeFlowchart}>
                  Delete
                </button>
              </div>
              <p className="hint">Right-click the canvas to add nodes. Drag between node ports to connect.</p>
            </aside>

            <div className="research-graph-card">
              <div className="research-graph-scroll">
                <div
                  className={`research-graph-canvas ${
                    showNodePorts ? 'research-graph-canvas-connect' : 'research-graph-canvas-move'
                  }`}
                  ref={graphRef}
                  style={graphCanvasStyle}
                  tabIndex={0}
                  aria-label="Research diagram canvas"
                  onContextMenu={openNodeMenu}
                  onPointerDown={handleGraphPointerDown}
                  onPointerMove={handleGraphPointerMove}
                  onPointerUp={finishGraphSelection}
                  onPointerCancel={finishGraphSelection}
                >
                  <svg
                    className="research-graph-lines"
                    viewBox={`0 0 ${graphSize.width} ${graphSize.height}`}
                    preserveAspectRatio="none"
                  >
                  <defs>
                    <marker
                      id="research-edge-arrow"
                      markerWidth="10"
                      markerHeight="10"
                      refX="9"
                      refY="5"
                      viewBox="0 0 10 10"
                      orient="auto"
                    >
                      <path className="research-edge-arrow-fill" d="M 1 1 L 9 5 L 1 9 z" />
                    </marker>
                    <marker
                      id="research-edge-arrow-selected"
                      markerWidth="10"
                      markerHeight="10"
                      refX="9"
                      refY="5"
                      viewBox="0 0 10 10"
                      orient="auto"
                    >
                      <path className="research-edge-arrow-selected-fill" d="M 1 1 L 9 5 L 1 9 z" />
                    </marker>
                    <marker
                      id="research-edge-arrow-draft"
                      markerWidth="10"
                      markerHeight="10"
                      refX="9"
                      refY="5"
                      viewBox="0 0 10 10"
                      orient="auto"
                    >
                      <path className="research-edge-arrow-draft-fill" d="M 1 1 L 9 5 L 1 9 z" />
                    </marker>
                  </defs>
                  {edges.map((edge) => {
                    const from = nodeById(nodes, edge.from);
                    const to = nodeById(nodes, edge.to);
                    if (!from || !to) return null;
                    const selected = selectedEdgeId === edge.id;
                    const start = portPoint(from, edge.fromSide ?? autoPortSide(from, to, 'from'));
                    const end = portPoint(to, edge.toSide ?? autoPortSide(from, to, 'to'));
                    return (
                      <g
                        key={edge.id}
                        role="button"
                        tabIndex={0}
                        className="research-edge-hit"
                        onClick={() => setSelectedEdgeId(edge.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedEdgeId(edge.id);
                          }
                        }}
                      >
                        <line
                          className="research-edge-target"
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                        />
                        <line
                          className={selected ? 'research-edge research-edge-selected' : 'research-edge'}
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                          markerEnd={
                            selected ? 'url(#research-edge-arrow-selected)' : 'url(#research-edge-arrow)'
                          }
                        />
                      </g>
                    );
                  })}
                  {connectionDraft ? (() => {
                    const from = nodeById(nodes, connectionDraft.from);
                    if (!from) return null;
                    return (
                      <line
                        className="research-edge research-edge-draft"
                        x1={portPoint(from, connectionDraft.fromSide).x}
                        y1={portPoint(from, connectionDraft.fromSide).y}
                        x2={(connectionDraft.x / 100) * graphSize.width}
                        y2={(connectionDraft.y / 100) * graphSize.height}
                        markerEnd="url(#research-edge-arrow-draft)"
                      />
                    );
                  })() : null}
                </svg>
                {selectionBox ? (
                  <div
                    className="research-selection-box"
                    style={{
                      left: `${Math.min(selectionBox.startX, selectionBox.currentX)}%`,
                      top: `${Math.min(selectionBox.startY, selectionBox.currentY)}%`,
                      width: `${Math.abs(selectionBox.currentX - selectionBox.startX)}%`,
                      height: `${Math.abs(selectionBox.currentY - selectionBox.startY)}%`,
                    }}
                  />
                ) : null}
                {nodes.map((node) => (
                  <div
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    data-research-node-id={node.id}
                    className={`research-node research-node-${node.role}${
                      selectedNodeId === node.id || selectedNodeIds.includes(node.id) ? ' research-node-selected' : ''
                    }${draggingNodeId === node.id ? ' research-node-dragging' : ''
                    }`}
                    style={{ left: `${node.x}%`, top: `${node.y}%` }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.focus();
                      const multiSelect = event.shiftKey || event.ctrlKey || event.metaKey;
                      if (multiSelect) {
                        const nextSelectedIds = selectedNodeIds.includes(node.id)
                          ? selectedNodeIds.filter((id) => id !== node.id)
                          : [...selectedNodeIds, node.id];
                        setSelectedNodeIds(nextSelectedIds);
                        setSelectedNodeId(nextSelectedIds[0] || '');
                        setSelectedEdgeId('');
                        return;
                      }
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const groupIds =
                        selectedNodeIds.includes(node.id) && selectedNodeIds.length > 1
                          ? selectedNodeIds
                          : [node.id];
                      const activeGroupIds = groupIds.length > 0 ? groupIds : [node.id];
                      const selected = new Set(activeGroupIds);
                      const initial = nodes
                        .filter((item) => selected.has(item.id))
                        .reduce<Record<string, { x: number; y: number }>>((record, item) => {
                          record[item.id] = { x: item.x, y: item.y };
                          return record;
                        }, {});
                      const point = pointerToGraphPercent(event.clientX, event.clientY);
                      setSelectedNodeId(node.id);
                      setSelectedNodeIds(activeGroupIds);
                      setSelectedEdgeId('');
                      if (point) {
                        setDragGroup({
                          pointerId: event.pointerId,
                          nodeIds: activeGroupIds,
                          startX: point.x,
                          startY: point.y,
                          initial,
                        });
                      }
                    }}
                    onPointerMove={(event) => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      setDraggingNodeId(node.id);
                      if (dragGroup?.pointerId === event.pointerId) {
                        moveDragGroupToPointer(dragGroup, event.clientX, event.clientY);
                      } else {
                        moveNodeToPointer(node.id, event.clientX, event.clientY);
                      }
                    }}
                    onPointerUp={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      setDraggingNodeId('');
                      setDragGroup(null);
                    }}
                    onPointerCancel={() => {
                      setDraggingNodeId('');
                      setDragGroup(null);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedNodeId(node.id);
                        setSelectedNodeIds([node.id]);
                        setSelectedEdgeId('');
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="research-node-delete"
                      title="Delete node"
                      aria-label={`Delete ${node.title}`}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        deleteNode(node.id);
                      }}
                    >
                      x
                    </button>
                    {showNodePorts ? NODE_PORT_SIDES.map((side) => (
                      <span
                        key={side}
                        className={`research-node-port research-node-port-${side}`}
                        role="button"
                        tabIndex={0}
                        title={`${side} port`}
                        aria-label={`Create connection from ${node.title} ${side} port`}
                        data-research-node-port-side={side}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const point = pointerToGraphPercent(event.clientX, event.clientY);
                          if (!point) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setSelectedNodeId(node.id);
                          setSelectedEdgeId('');
                          setConnectionDraft({
                            from: node.id,
                            fromSide: side,
                            x: point.x,
                            y: point.y,
                            pointerId: event.pointerId,
                          });
                        }}
                        onPointerMove={(event) => {
                          event.stopPropagation();
                          const point = pointerToGraphPercent(event.clientX, event.clientY);
                          if (!point) return;
                          setConnectionDraft((current) =>
                            current?.pointerId === event.pointerId
                              ? { ...current, x: point.x, y: point.y }
                              : current,
                          );
                        }}
                        onPointerUp={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                          }
                          const draft = connectionDraft;
                          setConnectionDraft(null);
                          if (!draft || draft.pointerId !== event.pointerId) return;
                          const targetElement = document
                            .elementFromPoint(event.clientX, event.clientY)
                            ?.closest<HTMLElement>('[data-research-node-id]');
                          const targetNodeId = targetElement?.dataset.researchNodeId;
                          const targetNode = targetNodeId ? nodeById(nodes, targetNodeId) : null;
                          if (targetNodeId && targetNode) {
                            const targetPortElement = document
                              .elementFromPoint(event.clientX, event.clientY)
                              ?.closest<HTMLElement>('[data-research-node-port-side]');
                            const toSide = isPipelinePortSide(targetPortElement?.dataset.researchNodePortSide)
                              ? targetPortElement.dataset.researchNodePortSide
                              : nearestPortSide(targetNode, event.clientX, event.clientY);
                            createConnection(draft.from, targetNodeId, draft.fromSide, toSide);
                          }
                        }}
                        onPointerCancel={(event) => {
                          event.stopPropagation();
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                          }
                          setConnectionDraft((current) =>
                            current?.pointerId === event.pointerId ? null : current,
                          );
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            setSelectedNodeId(node.id);
                            setSelectedEdgeId('');
                          }
                        }}
                      />
                    )) : null}
                    <span className="research-node-kind">{node.kind.toUpperCase()}</span>
                    <strong>{node.title}</strong>
                    <small>{node.subtitle}</small>
                  </div>
                ))}
                {nodeMenu ? (
                  <div
                    className="research-node-menu"
                    style={{ left: `${nodeMenu.x}%`, top: `${nodeMenu.y}%` }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    <span>Add node</span>
                    {NODE_TEMPLATES.map((template) => (
                      <button
                        type="button"
                        key={template.label}
                        onClick={() => addNodeFromTemplate(template)}
                      >
                        {template.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              </div>
            </div>

            <aside className="research-inspector">
              {selectedNode ? (
                <>
                  <span className="eyebrow">Stage inspector</span>
                  <h3>{selectedNode.title}</h3>
                  <span className={`chip chip-research-${selectedNode.role}`}>{selectedNode.role}</span>
                  {selectedNode.role === 'application' ? (
                    <label className="research-node-editor">
                      <span>Application name</span>
                      <input
                        value={selectedNode.title}
                        onChange={(event) => updateSelectedApplicationTitle(event.target.value)}
                        onBlur={normalizeSelectedApplicationTitle}
                        placeholder="Application"
                      />
                    </label>
                  ) : null}
                  <dl>
                    <div>
                      <dt>Type</dt>
                      <dd>{selectedNode.kind}</dd>
                    </div>
                    <div>
                      <dt>Note</dt>
                      <dd>{selectedNode.subtitle}</dd>
                    </div>
                    <div>
                      <dt>Inputs</dt>
                      <dd>{edges.filter((edge) => edge.to === selectedNode.id).length}</dd>
                    </div>
                    <div>
                      <dt>Outputs</dt>
                      <dd>{edges.filter((edge) => edge.from === selectedNode.id).length}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <div className="research-empty-inspector">
                  <span className="eyebrow">Stage inspector</span>
                  <h3>No node selected</h3>
                  <p className="hint">Select a node to inspect and edit its role.</p>
                </div>
              )}
              <div className="research-edge-actions">
                <div className="research-port-toggle">
                  <span>Edit mode</span>
                  <button
                    type="button"
                    className={showNodePorts ? 'research-port-toggle-active' : ''}
                    aria-pressed={showNodePorts}
                    onClick={() => setShowNodePorts((current) => !current)}
                  >
                    {showNodePorts ? 'Connect' : 'Move'}
                  </button>
                </div>
                <strong>Selected connection</strong>
                <span>
                  {selectedEdge
                    ? `${nodeById(nodes, selectedEdge.from)?.title || selectedEdge.from} -> ${
                        nodeById(nodes, selectedEdge.to)?.title || selectedEdge.to
                      }`
                    : 'None'}
                </span>
                <button type="button" disabled={!selectedEdgeId} onClick={removeSelectedConnection}>
                  Delete connection
                </button>
                <button type="button" onClick={resetConnections}>
                  Reset graph
                </button>
              </div>
              <div className="research-inspector-analysis">
                <span className="research-inspector-section-title">Analysis agent</span>
                <div className="research-connection-toolbar">
                  <label className="research-analysis-agent-select">
                    <select
                      value={analysisAgent}
                      onChange={(event) => setAnalysisAgent(event.target.value as ResearchAnalysisAgent)}
                      aria-label="Analysis agent"
                    >
                      <option value="">Select agent</option>
                      <option value="claude">Claude</option>
                      <option value="codex">Codex</option>
                      <option value="agy">agy</option>
                      <option value="bailian">baillian</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void analyzeFlowchartWithBailian()}
                    disabled={!hasAnalysisAgent || markdownAnalysis.status === 'running' || nodes.length === 0}
                  >
                    default analysis diagram
                  </button>
                  <button
                    type="button"
                    onClick={() => void analyzeMixFlowchartWithBailian()}
                    disabled={!hasAnalysisAgent || markdownAnalysis.status === 'running' || nodes.length === 0}
                  >
                    mix analysis diagram
                  </button>
                  <button
                    type="button"
                    className={codexDiagramOpen ? 'research-codex-draw-toggle-active' : ''}
                    aria-pressed={codexDiagramOpen}
                    onClick={() => setCodexDiagramOpen(true)}
                    disabled={!hasAnalysisAgent}
                  >
                    agent draw
                  </button>
                </div>
                {codexDiagramStatus.message || codexDiagramJson ? (
                  <div className="research-codex-draw-panel research-codex-draw-panel-compact">
                    <div className="research-codex-draw-actions">
                      <small>{analysisAgentLabel} will draw and apply the Diagram automatically.</small>
                      {codexDiagramStatus.message ? (
                        <span className={`research-codex-draw-status research-analysis-${codexDiagramStatus.status}`}>
                          {codexDiagramStatus.message}
                        </span>
                      ) : null}
                    </div>
                    <details className="research-codex-draw-advanced">
                      <summary>Advanced JSON</summary>
                      <label className="research-codex-draw-field">
                        <span>Diagram JSON</span>
                        <textarea
                          value={codexDiagramJson}
                          onChange={(event) => setCodexDiagramJson(event.target.value)}
                          placeholder='Paste JSON with "nodes" and "edges" here.'
                        />
                      </label>
                      <div className="research-codex-draw-actions">
                        <button type="button" onClick={applyCodexDiagramJson}>
                          Apply pasted JSON
                        </button>
                      </div>
                    </details>
                  </div>
                ) : null}
              </div>
            </aside>
          </section>

          <section className="card research-markdown-card" hidden={activeView !== 'markdown'}>
            <div className="research-card-head">
              <div>
                <h3>MD.md</h3>
                <p className="hint">
                  {hasRemoteMarkdown
                    ? 'Received Markdown from baillian. Review and start training when ready.'
                    : 'No baillian result yet. Showing the local Markdown draft.'}
                </p>
              </div>
              <div className="research-markdown-actions">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(pipelineMarkdown)}
                >
                  Copy
                </button>
                <button type="button" onClick={() => setMarkdownSourceOpen((current) => !current)}>
                  {markdownSourceOpen ? 'Hide source' : 'Edit source'}
                </button>
                <button type="button" onClick={startTrainingFromMarkdown}>
                  Start Training
                </button>
              </div>
            </div>
            {trainingPromptDialog && trainingDialogSource === 'markdown' ? (
              <div className="research-training-panel" role="region" aria-labelledby="start-training-title">
                <div className="research-training-panel-head">
                  <div>
                    <h4 id="start-training-title">Start Training</h4>
                    <p className="hint">
                      MD.md is used as the main training schedule prompt. Add project, dataset, output location, epoch, prompts, data, and model sources before sending.
                    </p>
                  </div>
                  <div className="form-actions research-training-actions">
                    <button
                      type="button"
                      className="danger research-training-cancel"
                      onClick={() => {
                        setTrainingPromptDialog(null);
                        setTrainingDialogSource(null);
                      }}
                    >
                      Cancel
                    </button>
                    <label className="research-agent-send-select">
                      <span>Send to</span>
                      <select
                        value={trainingTargetAgent}
                        onChange={(event) => setTrainingTargetAgent(event.target.value as QueuedTrainingAgent)}
                      >
                        <option value="claude">Claude</option>
                        <option value="codex">Codex</option>
                        <option value="agy">agy</option>
                        <option value="bailian">baillian</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void submitTrainingPrompt()}
                      disabled={trainingSubmitting}
                    >
                      {trainingSubmitting ? 'Sending...' : 'Send'}
                    </button>
                  </div>
                </div>
                <div className="research-training-meta">
                  <label className="research-training-field">
                    <span>Project name</span>
                    <input
                      type="text"
                      value={trainingPromptDialog.projectName ?? ''}
                      onChange={(event) => updateTrainingDialogField('projectName', event.target.value)}
                      placeholder="Folder name to create or reuse for outputs."
                    />
                  </label>
                  <label className="research-training-field">
                    <span>Dataset location</span>
                    <input
                      type="text"
                      value={trainingPromptDialog.datasetLocation ?? ''}
                      onChange={(event) => updateTrainingDialogField('datasetLocation', event.target.value)}
                      placeholder="Dataset path, e.g. /ssd/datasets/Celeb-DF"
                    />
                  </label>
                  <label className="research-training-field">
                    <span>File location</span>
                    <input
                      type="text"
                      value={trainingPromptDialog.fileLocation ?? ''}
                      onChange={(event) => updateTrainingDialogField('fileLocation', event.target.value)}
                      placeholder="Output/save path, e.g. /ssd/results/project"
                    />
                  </label>
                  <label className="research-training-field">
                    <span>Epoch</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={trainingPromptDialog.epoch ?? ''}
                      onChange={(event) => updateTrainingDialogField('epoch', event.target.value)}
                      placeholder="Optional max epoch; early stop still applies."
                    />
                  </label>
                </div>
                <label className="research-training-field">
                  <span>Prompt</span>
                  <textarea
                    value={trainingPromptDialog.userPrompt}
                    onChange={(event) => updateTrainingDialogField('userPrompt', event.target.value)}
                    placeholder="Auto-filled from MD.md and Diagram. You can edit before sending."
                  />
                </label>
                <label className="research-training-field">
                  <span>Other prompt</span>
                  <textarea
                    value={trainingPromptDialog.otherPrompt ?? ''}
                    onChange={(event) => updateTrainingDialogField('otherPrompt', event.target.value)}
                  />
                </label>
                <div className="research-training-sources">
                  <label className="research-training-field">
                    <span>Data source</span>
                    <textarea
                      value={trainingPromptDialog.dataSource}
                      onChange={(event) => updateTrainingDialogField('dataSource', event.target.value)}
                      placeholder="Auto-filled dataset path, split files, labels, or preprocessing notes."
                    />
                  </label>
                  <label className="research-training-field">
                    <span>Model source</span>
                    <textarea
                      value={trainingPromptDialog.modelSource}
                      onChange={(event) => updateTrainingDialogField('modelSource', event.target.value)}
                      placeholder="Auto-filled base model, checkpoint, config, or training script path."
                    />
                  </label>
                </div>
                <details className="research-training-preview">
                  <summary>Preview prompt</summary>
                  <pre>
                    {buildTrainingPromptFromMarkdown(
                      pipelineMarkdown.trim(),
                      nodes,
                      edges,
                      trainingPromptDialog,
                    )}
                  </pre>
                </details>
              </div>
            ) : null}
            {visibleMarkdownAnalysisMessage ? (
              <div className={`research-analysis-status research-analysis-${markdownAnalysis.status}`}>
                <span>{visibleMarkdownAnalysisMessage}</span>
                {markdownAnalysis.startedAt ? (
                  <strong>Elapsed {formatDuration(analysisElapsedMs)}</strong>
                ) : null}
              </div>
            ) : null}
            {markdownSourceOpen ? (
              <textarea
                className="research-markdown-editor"
                value={pipelineMarkdown}
                onChange={(event) => {
                  setRemoteMarkdownUserDraft(true);
                  setRemoteMarkdown(event.target.value);
                }}
                aria-label="MD.md source"
                spellCheck={false}
              />
            ) : null}
            <div className="research-markdown-preview">
              <Markdown remarkPlugins={[remarkGfm]}>{pipelineMarkdown}</Markdown>
            </div>
          </section>

          <section className="research-markdown-mix" hidden={activeView !== 'markdownMix'}>
            <aside className="research-mix-sidebar">
              <div className="research-mix-sidebar-head">
                <strong>MD.mix</strong>
                <button
                  type="button"
                  onClick={() => void analyzeMixFlowchartWithBailian()}
                  disabled={!hasAnalysisAgent || markdownAnalysis.status === 'running' || nodes.length === 0}
                >
                  Refresh
                </button>
              </div>
              <div className={`research-mix-counter research-analysis-${markdownAnalysis.status}`}>
                <strong>
                  {mixAnalysisCount} / {mixAnalysisTotal}
                </strong>
                <span>
                  {markdownAnalysis.status === 'running' && isMixAnalysisMessage
                    ? 'Analyzing feedback'
                    : hasMixMarkdownFiles
                      ? 'Feedback files'
                      : 'No feedback yet'}
                </span>
                {visibleMixAnalysisMessage ? <small>{visibleMixAnalysisMessage}</small> : null}
                {markdownAnalysis.startedAt && isMixAnalysisMessage ? (
                  <small>Elapsed {formatDuration(analysisElapsedMs)}</small>
                ) : null}
              </div>
              <button
                type="button"
                className="primary"
                disabled={!hasCompleteMixMarkdown}
                onClick={startTrainingFromMixMarkdown}
              >
                Start Training
              </button>
              <button
                type="button"
                disabled={!selectedMixFile}
                onClick={() => setMixSourceOpen((current) => !current)}
              >
                {mixSourceOpen ? 'Hide source' : 'Edit source'}
              </button>
              <div className="research-mix-file-list">
                {mixMarkdownFiles.map((file) => (
                  <button
                    type="button"
                    key={file.id}
                    className={selectedMixFile?.id === file.id ? 'research-mix-file-active' : ''}
                    onClick={() => setSelectedMixFileId(file.id)}
                  >
                    <span>{file.title}</span>
                    <small>{file.fileName}</small>
                  </button>
                ))}
                {!hasMixMarkdownFiles ? (
                  <div className="research-empty">
                    <strong>No flowchart feedback yet</strong>
                    <span>Run mix analysis diagram. Five Markdown files will appear here.</span>
                  </div>
                ) : null}
              </div>
            </aside>
            <main className="research-mix-preview">
              {trainingPromptDialog && trainingDialogSource === 'markdownMix' ? (
                <div className="research-training-panel" role="region" aria-labelledby="start-training-mix-title">
                  <div className="research-training-panel-head">
                    <div>
                      <h4 id="start-training-mix-title">Start Training</h4>
                      <p className="hint">
                        This uses all five MD.mix files as the training schedule prompt.
                      </p>
                    </div>
                    <div className="form-actions research-training-actions">
                      <button
                        type="button"
                        className="danger research-training-cancel"
                        onClick={() => {
                          setTrainingPromptDialog(null);
                          setTrainingDialogSource(null);
                        }}
                      >
                        Cancel
                      </button>
                      <label className="research-agent-send-select">
                        <span>Send to</span>
                        <select
                          value={trainingTargetAgent}
                          onChange={(event) => setTrainingTargetAgent(event.target.value as QueuedTrainingAgent)}
                        >
                          <option value="claude">Claude</option>
                          <option value="codex">Codex</option>
                          <option value="agy">agy</option>
                          <option value="bailian">baillian</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void submitTrainingPrompt()}
                        disabled={trainingSubmitting}
                      >
                        {trainingSubmitting ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                  </div>
                  <div className="research-training-meta">
                    <label className="research-training-field">
                      <span>Project name</span>
                      <input
                        type="text"
                        value={trainingPromptDialog.projectName ?? ''}
                        onChange={(event) => updateTrainingDialogField('projectName', event.target.value)}
                        placeholder="Folder name to create or reuse for outputs."
                      />
                    </label>
                    <label className="research-training-field">
                      <span>Dataset location</span>
                      <input
                        type="text"
                        value={trainingPromptDialog.datasetLocation ?? ''}
                        onChange={(event) => updateTrainingDialogField('datasetLocation', event.target.value)}
                        placeholder="Dataset path, e.g. /ssd/datasets/Celeb-DF"
                      />
                    </label>
                    <label className="research-training-field">
                      <span>File location</span>
                      <input
                        type="text"
                        value={trainingPromptDialog.fileLocation ?? ''}
                        onChange={(event) => updateTrainingDialogField('fileLocation', event.target.value)}
                        placeholder="Output/save path, e.g. /ssd/results/project"
                      />
                    </label>
                    <label className="research-training-field">
                      <span>Epoch</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={trainingPromptDialog.epoch ?? ''}
                        onChange={(event) => updateTrainingDialogField('epoch', event.target.value)}
                        placeholder="Optional max epoch; early stop still applies."
                      />
                    </label>
                  </div>
                  <label className="research-training-field">
                    <span>Prompt</span>
                    <textarea
                      value={trainingPromptDialog.userPrompt}
                      onChange={(event) => updateTrainingDialogField('userPrompt', event.target.value)}
                    />
                  </label>
                  <label className="research-training-field">
                    <span>Other prompt</span>
                    <textarea
                      value={trainingPromptDialog.otherPrompt ?? ''}
                      onChange={(event) => updateTrainingDialogField('otherPrompt', event.target.value)}
                    />
                  </label>
                  <div className="research-training-sources">
                    <label className="research-training-field">
                      <span>Data source</span>
                      <textarea
                        value={trainingPromptDialog.dataSource}
                        onChange={(event) => updateTrainingDialogField('dataSource', event.target.value)}
                      />
                    </label>
                    <label className="research-training-field">
                      <span>Model source</span>
                      <textarea
                        value={trainingPromptDialog.modelSource}
                        onChange={(event) => updateTrainingDialogField('modelSource', event.target.value)}
                      />
                    </label>
                  </div>
                  <details className="research-training-preview">
                    <summary>Preview prompt</summary>
                    <pre>
                      {buildTrainingPromptFromMarkdown(
                        mixTrainingMarkdown,
                        nodes,
                        edges,
                        trainingPromptDialog,
                      )}
                    </pre>
                  </details>
                </div>
              ) : null}
              {selectedMixFile && mixSourceOpen ? (
                <textarea
                  className="research-markdown-editor research-mix-markdown-editor"
                  value={selectedMixFile.markdown}
                  onChange={(event) => updateSelectedMixMarkdown(event.target.value)}
                  aria-label={`${selectedMixFile.fileName} source`}
                  spellCheck={false}
                />
              ) : null}
              <div className="research-markdown-preview">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {selectedMixFile?.markdown || '# MD.mix\n\nNo Markdown file selected yet.'}
                </Markdown>
              </div>
            </main>
          </section>
      {codexDiagramOpen ? (
        <div
          className="modal-overlay research-codex-draw-modal-overlay"
          role="presentation"
          onClick={() => {
            if (codexDiagramStatus.status !== 'running') setCodexDiagramOpen(false);
          }}
        >
          <section
            className="modal research-codex-draw-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="research-codex-draw-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head research-codex-draw-modal-head">
              <div>
                <h2 id="research-codex-draw-modal-title">Agent Draw</h2>
                <p className="hint">
                  Use natural language to ask {analysisAgentLabel} to rewrite the current Diagram.
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Close agent draw prompt"
                onClick={() => setCodexDiagramOpen(false)}
                disabled={codexDiagramStatus.status === 'running'}
              >
                x
              </button>
            </div>
            <label className="research-codex-draw-field research-codex-draw-modal-field">
              <span>Prompt</span>
              <textarea
                value={codexDiagramPrompt}
                onChange={(event) => setCodexDiagramPrompt(event.target.value)}
                placeholder="Example: draw a YOLO training flow from dataset, preprocessing, model, training, evaluation, and deployment."
                autoFocus
              />
            </label>
            {codexDiagramStatus.message ? (
              <div className={`research-codex-draw-modal-status research-analysis-${codexDiagramStatus.status}`}>
                {codexDiagramStatus.message}
              </div>
            ) : null}
            <div className="form-actions research-codex-draw-modal-actions">
              <button
                type="button"
                className="danger"
                onClick={() => setCodexDiagramOpen(false)}
                disabled={codexDiagramStatus.status === 'running'}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={async () => {
                  const applied = await sendDiagramPromptToCodex();
                  if (applied) setCodexDiagramOpen(false);
                }}
                disabled={!hasAnalysisAgent || codexDiagramStatus.status === 'running'}
              >
                {codexDiagramStatus.status === 'running' ? 'Sending...' : `Send to ${analysisAgentLabel}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
