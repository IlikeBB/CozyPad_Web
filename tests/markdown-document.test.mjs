import test from 'node:test';
import assert from 'node:assert/strict';
import { unified } from '../apps/app/node_modules/unified/index.js';
import remarkParse from '../apps/app/node_modules/remark-parse/index.js';
import { isMarkdownFile, markdownFileLink, markdownHeadingIds } from '../apps/app/src/components/markdown-document.mjs';

test('Markdown file links resolve Unicode, spaces, parent paths and anchors without browser navigation or unsafe schemes', () => {
  const file = '/home/tester/Markdown 文件/README.md';
  assert.deepEqual(markdownFileLink('notes/設計.md#介紹', file), { path: '/home/tester/Markdown 文件/notes/設計.md', hash: '介紹' });
  assert.deepEqual(markdownFileLink('../another%20file.md', file), { path: '/home/tester/another file.md', hash: '' });
  assert.deepEqual(markdownFileLink('#功能', file), { path: file, hash: '功能' });
  for (const href of ['https://other.test/readme.md', '//other.test/readme.md', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,abc', 'notes/%00.md', 'bad%ZZ.md', '\\host\file.md', 'bad\nfile.md']) assert.equal(markdownFileLink(href, file), null, href);
  for (const name of ['README.md', '中文.MD', 'notes.markdown', 'file.mdown', 'file.mkd']) assert.equal(isMarkdownFile(name), true);
  for (const name of ['file.md.exe', 'file.txt', undefined]) assert.equal(isMarkdownFile(name), false);
});

test('Markdown heading anchors retain Chinese, formatting text and deterministic duplicate suffixes', () => {
  const processor = unified().use(remarkParse).use(markdownHeadingIds);
  const tree = processor.runSync(processor.parse('# 使用說明\n\n## **GPU** 設定\n\n## 使用說明\n'));
  assert.deepEqual(tree.children.filter(node => node.type === 'heading').map(node => node.data.hProperties.id), ['使用說明', 'gpu-設定', '使用說明-1']);
});
