# Expected Organized Output Hints

這份檔案不是標準答案，而是用來讓模型知道使用者期待的整理風格。

好的彙整結果應該包含：

## 核心結論

簡短說明這批筆記主要在討論 CozyPad Markdown 彙整功能、遠端 91 server、Qwen3-14B、API route 與前端顯示調整。

## 已完成

- Markdown button 已加入左側 slide。
- 多個 md/txt 拖放區已建立。
- 回傳結果已改用 markdown renderer。
- Drop notes 會在 summarizing 時隱藏。
- Primary target 與 LLM binding 已隱藏。

## 待確認

- 遠端 Markdown summary API 是否提供 `summarize_files(payload)`。
- 遠端 Qwen3-14B 是否能正常載入。
- 長文件是否需要 chunking 或 queue。

## 風險

- SSH 連線失敗會導致 summary 失敗。
- API server 未重啟會造成 route Not found。
- 回傳內容若不是 markdown 字串，前端顯示品質可能較差。

## 待辦

- 測試 5 個檔案一起上傳。
- 檢查 summary 是否有去重。
- 將成功畫面截圖加入 README。
