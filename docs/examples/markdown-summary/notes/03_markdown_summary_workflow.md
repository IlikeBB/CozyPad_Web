# Markdown 彙整流程設計

## 使用情境

使用者將多個 `.md` 或 `.txt` 檔案拖入 CozyPad 的 Markdown 頁面。CozyPad 將內容送到指定的遠端 server，由遠端 Markdown summary API 呼叫 LLM 進行整理。

## 資料流

1. 前端讀取使用者拖入的檔案內容。
2. 前端呼叫 `/api/markdown/summarize`。
3. CozyPad API 驗證登入狀態。
4. API 找到 91 server 的 SSH 設定。
5. API 透過 SSH stdin 將 JSON payload 傳給遠端 Python。
6. 遠端 Python 匯入 `markdown_summary_api.py`。
7. `summarize_files(payload)` 回傳整理結果。
8. 前端顯示 summary。

## Payload 格式

```json
{
  "modelPath": "<remote-model-path>",
  "instruction": "整理成研究筆記",
  "files": [
    {
      "name": "note.md",
      "extension": "md",
      "content": "# Note",
      "size": 12
    }
  ]
}
```

## 預期輸出

```json
{
  "ok": true,
  "summary": "整理後的 Markdown",
  "fileCount": 1,
  "modelPath": "<remote-model-path>"
}
```

## 下一步

- 增加任務歷史紀錄。
- 支援整理結果下載成 `.md`。
- 支援把 summary 寫回遠端指定目錄。
- 增加長文件 chunking。
