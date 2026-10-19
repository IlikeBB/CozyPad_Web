export const markdownRoot = '/home/tester/markdown-docs';
export const markdownContent = `# CozyPad 使用說明

支援 **粗體重點**、*斜體說明*，也可以閱讀 \`config.json\`。

> 開啟檔案即可看到排版，不需要先修改原始碼。

## 功能

- 標題與段落
- 清單與引用
  - 巢狀清單

1. 開啟 Markdown
2. 閱讀完整排版

- [x] 已完成預覽
- [ ] 待補充文件

## 參數表格

| 設定 | 用途 | 路徑 |
| --- | --- | --- |
| preview | 以 Markdown 格式閱讀 | /home/tester/markdown-docs/notes/完整中文資料夾/very-long-configuration-file-name.md |
| source | 檢視原始內容 | README.md |

## 程式碼

\`\`\`powershell
Write-Output "CozyPad Markdown"
$project = 'F:\\work_project\\CozyPad_Project'
\`\`\`

---

[回到功能](#功能) · [下一份設計文件](notes/設計.md) · [外部文件](https://example.com/docs)

![範例圖片](notes/pixel.png)

<script>window.MARKDOWN_SCRIPT_EXECUTED = true</script>

[危險連結](javascript:alert(1))
`;
export function seedMarkdownBrowser(fixture) {
  fixture.directories.set(markdownRoot, 0o700);
  fixture.directories.set(`${markdownRoot}/notes`, 0o700);
  fixture.fileMap.set(`${markdownRoot}/README.md`, Buffer.from(markdownContent, 'utf8'));
  fixture.fileMap.set(`${markdownRoot}/notes/設計.md`, Buffer.from('# 設計段落\n\n這是另一份 Markdown。\n\n[回到使用說明](../README.md)\n', 'utf8'));
  fixture.fileMap.set(`${markdownRoot}/plain.txt`, Buffer.from('PLAIN_TEXT_FILE\n', 'utf8'));
  fixture.fileMap.set(`${markdownRoot}/empty.MD`, Buffer.alloc(0));
  fixture.fileMap.set(`${markdownRoot}/notes/pixel.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9oAAAAAASUVORK5CYII=', 'base64'));
}
