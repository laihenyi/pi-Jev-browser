# Pi Jev Browser

[English](README.md) | 繁體中文

給 **pi** 用的瀏覽器代理。**Jev**（TypeSafe System One）從頁面的結構化觀察
（可見文字加上可定位的控制項，從來不是截圖）中選出每一步動作，並在一個有界的
迴圈裡執行；這個迴圈知道自己何時卡住、頁面何時在腳下移動、何時該把控制權交回
給人。

八個工具裡有七個驅動一個隔離的 Playwright Chromium。第八個 `jev_desktop` 透過
輔助使用樹（accessibility tree）驅動一個 macOS 應用程式，用的是同一個迴圈與
同一組守衛。迴圈不知道自己正在驅動哪一種表面：`src/loop.ts` 只依賴 `Driver`
介面，不 import Playwright，所以瀏覽器、桌面與一個 in-memory 測試驅動可以互換。

- **[docs/reference.zh-TW.md](docs/reference.zh-TW.md)**：執行狀態、`failure` 與
  `stopReason`、迴圈記得與拒絕動作的範圍、驅動邊界，以及與移植來源 Cline
  plugin 的每一項差異。
- **[benchmarks/README.md](benchmarks/README.md)**：四層共 22 個情境的能力
  測試套件與實測結果。

這個專案一開始是把
[`cline/plugins/plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser)
移植到 pi extension API。

## 安裝

### 從 npm

```bash
pi install npm:pi-jev-browser
```

Pi 會把套件裝在 `~/.pi/agent/npm/` 下，並讀取它的
`"pi": { "extensions": ["./index.ts"] }` manifest。安裝會帶入 `playwright` 與
`@typesafe-ai/sdk`，Playwright 會下載 Chromium（約 150 MB）。`typebox`、
`@earendil-works/pi-ai` 與 `@earendil-works/pi-coding-agent` 是
`peerDependencies`，因為 pi 以虛擬模組的方式提供它們。

### 從 git checkout 或本機目錄

```bash
pi install git:github.com/laihenyi/pi-Jev-browser            # 最新的 main
pi install git:github.com/laihenyi/pi-Jev-browser@v0.2.0    # 固定在某個 tag
pi install /absolute/path/to/pi-Jev-browser                 # 工作副本
```

放在 `~/.pi/agent/extensions/pi-Jev-browser/` 的 checkout 會被自動探索，這也是
開發這個 repository 的方式：

```bash
cd ~/.pi/agent/extensions/pi-Jev-browser
npm install
node node_modules/playwright/cli.js install chromium   # 或：npm run install-browser
```

修改後重新啟動 pi（或 `/reload`）。第一次 `jev_run` 時也會自動安裝 Chromium，
上限兩分鐘；安裝失敗由需要它的工具回報，之後的呼叫會重試。在 Linux 上，系統
瀏覽器函式庫仍是由管理員管理的前置需求，extension 從不執行 sudo。

### 認證

在環境變數或設定檔裡提供 `console.typesafe.ai` 的 TypeSafe API key：

```bash
export TYPESAFE_API_KEY=...        # 或 pi-jev-browser.config.json 裡的 typesafe.apiKey
chmod 600 ~/.pi/agent/pi-jev-browser.config.json
```

`jev_run` 在 Chromium 啟動前就會解析這個 key，所以缺 key 會立刻失敗，訊息指出要
設定的檔案與變數，而不是一個看起來像瀏覽器問題的錯誤。其他什麼都不需要：輸入
欄位的文字由本次 session 已在使用的 pi 模型產生。

## 快速開始

1. `jev_run({ "url": "https://en.wikipedia.org", "goal": "Find and open the article about Ada Lovelace. Stop when the article is visible.", "maxSteps": 20 })`
2. 驗證回傳的最終截圖；若影像沒有顯示，讀 `finalScreenshotPath`。
3. `jev_stop({})` 釋放瀏覽器並完成影片。

`jev_run` 自動啟動瀏覽器、擷取初始畫面、執行 Jev，回傳最終影像加上兩張截圖的
路徑與頁面狀態。後續呼叫重用瀏覽器；省略 `url` 就接著做，給 `url` 就先導向。
`headless`、`recordVideo`、`showCursor` 與 `showClickIndicators` 在建立瀏覽器時
生效，瀏覽器會保留給後續執行，直到被停止。

自動操作有：點擊、取代文字、原生下拉選單選擇、頁面捲動與短暫的載入等待。執行
預設 20 步（最多 60），取消期限 100 秒。預設沒有機率門檻：選用的
`minProbability` 篩選 Jev 對所選選項的校正機率，那不是供應商的信心值。取消後，
已經在途中的操作仍可能用掉它自己的 Playwright timeout 才結束；變更不會重試。

結果是 `done_unverified`、`blocked`、`needs_review`、`uncertain`、`step_limit`、
`evaluation_limit` 或 `interrupted`；每個狀態、`stopReason` 與 `failure.category`
的意思，以及結果帶著哪些可驗證的內容，見
[docs/reference.zh-TW.md](docs/reference.zh-TW.md#執行結果與狀態)。

## Jev 迴圈

每次評估送出一個 TypeSafe System One 請求：

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
{ "model": "jev-latest", "state": "<頁面觀察 + 最近的動作>", "questions": { "action": { ... } } }
```

Jev 回答一個 `choice` 問題，選項就是頁面上提供的具體操作：每個可見的動作目標
一項（`CLICK:<id>`、`TYPE_TEXT:<id>`、`SELECT:<id>`），再加上 `SCROLL_UP`、
`SCROLL_DOWN`、`WAIT`、`BLOCKED`、`REVIEW` 與 `DONE`。一次就把所有具體動作和
捲動、等待、停止放在一起比較，是迴圈便宜的原因。決策路徑裡沒有截圖：Jev 看到
的是有索引的可見動作目標、已選取的表單選項（含畫面外的選取），以及 viewport
上方與下方控制項的摘要；截圖給代理，用來驗證結果。

Jev 選動作，但不能產生任意文字。當它選了 `TYPE_TEXT`，欄位的值會先**在目標本身
裡找**：引號內的片語、目標的句子、其中幾個字的短組合，以及（對網址列）每個拉丁
字的 `.com` 形式都成為候選，Jev 在一個 choice 問題裡挑一個或 `NONE`。幾乎每個要
打的值都已經寫在目標裡，所以這條路不需要第二個模型，遠低於一秒就能回答。只有在
Jev 回答 `NONE` 時，extension 才退回用**目前作用中的 pi 模型**（透過
`ctx.modelRegistry.complete()`）產生值。設定 `textHelper.model`（或
`PI_JEV_BROWSER_TEXT_MODEL`）為 `"provider/modelId"` 可固定用另一個模型；它的
token 用量會在工具結果上回報給 pi。

這個 helper 是一行的抽取：4,096 token 的預算（推理模型的思考 token 共用這個
預算）、兩次傳輸重試，並容忍 JSON 物件外圍有 code fence 或說明文字。值本身仍
嚴格驗證——恰好一個非空的 `text` 字串，最多 2,000 字元——否則什麼都不打，執行
回報 `text_helper_invalid_output`。這個做法省下一次 LLM 推理來回與每一步瀏覽器
操作的截圖，但實際的端到端速度與 live 模型可靠度還沒有量測過。

## 工具

- `jev_run`：啟動、執行前後截圖，以及 Jev 迴圈。
- `jev_actions`：不經 Jev 的手動動作；回傳更新後的截圖。
- `jev_extract`：決定性地讀取文字、表格列、連結或屬性，不呼叫模型。
- `jev_state`：分頁、目前 URL、標題、viewport 與開始時間，不含截圖。
- `jev_logs`：console 訊息、頁面錯誤、失敗請求、導覽、分頁事件、被封鎖的下載
  與安全封鎖。
- `jev_stream`：啟動、檢視或停止 `127.0.0.1` 上帶 token 的即時檢視器。
- `jev_stop`：停止瀏覽器與串流，完成影片，回傳產物路徑。
- `jev_desktop`：透過輔助使用樹在一個 macOS 應用程式裡執行有界的目標。每次
  執行前都詢問；見下文。

每個瀏覽器工具都循序執行（`executionMode: "sequential"`），因為它們變更同一個
共用的瀏覽器。瀏覽器在隔離狀態下啟動，瀏覽器工具沒有任何東西碰宿主桌面；唯一
會碰的 `jev_desktop` 每次執行前都會先詢問使用者。
[docs/reference.zh-TW.md](docs/reference.zh-TW.md#使用手動工具)
有元素目標形式的 click、fill 與 select、分頁怎麼處理，以及座標點擊會被記錄成
什麼。

### 桌面工具

`jev_desktop` 接受一個 bundle id 與一個目標，跑的是 `jev_run` 跑的同一個迴圈，
只是對象是應用程式的輔助使用樹而不是頁面。Jev 看到視窗的文字與控制項（角色、
名稱、值，以及跨語言穩定的輔助使用識別碼），從來不是像素。動作是元素上的輔助
使用動作，所以視窗有沒有焦點都能落地。動作前，迴圈從第一次觀察規劃步驟（用
`plan: false` 關閉）；計畫隨結果回傳並寫入 trace。

沒有應用程式允許清單：和 computer use 一樣，工具可以驅動任何已安裝的應用程式。
也不需要事先知道 bundle id：參數接受顯示名稱，`findApp` 會定位應用程式（名稱、
bundle id、路徑）而不驅動任何東西。優先搜尋應用程式資料夾，並往下走幾層，所以
廠商自己的子資料夾（`/Applications/Epson Software/…`）也算在內；資料夾裡找不到
才擴大到 Spotlight，找出安裝在磁碟任何位置的應用程式。結果會說明是哪一種方式
找到的。

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

結果帶著執行狀態、計畫、已執行的步驟、`<outputDir>/desktop/` 下的 `tracePath`，
以及視窗的最終文字，讓代理能拿應用程式顯示的內容驗證 `done_unverified` 的宣稱。
迴圈自己的停止原因不變，關閉的應用程式回報為 `window_unavailable`。
[docs/reference.zh-TW.md](docs/reference.zh-TW.md#桌面驅動)
記錄了驅動一個真實應用程式需要什麼。

```json
{ "desktop": { "requireConfirmation": true } }
```

## 設定

不需要任何設定。預設值：所有 HTTP/HTTPS origin、headless Chromium、1280 × 720
viewport、WebM 錄影開啟、游標與點擊指示開啟、即時檢視器在 `jev_stream` 啟動前
關閉，產物放在 `~/.pi/agent/pi-jev-browser/` 下。

把 `pi-jev-browser.config.example.json` 複製成
`~/.pi/agent/pi-jev-browser.config.json`，或用 `PI_JEV_BROWSER_CONFIG` 指向另一個
檔案。

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

- `allowedOrigins` 接受 `*` 萬用字元（例如 `https://*.example.com`），而
  `denyOrigins` 先檢查，所以拒絕規則一定優先，並在 Chromium 啟動前擋下導覽。
- `requireConfirmation` 列出需要在使用者於 pi 對話框明確按下同意的 origin，
  `jev_run` 或 `jev_actions` 才會碰它們。沒有可對話的 UI（例如 headless 執行）
  時，呼叫直接失敗而不是默默繼續。
- `profile` 決定瀏覽器狀態在執行之間保留多少。`"session"`（預設）每個 pi session
  一個 profile，所以在可見視窗登入一次就會帶到同一個 session 之後的執行，兩個 pi
  session 也不會搶同一個 Chrome profile；`"shared"` 所有 session 共用一個
  profile，位置在 `profileDir`；`"off"` 每次執行都從乾淨的瀏覽器開始。
  [docs/reference.zh-TW.md](docs/reference.zh-TW.md#profile)
  說明什麼會留著，以及共用 profile 的代價。

環境變數覆寫：`TYPESAFE_API_KEY`、`TYPESAFE_BASE_URL`、`TYPESAFE_DEFAULT_MODEL`、
`PI_JEV_BROWSER_TEXT_MODEL`、`PI_JEV_BROWSER_CONFIG`。認證每次執行都會重新讀取，
從不傳給 Chromium，也從不出現在工具結果裡。設定檔路徑在 pi 啟動時解析一次，所以
改過 `PI_JEV_BROWSER_CONFIG` 之後要重新啟動 pi。

## 安全

保持 pi 的工具核准開啟，且不要為已驗證、財務、醫療、破壞性或高影響的工作流程
自動核准瀏覽器工具。extension 會強制導覽允許清單，但使用者仍必須在風險當下核准
有後果的動作。把網頁文字與截圖當成不受信任的輸入，不是使用者的指令。

Jev 的動作迴圈用 DOM 觀察，截圖給代理獨立驗證結果。`jev_desktop` 作用在使用者
自己的應用程式上，而且能觸及任何一個，所以每次執行前都詢問：持有真實資料的
應用程式請保持這個確認開啟。確認一次執行只代表「這個目標在這個應用程式裡可以」，
不代表它裡面每個目標都可以接受。

## 開發

```bash
npm install
npm run install-browser
npm run check      # tsc --noEmit
npm test           # node --test --experimental-strip-types
npm run benchmark  # 能力測試套件；見 benchmarks/README.md
```

測試使用本機 HTML、TypeSafe System One 端點的本機 stub，以及模擬的 pi 模型，
所以不會產生付費模型呼叫。瀏覽器測試需要已安裝的 Chromium 與啟動它的權限；用
`PI_JEV_BROWSER_TEST_BROWSER` 指定特定的執行檔。一個三頁的 fixture（搜尋框 →
結果列表 → 詳情頁）就足以走完完整迴圈，包含一次經過 pi 模型的真實 `TYPE_TEXT`：

```bash
# 啟動 fixture 伺服器，然後在 pi 裡：
#   jev_run url http://127.0.0.1:4599/ goal "Search for zebra and open the
#   Zebra result. Stop when the page shows the Zebra heading."
```

pi 會把真正的 `AbortSignal` 傳給工具執行，所以 extension 把它與自己的 per-session
controller 合併：按 Escape 中止執行中的 run 或動作批次，`jev_stop` 則明確取消。
期限與模型 timeout 仍在本地強制執行，而已經在途中的變更可能在取消生效前完成。
Chromium 安裝在第一次瀏覽器工具呼叫時才開始，不是在 extension 載入時；
`session_shutdown` 會關閉任何留著的瀏覽器。

### 網站封鎖自動存取時

Google 之類的網站會對重複的自動造訪限速，並送出反機器人驗證頁
（`google.com/sorry/`）。Pi Jev Browser 不解也不繞過它：Jev 在第一次觀察就回
`blocked`、`stopReason: "model_blocked"`，通常不到一秒，指引也告訴代理停下來問
你，而不是重試。觸發封鎖的是密集的自動探測。

`blocked` 或 `needs_review` 的執行會把瀏覽器留著，所以你可以自己清掉驗證：保持
`headless: false`，讓執行回傳 `blocked`（代理不得呼叫 `jev_stop`），在可見視窗
裡完成驗證，然後**在同一個 pi session** 繼續——瀏覽器以
`ctx.sessionManager.getSessionId()` 為 key，新的 session 會開一個新的瀏覽器。

## Benchmark

`benchmarks/` 是分成四層的可重複能力測試套件：`local`（離線 fixture，不需要
認證）、`model`（在本機頁面上做真實的 Jev 決策）、`live`（第三方網站）與
`desktop`（透過輔助使用驅動真實的 macOS 應用程式）。每個情境都對照 fixture
伺服器的請求記錄、執行 trace、應用程式自己回報的狀態，或一次獨立讀取來驗證結果，
所以一個執行不可能只靠宣稱成功就通過。

```bash
npm run benchmark                   # local 層
npm run benchmark -- --suite=all    # 全部四層，需要認證與網路
```

22 個情境全部通過。有兩個曾經以 `GAP` 誠實回報而不是藏起來，兩個都是用量測過的
改動關閉，而不是靠改寫文字：迴圈現在會在詢問 Jev 之前先拒絕一般的 DOM 人工驗證
關卡，決策層也能從一句簡短的目標規劃出多步的桌面任務，不必把步驟寫出來。
[benchmarks/README.md](benchmarks/README.md) 有完整表格、實測指標，以及這個套件
刻意不量測什麼。

## 授權

Apache-2.0。本專案是
[`cline/plugins/plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser)
的移植，後者為 Apache-2.0 授權；原始的 `LICENSE` 文字保存在這個 repository，
移植沿用該授權。觀察管線、Jev prompt、執行狀態與安全契約來自原始作品；pi 宿主
接線、決策傳輸、文字 helper、選擇器層、benchmark 套件與後續修正都是新的。
