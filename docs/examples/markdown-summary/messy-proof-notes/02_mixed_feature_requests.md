# Mixed Feature Requests

這份檔案故意把功能需求寫得很亂，測試摘要是否能整理成「已完成、進行中、待確認」。

Files:
需要可以開圖片。後來已經有圖片預覽。mp3/mp4 也要能播放，但是之前點資料夾會 502，要確認是不是 preview API 一次讀太大。

Terminal:
使用者希望 SSH 不要斷線。切換分頁或關閉瀏覽器後，紀錄最好不要消失。Codex 也要背景繼續跑。這裡跟 tmux 或 server-side session 有關。

Codex:
一開始是本地端 Codex，後來確認錯了，應該使用遠端 server 的 Codex。右邊 Codex panel 曾經被隱藏，又改成要像 Claude 的版面。現在 Codex 任務要存在 server 上，切換 tab 不要消失。

Markdown:
新增左側 markdown button。內容是 LLM 整理 markdown 筆記。LLM 暫時不用完整掛，但目前會先預留遠端 model path 設定。目前已做拖放 md/txt。

Research:
columns 要改成 run, status, duration, seed, start date, end date。run 要用 codex 或 claude 開頭，後面四位亂碼。

Security:
不要存明文密碼。新增 server 用密碼安裝 key，之後只用 key。刪除、move、domain update 要二次確認。Cloudflare 先使用 managed challenge。

重複需求：
Markdown 回傳結果要用 markdown。
Markdown 回傳結果不要縱向。
Markdown 上傳清單要左到右。
Markdown 彙整中隱藏 Drop notes。

待確認：是否要把 markdown summary 寫回 91 的某個目錄。
