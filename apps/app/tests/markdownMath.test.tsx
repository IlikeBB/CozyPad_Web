import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { describe, expect, it } from 'vitest';

import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownMath,
} from '../src/components/markdownPlugins';
import { MathAwareMarkdown } from '../src/components/markdownComponents';

function renderMarkdown(value: string): string {
  return renderToStaticMarkup(
    <Markdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>
      {normalizeMarkdownMath(value)}
    </Markdown>,
  );
}

function renderMathAwareMarkdown(value: string): string {
  return renderToStaticMarkup(<MathAwareMarkdown showImages={false} text={value} />);
}

describe('normalizeMarkdownMath', () => {
  it('renders display formulas with surrounding Chinese text through KaTeX', () => {
    const markdown = [
      'Cross Entropy 常見公式如下：',
      '',
      '二元分類',
      '',
      '$$ L = - \\left[y\\log(p) + (1 - y)\\log(1 - p)\\right] $$',
      '其中：',
      '',
      '- y：真實標籤，為 0 或 1',
      '- p：模型預測為 1 的機率',
      '',
      '多分類',
      '',
      '$$ L = - \\sum_{c = 1}^{C} y_c\\log(p_c) $$',
    ].join('\n');

    const normalized = normalizeMarkdownMath(markdown);
    const html = renderMarkdown(markdown);

    expect(normalized).toMatch(/\$\$\s+L =\s+- \\left\[y\\log\(p\) \+ \(1 - y\)\\log\(1 - p\)\\right\]\s+\$\$/);
    expect(normalized).toMatch(/\$\$\s+L =\s+- \\sum_\{c = 1\}\^\{C\} y_\{c\}\\log\(p_\{c\}\)\s+\$\$/);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('$$ L =');
  });

  it('restores escaped display math delimiters before rendering', () => {
    const markdown = '\\$\\$ L = - \\\\sum_i y_i \\\\log(p_i) \\$\\$';
    const html = renderMarkdown(markdown);

    expect(normalizeMarkdownMath(markdown)).toMatch(/\$\$\s+L =\s+- \\sum_\{i\} y_\{i\} \\log\(p_\{i\}\)\s+\$\$/);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain('katex-error');
  });

  it('collapses repeated latex bracket delimiters produced by retries', () => {
    const markdown = '$$ L = - \\left\\left\\left[y\\log(p) + (1 - y)\\log(1 - p)\\right\\right\\right] $$';
    const normalized = normalizeMarkdownMath(markdown);
    const html = renderMarkdown(markdown);

    expect(normalized).toContain('\\left[y\\log(p) + (1 - y)\\log(1 - p)\\right]');
    expect(normalized).not.toContain('\\left\\left');
    expect(normalized).not.toContain('\\right\\right');
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain('katex-error');
  });

  it('promotes standalone latex formula lines to display math', () => {
    const markdown = 'L = - \\left[y\\log(\\hat{y}) + (1 - y)\\log(1 - \\hat{y})\\right]';
    const normalized = normalizeMarkdownMath(markdown);
    const html = renderMarkdown(markdown);
    const uiHtml = renderMathAwareMarkdown(markdown);

    expect(normalized.trim()).toMatch(/^\$\$\s+L = - \\left\[y\\log\(\\hat\{y\}\) \+ \(1 - y\)\\log\(1 - \\hat\{y\}\)\\right\]\s+\$\$$/s);
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain('katex-error');
    expect(html).not.toContain('$$');
    expect(uiHtml).toContain('class="katex-display"');
    expect(uiHtml).not.toContain('katex-error');
    expect(uiHtml).not.toContain('$$');
  });

  it('renders compact display math without leaking delimiters', () => {
    const markdown = '$$ E = mc^2 $$';
    const normalized = normalizeMarkdownMath(markdown);
    const uiHtml = renderMathAwareMarkdown(markdown);

    expect(normalized).toMatch(/\$\$\s+E = mc\^2\s+\$\$/);
    expect(uiHtml).toContain('class="katex-display"');
    expect(uiHtml).not.toContain('katex-error');
    expect(uiHtml).not.toContain('$$');
  });
});
