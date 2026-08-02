# Disordered Meeting Notes

## 片段 B

有人提到 Cloudflare Access 太嚴格，先不要用完整登入驗證，只要 managed challenge。原因是目前想要免費版，而且先擋 bot 就好。

## 片段 D

Markdown 頁面不要顯示 Primary target 和 LLM binding，因為那些是內部資訊，使用者不需要看。

## 片段 A

v3 是基於 CozyPad-0.2.9-alpha。v2 Web 的精神要融合，但 v2 Web 頁面本身暫時隱藏。v1 的 SSH、Files、Terminal、Monitor 功能要帶進來。

## 片段 C

現在最重要的是讓 Markdown 可以測試。Windows 端拖入檔案，CozyPad API 轉送到 91，91 上匯入 markdown_summary_api.py，再用 Qwen3-14B 整理。

## 零散記錄

- 之前 README 有亂碼問題，可能是編碼或 GitHub release 文字不是 UTF-8。
- 5173 是前端 dev server。
- 5174 是 legacy v2 API server。
- 5174 如果沒有重啟，新 route 會 Not found。
- 有些截圖要放 README，但登入預覽要刪掉。

## 會議後待辦

1. 確認 markdown_summary_api.py 函式名稱。
2. 新增測試 md。
3. 驗證 summary result 是否用 markdown 顯示。
4. 把測試結果截圖放 README。

## 風險

遠端 91 連線若被擋，Markdown 彙整會失敗。這時應該顯示 SSH 錯誤，而不是說前端壞掉。
