const presets = {
  ask: { sandbox: 'read-only', approvalPolicy: 'untrusted' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  'full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never' }
};

export function approvalSettings(mode = 'auto') {
  if (typeof mode !== 'string' || !Object.hasOwn(presets, mode)) throw Object.assign(new Error('無效的 Codex 核准模式。'), { status: 400 });
  return { ...presets[mode] };
}
