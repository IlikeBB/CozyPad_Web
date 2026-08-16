# CozyPad Web Agent：Codex app-server 遷移方案

## 1. 結論

把 CozyPad Web Agent 裡的 Codex 改成接近官方 Codex App 的結構與使用方式是可行的，而且比繼續維護純文字 marker parser 更適合作為長期方案。

建議的目標不是複製官方桌面 App 的封閉 UI，而是採用官方開源 Codex CLI 的 `app-server` 協議與資料模型：

- `Thread`：一段持久對話。
- `Turn`：一次使用者輸入到該輪完成。
- `Item`：使用者訊息、Agent 訊息、推理摘要、命令、檔案修改、審批等結構化項目。
- `threadId + turnId + itemId`：所有串流更新的穩定 identity。

這會直接解決目前依賴 `[CozyPad User]`、`[CozyPad Codex]` 和輸出文字內容猜測角色所造成的輸入／輸出混合問題。

整體可行性評為 **高**，但不建議直接覆蓋舊 Codex 實作。應採「新 adapter 並行、逐步切流、保留 legacy fallback」的方式上線。

## 2. 範圍與非目標

### 本方案包含

- 使用官方 `codex app-server --stdio` 作為 Codex 執行核心。
- CozyPad 後端透過既有 ssh2 broker，在選定的遠端主機啟動並管理 app-server。
- 將官方 JSON-RPC 通知轉換成 CozyPad 的統一 Agent event。
- 前端依 Thread／Turn／Item 顯示結構化對話。
- 支援串流文字、命令執行、檔案修改、審批、問題詢問、中斷、歷史恢復與斷線重連。
- 保留現有 Files、Terminal、Monitor、模型選擇、工作目錄、工作流與其他 Agent。

### 本方案不包含

- 不複製官方 Codex Desktop 的私有素材或完整 UI bundle。
- 不移除 AGY、Bailian、Claude 或既有 Terminal／Files 功能。
- 不在第一階段強制把舊 CozyPad Codex history 無損轉換成官方 rollout。
- 不直接把 app-server 的實驗性 WebSocket port 暴露到網路。

## 3. 現況與目標架構

### 現況

目前 Codex 資料流大致是：

```text
Browser composer
  -> CozyPad WebSocket
  -> legacy-v2-api-server
  -> codex CLI process
  -> JSON/文字輸出 parser
  -> 追加到 task.output 字串
  -> 前端靠 marker 重新猜 role
```

主要問題：

1. `task.output` 同時承載 User、Codex、System 與執行狀態。
2. Codex 輸出如果含有 `User`、`Assistant` 或 `>`，前端可能誤判角色。
3. 執行中追加第二個問題時，前端先插入 User marker，但第一輪輸出仍在追加，造成視覺上的輪次錯置。
4. 命令、檔案修改和審批被降級成文字，無法可靠互動。
5. 重連只能重播字串 buffer，無法按 event identity 去重與補流。

### 目標

```text
Browser / CodexPanel
  -> CozyPad Agent Gateway (WebSocket/SSE + RPC)
  -> CodexRuntimeManager [owner + server]
  -> shared ssh2 broker
  -> one long-lived exec channel
  -> remote: codex app-server --stdio
  -> JSON-RPC Thread / Turn / Item events
```

一個 CozyPad 使用者在一臺主機上只建立一個可共用的 `CodexRuntime`。同一個 runtime 可以管理多個官方 Thread；不應為每個訊息或每個前端分頁啟動新的 SSH 或 app-server。

app-server 的 stdio channel 中斷後，後端重新啟動 app-server，再使用 `thread/resume` 恢復 Thread。Thread history 由遠端 Codex 自己持久化，因此不需要讓 stdio process 本身永遠不死。

## 4. 建議的模組拆分

不要把新邏輯繼續堆進 `scripts/legacy-v2-api-server.mjs`。建議新增：

```text
packages/adapter-codex/
  src/
    protocol/             # 由 app-server schema 產生或同步的型別
    AppServerClient.ts    # JSONL、RPC id、initialize、pending request
    CodexEventMapper.ts   # 官方事件 -> NormalizedAgentEvent
    CodexCapabilities.ts  # 版本與能力偵測
    index.ts

packages/contracts/src/
  codexRuntime.ts         # CozyPad 對瀏覽器的 runtime/event contract

scripts/lib/
  codex-runtime-manager.mjs
  codex-runtime-relay.mjs

apps/app/src/workspaces/agents/
  CodexWorkspace.tsx
  codexTurnReducer.ts
```

`LegacyCodexPanel.tsx` 暫時保留，只作為 fallback 與舊紀錄檢視器；新 Codex UI 不再呼叫 `parseCodexDialogue()`。

## 5. 資料模型

目前 `NormalizedAgentEvent` 已經是好的起點，但 envelope 需要補足官方層級：

```ts
type CodexEventEnvelope = {
  eventId: string;
  sequence: number;
  localSessionId: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  method: string;
  timestamp: string;
  rawEventVersion: string;
};
```

前端狀態必須以 identity 更新，不以文字相似度或陣列最後一項更新：

```ts
type CodexThreadState = {
  threadId: string;
  turnsById: Record<string, CodexTurnState>;
  turnOrder: string[];
  lastSequence: number;
};

type CodexTurnState = {
  turnId: string;
  status: 'queued' | 'inProgress' | 'completed' | 'failed' | 'interrupted';
  itemsById: Record<string, CodexItem>;
  itemOrder: string[];
};
```

使用者送出訊息時產生 `clientUserMessageId`。收到官方 `userMessage.clientId` 後，將 optimistic message 與正式 item 合併，避免重複顯示。

### 執行中再次輸入的語意

必須在 UI 上分成兩個明確動作：

- **排入下一輪**：由 CozyPad queue 保存，等待 `turn/completed` 後再呼叫下一次 `turn/start`。
- **補充目前回合**：明確使用官方 `turn/steer`，並標示它屬於目前的 `turnId`。

預設採「排入下一輪」，最不容易造成使用者誤解。

## 6. SSH、程序與多使用者隔離

### SSH 連線成本

每個活躍的 `owner + server`：

- 1 個共用 ssh2 broker connection。
- 1 個長駐 app-server exec channel。
- Files／Monitor 使用短命 exec channel。
- Terminal 使用獨立 shell channel。

因此切換到官方 app-server 不需要每個 prompt 新建 SSH；但長駐 app-server 會固定占用一個 broker channel。現有每主機 6 channel 上限需要納入容量計算，建議為互動 Terminal 保留至少 1 個 channel，並將背景工作排隊。

### app-server runtime key

```text
owner + connectionProfileId + remoteHostFingerprint + codexHomeNamespace
```

不能只使用 host。否則同一 SSH 帳號下的不同 CozyPad 使用者可能共用 Codex auth、thread history 與 pending approval。

### `CODEX_HOME` 隔離

若多個 CozyPad 使用者共用同一個遠端 OS/SSH 帳號，必須為每位使用者設定獨立的遠端 `CODEX_HOME`，例如：

```text
$HOME/.cozypad/users/<safe-owner>/codex-home
```

這同時帶來一個產品問題：每個隔離的 `CODEX_HOME` 都要完成自己的 Codex 登入。若產品選擇共用登入，則必須明確承認它不是嚴格多租戶隔離，且不可把不同使用者的 Thread 列表互相暴露。

## 7. 版本與協議相容性

官方 app-server 仍在快速演進，這會是最大的長期維護成本。

建議：

1. 啟動時先執行 `codex --version` 和 capability probe。
2. 以版本為 key 快取 schema fingerprint。
3. 開發／CI 使用 `codex app-server generate-ts` 或 `generate-json-schema` 產生對應型別。
4. runtime parser 對未知 notification 採「保留 raw event、忽略未知 UI 類型」，不能讓整個 Thread 崩潰。
5. 設定最低支援版本；不符合時回退 legacy adapter，而不是嘗試猜格式。
6. 只依賴 v2 Thread／Turn／Item API；不要擴充已過時的 v1 surface。

CozyPad relay 本身也需要 bounded queue。官方 app-server 會在 ingress 過載時回覆 `-32001`，relay 應使用帶 jitter 的指數退避，而且不得把一次 retry 轉換成新的 SSH process。

## 8. 審批與安全問題

app-server 不只會發 notification，也會向 client 發出 server-initiated request，例如命令審批、檔案修改審批與 `requestUserInput`。後端必須保存：

```text
requestId -> owner + serverId + threadId + turnId + itemId + expiresAt
```

安全規則：

- 只有擁有該 Thread 的登入使用者可以回覆。
- 前端斷線時 pending request 保留在後端，重連後重新呈現。
- 超時或 runtime owner 消失時預設 deny/cancel，不可自動 allow。
- browser 不直接接觸 app-server stdin，也不能自行指定任意 JSON-RPC method。
- Gateway 只暴露 allowlist RPC，並以 Zod 驗證 request/response。
- 所有 approval decision 留下 audit log。

## 9. 舊資料遷移策略

舊 CozyPad history 與官方 rollout 不是同一資料格式，不能宣稱可以無損轉換。

建議：

- 舊任務保持可讀、可搜尋，標示為 `Legacy Codex`。
- 新任務預設使用 `Official Codex` adapter。
- 提供「以此內容開始新 Thread」，把舊對話摘要或最近幾輪作為一個新的使用者 context，而不是偽造官方歷史。
- 第一版不要依賴實驗性的 raw history injection 作為主要遷移途徑。
- workflow 紀錄新增 `runtime: 'legacy-cli' | 'app-server-v2'` 與 `threadId`，避免同一筆資料被兩個 adapter 同時接管。

## 10. 分階段執行方案

### Phase 0：相容性 Spike

目標：不改 UI，證明 91 測試主機或指定測試主機能穩定執行 app-server。

- 偵測 `codex app-server --help`。
- 完成 `initialize -> initialized`。
- 執行 `thread/start -> turn/start`。
- 接收 agent message delta、command、file change、turn completed。
- 中斷 SSH channel，重新啟動 app-server 並 `thread/resume`。
- 記錄一個 runtime 會占用多少 SSH channel、記憶體與 idle 資源。

Gate：連續 50 輪不丟 event、不跨 Thread 串流，斷線恢復後不重複訊息。

### Phase 1：Backend Adapter

- 建立 `adapter-codex` 和 `CodexRuntimeManager`。
- 加入 JSON-RPC request id、initialize、notification、server request、timeout 和 process lifecycle。
- 建立 owner/server runtime single-flight，防止同時啟動多個 app-server。
- 建立 event sequence、有限 replay buffer 與 reconnect cursor。
- 加入 feature flag：`COZYPAD_CODEX_RUNTIME=legacy|app-server|auto`。

Gate：後端 contract test、模擬 process crash、SSH 斷線、重複 notification、未知 event 與 overload。

### Phase 2：Structured Codex UI

- 新增 `CodexWorkspace` 與 Turn reducer。
- 顯示 userMessage、agentMessage、reasoning summary、commandExecution、fileChange、plan、usage。
- optimistic user message 使用 `clientUserMessageId` 去重。
- running 時預設 queue；另設明確的 steer 行為。
- Stop 對應 `turn/interrupt`，不能只 kill WebSocket。

Gate：任何 Codex 輸出即使包含 `User`、`Assistant`、marker 或 `>`，都不能改變 role。

### Phase 3：審批、恢復與歷史

- 完成 approval 與 requestUserInput UI。
- Thread list/read/resume/archive。
- browser refresh、換頁與換裝置後恢復。
- 舊 history read-only 顯示與「開始新官方 Thread」。
- app-server restart 後重新訂閱與補齊 items。

Gate：審批不串 Thread；離線期間完成的 Turn 可在重連後還原；沒有重複 bubble。

### Phase 4：灰度切換

- Admin／測試帳號先使用 `app-server`。
- 逐主機啟用 capability probe。
- 記錄成功率、平均 turn latency、runtime restart、SSH channel、fallback、approval timeout。
- 穩定後將 `auto` 設為預設，但保留 legacy 手動回退至少一個發佈週期。

Gate：新 runtime 的錯誤率不高於 legacy，且 SSH connection 不隨訊息數成長。

## 11. 測試矩陣

最低需要覆蓋：

| 情境 | 驗收結果 |
|---|---|
| Codex 回覆包含 `User`／`Assistant`／marker | role 不變 |
| 同一 Thread 連續送出 20 輪 | 每輪各自綁定 turnId |
| 執行中排入 5 個問題 | 依序開始，不混入當前輪 |
| 明確 steer 當前輪 | user item 綁定目前 turnId |
| 同一使用者開兩個 browser tab | 共用 runtime，不重複啟動 app-server |
| 兩個使用者使用同一主機 | Thread、approval、CODEX_HOME 隔離 |
| SSH channel 中斷 | 有限退避後重啟並 resume |
| Browser refresh | 不重啟 SSH，按 sequence 補流 |
| Command approval | 只由正確 owner/thread 回覆 |
| app-server 未安裝或版本過舊 | 顯示原因並回退 legacy |
| 大量 delta／命令輸出 | bounded queue，不耗盡記憶體 |
| Terminal、Files、Monitor 同時使用 | broker channel 有上限且公平排隊 |

## 12. 已知風險與處理

| 風險 | 影響 | 處理方式 |
|---|---|---|
| app-server API 版本變動 | event parser 或 RPC 失效 | 版本 probe、生成 schema、最低版本、legacy fallback |
| 遠端沒有 Codex／未登入 | runtime 無法啟動 | capability/status 頁面與每 owner 登入流程 |
| 多使用者共用遠端 HOME | auth、history 洩漏 | owner-scoped CODEX_HOME 或一人一 SSH user |
| browser 在 approval 時離線 | Turn 卡住 | backend pending store、重連重播、超時 deny |
| relay/app-server 重啟 | live delta 短暫遺失 | sequence buffer + thread/read/resume 補齊 |
| 舊 history 不相容 | 無法無損續聊 | legacy read-only + 新 Thread context handoff |
| 一臺主機太多活躍使用者 | app-server process/SSH channel 過多 | per-owner quota、idle eviction、runtime metrics |
| 完全照抄第三方 UI | 升級與授權負擔 | 只採協議與設計模式，保留 CozyPad UI/功能 |

## 13. 工期與優先順序

由一位熟悉現有 CozyPad 後端與 React 的工程師執行，合理估計：

- Phase 0：1–2 個工作日。
- Phase 1：4–7 個工作日。
- Phase 2：4–7 個工作日。
- Phase 3：4–7 個工作日。
- Phase 4：3–5 個工作日觀察與修正。

完整穩定替換約需 **3–5 週**；若第一版只要求純文字聊天、正確 Turn identity 和中斷功能，可在 **1–2 週**內做出可測 MVP。

實作優先順序：

1. app-server spike 與 owner/CODEX_HOME 隔離決策。
2. runtime manager 與結構化 event contract。
3. 正確的 Thread／Turn／Item UI。
4. approvals、history、reconnect。
5. legacy 灰度切換與監控。

## 14. 參考來源

- 官方 Codex app-server：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- 本地官方原始碼：`C:\Users\27419\Desktop\ai-tools\references\openai-codex`
- 官方 app-server test client：`references/openai-codex/codex-rs/app-server-test-client`
- CodexUI 參考 bridge：`references/codexui/src/server/codexAppServerBridge.ts`
- CozyPad 現行 Codex UI：`apps/app/src/workspaces/agents/LegacyCodexPanel.tsx`
- CozyPad 現行 Codex backend：`scripts/legacy-v2-api-server.mjs`

官方 Codex repository 採 Apache-2.0；本地參考的 CodexUI 採 MIT。實際移植程式碼時仍需保留對應授權與 copyright notice。

## 15. Implementation and rollout status (2026-08-13)

Implemented behind `COZYPAD_CODEX_RUNTIME`:

- `legacy` (default): existing `/api/codex/session` and UI remain unchanged.
- `app-server`: Agents / Codex uses the structured app-server panel and keeps a visible Legacy fallback button.
- `auto`: remains legacy unless the browser explicitly sets `cozypad.codexAppServer.autoOptIn.v1=true`.

The backend now provides an owner/server/host/CODEX_HOME keyed single-flight runtime, bounded event replay, bounded restart, pending approval replay, RPC allowlisting, a read-only status endpoint, and the independent `/api/codex/app-server/session` WebSocket route. Remote app-server startup only uses an existing `ssh2` broker and never falls back to `ssh.exe`.

The first structured UI supports thread list/start/resume, turn start/interrupt, typed user/agent/command/tool items, command/file/permission approvals, `requestUserInput`, reconnect with sequence replay, and history reconstruction from official thread turns. Existing Files, Terminal, Monitor, Research, agy and baillian routes are untouched.

Verification completed locally:

- 65 targeted contract, adapter, runtime-manager and UI reducer tests pass.
- A 100-caller concurrency burst creates one transport for one runtime identity.
- App, contracts and adapter TypeScript checks pass.
- Production Vite build passes.
- The legacy API starts on a test port; `/api/health` returns 200 and unauthenticated runtime status returns 401.
- No remote SSH was used by tests.
- Browser regression confirms the default legacy Codex panel still renders while disconnected, does not start SSH, and emits no console errors.

The installed Microsoft Store Codex executable could not be spawned from this managed workspace (`Access is denied`), so the real local app-server process smoke test remains an environment verification item. Before enabling a remote host, run the same `initialize -> initialized -> thread/list` probe for that host and confirm its isolated `CODEX_HOME` is logged in.
