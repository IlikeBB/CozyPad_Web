export function executionMode(value = 'general') {
  if (!['general', 'delegated', 'cooperative'].includes(value)) throw Object.assign(new Error('無效的 Codex 執行模式。'), { status: 400 });
  return value;
}

export function executionConfig(mode) {
  const enabled = executionMode(mode) === 'delegated';
  return { 'agents.enabled': enabled, ...(enabled ? { 'agents.max_concurrent_threads_per_session': 2 } : {}) };
}

export function executionInstruction(mode) {
  return executionMode(mode) === 'delegated'
    ? '本輪使用委派處理：請使用 Codex 子代理處理可獨立分工的大型文件或程式碼工作，再由主代理檢查結果並彙整回覆。給子代理明確範圍、不同的檔案責任與必要的上下文，要求回傳精簡摘要及產出路徑，避免將完整文件或大量日誌帶回主對話。短小或互相依賴的工作可直接處理。不啟用額外付費 API，不另建 SSH 登入，所有動作遵守本輪的權限與核准設定。'
    : '本輪使用一般處理：由目前的 Codex 直接完成工作，不建立或委派子代理；遵守目前的權限與核准設定。';
}

export function supportsDelegation(version) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version || '');
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 161);
}

export function delegationDetails(item) {
  const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  return {
    tool: text(item.tool, 40), status: text(item.status, 40), model: text(item.model, 128),
    prompt: text(item.prompt, 2048),
    agents: Object.entries(item.agentsStates || {}).slice(0, 8).map(([id, state]) => ({
      id: text(id, 128), status: text(state?.status, 40), message: text(state?.message, 4096)
    }))
  };
}
