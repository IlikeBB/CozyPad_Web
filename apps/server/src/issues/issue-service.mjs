import crypto from 'node:crypto';
import { userId } from '../storage/json-store.mjs';

const file = 'issues.json';
const categories = ['bug', 'connection', 'agents', 'files', 'other'];
const statuses = ['open', 'in_progress', 'resolved', 'closed'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function text(value, label, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label}格式不正確。`);
  const result = value.trim();
  if ((required && !result) || result.length > max) fail(`${label}${required ? '不可空白，且' : ''}最多 ${max} 字。`);
  return result;
}
function fields(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key))) fail('回報欄位不正確。');
}
function diagnostics(value) {
  if (value === undefined || value === null) return null;
  fields(value, ['userAgent', 'viewport', 'version']);
  return { userAgent: text(value.userAgent, '瀏覽器資訊', 500, true), viewport: text(value.viewport, '視窗大小', 32, true), version: text(value.version, '版本', 32, true) };
}
function summary(report) {
  const { id, owner, title, category, status, createdAt, updatedAt, revision } = report;
  return { id, owner, title, category, status, createdAt, updatedAt, revision };
}
function publicReport(report) {
  const { requestId, digest, ...result } = report;
  return structuredClone(result);
}

export class IssueService {
  constructor(store, now = Date.now) { this.store = store; this.now = now; }
  async list(user, query = {}) {
    const owner = userId(user.username);
    const scope = query.scope || 'mine', status = query.status || 'all';
    if (!['mine', 'all'].includes(scope) || !['all', ...statuses].includes(status)) fail('回報篩選條件不正確。');
    if (scope === 'all' && user.role !== 'admin') fail('只有管理員可以查看全部回報。', 403);
    const page = Number(query.page ?? 1), limit = Number(query.limit ?? 25);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('回報分頁不正確。');
    const { reports } = await this.store.read(file, { reports: [] });
    const visible = reports.filter(report => (scope === 'all' || report.owner === owner) && (status === 'all' || report.status === status))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
    return { items: visible.slice((page - 1) * limit, page * limit).map(summary), total: visible.length, page, limit };
  }
  async find(user, id) {
    if (!uuid.test(id)) fail('找不到此回報。', 404);
    const { reports } = await this.store.read(file, { reports: [] });
    const report = reports.find(item => item.id === id && (user.role === 'admin' || item.owner === userId(user.username)));
    if (!report) fail('找不到此回報。', 404);
    return publicReport(report);
  }
  async create(user, payload) {
    const owner = userId(user.username);
    fields(payload, ['requestId', 'title', 'category', 'description', 'steps', 'expected', 'diagnostics']);
    if (typeof payload.requestId !== 'string' || !uuid.test(payload.requestId)) fail('回報識別碼不正確。');
    if (!categories.includes(payload.category)) fail('請選擇問題類型。');
    const draft = { title: text(payload.title, '標題', 160, true), category: payload.category,
      description: text(payload.description, '問題描述', 8000, true), steps: text(payload.steps, '重現步驟', 4000),
      expected: text(payload.expected, '預期結果', 2000), diagnostics: diagnostics(payload.diagnostics) };
    const requestId = payload.requestId.toLowerCase();
    const digest = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    return this.store.update(file, { reports: [] }, ({ reports }) => {
      // Retries after a lost response must not create a second issue.
      const previous = reports.find(report => report.owner === owner && report.requestId === requestId);
      if (previous) {
        if (previous.digest !== digest) fail('此回報識別碼已使用，請重新建立回報。', 409);
        return publicReport(previous);
      }
      const now = this.now();
      if (reports.filter(report => report.owner === owner && report.createdAt > now - 3600000).length >= 10) fail('回報次數過多，請稍後再試。', 429);
      if (reports.length >= 10000) fail('回報儲存空間已滿，請聯絡管理員。', 507);
      const report = { id: crypto.randomUUID(), requestId, digest, owner, ...draft, status: 'open', response: '',
        respondedBy: null, respondedAt: null, createdAt: now, updatedAt: now, revision: 1 };
      reports.push(report);
      return publicReport(report);
    });
  }
  async update(user, id, payload) {
    if (user.role !== 'admin') fail('只有管理員可以更新回報。', 403);
    const owner = userId(user.username);
    if (!uuid.test(id)) fail('找不到此回報。', 404);
    fields(payload, ['status', 'response', 'revision']);
    if (!statuses.includes(payload.status) || !Number.isSafeInteger(payload.revision) || payload.revision < 1) fail('回報狀態或版本不正確。');
    const response = text(payload.response, '管理員回覆', 4000);
    return this.store.update(file, { reports: [] }, ({ reports }) => {
      const report = reports.find(item => item.id === id);
      if (!report) fail('找不到此回報。', 404);
      if (report.revision !== payload.revision) fail('回報已被更新，請重新整理後再儲存。', 409);
      const now = this.now();
      const nextResponse = payload.response === undefined ? report.response : response;
      if (report.response !== nextResponse) { report.response = nextResponse; report.respondedBy = owner; report.respondedAt = now; }
      report.status = payload.status; report.updatedAt = now; report.revision++;
      return publicReport(report);
    });
  }
}
