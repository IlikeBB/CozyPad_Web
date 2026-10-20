import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, ChevronDown, History, LoaderCircle, PanelLeft, PanelRight, Paperclip, Square, Trash2, X } from 'lucide-react';
import type { AgentEvent, AgentTask, BrowserDirectoryContext, CodexModel, FileEntry, ServerProfile } from '@cozypad/contracts';
import { api, ApiError, message, post, serverQuery } from '../api';
import { Dialog, IconButton } from '../components/Controls';
import { AgentDrawer } from '../components/AgentDrawer';
import { AgentTaskList, taskLabels, type TaskStage } from '../components/AgentTaskList';
import { AgentSettings, type AgentOptions } from '../components/AgentSettings';
import { AgentTimeline } from '../components/AgentTimeline';
import { AgentApprovalSelect } from '../components/AgentApprovalSelect';
import { AgentExecutionSelect } from '../components/AgentExecutionSelect';
import { AgentAttachmentTray } from '../components/AgentAttachments';
import { AgentDirectorySelect } from '../components/AgentDirectorySelect';
import { BrowserDirectoryPicker } from '../components/BrowserDirectoryPicker';
import { AgentFileExplorer } from '../components/AgentFileExplorer';
import { AgentEditorTabs, type EditorTab } from '../components/AgentEditorTabs';
import { AgentFilePreview, type FilePreview } from '../components/AgentFilePreview';
import { mediaType } from '../../../../packages/contracts/src/media-types.mjs';
import { attachmentAccept, attachmentLimits } from '@cozypad/contracts';
import type { LocalMarkdownReader } from './markdown-directory.mjs';
import { useAgentAttachments, type PendingAttachment } from './use-agent-attachments';
import { mergeEvent, mergeHistory } from './chat-state';

function readOptions(key: string, servers: ServerProfile[]): AgentOptions {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    if (value.executionMode === 'cooperative' && !servers.some(server => server.id === value.cooperationTargetId)) value.executionMode = 'general';
    return { model: typeof value.model === 'string' ? value.model : '', reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '', approvalMode: ['ask', 'auto', 'full-access'].includes(value.approvalMode) ? value.approvalMode : 'auto', executionMode: ['delegated', 'cooperative'].includes(value.executionMode) ? value.executionMode : 'general', cooperationTargetId: typeof value.cooperationTargetId === 'string' ? value.cooperationTargetId : '', cooperationPath: typeof value.cooperationPath === 'string' ? value.cooperationPath : '' };
  } catch { return { model: '', reasoningEffort: '', approvalMode: 'auto', executionMode: 'general' }; }
}

type ChatTab = { key: string; taskId: string | null; label: string };
type ComposerDraft = { prompt: string; path: string; options: AgentOptions; files: PendingAttachment[] };

export function AgentsWorkspace({ server, servers, username, initialTaskId, onOpenTask }: { server: ServerProfile; servers: ServerProfile[]; username: string; initialTaskId?: string; onOpenTask: (serverId: string, taskId: string) => void }) {
  const preferenceKey = `cozypad-tt:${username.toLowerCase()}:agent:${server.id}`;
  const [options, setOptions] = useState(() => readOptions(preferenceKey, servers));
  const [drawers, setDrawers] = useState(() => ({ left: window.matchMedia('(min-width: 1280px)').matches, right: false }));
  const [leftMode, setLeftMode] = useState<'files' | 'history'>('files');
  const [hovered, setHovered] = useState<'left' | 'right' | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leftOpen = drawers.left || hovered === 'left';
  const rightOpen = drawers.right || hovered === 'right';
  const [overlay, setOverlay] = useState(() => window.matchMedia('(max-width: 1279px)').matches);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<ChatTab[]>([{ key: 'draft:1', taskId: null, label: '新對話 1' }]);
  const [tabKey, setTabKey] = useState('draft:1');
  const drafts = useRef(new Map<string, ComposerDraft>()), draftSequence = useRef(1);
  const [previewFiles, setPreviewFiles] = useState<FilePreview[]>([]), [previewPath, setPreviewPath] = useState<string | null>(null);
  const previewRequests = useRef(new Map<string, number>());
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<TaskStage>('all');
  const [prompt, setPrompt] = useState('');
  const [path, setPath] = useState(server.defaultPath);
  const [directoryBusy, setDirectoryBusy] = useState(false), [localBusy, setLocalBusy] = useState(false);
  const [explorerBusy, setExplorerBusy] = useState(false);
  const [localContext, setLocalContext] = useState<BrowserDirectoryContext | undefined>(undefined);
  const markdownReader = useRef<LocalMarkdownReader | undefined>(undefined), markdownAbort = useRef<AbortController | null>(null);
  const [preparingMarkdown, setPreparingMarkdown] = useState(false);
  const registerMarkdownReader = useCallback((reader: LocalMarkdownReader | undefined) => { markdownReader.current = reader; }, []);
  useEffect(() => () => { markdownAbort.current?.abort(); }, []);
  const [peerBusy, setPeerBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const steeringDrafts = useRef(new Map<string, { requestId: string; prompt: string; expectedTurnId: string }>());
  const choiceSteers = useRef(new Map<string, { answer: string; payload: { requestId: string; prompt: string; expectedTurnId: string; replyToEventId: number } }>());
  const selection = useRef(selected);
  selection.current = selected;
  const [deleteTarget, setDeleteTarget] = useState<AgentTask | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleted = useRef(new Set<string>());
  const [error, setError] = useState('');
  const [models, setModels] = useState<CodexModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState('');
  const modelRequest = useRef(0);
  const workspace = useRef(server.id);
  const timeline = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const active = tasks.find(task => task.id === selected);
  const running = active?.status === 'running';
  const anyRunning = tasks.some(task => task.status === 'running');
  const attachments = useAgentAttachments(busy || !!running || loadingTasks || !!active?.remoteThreadDeleted);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const peers = servers.filter(item => item.id !== server.id);
  const peer = peers.find(item => item.id === options.cooperationTargetId);
  const canCooperate = !active?.threadId || !!active.cooperationToolEnabled;
  const cooperationReady = options.executionMode !== 'cooperative' || (!!peer && canCooperate);
  const sendBlockedReason = active?.remoteThreadDeleted ? '遠端對話已刪除，請新增對話。'
    : busy ? '訊息正在送出…'
    : running && !active.activeTurnId ? '目前連線需等回覆結束後送出訊息。'
    : loadingTasks ? '正在載入對話…'
    : attachments.reading ? '正在準備附件…'
    : directoryBusy || explorerBusy ? '正在確認工作目錄…'
    : localBusy ? '正在讀取本機參考資料夾…'
    : peerBusy ? '正在確認協同端工作目錄…'
    : !running && !cooperationReady ? canCooperate ? '請選擇協同端，或改用一般處理。' : '此對話未載入協同工具，請新增對話或改用一般處理。'
    : '';
  const canSubmit = (!!prompt.trim() || (!running && !!attachments.files.length)) && !sendBlockedReason;
  const tabsDisabled = busy || attachments.reading || loadingTasks;
  const closeLeft = useCallback(() => { setDrawers(previous => ({ ...previous, left: false })); setHovered(previous => previous === 'left' ? null : previous); }, []);
  const closeRight = useCallback(() => { setDrawers(previous => ({ ...previous, right: false })); setHovered(previous => previous === 'right' ? null : previous); }, []);
  const toggleDrawer = (side: 'left' | 'right') => {
    clearTimeout(hoverTimer.current); setHovered(null);
    setDrawers(previous => ({ ...previous, ...(overlay ? { left: false, right: false } : {}), [side]: !previous[side] }));
  };
  const hoverDrawer = (side: 'left' | 'right') => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    clearTimeout(hoverTimer.current); setHovered(side);
    if (overlay) setDrawers(previous => ({ ...previous, [side === 'left' ? 'right' : 'left']: false }));
  };
  const leaveDrawer = (side: 'left' | 'right') => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHovered(previous => previous === side ? null : previous), 180);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => { workspace.current = server.id; return () => { workspace.current = ''; }; }, [server.id]);
  const changeOptions = (value: AgentOptions) => {
    setOptions(value);
    try { localStorage.setItem(preferenceKey, JSON.stringify(value)); } catch { /* Preferences are optional when browser storage is disabled. */ }
  };
  const loadModels = useCallback(async () => {
    const request = ++modelRequest.current;
    setLoadingModels(true); setModelError('');
    try {
      const items = await api<CodexModel[]>(`/agents/models?${serverQuery(server.id)}`);
      if (request === modelRequest.current) setModels(items);
    } catch (error) { if (request === modelRequest.current) setModelError(message(error)); }
    finally { if (request === modelRequest.current) setLoadingModels(false); }
  }, [server.id]);
  useEffect(() => {
    if (!anyRunning) return;
    let mounted = true;
    const timer = window.setInterval(() => {
      void api<AgentTask[]>('/tasks').then(items => { if (mounted) setTasks(previous => mergeHistory(previous, items, server.id, deleted.current)); }).catch(error => { if (mounted) setError(message(error)); });
    }, 5000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [anyRunning, server.id]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)');
    const resize = () => {
      setOverlay(media.matches);
      setHovered(null);
      if (media.matches) setDrawers({ left: false, right: false });
    };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  useEffect(() => { void loadModels(); return () => { modelRequest.current++; }; }, [loadModels]);
  useEffect(() => {
    let mounted = true; deleted.current.clear(); setTasks([]); setSelected(null); setPath(server.defaultPath); setLoadingTasks(true); setDeleteTarget(null);
    void api<AgentTask[]>('/tasks').then(items => {
      if (mounted) {
        const history = items.filter(item => item.serverId === server.id && !deleted.current.has(item.id));
        const chosen = history.find(task => task.id === initialTaskId) || history[0];
        setTasks(history); setSelected(chosen?.id || null); setPath(chosen?.path || server.defaultPath);
        const initialKey = chosen ? `chat:${chosen.id}` : 'draft:1';
        setTabs([{ key: initialKey, taskId: chosen?.id || null, label: chosen ? `對話 · ${chosen.prompt}` : '新對話 1' }]); setTabKey(initialKey); drafts.current.clear();
        if (chosen && initialTaskId) changeOptions({ model: chosen.model || '', reasoningEffort: chosen.reasoningEffort || '', approvalMode: chosen.approvalMode || 'auto', executionMode: chosen.executionMode === 'cooperative' && !servers.some(server => server.id === chosen.cooperationTargetId) ? 'general' : chosen.executionMode || 'general', cooperationTargetId: chosen.cooperationTargetId, cooperationPath: chosen.cooperationPath });
      }
    }).catch(error => { if (mounted) setError(message(error)); }).finally(() => { if (mounted) setLoadingTasks(false); });
    return () => { mounted = false; };
  }, [server.id]);
  useEffect(() => {
    if (!selected || !running) return;
    const after = Math.max(active?.eventSequence || 0, ...(active?.events.map(event => event.id) || []));
    const source = new EventSource(`/api/tasks/${encodeURIComponent(selected)}/events?after=${after}`);
    source.onmessage = event => {
      const item = JSON.parse(event.data) as AgentEvent;
      setTasks(previous => previous.map(task => task.id === selected ? mergeEvent(task, item) : task));
      if (item.type === 'status') { source.close(); void api<AgentTask[]>('/tasks').then(items => { if (workspace.current === server.id) setTasks(previous => mergeHistory(previous, items, server.id, deleted.current)); }).catch(error => { if (workspace.current === server.id) setError(message(error)); }); }
    };
    source.onerror = () => { setError('工作串流暫時中斷，正在重新連線…'); };
    source.onopen = () => setError('');
    return () => source.close();
  }, [selected, running, server.id]);
  useEffect(() => { followOutput.current = true; const element = timeline.current; element?.scrollTo({ top: element.scrollHeight }); }, [selected]);
  useEffect(() => { const element = timeline.current; if (element && followOutput.current) element.scrollTo({ top: element.scrollHeight }); }, [active?.eventSequence, attachments.files.length]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (!canSubmit || submitting.current) return; submitting.current = true; setBusy(true); setError('');
    try {
      const retained = active && steeringDrafts.current.get(active.id);
      if (active && (running || retained?.prompt === prompt.trim())) {
        const guidance = retained?.prompt === prompt.trim() ? retained : { requestId: crypto.randomUUID(), prompt: prompt.trim(), expectedTurnId: active.activeTurnId! };
        steeringDrafts.current.set(active.id, guidance);
        const result = await post<{ event: AgentEvent }>(`/tasks/${encodeURIComponent(active.id)}/steer`, guidance, 25000);
        if (workspace.current !== server.id) return;
        steeringDrafts.current.delete(active.id);
        setTasks(previous => previous.map(task => task.id === active.id ? mergeEvent(task, result.event) : task));
        if (selection.current === active.id) { followOutput.current = true; setPrompt(''); }
        return;
      }
      const controller = new AbortController(); markdownAbort.current = controller;
      setPreparingMarkdown(!!markdownReader.current && !markdownReader.current.ready);
      const bundle = await markdownReader.current?.(controller.signal);
      setPreparingMarkdown(false);
      if (workspace.current !== server.id || controller.signal.aborted) return;
      const automatic = bundle && !active?.attachmentManifest?.some(file => file.name === bundle.name && file.size === bundle.size) ? [bundle] : [];
      if (automatic.length + attachments.files.length > attachmentLimits.count) throw new Error('本機 MD 內容需使用 1 個附件位置，請先移除一個手動附件，或關閉「預先載入本機 MD」。');
      if ((bundle && automatic.length ? bundle.size : 0) + attachments.files.reduce((sum, file) => sum + file.size, 0) > attachmentLimits.bytes) throw new Error('本機 MD 與附件合計超過 30 MB 上限。');
      const sentFiles = [...attachments.files, ...automatic].map(file => ({ name: file.name, content: file.content }));
      const task = await post<AgentTask>('/tasks', { serverId: server.id, prompt, path, ...options, ...(localContext ? { localContext } : {}), attachments: sentFiles, ...(active ? { resumeTaskId: active.id } : {}) }, sentFiles.length ? 120000 : 35000);
      if (workspace.current !== server.id) return;
      followOutput.current = true;
      const nextKey = `chat:${task.id}`;
      setTabs(previous => previous.map(tab => tab.key === tabKey ? { key: nextKey, taskId: task.id, label: `對話 · ${task.prompt}` } : tab));
      drafts.current.delete(tabKey); setTabKey(nextKey);
      setTasks(previous => [task, ...previous.filter(item => item.id !== task.id)]); setSelected(task.id); setPrompt(''); attachments.clear();
    } catch (error) {
      if (active && error instanceof ApiError && [400, 404, 409, 429].includes(error.status)) steeringDrafts.current.delete(active.id);
      setError(message(error));
    } finally { markdownAbort.current = null; setPreparingMarkdown(false); submitting.current = false; setBusy(false); }
  };
  const answerChoice = async (eventId: number, answer: string, question: string) => {
    if (!active || busy || directoryBusy || explorerBusy || localBusy || peerBusy || (!running && !cooperationReady) || submitting.current || loadingTasks || active.remoteThreadDeleted || (running && !active.activeTurnId)) throw new Error('此對話目前無法送出選擇。');
    const taskId = active.id;
    const latest = [...active.events].filter(event => ['user', 'assistant', 'question'].includes(event.type)).sort((a, b) => (a.order || a.id) - (b.order || b.id)).at(-1);
    const reply = latest?.id === eventId ? answer : `針對先前的問題「${question}」，我的選擇是：${answer}`;
    submitting.current = true; setBusy(true);
    const choiceKey = `${taskId}:${eventId}`;
    try {
      const previous = choiceSteers.current.get(choiceKey);
      if (running || previous) {
        if (previous && previous.answer !== answer) throw new Error('前一次選擇尚未確認，請先確認對話更新後再變更選項。');
        const payload = previous?.payload || { requestId: crypto.randomUUID(), prompt: reply, expectedTurnId: active.activeTurnId!, replyToEventId: eventId };
        choiceSteers.current.set(choiceKey, { answer, payload });
        const result = await post<{ event: AgentEvent }>(`/tasks/${encodeURIComponent(taskId)}/steer`, payload, 25000);
        if (workspace.current !== server.id) return;
        choiceSteers.current.delete(choiceKey);
        setTasks(previous => previous.map(task => task.id === taskId ? mergeEvent(task, result.event) : task));
        if (selection.current === taskId) followOutput.current = true;
        return;
      }
      const task = await post<AgentTask>('/tasks', { serverId: server.id, prompt: reply, path, ...options, ...(localContext ? { localContext } : {}), attachments: [], resumeTaskId: taskId, replyToEventId: eventId });
      if (workspace.current !== server.id) return;
      if (selection.current === taskId) followOutput.current = true;
      setTasks(previous => [task, ...previous.filter(item => item.id !== task.id)]);
      // Keep the composer draft and pending attachments separate from a choice reply.
    } catch (error) {
      if (error instanceof ApiError && [400, 404, 409, 429].includes(error.status)) choiceSteers.current.delete(choiceKey);
      throw error;
    } finally { submitting.current = false; setBusy(false); }
  };
  const promptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && canSubmit) event.currentTarget.form?.requestSubmit();
  };
  const stop = async () => {
    if (!active) return;
    try { await post(`/tasks/${encodeURIComponent(active.id)}/cancel`); } catch (error) { setError(message(error)); }
  };
  const taskOptions = (task: AgentTask): AgentOptions => ({ model: task.model || '', reasoningEffort: task.reasoningEffort || '', approvalMode: task.approvalMode || 'auto', executionMode: task.executionMode === 'cooperative' && !servers.some(server => server.id === task.cooperationTargetId) ? 'general' : task.executionMode || 'general', cooperationTargetId: task.cooperationTargetId, cooperationPath: task.cooperationPath });
  const rememberDraft = () => { drafts.current.set(tabKey, { prompt, path, options: { ...options }, files: [...attachments.files] }); };
  const activateTab = (tab: ChatTab) => {
    if (tabsDisabled) return;
    if (tab.key !== tabKey) {
      rememberDraft();
      const saved = drafts.current.get(tab.key), task = tasks.find(item => item.id === tab.taskId);
      setPrompt(saved?.prompt || ''); setPath(saved?.path || task?.path || server.defaultPath);
      attachments.restore(saved?.files || []); changeOptions(saved?.options || (task ? taskOptions(task) : { ...options }));
      setTabKey(tab.key); setSelected(tab.taskId);
    }
    setPreviewPath(null); setError('');
    if (overlay) closeLeft();
  };
  const newTask = () => {
    if (tabsDisabled) return;
    rememberDraft(); const label = `新對話 ${++draftSequence.current}`, key = `draft:${draftSequence.current}`;
    setTabs(previous => [...previous, { key, taskId: null, label }]); setTabKey(key);
    setSelected(null); setPreviewPath(null); setPrompt(''); setError(''); attachments.clear(); if (overlay) closeLeft();
  };
  const selectTask = (task: AgentTask) => {
    if (tabsDisabled) return;
    const existing = tabs.find(tab => tab.taskId === task.id), tab = existing || { key: `chat:${task.id}`, taskId: task.id, label: `對話 · ${task.prompt}` };
    if (!existing) setTabs(previous => [...previous, tab]);
    activateTab(tab);
    // Selecting the current saved conversation also restores its saved settings.
    if (tab.key === tabKey) { setPath(task.path); changeOptions(taskOptions(task)); }
  };
  const loadPreview = async (entry: Pick<FileEntry, 'name' | 'path'>) => {
    const generation = (previewRequests.current.get(entry.path) || 0) + 1; previewRequests.current.set(entry.path, generation);
    if (mediaType(entry.path)) {
      setPreviewFiles(previous => previous.map(file => file.path === entry.path ? { ...file, loading: false, error: '', version: generation } : file));
      return;
    }
    setPreviewFiles(previous => previous.map(file => file.path === entry.path ? { ...file, loading: true, error: '' } : file));
    try {
      const result = await api<{ path: string; content: string }>(`/files/content?${serverQuery(server.id, entry.path)}`);
      if (workspace.current !== server.id || previewRequests.current.get(entry.path) !== generation) return;
      setPreviewFiles(previous => previous.map(file => file.path === entry.path ? { ...file, content: result.content, loading: false } : file));
    } catch (error) { if (workspace.current === server.id && previewRequests.current.get(entry.path) === generation) setPreviewFiles(previous => previous.map(file => file.path === entry.path ? { ...file, loading: false, error: message(error) } : file)); }
  };
  const openPreview = (entry: FileEntry) => {
    setPreviewPath(entry.path);
    if (!previewFiles.some(file => file.path === entry.path)) {
      setPreviewFiles(previous => [...previous, { path: entry.path, name: entry.name, content: '', loading: true, error: '' }]);
      void loadPreview(entry);
    }
    if (overlay) closeLeft();
  };
  const closeTab = (key: string, confirmed = false) => {
    if (tabsDisabled) return;
    if (key.startsWith('file:')) {
      const filePath = key.slice(5); previewRequests.current.set(filePath, (previewRequests.current.get(filePath) || 0) + 1);
      setPreviewFiles(previous => previous.filter(file => file.path !== filePath)); if (previewPath === filePath) setPreviewPath(null); return;
    }
    const saved = key === tabKey ? { prompt, files: attachments.files } : drafts.current.get(key);
    if (!confirmed && (saved?.prompt.trim() || saved?.files.length)) { setCloseTarget(key); return; }
    if (key === tabKey) rememberDraft();
    const remaining = tabs.filter(tab => tab.key !== key);
    if (key === tabKey) {
      if (remaining.length) activateTab(remaining.at(-1)!);
      else {
        const next = { key: `draft:${++draftSequence.current}`, taskId: null, label: `新對話 ${draftSequence.current}` };
        remaining.push(next); setTabKey(next.key); setSelected(null); setPrompt(''); attachments.clear(); setPreviewPath(null);
      }
    }
    setTabs(remaining); setCloseTarget(null);
  };
  const removeTask = async () => {
    if (!deleteTarget || removing) return;
    const task = deleteTarget;
    setRemoving(true); setDeleteError('');
    try {
      await api(`/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      if (workspace.current !== server.id) return;
      deleted.current.add(task.id);
      setTasks(previous => previous.filter(item => item.id !== task.id));
      drafts.current.delete(`chat:${task.id}`);
      const remaining = tabs.filter(tab => tab.taskId !== task.id);
      if (selected === task.id) {
        const next = remaining.at(-1) || { key: `draft:${++draftSequence.current}`, taskId: null, label: `新對話 ${draftSequence.current}` };
        if (!remaining.length) remaining.push(next);
        const saved = drafts.current.get(next.key), nextTask = tasks.find(item => item.id === next.taskId);
        setTabKey(next.key); setSelected(next.taskId); setPrompt(saved?.prompt || ''); attachments.restore(saved?.files || []); setPath(saved?.path || nextTask?.path || server.defaultPath); setError(''); setPreviewPath(null);
        if (saved?.options || nextTask) changeOptions(saved?.options || taskOptions(nextTask!));
      }
      setTabs(remaining);
      setDeleteTarget(null);
    } catch (error) { if (workspace.current === server.id) setDeleteError(message(error)); }
    finally { if (workspace.current === server.id) setRemoving(false); }
  };
  const lastUsage = active?.events.filter(event => event.type === 'usage').at(-1);
  let tokens: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } = {};
  try { tokens = JSON.parse(lastUsage?.text || '{}'); } catch { /* Malformed CLI usage is optional. */ }
  const preview = previewFiles.find(file => file.path === previewPath);
  const editorTabs: EditorTab[] = [...tabs.map(tab => ({ key: tab.key, label: tab.label, kind: 'chat' as const, title: `${tab.label}\n${drafts.current.get(tab.key)?.path || tasks.find(task => task.id === tab.taskId)?.path || path}`, status: tasks.find(task => task.id === tab.taskId)?.status })), ...previewFiles.map(file => ({ key: `file:${file.path}`, label: file.name, kind: 'file' as const, title: file.path }))];
  return <section className="agents-workspace">
    <div className="workspace-toolbar agent-toolbar">
      <IconButton label="檔案總管抽屜" aria-expanded={leftOpen && leftMode === 'files'} aria-controls="agent-drawer-left" onClick={() => { setLeftMode('files'); if (leftMode !== 'files' && leftOpen) return; toggleDrawer('left'); }}><PanelLeft size={18} /></IconButton>
      <Bot size={18} className="accent" /><strong>Codex</strong><span className="muted agent-status">{active ? taskLabels[active.status] : '新對話'}</span>
      <div className="toolbar-spacer" />
      <button className="agent-model-summary" title="選擇模型" onPointerEnter={event => { if (event.pointerType === 'mouse') hoverDrawer('right'); }} onPointerLeave={() => leaveDrawer('right')} onClick={() => toggleDrawer('right')}><span>{(running ? active?.model : options.model) || 'CLI 預設'}</span><ChevronDown size={13} /></button>
      <IconButton label="工作階段抽屜" aria-expanded={leftOpen && leftMode === 'history'} aria-controls="agent-drawer-left" onClick={() => { clearTimeout(hoverTimer.current); setHovered(null); setLeftMode('history'); setDrawers(previous => ({ ...previous, ...(overlay ? { right: false } : {}), left: true })); }}><History size={18} /></IconButton>
      <IconButton label="模型設定抽屜" aria-expanded={rightOpen} aria-controls="agent-drawer-right" onPointerEnter={event => { if (event.pointerType === 'mouse') hoverDrawer('right'); }} onPointerLeave={() => leaveDrawer('right')} onClick={() => toggleDrawer('right')}><PanelRight size={18} /></IconButton>
    </div>
    <div className={`agent-panes ${leftOpen ? 'left-open' : ''} ${rightOpen ? 'right-open' : ''}`}>
    {overlay && (leftOpen || rightOpen) && <div className="drawer-backdrop" onClick={() => { setDrawers({ left: false, right: false }); setHovered(null); }} />}
    <AgentDrawer side="left" title={leftMode === 'files' ? '檔案總管' : '工作階段'} open={leftOpen} overlay={overlay} interactive={drawers.left} onOpen={() => toggleDrawer('left')} onClose={closeLeft} onHover={() => hoverDrawer('left')} onLeave={() => leaveDrawer('left')}>
      <div className="agent-drawer-content" hidden={leftMode !== 'files'}><AgentFileExplorer server={server} path={path} contextKey={tabKey} enabled={!loadingTasks && leftMode === 'files' && leftOpen} disabled={busy || loadingTasks || attachments.reading || directoryBusy} onPath={setPath} onFile={openPreview} onBusy={setExplorerBusy} /></div>
      <div className="agent-drawer-content" hidden={leftMode !== 'history'}>
      <AgentTaskList tasks={tasks} selected={selected} search={search} stage={stage} loading={loadingTasks} onSearch={setSearch} onStage={setStage} onSelect={selectTask} onDelete={task => { setDeleteTarget(task); setDeleteError(''); }} onNew={newTask} />
      </div>
    </AgentDrawer>
    <div className="agent-main" inert={overlay && (drawers.left || drawers.right)}>
      <AgentEditorTabs tabs={editorTabs} selected={preview ? `file:${preview.path}` : tabKey} disabled={tabsDisabled} onNew={newTask} onClose={closeTab} onSelect={key => {
        if (key.startsWith('file:')) { const file = previewFiles.find(item => item.path === key.slice(5)); if (file) { setPreviewPath(file.path); setPath(file.path.slice(0, file.path.lastIndexOf('/')) || '/'); } }
        else { const tab = tabs.find(item => item.key === key); if (tab) activateTab(tab); }
      }} />
      {preview && <AgentFilePreview key={preview.path} file={preview} serverId={server.id} onRefresh={() => void loadPreview(preview)} />}
      <div className="agent-chat-panel" hidden={!!preview}>
      <div className="agent-timeline" ref={timeline} onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; }}>
        {!active && <div className="agent-empty"><Bot size={32} /><h2>新對話</h2><span className="muted">{server.username}@{server.host}</span></div>}
        {active && <AgentTimeline task={active} choiceDisabled={busy || directoryBusy || explorerBusy || localBusy || peerBusy || !cooperationReady || loadingTasks || attachments.reading} onChoice={answerChoice} onOpenTask={onOpenTask} />}
      </div>
      {(error || attachments.error || active?.remoteThreadDeleted) && <p className="error inline-alert" role="alert">{error || attachments.error || '遠端對話已刪除，請用垃圾桶完成附件清理。'}</p>}
      <form className={`agent-composer ${dragging ? 'attachment-dragging' : ''}`} onSubmit={submit}
        onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
        onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
        onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); dragDepth.current = 0; setDragging(false); void attachments.add(event.dataTransfer.files); } }}><div className="composer-meta"><AgentDirectorySelect key={tabKey} server={server} path={path} disabled={busy || !!running || loadingTasks || attachments.reading || localBusy || explorerBusy || !!active?.remoteThreadDeleted} onPath={setPath} onBusy={setDirectoryBusy} /><span>{active ? `${active.turnCount || 1} 輪對話` : '新對話'}</span></div>
        {lastUsage && <div className="token-row"><span>Input <b>{(tokens.input_tokens || 0).toLocaleString()}</b></span><span>Cached <b>{(tokens.cached_input_tokens || 0).toLocaleString()}</b></span><span>Output <b>{(tokens.output_tokens || 0).toLocaleString()}</b></span></div>}
        <AgentAttachmentTray files={attachments.files} disabled={busy || attachments.reading} onRemove={attachments.remove} />
        {preparingMarkdown && <p className="muted local-markdown-progress" role="status"><LoaderCircle size={15} className="spin" />等待本機 MD 預載入完成…<button type="button" className="secondary" onClick={() => markdownAbort.current?.abort()}>停止讀取本機 MD</button></p>}
        {sendBlockedReason && !preparingMarkdown && !active?.remoteThreadDeleted && <p id="codex-send-state" className="muted composer-send-state" role="status" aria-label="訊息送出狀態">{sendBlockedReason}</p>}
        {running && !sendBlockedReason && <p className="muted composer-send-state" role="status">可補充限制、修正方向，或細化目前的設計；Enter 送出引導，Shift＋Enter 換行。</p>}
        <div className="composer-input"><textarea aria-label="Codex 訊息" placeholder={running ? '補充指示，引導目前的工作…' : '傳送訊息給 Codex…'} value={prompt} rows={2} onChange={event => setPrompt(event.target.value)} onKeyDown={promptKeyDown} disabled={busy || !!active?.remoteThreadDeleted} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void attachments.add(event.clipboardData.files); } }} />
          {running && <button type="button" className="secondary send-button" title="停止回覆" aria-label="停止回覆" onClick={() => void stop()}><Square size={16} /></button>}
          <button className="primary send-button" title={sendBlockedReason || (running ? '送出引導' : '送出訊息')} aria-label={running ? '送出引導' : '送出訊息'} disabled={!canSubmit}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={20} />}</button>
        </div>
        <div className="composer-footer"><IconButton label="附加圖片或文件" disabled={busy || !!running || loadingTasks || attachments.reading || !!active?.remoteThreadDeleted} onClick={() => fileInput.current?.click()}>{attachments.reading ? <LoaderCircle size={18} className="spin" /> : <Paperclip size={18} />}</IconButton>
          <BrowserDirectoryPicker scope={`${username.toLowerCase()}:${server.id}`} disabled={busy || !!running || loadingTasks || attachments.reading || directoryBusy || !!active?.remoteThreadDeleted} attachmentError={attachments.error} attachedNames={attachments.files.map(file => file.name)} onContext={setLocalContext} onAttach={attachments.add} onBusy={setLocalBusy} onMarkdownReader={registerMarkdownReader} />
          <input type="file" multiple hidden ref={fileInput} accept={attachmentAccept} aria-label="選擇 Codex 附件" onChange={event => { if (event.target.files) void attachments.add(event.target.files); event.target.value = ''; }} />
          <AgentApprovalSelect value={running ? active.approvalMode || 'auto' : options.approvalMode} disabled={busy || !!running || loadingTasks} onChange={approvalMode => changeOptions({ ...options, approvalMode })} />
          <AgentExecutionSelect value={running ? active.executionMode || 'general' : options.executionMode} canCooperate={canCooperate && peers.length > 0} disabled={busy || !!running || loadingTasks || directoryBusy || localBusy || peerBusy || !!active?.remoteThreadDeleted} onChange={executionMode => changeOptions({ ...options, executionMode })} />
        </div>
        {options.executionMode === 'cooperative' && <div className="cooperation-controls"><label>協同端<select aria-label="協同 Codex 來源" value={options.cooperationTargetId || ''} disabled={busy || !!running || peerBusy} onChange={event => { const target = peers.find(item => item.id === event.target.value); changeOptions({ ...options, cooperationTargetId: target?.id || '', cooperationPath: target?.defaultPath || '' }); }}><option value="">選擇協同端</option>{peers.map(item => <option key={item.id} value={item.id}>{item.kind === 'local' ? '本機' : 'SSH'} · {item.name}</option>)}</select></label>{peer && <AgentDirectorySelect key={`${tabKey}:${peer.id}`} server={peer} path={options.cooperationPath || peer.defaultPath} disabled={busy || !!running || directoryBusy || localBusy} onPath={cooperationPath => changeOptions({ ...options, cooperationPath })} onBusy={setPeerBusy} />}{!canCooperate && <span className="error">此對話未載入跨端工具，請新增協同對話。</span>}</div>}
      </form>
      </div>
    </div>
    {closeTarget && <Dialog title="關閉未送出的分頁" onClose={() => setCloseTarget(null)}><div className="dialog-body"><p>此分頁有未送出的草稿或附件，是否關閉？已儲存的對話紀錄會保留。</p><div className="dialog-actions"><button type="button" className="secondary" onClick={() => setCloseTarget(null)}>保留分頁</button><button type="button" className="danger" onClick={() => closeTab(closeTarget, true)}>關閉分頁</button></div></div></Dialog>}
    <AgentDrawer side="right" title="模型設定" open={rightOpen} overlay={overlay} interactive={drawers.right} onOpen={() => toggleDrawer('right')} onClose={closeRight} onHover={() => hoverDrawer('right')} onLeave={() => leaveDrawer('right')}>
      <AgentSettings server={server} options={running ? { model: active.model || '', reasoningEffort: active.reasoningEffort || '', approvalMode: active.approvalMode || 'auto', executionMode: active.executionMode || 'general' } : options} models={models} loading={loadingModels} error={modelError} disabled={busy || !!running || directoryBusy || localBusy} path={path} onOptions={changeOptions} onPath={setPath} onRefresh={() => void loadModels()} />
    </AgentDrawer>
    </div>
    {deleteTarget && <Dialog title="刪除工作階段" onClose={() => { if (!removing) setDeleteTarget(null); }}>
      <div className="dialog-body">
      <p className="task-delete-summary">確定永久刪除「{deleteTarget.prompt}」？</p>
      <p className="muted">{deleteTarget.threadId ? '會刪除本機紀錄及遠端 Codex 對話／日誌，包含衍生子工作階段與專屬附件。' : deleteTarget.remoteAttachmentDirectory ? '會刪除本機紀錄與此工作階段的專屬附件。' : '此工作尚無遠端對話，只會刪除本機紀錄與快取附件。'}</p>
      <p className="muted">此操作無法復原，專案檔案與 SSH 金鑰不受影響。</p>
      {deleteError && <p className="error" role="alert">{deleteError}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={removing} onClick={() => setDeleteTarget(null)}><X size={15} />取消</button><button type="button" className="danger" disabled={removing} onClick={() => void removeTask()}>{removing ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}確定刪除</button></div>
      </div>
    </Dialog>}
  </section>;
}
