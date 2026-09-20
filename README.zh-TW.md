# Pi Jev Browser

[English](README.md) | 繁體中文

給 **pi** 用的瀏覽器代理。**Jev**（TypeSafe System One）從頁面的結構化觀察
（可見文字加上可定位的控制項，從來不是截圖）中選出每一步動作，並在一個有界的
迴圈裡執行；這個迴圈知道自己何時卡住、頁面何時在腳下移動、何時該把控制權交回
給人。一層決定性的選擇器負責精確操作，四層 benchmark 量測代理實際做了什麼，
而不是相信一段 demo。

看細節之前，先知道關於這份程式碼的三件事：

- **八個 pi 工具裡有七個是瀏覽器工具。** `jev_run`、`jev_actions`、
  `jev_extract`、`jev_state`、`jev_logs`、`jev_stream` 與 `jev_stop` 驅動一個
  隔離的 Playwright Chromium。
- **第八個 `jev_desktop` 透過輔助使用樹（accessibility tree）驅動一個 macOS
  應用程式**，用的是同一個迴圈與同一組守衛。和 computer use 一樣，任何已安裝的
  應用程式都能驅動，每次執行都先詢問使用者；參數接受顯示名稱，`findApp` 會列出
  已安裝的應用程式，呼叫端不必先知道另一台機器的 bundle id。決策迴圈不知道
  自己在驅動哪一種表面：`src/loop.ts` 只依賴 `Driver` 介面，不 import Playwright。
  瀏覽器驅動是 `src/observe.ts`；桌面驅動是 `src/drivers/desktop.ts` 加上一個常駐的
  Swift helper，`desktop` benchmark 層在真實的計算機與 TextEdit 視窗上量測它。
  見[迴圈在哪裡結束、表面從哪裡開始](#迴圈在哪裡結束表面從哪裡開始)與
  [桌面工具](#桌面工具)。
- **這份 README 裡的每一項宣稱背後都有一個情境。** `benchmarks/README.md` 列出
  `local`、`model`、`live`、`desktop` 四層共 22 個情境，每一個都對照請求記錄、
  trace 或獨立讀取驗證；找到的缺口寫下來，已關閉的兩個附上數字。

這個專案一開始是把
[`cline/plugins/plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser)
移植到 pi extension API；哪些沿用、哪些改了，見
[與 Cline plugin 的差異](#與-cline-plugin-的差異)。

## 安裝

### 從 npm

```bash
pi install npm:pi-jev-browser
```

Pi 會把套件裝在 `~/.pi/agent/npm/` 下，並讀取這段 manifest：

```json
"pi": { "extensions": ["./index.ts"] }
```

安裝會帶入 `playwright` 與 `@typesafe-ai/sdk`，Playwright 自己的安裝步驟會下載
Chromium。那個下載約 150 MB，所以第一次安裝要等一下。`typebox`、
`@earendil-works/pi-ai` 與 `@earendil-works/pi-coding-agent` 是 `peerDependencies`，
因為 pi 以虛擬模組的方式提供它們，不會被打包兩次。

### 從 git checkout 或本機目錄

```bash
pi install git:github.com/laihenyi/pi-Jev-browser            # 最新的 main
pi install git:github.com/laihenyi/pi-Jev-browser@v0.1.0    # 固定在某個 tag
pi install /absolute/path/to/pi-Jev-browser                 # 工作副本
```

### 在 `~/.pi/agent/extensions` 自動探索

放在 `~/.pi/agent/extensions/pi-Jev-browser/` 的 checkout 會被自動探索，這也是
開發期間使用這個 repository 的方式。修改後重新啟動 pi（或 `/reload`），並安裝
一次相依套件：

```bash
cd ~/.pi/agent/extensions/pi-Jev-browser
npm install
node node_modules/playwright/cli.js install chromium   # 或：npm run install-browser
```

第一次 `jev_run` 時也會自動安裝 Chromium，上限兩分鐘。安裝失敗由需要它的工具
回報，之後的呼叫會重試。在 Linux 上，系統瀏覽器函式庫仍是由管理員管理的
前置需求；extension 從不執行 sudo。

在環境變數或設定檔裡提供 `console.typesafe.ai` 的 TypeSafe API key：

```bash
export TYPESAFE_API_KEY=...        # 或 pi-jev-browser.config.json 裡的 typesafe.apiKey
chmod 600 ~/.pi/agent/pi-jev-browser.config.json
```

`jev_run` 在 Chromium 啟動前就會解析這個 key，所以缺 key 會立刻失敗，訊息指出要
設定的檔案與變數，而不是一個看起來像瀏覽器問題的錯誤。

其他什麼都不需要：輸入欄位的文字由本次 session 已在使用的 pi 模型產生。

## Jev 迴圈

`jev_run` 啟動或重用一個瀏覽器，擷取一張執行前截圖，然後跑一個有界的決策迴圈。
每次評估送出一個 TypeSafe System One 請求：

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
{ "model": "jev-latest", "state": "<頁面觀察 + 最近的動作>", "questions": { "action": { ... } } }
```

Jev 回答一個 `choice` 問題，選項就是目前頁面上提供的具體操作：每個可見的動作
目標一項（`CLICK:<id>`、`TYPE_TEXT:<id>`、`SELECT:<id>`），再加上 `SCROLL_UP`、
`SCROLL_DOWN`、`WAIT`、`BLOCKED`、`REVIEW` 與 `DONE`。一次就把所有具體動作和
捲動、等待、停止放在一起比較，是迴圈便宜的原因；決策路徑裡沒有截圖。

Jev 看到的是有索引的可見動作目標、已選取的表單選項（含畫面外的選取）、以及
viewport 上方與下方控制項的摘要。它不收截圖。截圖給代理，用來驗證結果。

Jev 選動作，但不能產生任意文字。當它選了 `TYPE_TEXT`，欄位的值會先**在目標本身
裡找**：引號內的片語、目標的句子、其中幾個字的短組合，以及（對瀏覽器網址列）
每個拉丁字的 `.com` 形式都成為候選，Jev 在一個 choice 問題裡挑一個（或 `NONE`）。
幾乎每個要打的值都已經寫在目標裡，所以這條路不需要第二個模型，遠低於一秒就能
回答。只有在 Jev 回答 `NONE` 時，extension 才退回用**目前作用中的 pi 模型**
（透過 `ctx.modelRegistry.complete()`）產生值。設定 `textHelper.model`（或
`PI_JEV_BROWSER_TEXT_MODEL`）為 `"provider/modelId"` 可固定用另一個模型。它的
token 用量會在工具結果上回報給 pi。

這個 helper 是一行的抽取，所以用 4,096 token 的預算（推理模型的思考 token 共用
這個預算）與兩次傳輸重試，並容忍 JSON 物件外圍有 code fence 或說明文字。值本身
仍嚴格驗證：恰好一個非空的 `text` 字串，最多 2,000 字元，否則什麼都不打，執行
回報 `text_helper_invalid_output`。

### 工具序列範例

1. `jev_run({ "url": "https://en.wikipedia.org", "goal": "Find and open the article about Ada Lovelace. Stop when the article is visible.", "maxSteps": 20 })`
2. 驗證回傳的最終截圖（若影像沒有顯示，讀 `finalScreenshotPath`）。
3. `jev_stop({})` 釋放瀏覽器並完成影片。

`jev_run` 自動啟動瀏覽器、擷取初始畫面、執行 Jev，回傳最終影像加上兩張截圖的
路徑與頁面狀態。後續呼叫重用瀏覽器；省略 `url` 就接著做，給 `url` 就先導向。
啟動選項（`headless`、`recordVideo`、`showCursor`、`showClickIndicators`）在建立
瀏覽器時生效。瀏覽器在停止前一直可供後續執行使用。

支援的自動操作：點擊、取代文字、原生下拉選單選取、頁面捲動、短暫載入等待。
執行預設 20 步（最多 60），有 100 秒的取消期限。沒有預設的機率門檻。選填的
`minProbability` 以 Jev 對所選項目的校準機率作門檻；它不是 provider 的信心值。
取消後，一個進行中的瀏覽器操作最多再花它的有界 Playwright timeout 才會落定。
瀏覽器的變更操作不會重試。

結果包含 `status`、`steps`、`elapsedMs` 與 JSONL 的 `tracePath`。狀態有
`done_unverified`、`blocked`、`needs_review`、`uncertain`、`step_limit`、
`evaluation_limit` 或 `interrupted`。失敗的執行另外回報 `failure`
（`stage`、`category`、`detail`）與 `errorsLogPath`：

| `failure.category` | 意義 |
| --- | --- |
| `configuration` | 設定缺失或無法讀取；訊息指出檔案與要設定的變數。在 Chromium 啟動前回報。 |
| `text_helper_invalid_output` | 作用中的 pi 模型沒有回傳可用的 `{"text": ...}`。什麼都沒打。 |
| `cancelled` | 執行被中止或到達期限。 |
| `navigation_context` | 讀取途中文件變了。 |
| `timeout` | 某個有界的瀏覽器或模型 timeout 到了。 |
| `document_not_ready` | 頁面一直沒有產生可讀的文件。 |
| `unexpected_error` | 其他情況，通常是 provider 錯誤。 |

`stopReason` 解釋迴圈為何停止，與模型的狀態無關：

| `stopReason` | 意義 |
| --- | --- |
| `model_done` | Jev 回報 DONE；狀態是 `done_unverified`，因為宣稱不是證據。 |
| `model_blocked` | Jev 回報 BLOCKED：沒有支援的動作能推進。 |
| `model_review` | Jev 回報 REVIEW：下一步需要敏感資料、會送出某樣東西，或跨越 CAPTCHA 之類的安全關卡。 |
| `submit_review` | 迴圈自己拒絕在一個沒有自身確認控制項的欄位裡按 Return（聊天輸入框、命令列）：那會送出或執行剛打的內容。狀態是 `needs_review`；由使用者送出。 |
| `verification_gate` | 迴圈在問 Jev 之前就自己拒絕了一個人類驗證關卡：頁面文字宣告了挑戰，且有控制項可以通過它。狀態是 `needs_review`；把這一步交給使用者。 |
| `min_probability` | 所選項目低於要求的 `minProbability`。 |
| `step_limit` / `evaluation_limit` | 動作或評估預算用完。 |
| `repeated_action` | 同一個動作不再產生新狀態（控制項在已產生過的狀態間循環），或作為後備連續執行 12 次。持續產生新狀態的重複按壓是允許的，因為輸入 `111` 是合法輸入。 |
| `scroll_oscillation` | `SCROLL_UP` 與 `SCROLL_DOWN` 反覆交替，這種二循環不是探索。 |
| `stale_observations` | 連續四次觀察在動作執行前就失效。 |
| `no_progress` | 三個動作沒有產生可觀察的變化。按了兩次都沒變化的控制項會先從下一題撤下，題目變了計數就重新開始；只有 Jev 一直選新的、卻什麼都不改變的控制項時才會停止。 |
| `text_unavailable` | 目標與 pi 文字 helper 都沒有給欄位一個值，所以什麼都沒打。 |
| `cancelled` / `error` | 執行被中止，或失敗了；見 `failure`。 |

`failure.detail` 是有界的摘要（錯誤名稱、已知時的 HTTP 狀態），執行目錄裡的
`errors.log` 保存完整錯誤含堆疊。Provider 錯誤可能引用送出的請求本文，所以完整
文字只寫到那個本機檔案，從不回傳給模型。失敗的執行裡嘗試過的動作可能已經生效：
繼續前先檢查。Trace 記錄決策（含終止與被拒絕的決策）、失效的觀察、動作嘗試、
完成與最終結果。Provider 信心值若有提供則另外記錄。Trace 不含產生的欄位文字，
但可能含頁面標籤。

在同一個瀏覽器 session 裡，同一目標的多次執行之間，迴圈保留最近十個動作、輸入
的文字與觀察到的進度。文字留在記憶體，不寫進 trace。三個非等待動作沒有可觀察的
進度就停止執行。失效的決策在 `maxSteps` 兩倍的預算內重新評估；已執行的變更操作
從不重試。

迴圈保留觀察到的 DOM 節點，動作前檢查頁面語意、節點身分與遮蔽。開放的 shadow
root 會被走訪，所以 web component 的控制項與文字和 light DOM 一樣可觀察、可操作
（hit-testing 會進入 shadow tree，蓋住目標的 shadow 渲染覆蓋層會被指名為遮蔽物）。
封閉的 shadow root、frame、canvas 控制項、巢狀捲動、上傳與任意鍵盤元件不在這個
DOM 迴圈內；適當時改用 `jev_actions`。模型上下文上限為 200 個動作目標與 6,000 個
可見文字字元，加上 50 個已選選項與每個方向最多 50 個畫面外控制項標籤。密集的
頁面可能因此漏掉控制項。

頁面文字與可見的欄位值會送到 TypeSafe `api.typesafe.ai`；當目標裡沒有欄位值而
必須產生時，同樣的內容會送到你的 pi 模型 provider。密碼與檔案欄位排除在外，其他
敏感內容不會自動遮蔽。Jev 被指示在有後果的動作前回 `REVIEW`；這是模型指引，不是
決定性的安全邊界。只委派範圍狹窄、適合自主瀏覽器操作的任務。代理必須處理所有
review，並獨立驗證 `done_unverified`。

這個整合省掉了每個瀏覽器步驟一次 LLM 推理往返與一張截圖。實際的端到端速度與
線上模型的可靠度尚未 benchmark。

### 迴圈在哪裡結束、表面從哪裡開始

決策迴圈實作的是後來證明困難的那部分：有界的步數、失效觀察的處理、震盪守衛、
無進展守衛、trace，以及在有後果的動作前把控制權交回給人。這些都與 web 無關，
所以 `src/loop.ts` 不 import Playwright。它驅動一個 `Driver`（`src/driver.ts`）：

```ts
interface Driver {
  /** 表面的身分；變了代表執行已經移動，不得再動作。 */
  id(): unknown;
  observe(signal?: AbortSignal): Promise<ObservationSnapshot>;
  /** 驅動自己的讀取失敗詞彙：導覽上下文、關閉的視窗。 */
  readFailureCategory?(
    error: unknown,
  ): "navigation_context" | "document_not_ready" | "window_unavailable" | undefined;
}
```

`Observation` 是決策層讀取的契約：文字加上可定位的目標（`role`、`label`、
`value`、`href` 與狀態），從來不是像素。快照綁定在它讀取時的狀態，所以
`assertFresh` 與 `execute` 在狀態移動後都拒絕動作，這就是讓動作不會落在中途取代
目標的東西上的機制。

瀏覽器實作是 `src/observe.ts` 裡的 `browserDriver(getPage)`。所有 Playwright
專屬的東西都在那裡，包括錯誤詞彙：被銷毀的執行上下文是進行中的導覽，一直沒有
變成可讀的文件是瀏覽器狀況，不是泛用失敗。

第二個驅動在 `src/drivers/desktop.ts`，透過輔助使用樹驅動真實的 macOS 應用
程式，`desktop/ax-helper.swift` 是常駐的 helper，負責走訪樹並執行輔助使用動作。
它對應到同一個 `Observation`，所以迴圈不動。兩個得來不易的細節寫在那裡：應用
程式用 bundle id 定位，因為顯示名稱是在地化的；可及名稱在 `AXDescription`，穩定
的把手是 `AXIdentifier`（計算機在 `AXTitle` 裡什麼都不放，乘號按鈕叫「乘」但
識別碼是 `Multiply`）。標題列的關閉／縮小／縮放按鈕依 subrole 排除，因為按關閉
會讓最後一個視窗關閉即結束的應用程式退出。表面的身分是被驅動的應用程式的
process，不是最前面的應用程式：輔助使用動作不需要焦點就能落地，所以有人在執行
途中切換視窗不會改變迴圈操作的對象，而退出或重新啟動仍會停止它。可編輯文字
（`AXTextArea`、`AXTextField`）沒有按壓動作，以設定值的方式作為 `TYPE_TEXT` 目標
提供；它的內容併入視窗文字，因為對編輯器而言文件就是狀態。桌面驅動由 `desktop`
benchmark 層在兩個應用程式上覆蓋：計算機，由應用程式外計算的算術結果驗證；
TextEdit，由從應用程式讀回文件驗證。

迴圈也可以先規劃再動作。`createJevPolicy({ planning: true })` 加入一個規劃階段，
對初始觀察只跑一次：同一個 choice 模型挑選計畫的下一步（或 `PLAN_COMPLETE`）
直到計畫完成，然後執行使用者的目標加上列舉出的步驟。這關閉了桌面層一個量測到
的缺口：短目標（「計算 1234 乘 5678」）沒有計畫時只按對一步，有計畫時十次
全對。它是 opt-in，因為從一次觀察做出的計畫只涵蓋那次觀察看到的東西，適合
應用程式視窗，卻會誤導多頁的 web 任務。計畫以 `plan` 步驟寫入 trace，並在執行
結果中回傳。

`test/driver.test.ts` 證明這條邊界是真的：它用一個沒有 Playwright、沒有 DOM、
沒有瀏覽器的記憶體內驅動去驅動迴圈，仍然走過 `done_unverified`、`model_review`、
`model_blocked`、`text_unavailable`、`repeated_action`、`no_progress`、
`scroll_oscillation`、`stale_observations` 與 `step_limit`。要驅動另一種表面，
例如透過輔助使用樹驅動桌面，代表再寫一個驅動，不是重寫迴圈。

## 功能

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

瀏覽器在隔離狀態下啟動，瀏覽器工具沒有任何東西碰宿主桌面。唯一會碰的
`jev_desktop` 每次執行前都會先詢問使用者；見[桌面工具](#桌面工具)。

## 工具

- `jev_run`：啟動、執行前後截圖，以及 Jev 迴圈。
- `jev_actions`：不經 Jev 的手動動作；回傳更新後的截圖。
- `jev_extract`：決定性地讀取文字、表格列、連結或屬性，不呼叫模型。
- `jev_state`：分頁、目前 URL、標題、viewport 與開始時間，不含截圖。
- `jev_logs`：擷取的 console 訊息、頁面錯誤、失敗請求、導覽、被封鎖的下載與
  安全封鎖。
- `jev_stream`：啟動、檢視或停止 `127.0.0.1` 上帶 token 的即時檢視器。
- `jev_stop`：停止瀏覽器與串流，完成影片，回傳產物路徑。
- `jev_desktop`：透過輔助使用樹在一個 macOS 應用程式裡執行有界的目標。預設
  關閉；見下文。

### 桌面工具

`jev_desktop` 接受一個 bundle id（或用應用程式顯示名稱，例如 `Microsoft Word`）與一個目標，
跑的是 `jev_run` 跑的同一個迴圈，只是對象是應用程式的輔助使用樹而不是頁面。Jev 看到視窗的文字與控制項
（角色、名稱、值，以及跨語言穩定的輔助使用識別碼），從來不是像素。動作是元素
上的輔助使用動作，所以視窗有沒有焦點都能落地，有人在執行途中切換視窗不會改變
迴圈操作的對象。動作前，迴圈從第一次觀察規劃步驟（用 `plan: false` 關閉）；計畫
隨結果回傳並寫入 trace。

沒有應用程式允許清單：和 computer use 一樣，工具可以驅動任何已安裝的應用程式。
也不需要事先知道 bundle id：參數接受顯示名稱，`findApp` 會定位應用程式
（名稱、bundle id、路徑）而不驅動任何東西。優先搜尋應用程式資料夾，並往下走幾層，
所以廠商自己的子資料夾（`/Applications/Epson Software/…`）也算在內；資料夾裡
找不到才擴大到 Spotlight，找出安裝在磁碟任何位置的應用程式。結果會說明是哪一種
方式找到的。

兩件事成立前它拒絕執行，並說出缺的是哪一件：

- **使用者確認了這次執行。** 除非 `desktop.requireConfirmation` 為 `false`，
  每次呼叫都會詢問，並指名應用程式與目標。設定檔仍然是使用者的，指引禁止代理
  自己關掉這個詢問，或繞過它。
- **宿主做得到。** macOS、用 `npm run build:ax-helper` 建好的 helper，以及執行
  pi 的 process 的輔助使用權限。缺少前置需求以設定訊息回報，不是失敗的執行。

自己繪製文件的應用程式（Word 的頁面是一個沒有值、沒有動作、沒有子節點的
`AXLayoutArea`）也能驅動：helper 把頁面當成文字目標，用文字辨識讀出頁面上的
內容，並在點擊放好游標後以鍵盤事件輸入。目標裡自成一行的段落會整段作為候選，
所以一則故事一步就打完，不是一句一句拆開。冷啟動後，執行會先等到第一個視窗
出現才觀察。

結果帶著執行狀態、計畫、已執行的步驟、`<outputDir>/desktop/` 下的
`tracePath`，以及視窗的最終文字，讓代理能拿應用程式顯示的內容驗證
`done_unverified` 的宣稱。迴圈自己的停止原因不變：REVIEW 與驗證關卡的
`needs_review`、`repeated_action`、`no_progress`、`step_limit`；關閉的應用程式
回報為 `window_unavailable`。

```json
{ "desktop": { "requireConfirmation": true } }
```

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

目標接受 `role`、`name`（需要 `role`）、`text`、`selector` 與 `nth`。比對最多
等五秒讓元素出現，所以一個批次可以點連結再對導向後的頁面動作。沒有任何元素
符合的目標會以 `No element matched …` 失敗，而不是點到游標下剛好的東西。
`x`/`y` 座標仍可用於 canvas 類的表面。

座標點擊是原始事件，所以瀏覽器會把它送進 iframe，即使自動迴圈從不看 frame 的
內容。當點擊或拖曳落在 frame 上，結果帶一個 `warnings` 項目，`jev_logs` 出現對應
的 `security` 項目，指名 frame 的 origin 並標示已知的反機器人服務（`reCAPTCHA`、
`hCaptcha`、`Cloudflare challenge`）：

```
A click at (160, 165) landed inside a frame from https://www.google.com [reCAPTCHA].
The automatic Jev loop never interacts with frame content; this was a raw coordinate click.
```

這是記錄，不是封鎖：它讓座標點擊可稽核，並告訴代理別再點那裡。決定是否自動
核准瀏覽器工具時記得這點。

### 分頁

網站不停開新分頁（登入與外部連結的 `target="_blank"`）。Pi Browser 從不悄悄
切換被觀察的頁面：

- `popups: "stay"`（預設）讓執行留在原頁面，在 `jev_logs` 記一筆 `tab`，並回傳
  指名新 URL 的警告。
- `popups: "follow"` 把新分頁當作被觀察的頁面，並說明這件事。
- `jev_actions` 之後可以用 `activate_tab` / `close_tab` 刻意移動，
  `jev_state.activePageIndex` 回報正在觀察哪個分頁。

被觀察的分頁關閉時，執行退回另一個開著的分頁，而不是抓著已關閉頁面的參照。

- `jev_logs`：擷取的 console、錯誤、請求、導覽、分頁與安全記錄。
- `jev_stream`：啟動、檢視或停止 localhost 即時檢視器。
- `jev_state`：作用中的狀態、分頁、URL、標題、viewport、開始時間。
- `jev_stop`：關閉瀏覽器、停止串流、完成影片。

每個工具都循序執行（`executionMode: "sequential"`），因為它們變更同一個共用的
瀏覽器，每個 pi session 一次只允許一個瀏覽器操作。

## 設定

不需要任何設定。預設值：所有 HTTP/HTTPS origin、headless Chromium、1280 × 720
viewport、WebM 錄影開啟、游標與點擊指示開啟、即時檢視器在 `jev_stream` 啟動前
關閉，產物放在 `~/.pi/agent/pi-jev-browser/`。

把 `pi-jev-browser.config.example.json` 複製到 `~/.pi/agent/pi-jev-browser.config.json`
以修改預設，或用 `PI_JEV_BROWSER_CONFIG` 指向另一個檔案。對需要登入或敏感的
工作流程，用 `*` 萬用字元限制 `allowedOrigins`（例如 `https://*.example.com`）。

```json
{
  "allowedOrigins": ["https://*.example.com"],
  "denyOrigins": [],
  "requireConfirmation": [],
  "headless": true,
  "recordVideo": true,
  "viewport": { "width": 1280, "height": 720 },
  "stream": { "enabled": false, "intervalMs": 1000 },
  "popups": "stay",
  "profile": "session",
  "typesafe": { "apiKey": "", "baseUrl": "https://api.typesafe.ai", "model": "jev-latest" },
  "textHelper": { "model": "" },
  "desktop": { "requireConfirmation": true }
}
```

### 依網站的政策

- `denyOrigins` 在 `allowedOrigins` 之前檢查，所以拒絕規則永遠贏，在 Chromium
  啟動前就封鎖導覽。
- `requireConfirmation` 列出在 `jev_run` 或 `jev_actions` 碰它們之前需要在 pi
  對話框裡明確同意的 origin。沒有能顯示對話框的 UI（例如 headless 執行）時，
  呼叫會失敗而不是悄悄繼續。

### 持久 profile 與人工登入

`profile` 決定執行之間保留多少瀏覽器狀態：

- `"session"`（預設）：每個 pi session 一個 profile，在
  `~/.pi/agent/pi-jev-browser/profiles/<session id>` 下。在可見視窗登入一次，同一個
  pi session 裡之後的執行重用 cookie。兩個 pi session 從不搶同一個 Chrome profile。
- `"shared"`：所有 session 共用一個 profile，在 `profileDir`。方便，但兩個同時
  進行的 pi session 不能同時使用。
- `"off"`：每次執行都是乾淨的瀏覽器，也就是有 profile 之前的行為。

只有帶到期時間的 cookie 會保留；Chromium 依設計在退出時丟棄 session cookie。
注意持久 profile 也保留 localStorage 與 IndexedDB，所以把 `profileDir` 指向你
願意重用的位置。

環境變數覆寫：`TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL`、`TYPESAFE_DEFAULT_MODEL`、
`PI_JEV_BROWSER_TEXT_MODEL`、`PI_JEV_BROWSER_CONFIG`。憑證每次執行都重新讀取，
從不傳給 Chromium，也從不出現在工具結果裡。設定檔路徑在 pi 啟動時解析一次，
所以改了 `PI_JEV_BROWSER_CONFIG` 後要重新啟動 pi。

## 安全

保持 pi 的工具核准開啟，不要對需要登入、金融、醫療、破壞性或其他高影響的
工作流程自動核准瀏覽器工具。Extension 強制執行導覽允許清單，但使用者仍必須在
風險點核准有後果的動作。把網頁文字與截圖當作不可信的輸入，不是使用者指示。

瀏覽器在隔離狀態下啟動。Jev 的動作迴圈用 DOM 觀察；代理收到截圖來獨立驗證
結果。

`jev_desktop` 操作的是使用者自己的應用程式，而且任何一個都碰得到，所以每次執行
前都會詢問。對任何存有真實資料的應用程式保持這個確認開啟；迴圈會在有後果的動作
前交回控制權，但確認一次執行說的是這個應用程式裡的這個目標可以，不是它裡面的
每個目標都可以接受。

## 開發

```bash
npm install
npm run install-browser
npm run check      # tsc --noEmit
npm test           # node --test --experimental-strip-types
npm run benchmark  # 能力套件；見 benchmarks/README.md
```

測試使用本機 HTML、TypeSafe System One 端點的本機 stub，以及 mock 的 pi 模型。
它們不做付費的模型呼叫。瀏覽器測試需要已安裝的 Chromium 與啟動它的權限；設定
`PI_JEV_BROWSER_TEST_BROWSER` 可指定執行檔。

### 回傳的頁面證據

`jev_run` 的結果帶著迴圈停止時擷取的頁面狀態：JSON 摘要（`status`、
`stopReason`、`failure`、`steps`、`tracePath`、`errorsLogPath`、`finalPageUrl`、
`finalPageTitle`）、含最終 URL、標題與可見頁面文字的可讀區塊，以及執行前後的
截圖。文字區塊是沒有影像輸入的模型用來驗證結果的東西，所以迴圈回傳它而不是
強迫讀截圖。每次執行的完整記錄也落在 trace 最後的 `result` 項目裡。

### 網站封鎖自動存取時

Google 與類似的網站會對重複的自動造訪限流，並回一個反機器人驗證頁
（`google.com/sorry/`）。Pi Jev Browser 不會解或繞過它：Jev 在第一次觀察就回
`blocked` 與 `stopReason: "model_blocked"`，通常不到一秒，指引告訴代理停下來
問你，而不是重試。

因為 `blocked` 或 `needs_review` 的執行會讓瀏覽器保持開啟，你可以自己清掉驗證：

1. 保持 `headless: false` 讓視窗可見。
2. 讓執行回 `blocked`（瀏覽器保持開啟；代理不得呼叫 `jev_stop`）。
3. 在可見視窗裡完成驗證。
4. **在同一個 pi session** 裡繼續：瀏覽器以 `ctx.sessionManager.getSessionId()`
   為鍵，新的 pi session 會啟動新的瀏覽器。

觸發封鎖的是一連串的自動探測；正常使用很少會。若某個網站持續封鎖你，換一個
來源比升級手段好。

### 手動煙霧測試

一個三頁的 fixture（搜尋框 → 結果列表 → 詳細頁）就足以走完整個迴圈，包括一次
真的透過 pi 模型的 `TYPE_TEXT`：

```bash
# 啟動 fixture 伺服器，然後在 pi 裡：
#   jev_run url http://127.0.0.1:4599/ goal "Search for zebra and open the
#   Zebra result. Stop when the page shows the Zebra heading."
```

### 取消

pi 會把真正的 `AbortSignal` 傳到工具執行，所以 extension 把那個 signal 與自己
每個 session 的 controller 結合。按 Escape 中止進行中的執行或動作批次，
`jev_stop` 明確取消一個。執行期限與模型 timeout 仍在本機強制執行。已在進行中的
瀏覽器變更操作可能在取消生效前完成。

Chromium 安裝在第一次呼叫瀏覽器工具時才延遲啟動，而不是在 extension 載入時；
`session_shutdown` 會關閉所有還開著的瀏覽器。

## 與 Cline plugin 的差異

觀察管線、Jev prompt、執行狀態與安全契約沿用自 Cline plugin；宿主接線、決策
傳輸與文字 helper 改了，而從 `Driver` 介面往後的一切（桌面驅動、規劃階段、驗證
關卡、shadow DOM、benchmark 套件）都是在這裡新增的。

| 面向 | Cline plugin | Pi Jev Browser |
| --- | --- | --- |
| 宿主 API | `plugin.setup(api)` 搭配 JSON Schema `inputSchema` | `export default (pi)` 搭配 TypeBox `parameters` |
| 安全規則 | `api.registerRule()` | `promptSnippet` + `promptGuidelines`（在建好的 system prompt 中驗證） |
| 決策傳輸 | `@ai-sdk/gateway` + `experimental_evaluate` | 直接 `POST https://api.typesafe.ai/v1/systemone` |
| 決策模型 | 經 AI Gateway 的 `typesafe-ai/jev` | 直連 `jev-latest`（可設定） |
| 文字 helper | 經 Gateway 的 `google/gemini-2.5-flash-lite` | 透過 `ctx.modelRegistry.complete()` 的作用中 pi 模型 |
| 憑證 | `AI_GATEWAY_API_KEY` | `TYPESAFE_API_KEY` |
| 設定 | `~/.cline/plugins/cline-jev-browser.config.json` | `~/.pi/agent/pi-jev-browser.config.json` |
| 產物 | `~/.cline/data/jev-browser/` | `~/.pi/agent/pi-jev-browser/` |
| Session 身分 | 經 JSON IPC 的 `context.sessionId` | `ctx.sessionManager.getSessionId()` |
| 取消 | 只有本機 controller（signal 沒有傳輸） | pi `AbortSignal` + 本機 controller |
| 失敗回報 | 一則不透明的 `interrupted` 訊息 | 分類過的 `failure` + 含完整 provider 錯誤的 `errors.log` |
| 安裝 | plugin 載入時立即開始 | 第一次使用瀏覽器工具時延遲開始 |
| 工具名稱 | `jev_run`、`jev_actions`、`jev_state`、`jev_logs`、`jev_stream`、`jev_stop` | 同名，再加上決定性讀取的 `jev_extract` |
| 工具結果 | 由 Cline 解讀的 `{ result: [...] }` | `{ content, details, usage }`；巢狀的模型用量回報給 pi |
| Schema | `additionalProperties: false` 的 JSON Schema | `additionalProperties: false` 的 TypeBox，加上每個動作的欄位驗證 |
| 併行 | 由宿主定義 | 所有瀏覽器工具 `executionMode: "sequential"` |
| 清理 | plugin teardown | `session_shutdown` handler 呼叫 `stopAll()` |

## Benchmark

`benchmarks/` 是可重複的能力套件，分四層：`local`（離線 fixture，不需憑證）、
`model`（在本機頁面上的真實 Jev 決策）、`live`（第三方網站）與 `desktop`
（透過輔助使用驅動的真實 macOS 應用程式，需要在建好 helper 的 Mac 上）。每個
情境都對照 fixture 伺服器的請求記錄、執行 trace、應用程式自己回報的狀態或獨立
讀取驗證結果，所以執行不能靠宣稱成功而通過。

```bash
npm run benchmark                   # local 層
npm run benchmark -- --suite=all    # 每一層，需要憑證與網路
```

最新結果：local、model、live 與 desktop 各層所有可執行的情境都通過。曾有兩個
情境以 `GAP` 回報而不是隱藏，兩個都由量測過的修改關閉，而不是改寫文字：迴圈
現在會在問 Jev 之前拒絕一般 DOM 的人類驗證關卡（以前會直接點過去，只因為元件
在觀察不到的 iframe 裡才會在真正的 CAPTCHA 停下），決策層會從短目標規劃多步的
桌面任務，而不需要把步驟寫清楚。`benchmarks/README.md` 有完整的表格、量測的
指標，以及套件刻意不量測的清單。

## 授權

Apache-2.0。本專案是
[`cline/plugins/plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser)
的移植，原專案採 Apache-2.0；原始 `LICENSE` 文字保留在本 repository，移植版沿用
該授權。觀察管線、Jev prompt、執行狀態與安全契約來自原作；pi 宿主接線、決策
傳輸、文字 helper、選擇器層、benchmark 套件與後續修正是新的。
