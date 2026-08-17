export const V4_STORAGE_KEYS = {
  agents: {
    codexTasks: 'cozypad4.legacyCodexTasks.v1',
    claudeTasks: 'cozypad4.legacyClaudeTasks.v1',
    agyTasks: 'cozypad4.legacyAgyTasks.v1',
    bailianTasks: 'cozypad4.legacyBailianTasks.v1',
    codexComposerDraft: 'cozypad4.legacyCodexComposerDraft.v1',
  },
  agentModels: {
    codex: 'cozypad4.remoteCodex.model.v1',
    codexReasoningEffort: 'cozypad4.remoteCodex.reasoningEffort.v1',
    claude: 'cozypad4.remoteClaude.model.v1',
    agy: 'cozypad4.remoteAgy.model.v1',
    bailian: 'cozypad4.remoteBailian.model.v1',
  },
  research: {
    pipelineNodes: 'cozypad4.researchPipelineNodes.v1',
    pipelineEdges: 'cozypad4.researchPipelineEdges.v1',
    flowcharts: 'cozypad4.researchFlowcharts.v2',
    activeFlowchart: 'cozypad4.researchActiveFlowchart.v1',
    markdown: 'cozypad4.researchRemoteMarkdown.v1',
    markdownByFlowchart: 'cozypad4.researchRemoteMarkdownByFlowchart.v1',
  },
  workRuns: {
    deletedRunIds: 'cozypad4.deletedWorkRunIds.v1',
  },
  sshServers: {
    lastSelectedLegacyServerId: 'cozypad4.lastSelectedLegacyServerId',
  },
  queues: {
    codexTrainingTasks: 'cozypad4.pendingCodexTrainingTasks.v1',
  },
} as const;

export const V4_STORAGE_EVENTS = {
  codexTrainingTaskQueued: 'cozypad4:codex-training-task-queued',
  lastSelectedLegacyServer: 'cozypad4:last-selected-legacy-server',
} as const;
