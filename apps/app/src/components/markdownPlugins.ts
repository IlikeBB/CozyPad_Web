import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export const markdownRemarkPlugins = [remarkGfm, remarkMath];
export const markdownRehypePlugins = [rehypeKatex];

const latexSignals = [
  '\\sum',
  '\\log',
  '\\frac',
  '\\boxed',
  '\\mathbb',
  '\\mathbf',
  '\\mathrm',
  '\\hat',
  '\\dots',
  '\\sim',
  '\\times',
  '\\partial',
  '\\nabla',
  '\\alpha',
  '\\beta',
  '\\gamma',
  '\\theta',
  '\\lambda',
  '\\infty',
];

const plainFormulaSignals = [
  'sum_',
  'log(',
  'exp(',
  'p_i',
  'q_i',
  'y_i',
  'z_i',
  'z_j',
  'z_k',
  'z_c',
];

const mathFenceLanguages = new Set(['math', 'tex', 'latex', 'katex']);
const textFenceLanguages = new Set(['text', 'txt', 'plain']);

function isCodeLike(value: string): boolean {
  return /^\s*(?:import|from|const|let|var|function|class|def|return|if|for|while|print|console\.|#include)\b/m.test(
    value,
  );
}

function isTechnicalNotation(value: string): boolean {
  return /\b(?:logit|logits|prediction|probability|label|labels|target|targets)\s+shape\s*[:=]/i.test(value)
    || /\b(?:label|labels|target|targets)\s+dtype\s*[:=]/i.test(value)
    || /\b(?:loss|criterion)\s*[:=]\s*(?:nn\.)?[\w.]+(?:\([^)]*\))?/i.test(value)
    || /\bpos_weight\s*[:=]/i.test(value)
    || /\b(?:BCEWithLogitsLoss|BCELoss|CrossEntropyLoss)\(\)/i.test(value);
}

function looksLikeLatexMath(value: string): boolean {
  const text = value.trim();
  if (!text.includes('\\')) return false;
  return (
    latexSignals.some((signal) => text.includes(signal)) ||
    /(?:^|[^A-Za-z])(?:[A-Za-z][A-Za-z0-9_{}\\]*\s*=|[A-Za-z]\([^)]*\)|[A-Za-z]_[A-Za-z0-9{}\\]+)/.test(text)
  );
}

function looksLikeFormula(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 500 || isCodeLike(text) || isTechnicalNotation(text)) return false;
  if (/[\u4E00-\u9FFF]/.test(text) && !/[=\\]|(?:^|[\s([{])[-+]?(?:log|exp|softmax)\s*\(/i.test(text)) {
    return false;
  }
  if (looksLikeLatexMath(text)) return true;

  const lower = text.toLowerCase();
  if (plainFormulaSignals.some((signal) => lower.includes(signal))) return true;
  if (/^[A-Za-z](?:\([^)]*\)|_\{?[A-Za-z0-9]+\}?)?\s*=/.test(text)) return true;
  if (/^[-+]?(?:log|exp|softmax)\s*\(/i.test(text)) return true;
  if (/^=\s*[-+]?\S+/.test(text)) return true;
  return /[A-Za-z0-9)}\]]\s*=\s*[-+]?[\w\\([{]/.test(text) && /[()[\]_\-+*/\\]/.test(text);
}

function unwrapBoxedLatex(text: string): string {
  let output = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = output.replace(/\\boxed\s*\{([^{}]*)\}/g, '$1');
    if (next === output) break;
    output = next;
  }
  return output;
}

function normalizeKnownMathNames(value: string): string {
  return value
    .replace(/\blog\s*\(/g, '\\log(')
    .replace(/\bexp\s*\(/g, '\\exp(')
    .replace(/\bsoftmax\s*\(/gi, '\\operatorname{softmax}(');
}

function normalizeSubscripts(value: string): string {
  return value
    .replace(/\bsum_([A-Za-z0-9]+)\b/g, '\\sum_{$1}')
    .replace(/\b([A-Za-z])_([A-Za-z0-9]+)\b/g, '$1_{$2}');
}

function normalizeHats(value: string): string {
  return value
    .replace(/\\hat\s*\{\s*([^{}]+?)\s*\}/g, '\\hat{$1}')
    .replace(/\\hat\s+([A-Za-z])/g, '\\hat{$1}');
}

function normalizeBrackets(value: string): string {
  return value.replace(/\[([^\[\]]*(?:\\log|\\sum|\\hat|[A-Za-z]_\{|[-+*/])[^\[\]]*)\]/g, '\\left[$1\\right]');
}

function convertFormulaExpression(value: string): string {
  return normalizeBrackets(
    normalizeHats(
      normalizeSubscripts(
        normalizeKnownMathNames(value.trim())
          .replace(/\\\\(log|hat|sum|frac|exp|operatorname|left|right|ldots|dots|mathbb|mathbf|mathrm)/g, '\\$1')
          .replace(/\.\.\./g, '\\ldots')
          .replace(/\s+/g, ' ')
          .replace(/\s*([=+\-*/])\s*/g, ' $1 ')
          .replace(/\s*,\s*/g, ', '),
      ),
    ),
  )
    .replace(
      /\\log\(\s*\\exp\(([^()]+)\)\s*\/\s*\\sum_\{([^}]+)\}\s*\\exp\(([^()]+)\)\s*\)/g,
      '\\log\\left(\\frac{\\exp($1)}{\\sum_{$2}\\exp($3)}\\right)',
    )
    .replace(
      /\\log\(\s*\\sum_\{([^}]+)\}\s*\\exp\(([^()]+)\)\s*\)/g,
      '\\log\\left(\\sum_{$1}\\exp($2)\\right)',
    );
}

function normalizePseudoMathBlocks(text: string): string {
  return text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, language: string | undefined, body: string) => {
    const lang = String(language || '').trim().toLowerCase();
    const explicitMath = mathFenceLanguages.has(lang);
    const plainTextMath = !lang || textFenceLanguages.has(lang);
    const bodyLooksMath = body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => looksLikeFormula(line));

    if (!explicitMath && !(plainTextMath && bodyLooksMath)) return match;

    const expressions = body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => convertFormulaExpression(line))
      .join(' \\\\\n');
    return `\n$$\n${expressions}\n$$\n`;
  });
}

function pushDisplayFormula(output: string[], expression: string): void {
  output.push('', '$$', convertFormulaExpression(expression), '$$', '');
}

function normalizeSplitConditionLines(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const current = lines[index]?.trim() || '';
    const variable = lines[index + 1]?.trim() || '';
    const equals = lines[index + 2]?.trim() || '';
    const value = lines[index + 3]?.trim() || '';
    const repeated = lines[index + 4]?.trim() || '';
    const ifOnly = current.match(/^(?:\u5982\u679c|if|\?+)\s*$/i);

    if (
      ifOnly &&
      /^[A-Za-z]$/.test(variable) &&
      equals === '=' &&
      /^[01]$/.test(value) &&
      new RegExp(`^${variable}\\s*=\\s*${value}[\\uFF1A:]?$`).test(repeated)
    ) {
      output.push(`${current} $${variable}=${value}$:`);
      index += 5;
      continue;
    }

    const sameLine = current.match(/^((?:\u5982\u679c|if)\s+)([A-Za-z])\s*=\s*([01])\s*$/i);
    const sameLineRepeated = lines[index + 1]?.trim() || '';
    if (sameLine && new RegExp(`^${sameLine[2]}\\s*=\\s*${sameLine[3]}[\\uFF1A:]?$`).test(sameLineRepeated)) {
      output.push(`${sameLine[1]}$${sameLine[2]}=${sameLine[3]}$:`);
      index += 2;
      continue;
    }

    output.push(lines[index] ?? '');
    index += 1;
  }

  return output.join('\n');
}

function normalizeFormulaLines(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let inDisplayMath = false;
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      output.push(line);
      continue;
    }
    if (inCodeFence) {
      output.push(line);
      continue;
    }
    if (trimmed === '$$') {
      inDisplayMath = !inDisplayMath;
      output.push(line);
      continue;
    }
    if (inDisplayMath) {
      output.push(line);
      continue;
    }

    const inlineFormulaLabel = trimmed.match(/^(.*(?:\u516c\u5f0f|formula)\s*[:\uFF1A])\s+(.+)$/i);
    if (inlineFormulaLabel && looksLikeFormula(inlineFormulaLabel[2] || '')) {
      output.push(inlineFormulaLabel[1] || '');
      pushDisplayFormula(output, inlineFormulaLabel[2] || '');
      continue;
    }

    const bracketedLatex = trimmed.match(/^\[\s*(.+?)\s*\]$/);
    if (bracketedLatex && looksLikeFormula(bracketedLatex[1] || '')) {
      pushDisplayFormula(output, bracketedLatex[1] || '');
      continue;
    }

    if (looksLikeFormula(trimmed) && !trimmed.startsWith('- ') && !trimmed.startsWith('* ')) {
      pushDisplayFormula(output, trimmed);
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

function normalizeDisplayMathSpacing(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let inDisplayMath = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed === '$$') {
      if (!inDisplayMath && output.length > 0 && output[output.length - 1]?.trim()) {
        output.push('');
      }

      output.push('$$');
      inDisplayMath = !inDisplayMath;

      const next = lines[index + 1]?.trim() || '';
      if (!inDisplayMath && next) {
        output.push('');
      }
      continue;
    }

    output.push(line);
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

function formatInlineCode(value: string): string {
  return `\`${value.trim().replace(/`/g, '\\`').replace(/\s*,\s*/g, ', ')}\``;
}

function normalizeTechnicalNotationLines(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let inDisplayMath = false;
  let inCodeFence = false;

  const notationPattern =
    /((?:logit|logits|prediction|probability|label|labels|target|targets)\s+shape\s*[:=]\s*\[[^\]]+\]|(?:label|labels|target|targets)\s+dtype\s*[:=]\s*[\w.]+|(?:loss|criterion)\s*[:=]\s*(?:nn\.)?[\w.]+(?:\([^)]*\))?|pos_weight\s*[:=]\s*[\w.[\],\s-]+|(?:nn\.)?(?:BCEWithLogitsLoss|BCELoss|CrossEntropyLoss)\(\))/gi;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      output.push(line);
      continue;
    }
    if (inCodeFence) {
      output.push(line);
      continue;
    }
    if (trimmed === '$$') {
      inDisplayMath = !inDisplayMath;
      output.push(line);
      continue;
    }
    if (inDisplayMath) {
      output.push(line);
      continue;
    }

    const matches = [...trimmed.matchAll(notationPattern)];
    if (matches.length < 2) {
      output.push(line);
      continue;
    }

    const firstIndex = matches[0]?.index ?? 0;
    const prefix = trimmed.slice(0, firstIndex).replace(/[:\uFF1A,\uFF0C\u3001\s]+$/, '').trim();
    if (prefix) {
      output.push(`${prefix}:`);
      output.push('');
    }
    for (const match of matches) {
      output.push(`- ${formatInlineCode(match[0] || '')}`);
    }
    output.push('');
  }

  return output.join('\n');
}

function normalizeInlineUnderscoreTokens(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let inDisplayMath = false;
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      output.push(line);
      continue;
    }
    if (inCodeFence) {
      output.push(line);
      continue;
    }
    if (trimmed === '$$') {
      inDisplayMath = !inDisplayMath;
      output.push(line);
      continue;
    }
    if (inDisplayMath) {
      output.push(line);
      continue;
    }

    const parts = line.split(/(`[^`]*`|\$[^$]*\$)/g);
    output.push(
      parts
        .map((part) => {
          if ((part.startsWith('`') && part.endsWith('`')) || (part.startsWith('$') && part.endsWith('$'))) return part;
          return part.replace(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g, (token) => formatInlineCode(token));
        })
        .join(''),
    );
  }

  return output.join('\n');
}

export function normalizeMarkdownMath(text: string): string {
  const normalized = normalizeInlineUnderscoreTokens(
    normalizeTechnicalNotationLines(
      normalizeFormulaLines(normalizePseudoMathBlocks(normalizeSplitConditionLines(unwrapBoxedLatex(text)))),
    ),
  )
    .replace(/\\\[((?:.|\n)*?)\\\]/g, (_, body: string) => `\n$$\n${convertFormulaExpression(body.trim())}\n$$\n`)
    .replace(/\\\((.*?)\\\)/g, (_, body: string) => `$${convertFormulaExpression(body.trim())}$`);

  return normalizeDisplayMathSpacing(normalized);
}
