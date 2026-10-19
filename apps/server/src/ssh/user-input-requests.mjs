import crypto from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const boundedText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

function questionsFrom(params) {
  if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 3) throw invalid('無效的提問。');
  const ids = new Set();
  return params.questions.map(question => {
    if (!boundedText(question?.id, 128) || ['__proto__', 'constructor', 'prototype'].includes(question.id) || ids.has(question.id) || !boundedText(question.question, 8192)) throw invalid('無效的問題識別碼或內容。');
    ids.add(question.id);
    if (question.options != null && (!Array.isArray(question.options) || question.options.length > 8)) throw invalid('選項數量不正確。');
    const labels = new Set();
    const options = (question.options || []).map(option => {
      if (!boundedText(option?.label, 512) || labels.has(option.label) || (option.description != null && (typeof option.description !== 'string' || option.description.length > 2048))) throw invalid('選項內容不正確。');
      labels.add(option.label);
      return { label: option.label, description: option.description || '' };
    });
    return { id: question.id, header: typeof question.header === 'string' ? question.header.slice(0, 256) : '', question: question.question, options, isOther: question.isOther === true || !options.length, isSecret: question.isSecret === true };
  });
}

export class UserInputRequests {
  requests = new Map();
  constructor({ matches, send, emit }) { Object.assign(this, { matches, send, emit }); }
  request(message) {
    const params = message.params || {};
    if (!this.matches(params)) { this.send({ id: message.id, error: { code: -32602, message: 'Question does not match the active turn.' } }); return; }
    if ([...this.requests.values()].some(request => request.remoteId === message.id)) return;
    try {
      if (this.requests.size >= 8) throw invalid('待回覆的提問過多。');
      const details = { id: crypto.randomUUID(), status: 'pending', questions: questionsFrom(params) };
      this.requests.set(details.id, { remoteId: message.id, threadId: params.threadId, details });
      this.emit(details);
    } catch (error) { this.send({ id: message.id, error: { code: -32602, message: error.message } }); }
  }
  answer(id, values) {
    const request = this.requests.get(id);
    if (!request) throw Object.assign(new Error('此提問已結束或已回覆。'), { status: 409 });
    const questions = request.details.questions;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length !== questions.length) throw invalid('請回覆所有問題。');
    const entries = questions.map(question => {
      const value = Object.hasOwn(values, question.id) ? values[question.id] : undefined;
      if (!boundedText(value, 4096) || (!question.isOther && !question.options.some(option => option.label === value))) throw invalid('請選擇有效項目或輸入回覆。');
      return [question.id, { answers: [value] }];
    });
    // A response goes over the existing app-server channel, never a new SSH connection.
    this.send({ id: request.remoteId, result: { answers: Object.fromEntries(entries) } });
    this.requests.delete(id);
    const answers = Object.fromEntries(questions.filter(question => !question.isSecret).map(question => [question.id, values[question.id]]));
    this.emit({ ...request.details, status: 'answered', answers });
  }
  resolve(remoteId, threadId) {
    for (const [id, request] of this.requests) if (request.remoteId === remoteId && request.threadId === threadId) {
      this.requests.delete(id); this.emit({ ...request.details, status: 'cancelled' });
    }
  }
  clear() {
    for (const request of this.requests.values()) this.emit({ ...request.details, status: 'cancelled' });
    this.requests.clear();
  }
}
