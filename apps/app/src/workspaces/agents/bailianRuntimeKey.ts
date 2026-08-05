let bailianRuntimeKey = '';

export function extractBailianRuntimeKey(value: string): string {
  const text = value.replace(/^\uFEFF/, '').trim();
  if (!text) return '';

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      for (const key of [
        'COZYPAD_BAILIAN_API_KEY',
        'DASHSCOPE_API_KEY',
        'BAILIAN_API_KEY',
        'ALIBABA_CLOUD_API_KEY',
        'apiKey',
        'key',
      ]) {
        const candidate = parsed[key];
        if (typeof candidate === 'string' && candidate.trim()) return extractBailianRuntimeKey(candidate);
      }
    }
  } catch {
    // Plain text key files are the common path.
  }

  const bearer = text.match(/\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/i);
  if (bearer?.[1]) return bearer[1].trim();

  const skKey = text.match(/\bsk-[A-Za-z0-9_-]{16,}\b/);
  if (skKey?.[0]) return skKey[0].trim();

  const assignment = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) =>
      /^(?:export\s+)?(?:COZYPAD_BAILIAN_API_KEY|DASHSCOPE_API_KEY|BAILIAN_API_KEY|ALIBABA_CLOUD_API_KEY)\s*=/.test(
        line,
      ),
    );
  if (assignment) {
    const rawValue = assignment.replace(/^(?:export\s+)?[^=]+=/, '').trim();
    return rawValue.replace(/^['"]|['"];?$/g, '').trim();
  }

  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('//'));
  return (firstLine || text).replace(/^['"]|['"];?$/g, '').trim();
}

export function setBailianRuntimeKey(value: string): void {
  bailianRuntimeKey = extractBailianRuntimeKey(value);
}

export function clearBailianRuntimeKey(): void {
  bailianRuntimeKey = '';
}

export function getBailianRuntimeKey(): string {
  return bailianRuntimeKey;
}
