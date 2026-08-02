# Raw Chat Log - CozyPad Markdown Test

今天先不處理 README，先看 markdown 彙整。

使用者說希望可以丟多個 md 和 txt，最好不要一次只能單檔。後來又說回傳結果要是 markdown，不要只是一大段文字。這件事很重要，因為如果回傳還是 pre block，看不出表格和 checkbox。

突然想到：送到 91 彙整時，Drop notes 那個很大的區塊應該要暫時隱藏，不然畫面很擠。處理完後再出現。

重複提醒：
- 回傳結果要用 markdown。
- Summary result 要從左到右。
- 上傳檔案卡片也要從左到右。
- Primary target 和 LLM binding 不要顯示。

有一個問題是 5174 API server 沒重啟，所以 route 回 Not found。這不是 91 的問題，也不是模型問題。重啟後 route 變成 Authentication required，代表 API 已經有進去。

待辦：
- 做幾個測試 md。
- 測試拖放 5 個檔案。
- 看 summary 是否會把重複的重點合併。
- 確認遠端 script 是否有 summarize_files(payload)。

不知道遠端 Python 現在是否真的會載入 Qwen3-14B，先只驗證介面格式。

決策：目前先以 NCKU-91 為主，不要做 server 下拉選單。

又重複一次：Drop notes 彙整中要隱藏。
