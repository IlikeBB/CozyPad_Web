# Duplicate TODO Notes

TODO: 確認 91 server 上 python3 可以 import markdown_summary_api.py。

TODO: 確認 91 server 上 python3 可以 import markdown_summary_api.py。

TODO: 測試 summarize_files(payload) 是否回傳 dict。

TODO: 測試 summarize_files(payload) 是否回傳 dict。

TODO: 如果 summary 是字串，前端要用 markdown renderer 顯示。

TODO: 如果 result 是 object，先 JSON stringify，再用 markdown 顯示可能不理想，需要後續調整。

備註：這份檔案刻意重複待辦，摘要應該要去重或合併。

優先順序雜記：
- 高：遠端函式介面。
- 中：summary history。
- 低：漂亮的動畫。
- 高：API route 不可以 Not found。
- 中：錯誤訊息要清楚。
- 低：結果可以下載成 md。

決策雜記：
使用 91 作為預設。先不做多 server 選擇。先不把上傳內容落地到 Windows。透過 SSH stdin 傳到遠端比較乾淨。

問題：
- 如果模型很慢，前端是否需要進度條？
- 如果檔案很多，是否需要 queue？
- 如果使用者切頁，結果是否要保存？
