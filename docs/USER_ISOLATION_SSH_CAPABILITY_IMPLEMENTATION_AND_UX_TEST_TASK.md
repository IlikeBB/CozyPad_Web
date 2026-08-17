# CozyPad 多帳號隔離、SSH 安全建立與權限 UI 任務書

## 1. 任務目的

在不處理公開註冊功能的前提下，先建立適合內測使用的多帳號基礎：

1. 不同 CozyPad 使用者的瀏覽器狀態互不污染。
2. SSH profile 可以先保存，亦可透過可回滾流程完成金鑰安裝與連線驗證。
3. 前端顯示的功能與後端實際權限一致。
4. 功能完成後，以一般使用者身分實際操作 UI，記錄不順手、難理解、狀態不清楚及視覺異常的地方，提交給產品負責人決定如何修正。

本任務分成兩個部分：

- Part A：功能實現與自動化驗證。
- Part B：滑鼠／鍵盤導向的使用者體驗測試與回饋。

## 2. 本輪產品決策

- 不新增註冊、邀請或使用者管理 UI。
- Research 資料本輪先做使用者分區，不立即改成完整雲端同步；結構需保留日後移到後端的可能。
- SSH Connection Manager 同時提供 `Save without connecting` 和 `Add & Connect`。
- 一般使用者完全隱藏 Public 管理入口與 Developer/mock 工具。
- 後端仍是最終權限判定者；前端隱藏功能不能取代 API 權限檢查。
- 不引入 Teleport、SSH CA 或新的大型狀態管理框架。
- SSH 流程可先用 TypeScript 狀態模型／reducer 實作，不強制加入 XState。

## 3. 不在本輪範圍

- 公開註冊、自助建立帳號、忘記密碼。
- 多組織、Team、Project 級 RBAC。
- Teleport、Vault、SSH CA 或短效 SSH certificate。
- 將所有 Research 資料同步到多裝置。
- 大幅重新設計 Agents、Terminal、Files 或 Research 的整體視覺。
- 與本任務無關的上游大版本整包覆蓋。

# Part A：功能實現

## A1. 建立使用者分區 Storage Adapter

新增統一的 storage abstraction，禁止各功能自行拼接全域 localStorage key。

建議介面：

```ts
type UserStorage = {
  get<T>(feature: string, fallback: T): T;
  set<T>(feature: string, value: T): void;
  remove(feature: string): void;
};

createUserStorage(userId: string): UserStorage;
```

正式 key 格式：

```text
cozypad4.user.<normalized-user-id>.<feature>.vN
```

必須分區的資料：

- Codex model、reasoning effort、Review permission、Threads 收合狀態。
- Goal policy 與僅屬於該帳號的 Goal UI 狀態。
- Composer draft。
- Research flowcharts、active flowchart、Markdown 與分析 agent 選項。
- Work runs 與 deleted run IDs。
- 最後選擇的 SSH server。
- Agent task queue 與尚未送出的非敏感任務資料。

不得保存到 localStorage：

- Password、Private key 內容。
- Session token、Bearer token。
- 未限定使用者的 Full access／Review 授權狀態。

Review permission 的安全預設為 `Ask for approval`。它可以在單一使用者範圍內保存，但不得從舊全域資料遷移，也不得被其他帳號繼承。

## A2. 舊資料遷移

登入並確認使用者後才執行遷移，不得在尚未得知使用者身分時遷移。

規則：

1. 舊 `cozypad3.*` 和全域 `cozypad4.*` 只遷移給 admin。
2. 一般使用者第一次登入必須取得乾淨空狀態。
3. Review／Full access 不遷移。
4. 每個遷移步驟須有版本 marker，重整頁面不能重複執行。
5. 遷移失敗不得阻止登入；顯示可理解的警告並保留舊資料。
6. 遷移完成後，本輪先不刪除舊 key，待驗證完成再另行決定清理策略。

## A3. 帳號切換生命週期

登出或切換帳號時必須：

- 停止目前使用者的 polling、WebSocket、event subscription 與尚未完成的 request。
- 清空 React 中與帳號綁定的 state。
- 關閉或重新確認 SSH／Codex runtime 所屬帳號。
- 清除尚未提交的密碼、私鑰與 credential prompt。
- 重新建立下一位使用者的 storage adapter。
- 不刪除前一位使用者已保存的合法偏好。

禁止出現 admin → user → admin 後，admin 的 Model、Effort、Review、Research 或 SSH 選擇被 user 覆蓋。

## A4. Capability-driven UI

擴充 session response：

```json
{
  "user": {
    "username": "EFan",
    "role": "user"
  },
  "capabilities": [
    "agent.use",
    "research.use",
    "ssh.manage-own"
  ]
}
```

第一版 capability：

```text
agent.use
research.use
ssh.manage-own
ssh.import-system-config
public.read
public.manage
developer.simulate-drop
```

要求：

- `Public` 只有具備 `public.read` 或 `public.manage` 時顯示。
- `Start / Repair`、`Restart tunnel` 需要 `public.manage`。
- `Import ~/.ssh` 依 `ssh.import-system-config` 決定是否出現；不能顯示一個必定回傳 0 或 403 的假入口。
- Developer/mock 功能需要 `developer.simulate-drop` 且必須處於開發模式。
- 後端所有相應 API 採 deny-by-default，不能只依賴前端。
- UI 與 API 使用同一份 capability 定義，避免前後端名稱漂移。

## A5. SSH profile 與 provisioning 分離

### Save without connecting

- 只保存名稱、Host、Port、Username、起始目錄和驗證方式。
- 不要求輸入或保存密碼。
- profile 狀態標記為 `pending` 或 `not-provisioned`。
- 使用者稍後可按 Connect 開始驗證與 provisioning。

### Add & Connect

必須顯示以下狀態：

```text
validating
verifying-host
generating-key
installing-key
testing-key
saving-profile
ready
rolling-back
failed
cleanup-required
```

UI 需顯示目前進度，不得只顯示旋轉圖示或 `處理中`。

## A6. Transactional SSH provisioning

推薦流程：

1. 驗證表單與重複 profile。
2. 建立 operation ID，並以 user + host + port 建立單一操作鎖。
3. 連線前取得 Host key fingerprint。
4. 未信任 Host key必須要求使用者明確確認；變更過的 Host key 必須阻止連線。
5. 在正式 key 目錄的同一磁碟建立暫存目錄。
6. 在暫存目錄產生 private/public key。
7. 使用一次性密碼連線，將帶有唯一 comment 的 public key 加入 `authorized_keys`。
8. 保留密碼連線，另外建立 key-based 驗證連線。
9. 驗證 hostname、工作目錄與 key 登入成功。
10. 保存 profile。
11. 將暫存 key 目錄移至正式 profile 目錄。
12. 將狀態設為 ready，清除記憶體中的密碼。

public key comment：

```text
cozypad:<username>:<profile-id>:<operation-id>
```

失敗時：

1. 使用仍存在的密碼連線，依完整 key/fingerprint 移除本次加入的遠端 key。
2. 刪除本機暫存 key。
3. 不保存 ready profile。
4. 若遠端清理失敗，保存不含密碼的 cleanup record，狀態設為 `cleanup-required`。
5. UI 必須明確說明「主要操作失敗」與「清理是否成功」。

不得因為同一台主機連續按多次按鈕而平行產生多組 key 或多次登入。

## A7. SSH 錯誤模型

API 回傳結構化錯誤：

```json
{
  "code": "SSH_AUTH_FAILED",
  "stage": "installing-key",
  "message": "SSH password authentication failed",
  "retryable": true,
  "cleanup": "complete"
}
```

至少區分：

- `INVALID_INPUT`
- `DUPLICATE_PROFILE`
- `HOST_UNREACHABLE`
- `HOST_KEY_UNKNOWN`
- `HOST_KEY_CHANGED`
- `SSH_AUTH_FAILED`
- `KEY_GENERATION_FAILED`
- `KEY_INSTALL_FAILED`
- `KEY_VERIFICATION_FAILED`
- `PROFILE_COMMIT_FAILED`
- `CLEANUP_FAILED`

前端不得直接顯示 `LegacyApiError:`、stack trace 或本機敏感路徑。

## A8. 實作階段自動化測試

### Storage tests

- admin 與 EFan 使用不同 key。
- admin 的 model/effort 不會出現在 EFan。
- Review 預設為 Ask for approval。
- 舊資料只遷移給 admin 且只執行一次。
- logout/login 後恢復各自設定。
- localStorage 讀取失敗或 quota error 不會造成白畫面。

### Capability tests

- 普通 user 沒有 Public 與 Developer 功能。
- admin 可以看到並使用允許的功能。
- 手動呼叫受限 API 時，普通 user 仍收到 403。
- 未知 capability 預設拒絕。

### SSH tests

- Save without connecting 不會開啟 SSH。
- provisioning 成功只留下正式 key 和一個 profile。
- Host unreachable 不留下 key。
- Password 錯誤不留下 key。
- key 安裝成功但驗證失敗時會移除遠端 key。
- rollback 失敗會產生 cleanup-required record。
- 同一 user/host 的併發操作只允許一個執行。
- 重複重試不會在 authorized_keys 累積重複 key。
- Host key changed 必須阻止傳送密碼。

# Part B：滑鼠／鍵盤使用者體驗測試

## B1. 測試原則

功能實作和自動化測試完成後，測試者要以一般使用者角度實際操作 CozyPad。

主要流程只能透過以下方式完成：

- 滑鼠點擊、鍵盤輸入。
- Tab／Shift+Tab 導覽。
- Enter、Space、Escape、方向鍵。
- 滑鼠滾輪與拖動 scrollbar。
- 頁面上真實可見的選單、按鈕、表單和對話框。

不得用以下方式替代使用者流程：

- 直接呼叫 API 完成操作。
- 直接修改 localStorage／IndexedDB 來製造成功狀態。
- 直接執行 DOM script 點擊隱藏元素。
- 直接修改資料檔案假裝使用者已完成設定。
- 只依靠單元測試宣稱 UI 可用。

瀏覽器自動化可以用，但操作必須對應真實滑鼠／鍵盤行為，例如 click、fill、press、select、scroll；每個主要判斷都要能由可見 UI 證明。

## B2. 測試帳號與資料

- admin：驗證既有資料與管理功能沒有退化。
- fresh user：沒有 SSH profile、Threads、Runs 和 Research 自訂資料。
- 測試帳號不得讀到 admin 的 SSH、Threads、Research、Model、Effort 或 Review 狀態。
- 密碼不得寫入報告、截圖、console 或測試 fixture。

## B3. Mouse-first 測試

逐項使用滑鼠完成：

1. 登入 fresh user。
2. 瀏覽全部主導航。
3. 開啟／關閉 Connection Manager。
4. Save without connecting。
5. 從 pending profile 發起 Connect。
6. 取消 Host key 確認，再重新開始。
7. 使用錯誤密碼並確認可恢復。
8. 使用正確資料完成連線。
9. 展開、收合、編輯、刪除 profile。
10. 登出 fresh user，登入 admin，確認 admin 狀態保持。
11. 檢查長連線列表的滾輪與 scrollbar。
12. 檢查 loading／error 出現時頁面是否跳動、抽搐或失去目前位置。

## B4. Keyboard-first 測試

不使用滑鼠，完成：

1. 從登入頁 Tab 到所有控制項。
2. Enter 提交登入表單。
3. 使用 Tab／Shift+Tab 遍歷頂部主機選擇、導航、Connection Manager。
4. Space 或 Enter 啟動按鈕。
5. 方向鍵操作 select／menu。
6. Escape 關閉 modal，但不得意外丟失已輸入內容；若設計會丟失，需提供確認。
7. Enter 提交 SSH 表單，Shift+Enter 不應造成意外提交。
8. 焦點必須留在可見元素，modal 開啟時不能跑到背景頁面。
9. modal 關閉後焦點回到原觸發按鈕。
10. 錯誤發生後焦點移到錯誤摘要或第一個錯誤欄位。

## B5. 使用者體驗觀察重點

每個流程都要回答：

- 我是否知道現在可以做什麼？
- 按鈕名稱是否符合實際行為？
- 我是否知道系統目前正在做哪一步？
- 等待時是否誤以為頁面壞掉？
- 錯誤訊息是否告訴我原因和下一步？
- 取消、重試、返回是否容易找到？
- 狀態改變時頁面是否跳動、抽搐或捲動位置重置？
- disabled 控制項是否有原因說明？
- 一般使用者是否看到無權使用或不需要理解的功能？
- 是否有不必要的專業術語、mock、legacy 或內部錯誤文字？

## B6. 測試回饋規則

測試階段發現的主觀 UX 問題，先回報產品負責人，不直接修改。

每個問題使用以下格式：

```md
### UX-001 — Severity

- 頁面／功能：
- 使用者目標：
- 操作方式：Mouse / Keyboard
- 前置條件：
- 重現步驟：
- 實際結果：
- 為什麼不順手或奇怪：
- 預期體驗：
- 建議方向（不是直接決定）：
- 證據：截圖／錄影／console／network
```

嚴重度：

- Blocker：無法完成主要流程。
- High：可能造成資料混用、安全問題或無法可靠恢復。
- Medium：可以完成，但很容易誤解或操作成本高。
- Low：文案、間距、焦點、視覺一致性等小問題。

## B7. 測試交付物

完成體驗後提交：

1. 通過的使用者流程列表。
2. 未通過的流程與阻斷原因。
3. UX 問題清單，依嚴重度排序。
4. 每個問題的滑鼠／鍵盤重現步驟。
5. 必要的截圖或短錄影。
6. 建議修正方向與可能影響。
7. 明確列出「需產品負責人決定」的項目。

測試者提交回饋後停止，不自行進行主觀 UI 重設計；等待產品負責人選擇修正項目與方向。

# 4. 完成標準

Part A 完成需同時符合：

- 使用者狀態不存在已知跨帳號污染。
- Review 權限使用安全預設。
- SSH 失敗不留下未記錄的本機 key 或遠端 authorized key。
- 一般使用者看不到管理員與 Developer 功能。
- 前後端 capability 測試通過。
- 所有新增及既有相關測試通過。

Part B 完成需同時符合：

- 已使用 fresh user 和 admin 完成帳號切換測試。
- 主要流程實際透過滑鼠和鍵盤操作。
- 已檢查 keyboard focus、modal、scroll、loading 與 error recovery。
- 已產出結構化 UX 回饋文件。
- 主觀修正項目已交由產品負責人決定，未擅自更改產品方向。

# 5. 建議執行順序

```text
A1 Storage adapter
→ A2 Migration
→ A3 Account lifecycle
→ A4 Capabilities
→ A5 Profile/provisioning split
→ A6 Transactional SSH
→ A7 Error model
→ A8 Automated tests
→ Part B Mouse/Keyboard UX test
→ 提交回饋
→ 討論下一個修正 Goal
```

