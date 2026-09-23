# 參考文件

留在 [README](../README.zh-TW.md) 之外、需要解釋時才查的細節：執行狀態與錯誤分類、
決策迴圈與它所驅動表面之間的邊界，以及與移植來源 Cline plugin 的差異。

- [瀏覽器這一側提供什麼](#瀏覽器這一側提供什麼)
- [執行結果與狀態](#執行結果與狀態)
- [迴圈記得什麼、拒絕對什麼動作](#迴圈記得什麼拒絕對什麼動作)
- [使用手動工具](#使用手動工具)
- [Profile](#profile)
- [迴圈在哪裡結束、表面從哪裡開始](#迴圈在哪裡結束表面從哪裡開始)
- [與 Cline plugin 的差異](#與-cline-plugin-的差異)

## 瀏覽器這一側提供什麼

除了決策迴圈，瀏覽器工具還附帶：

- 截圖以影像工具結果回傳，代理可以驗證結果
- 批次的 `click`、`double_click`、`scroll`、`type`、`wait`、`keypress`、`drag`、
  `move`、`navigate`、`back`、`forward`、`reload` 與 `screenshot` 動作
- 瀏覽器 console、頁面錯誤、失敗請求、導覽、下載與安全記錄
- 每次執行的 PNG 產物與選用的 WebM 錄影，含可見的代理游標與點擊動畫
- 綁定 `127.0.0.1`、帶 token 的即時截圖／記錄檢視器
- session 隔離、封鎖下載、封鎖 service worker、不繼承宿主環境、停用 extension
  與瀏覽器檔案系統存取
- 有界的瀏覽器啟動、導覽、影片完成與清理 timeout，讓無法使用的應用程式帶著
  底層錯誤失敗而不是懸掛
- macOS 上 headless Chromium 無法啟動時自動退回可見瀏覽器
- 瀏覽器執行串流決策時的即時頁尾狀態列
- 涵蓋 prompt injection、敏感資料與有後果動作的 prompt 指引

## 執行結果與狀態

一次 `jev_run` 結果帶著 `status`、`steps`、`elapsedMs` 與一份 JSONL 的
`tracePath`。狀態有 `done_unverified`、`blocked`、`needs_review`、`uncertain`、
`step_limit`、`evaluation_limit` 或 `interrupted`。失敗的執行另外回報 `failure`
（`stage`、`category`、`detail`）與 `errorsLogPath`。

`failure.detail` 是有界的摘要（錯誤名稱，已知時附 HTTP 狀態），執行目錄裡的
`errors.log` 則有完整錯誤含堆疊。供應商錯誤可能引用送出的請求內容，所以完整
文字只寫進那個本機檔案，從不回傳給模型。失敗執行中已嘗試的動作可能已經生效：
繼續之前先確認。

### `failure.category`

| `failure.category` | 意思 |
| --- | --- |
| `configuration` | 設定缺少或無法讀取；訊息指出要設定的檔案與變數。在 Chromium 啟動前就回報。 |
| `text_helper_invalid_output` | 作用中的 pi 模型沒有回傳可用的 `{"text": ...}`。什麼都沒打。 |
| `cancelled` | 執行被中止或達到期限。 |
| `navigation_context` | 讀取期間文件改變了。 |
| `timeout` | 有界的瀏覽器或模型 timeout 到期。 |
| `document_not_ready` | 頁面始終沒有產生可讀的文件。 |
| `unexpected_error` | 其他任何情況，通常是供應商錯誤。 |

### `stopReason`

`stopReason` 說明迴圈為什麼停下來，與模型的狀態無關。

| `stopReason` | 意思 |
| --- | --- |
| `model_done` | Jev 回報 DONE；狀態是 `done_unverified`，因為宣稱不是證據。 |
| `model_blocked` | Jev 回報 BLOCKED：沒有支援的動作能推進。 |
| `model_review` | Jev 回報 REVIEW：下一步需要敏感資料、要送出東西，或跨越 CAPTCHA 之類的安全屏障。 |
| `submit_review` | 迴圈自己拒絕在沒有確認控制項的欄位（聊天輸入框、命令列）按下 Return：那會送出或執行已輸入的內容。狀態是 `needs_review`，由使用者送出。 |
| `verification_gate` | 迴圈自己拒絕人工驗證關卡，在詢問 Jev 之前：頁面文字宣告了挑戰，且有控制項提供通過它。狀態是 `needs_review`，交給使用者處理這一步。 |
| `min_probability` | 所選選項低於要求的 `minProbability`。 |
| `step_limit` / `evaluation_limit` | 動作或評估預算用完了。 |
| `repeated_action` | 相同的動作不再產生新狀態（一個控制項在自己已產生過的狀態之間循環），或連續執行 12 次作為最後防線。會持續產生新狀態的重複按壓是允許的，因為輸入 `111` 是合法的輸入。 |
| `scroll_oscillation` | `SCROLL_UP` 與 `SCROLL_DOWN` 反覆交替，這種兩步循環不是探索。 |
| `stale_observations` | 連續四個觀察在動作執行前就已失效。 |
| `no_progress` | 三個動作沒有產生任何可觀察的變化。按兩次都沒變化、或按下後第二次導致同一個已出現過狀態（會亮起的訊息泡泡、重新打開的分頁）的控制項，會先從下一次問題中撤下，所以問題改變時計數重新開始；只有當 Jev 不斷選擇什麼都改變不了的新控制項時，執行才會停止。兩次讀取之間只差空白或標點不算變化。 |
| `text_unavailable` | 目標與 pi 文字 helper 都沒有提供欄位的值，所以什麼都沒打。 |
| `cancelled` / `error` | 執行被中止，或失敗了；見 `failure`。 |

### 回傳的頁面證據

一次 `jev_run` 結果帶著迴圈停止時擷取的頁面狀態：JSON 摘要（`status`、
`stopReason`、`failure`、`steps`、`tracePath`、`errorsLogPath`、`finalPageUrl`、
`finalPageTitle`）、一段可讀的區塊含最終 URL、標題與可見頁面文字，以及執行前後
的截圖。那段文字是沒有影像輸入的模型用來驗證結果的內容，所以迴圈回傳它，而不是
逼人讀截圖。每一次執行的完整記錄也會落在那次 trace 最後的 `result` 項目裡。

trace 記錄決策（含終止與被拒絕的決策）、失效的觀察、動作嘗試、完成與最終結果。
供應商提供的信心值另外記錄。trace 不含產生的欄位文字，但可能包含頁面標籤。

## 迴圈記得什麼、拒絕對什麼動作

迴圈在同一個瀏覽器 session 中，跨同一個目標的多次執行保留最近十個動作、輸入的
文字與觀察到的進展。文字留在記憶體裡，不會寫進 trace。失效的決策會在 `maxSteps`
兩倍的預算內重新評估；已執行的變更永不重試。

它保留觀察到的 DOM 節點，動作前檢查頁面語意、節點身分與遮擋。開放式 shadow root
會被走訪，所以 web component 的控制項與文字像 light DOM 一樣被觀察與操作：命中
測試會下探 shadow tree，而覆蓋目標的 shadow 渲染覆蓋層會被指名為遮擋者。封閉式
shadow root、frame、canvas 控制項、巢狀捲動、上傳與任意鍵盤小工具不在這個 DOM
迴圈內；那些情況請用 `jev_actions`。

模型上下文上限是 200 個動作目標與 6,000 個可見文字字元，外加 50 個已選取選項與
每個方向最多 50 個畫面外控制項標籤。這可能在密集的頁面上漏掉控制項。

頁面文字與可見欄位值會送到 TypeSafe `api.typesafe.ai`；當欄位的值必須產生、因為
目標裡沒有它時，同樣的內容也會送到你的 pi 模型供應商。密碼與檔案欄位被排除，但
其他敏感內容不會自動遮蔽。Jev 被要求在具後果的動作前回傳 `REVIEW`；那是模型
指引，不是決定性的安全邊界。

## 使用手動工具

### 用元素目標取代座標

手動的 click、fill 或 select 可以定位元素而不是像素，版面變了同一個呼叫仍然
有效：

```json
[
  { "type": "click", "target": { "role": "link", "name": "部落格" } },
  { "type": "fill", "target": { "role": "textbox", "name": "Email" }, "value": "a@b.c" },
  { "type": "select", "target": { "role": "combobox", "name": "Plan" }, "value": "pro" },
  { "type": "click", "target": { "selector": "#submit" } },
  { "type": "click", "target": { "role": "button", "name": "Buy", "nth": 1 } }
]
```

目標接受 `role`、`name`（需要 `role`）、`text`、`selector` 與 `nth`。比對最多等
五秒讓元素出現，所以一個批次可以點連結再對導向後的頁面動作。沒有任何元素符合的
目標會以 `No element matched …` 失敗，而不是點到游標下剛好的東西。`x`/`y` 座標
仍可用於 canvas 類的表面。

座標點擊是原始事件，所以瀏覽器會把它送進 iframe，即使自動迴圈從不看 frame 的
內容。當點擊或拖曳落在 frame 上，結果帶一個 `warnings` 項目，`jev_logs` 出現
對應的 `security` 項目，指名 frame 的 origin 並標示已知的反機器人服務
（`reCAPTCHA`、`hCaptcha`、`Cloudflare challenge`）：

```
A click at (160, 165) landed inside a frame from https://www.google.com [reCAPTCHA].
The automatic Jev loop never interacts with frame content; this was a raw coordinate click.
```

這是記錄，不是封鎖：它讓座標點擊可稽核，並告訴代理別再點那裡。決定是否自動核准
瀏覽器工具時記得這點。

### 分頁

網站不停開新分頁（登入與外部連結的 `target="_blank"`）。Pi Jev Browser 從不悄悄
切換被觀察的頁面：

- `popups: "stay"`（預設）讓執行留在原頁面，在 `jev_logs` 記一筆 `tab`，並回傳
  指名新 URL 的警告。
- `popups: "follow"` 把新分頁當作被觀察的頁面，並說明這件事。
- `jev_actions` 之後可以用 `activate_tab` / `close_tab` 刻意移動，
  `jev_state.activePageIndex` 回報正在觀察哪個分頁。

被觀察的分頁關閉時，執行退回另一個開著的分頁，而不是抓著已關閉頁面的參照。

## Profile

`profile` 決定瀏覽器狀態在執行之間保留多少：

- `"session"`（預設）：每個 pi session 一個 profile，位置在
  `~/.pi/agent/pi-jev-browser/profiles/<session id>`。在可見視窗登入一次，同一個
  pi session 之後的執行就重用那些 cookie。兩個 pi session 不會搶同一個 Chrome
  profile。
- `"shared"`：所有 session 共用一個 profile，位置在 `profileDir`。方便，但兩個
  同時執行的 pi session 無法一起使用它。
- `"off"`：每次執行都是乾淨的瀏覽器，也就是還沒有 profile 之前的行為。

只有帶到期時間的 cookie 會留著；Chromium 依設計會在結束時丟掉 session cookie。
持久 profile 也會保留 localStorage 與 IndexedDB，所以把 `profileDir` 指向你
願意重複使用的東西。

## 迴圈在哪裡結束、表面從哪裡開始

決策迴圈實作的是真正難的那部分：有界的步驟、失效觀察的處理、震盪守衛、無進展
守衛、trace，以及在具後果的動作前把控制權交回給人。這些都不是 web 專屬的，所以
`src/loop.ts` 不 import Playwright。它驅動一個 `Driver`（`src/driver.ts`）：

```ts
interface Driver {
  /** Identity of the surface; a change means the run moved and must not act. */
  id(): unknown;
  observe(signal?: AbortSignal): Promise<ObservationSnapshot>;
  /** The driver's own vocabulary for read failures: a navigation context, a closed window. */
  readFailureCategory?(
    error: unknown,
  ): "navigation_context" | "document_not_ready" | "window_unavailable" | undefined;
}
```

`Observation` 是決策層讀取的契約：文字加上可定位的目標（`role`、`label`、
`value`、`href` 與狀態），從來不是像素。一個 snapshot 綁在它被讀取時的狀態上，
所以 `assertFresh` 與 `execute` 在狀態移動後都拒絕動作——這正是讓動作不會落在
取代目標的東西上的原因。

`test/driver.test.ts` 證明這個邊界是真的：它用一個沒有 Playwright、沒有 DOM、
沒有瀏覽器的 in-memory 驅動來跑迴圈，仍然走過 `done_unverified`、`model_review`、
`model_blocked`、`text_unavailable`、`repeated_action`、`no_progress`、
`scroll_oscillation`、`stale_observations` 與 `step_limit`。要驅動另一種表面，就是
再寫一個驅動，不是重寫迴圈。

### 瀏覽器驅動

`src/observe.ts` 的 `browserDriver(getPage)`——所有 Playwright 專屬的東西都在
那裡，包括錯誤詞彙：被銷毀的 execution context 是正在進行的導覽，而始終沒有變成
可讀的文件是瀏覽器狀況，不是一般性失敗。

### 桌面驅動

`src/drivers/desktop.ts` 透過輔助使用樹驅動一個真實的 macOS 應用程式，
`desktop/ax-helper.swift` 是走訪那棵樹並執行輔助使用動作的常駐 helper。它對應到
同一個 `Observation`，所以迴圈沒有被改動。幾個吃過苦頭才拿到的細節寫在那裡：

- 應用程式以 bundle id 定位，因為顯示名稱是本地化的；可存取名稱在
  `AXDescription`，而穩定的把手是 `AXIdentifier`。計算機的 `AXTitle` 什麼都沒有，
  它的乘號按鈕標籤隨系統語言改變，但識別碼是 `Multiply`。
- 標題列的關閉／最小化／縮放按鈕依 subrole 排除，因為按下關閉會終止一個「最後
  一個視窗關掉就結束」的應用程式。
- 表面身分是被驅動應用程式的 process，不是最前面的應用程式：輔助使用動作沒有
  焦點也會落地，所以有人在執行途中切換視窗不會改變迴圈操作的對象，而結束或
  重新啟動仍然會讓它停下來。
- 可編輯文字（`AXTextArea`、`AXTextField`）不帶按壓動作，被提供為以設定值驅動的
  `TYPE_TEXT` 目標；它的內容併入視窗文字，因為對編輯器來說文件就是狀態。
- 自己繪製文件的應用程式（Word 的頁面是一個沒有值、沒有動作、沒有子節點的
  `AXLayoutArea`）會被提供為文字目標，用文字辨識讀取，並在點擊放好游標後以鍵盤
  事件輸入。
- 文字辨識只讀有變的部分。視窗擷取會與上一張以 1/8 縮圖、128 點方格比對；沒變的
  方格沿用上次讀出的文字行，只有變動方格周圍的矩形會重新辨識（矩形會擴大到不切
  到任何已知的行，最多四個）。一個像素都沒動的視窗只花一次擷取、零辨識，穩定等待
  的第二次讀取與按壓前的重走樹因此變便宜。helper 在每次觀察回報 `timing`
  （walk、capture、ocr、ocrRead 百分比）。
- 合成的滑鼠點擊（沒有任何動作的列只能這樣選）在點擊前會做命中測試，該點不屬於
  被驅動的應用程式就拒絕：視窗可能在別的 Space、被縮小或被蓋住，點擊會落在那裡的
  別的東西上。拒絕以「covered」回報，迴圈重新觀察而不是點到別處。輔助使用動作
  不需要這個檢查。
- 動作後的觀察會直接帶到下一次決策，不再重讀一次，所以一步只花一次讀取。
- 只有一兩個字且信心值低的辨識行（圖示、徽章、游標被讀成「口」「-6」）會被丟棄：
  它們在兩次讀取間閃動，會讓每次觀察都變成新狀態。
- AXError `-25204`（cannot complete）與 `-25205`（invalid element）是應用程式
  來不及回應、以及控制項因為那次按壓而死掉，不是拒絕——前提是觀察之後視窗已經
  改變。

桌面驅動由 `desktop` benchmark 層在兩個應用程式上覆蓋：計算機，用應用程式之外
算出的算術結果驗證；TextEdit，從應用程式讀回文件來驗證。

### 規劃

`createJevPolicy({ planning: true })` 加入一個規劃階段，對初始觀察執行一次：同一個
choice 模型選出計畫的下一步（或 `PLAN_COMPLETE`），直到計畫完成，然後執行使用者的
目標加上列舉出的步驟。這關閉了桌面層上一個量測到的缺口：簡短的目標（「compute
1234 times 5678」）在沒有計畫時只達到一次正確按壓，有計畫時十次全中。它是 opt-in，
因為從一次觀察做出的計畫只涵蓋那次觀察看得到的東西，這適合一個應用程式視窗，卻
會在多頁的 web 任務上誤導。計畫會以 `plan` 步驟寫入 trace，並在執行結果中回傳。

## 與 Cline plugin 的差異

觀察管線、Jev prompt、執行狀態與安全契約沿用自 Cline plugin；宿主接線、決策傳輸
與文字 helper 改了，而從 `Driver` 介面開始的一切（桌面驅動、規劃階段、驗證關卡、
shadow DOM、benchmark 套件）都是在這裡加的。

| 面向 | Cline plugin | Pi Jev Browser |
| --- | --- | --- |
| 宿主 API | `plugin.setup(api)` 搭配 JSON Schema `inputSchema` | `export default (pi)` 搭配 TypeBox `parameters` |
| 安全規則 | `api.registerRule()` | `promptSnippet` + `promptGuidelines`（在建好的 system prompt 裡驗證過） |
| 決策傳輸 | `@ai-sdk/gateway` + `experimental_evaluate` | 直接 `POST https://api.typesafe.ai/v1/systemone` |
| 決策模型 | 經 AI Gateway 的 `typesafe-ai/jev` | `jev-latest`（可設定）直接連 |
| 文字 helper | 經 Gateway 的 `google/gemini-2.5-flash-lite` | 透過 `ctx.modelRegistry.complete()` 用作用中的 pi 模型 |
| 認證 | `AI_GATEWAY_API_KEY` | `TYPESAFE_API_KEY` |
| 設定 | `~/.cline/plugins/cline-jev-browser.config.json` | `~/.pi/agent/pi-jev-browser.config.json` |
| 產物 | `~/.cline/data/jev-browser/` | `~/.pi/agent/pi-jev-browser/` |
| Session 身分 | JSON IPC 上的 `context.sessionId` | `ctx.sessionManager.getSessionId()` |
| 取消 | 只有本地 controller（signal 沒有被傳遞） | pi `AbortSignal` + 本地 controller |
| 失敗回報 | 一個模糊的 `interrupted` 訊息 | 分類過的 `failure` + 含完整供應商錯誤的 `errors.log` |
| 安裝時機 | plugin 載入時就急著開始 | 第一次使用瀏覽器工具時才做 |
| 工具名稱 | `jev_run`、`jev_actions`、`jev_state`、`jev_logs`、`jev_stream`、`jev_stop` | 同名，再加上用於決定性讀取的 `jev_extract` |
| 工具結果 | `{ result: [...] }`，由 Cline 解讀 | `{ content, details, usage }`；巢狀模型用量回報給 pi |
| Schema | 帶 `additionalProperties: false` 的 JSON Schema | TypeBox 加 `additionalProperties: false`，再加逐動作的欄位驗證 |
| 併發 | 由宿主定義 | 所有瀏覽器工具都是 `executionMode: "sequential"` |
| 清理 | plugin teardown | `session_shutdown` handler 呼叫 `stopAll()` |
