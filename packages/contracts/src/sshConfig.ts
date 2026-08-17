import { z } from 'zod';
import type { ConnectionProfile } from './connection';
import { ConnectionProfileSchema } from './connection';

const SSH_CONFIG_IMPORT_MAX_BYTES = 1024 * 1024;

export const SshConfigImportRequestSchema = z
  .object({
    rawConfig: z.string().max(SSH_CONFIG_IMPORT_MAX_BYTES).optional(),
    sourcePath: z.string().max(2048).optional(),
  })
  .default({});

export type SshConfigImportRequest = z.infer<typeof SshConfigImportRequestSchema>;

export const SshConfigImportResultSchema = z.object({
  source: z.string().optional(),
  imported: z.number().int().min(0),
  skipped: z.number().int().min(0),
  profiles: z.array(ConnectionProfileSchema),
});

export type SshConfigImportResult = {
  source?: string;
  imported: number;
  skipped: number;
  profiles: ConnectionProfile[];
};

export type SshConfigEntry = {
  alias: string;
  host: string;
  port: number;
  username: string;
  identityFile?: string;
};

export type SshConfigParseResult = {
  entries: SshConfigEntry[];
  skipped: number;
};

type SshConfigOptions = {
  hostname?: string;
  user?: string;
  port?: string;
  identityfile?: string;
};

function stripInlineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === '#' && quote === null && (index === 0 || /\s/.test(line[index - 1] ?? ''))) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line;
}

function splitDirective(line: string): { key: string; value: string } | null {
  const trimmed = stripInlineComment(line).trim();
  if (!trimmed) return null;

  const equalsIndex = trimmed.indexOf('=');
  const whitespaceIndex = trimmed.search(/\s/);
  if (equalsIndex > 0 && (whitespaceIndex === -1 || equalsIndex < whitespaceIndex)) {
    return {
      key: trimmed.slice(0, equalsIndex).trim().toLowerCase(),
      value: trimmed.slice(equalsIndex + 1).trim(),
    };
  }

  const match = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (!match) return null;
  return {
    key: match[1]!.toLowerCase(),
    value: match[2]!.trim(),
  };
}

function splitWords(value: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) words.push(current);
  return words;
}

function concreteHostPattern(alias: string): boolean {
  return alias !== '' && !alias.startsWith('!') && !/[*?[\]]/.test(alias);
}

function normalizedPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22;
}

function applyOption(options: SshConfigOptions, key: string, value: string): void {
  if (key === 'hostname') options.hostname = splitWords(value)[0] ?? value;
  if (key === 'user') options.user = splitWords(value)[0] ?? value;
  if (key === 'port') options.port = splitWords(value)[0] ?? value;
  if (key === 'identityfile' && options.identityfile === undefined) {
    options.identityfile = splitWords(value)[0] ?? value;
  }
}

export function parseSshConfigEntries(rawConfig: string): SshConfigParseResult {
  const entries: SshConfigEntry[] = [];
  const globalOptions: SshConfigOptions = {};
  let currentHosts: string[] = [];
  let options: SshConfigOptions = { ...globalOptions };
  let skipped = 0;

  function flush(): void {
    for (const alias of currentHosts) {
      if (!concreteHostPattern(alias)) {
        skipped += 1;
        continue;
      }

      const host = (options.hostname || alias).trim();
      if (!host) {
        skipped += 1;
        continue;
      }

      entries.push({
        alias,
        host,
        port: normalizedPort(options.port),
        username: (options.user || '').trim(),
        ...(options.identityfile ? { identityFile: options.identityfile } : {}),
      });
    }
  }

  for (const line of rawConfig.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const directive = splitDirective(line);
    if (!directive) continue;

    if (directive.key === 'host') {
      flush();
      currentHosts = splitWords(directive.value);
      options = { ...globalOptions };
      continue;
    }

    if (currentHosts.length === 0) {
      applyOption(globalOptions, directive.key, directive.value);
      continue;
    }

    applyOption(options, directive.key, directive.value);
  }

  flush();
  return { entries, skipped };
}
