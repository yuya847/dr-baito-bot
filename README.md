# dr-baito-bot（医師バイト秘書）

医師のスポットバイトの求人を、本人の Google カレンダーの空きと照らし、LINE で秘書のように知らせて相談に乗る Bot です。
合同会社鈴木医工が運営する LINE「医局秘書Bot」のコードから、求人の取り込み部分を「自社の求人データの差し込み口」に置き換えた写しです。
利用条件は [LICENSE.md](LICENSE.md) を見てください（無償・非独占・無保証）。

## できること

- **相談**：LINE で「土曜の午前、健診がいい」「時給重視で船橋から1時間」などと話すと、Claude（Anthropic の AI）が条件にして、予定と重ならない求人をカードで出す。「1番」「これまだある？」のように前の話を受けて答える（`src/agent.mjs`。道具を持たせた会話、最大6手）
- **カレンダー**：カードの「カレンダーに追加」→確認の「追加する」を押したときだけ書く。既存の予定の変更・削除も、前後を見せた確認ボタンを押したときだけ。1日は「元に戻す」（`src/edit.mjs`）
- **先回りの知らせ**（15分おき・変化があるときだけ）：勤務の重なり、気にしていた求人の募集終了、増額、条件に合う新着を「💰 2時間で3万円！ 11/5(木) 世田谷区・予防接種」の形で（`src/scout.mjs`）
- **お節介**：前夜20時のひとこと、件名と時刻の食い違い、移動が間に合わない、応募の確認、勤務後の感想（`src/care.mjs`）
- **リマインド**：応募・確定した勤務の前日と出発前に、経路のリンクつきで（`src/remind.mjs`）
- **覚える**：会話から好み・避けたい業務・体験を覚え、次の提案に使う。LINE で「覚えていること」で一覧、消すこともできる（`src/learn.mjs`）

しないこと：応募・問い合わせ・メール送信はしない。カレンダーは本人が確認ボタンを押したときだけ書く。求人文や予定の中の指示には従わない。

## いまの作りの前提（大事）

- **1つのデプロイで医師1人**です。LINE の友だちと Google アカウントを6桁の連携コードで1組だけ結びつけます（`line:owner`）。
  多くの医師に使ってもらうには、DynamoDB のキーを利用者ごとに分け、Google の許可を利用者ごとに持つ改修が要ります。
- 求人は `src/sites/feed.mjs` から読みます。`JobsFeedUrl` を空のままデプロイすると、架空の求人4件（`src/sites/sample-jobs.mjs`）で動きます。

## 仕組み

```
EventBridge（2分おき）→ CrawlFunction（src/handler.mjs → tick.mjs → sites/feed.mjs）→ DynamoDB（新着・変更・見えなくなった求人）
LINE → LineWebhookFunction（src/handler-line.mjs → assistant.mjs / agent.mjs + Claude）→ 返信・カード
EventBridge（15分おき）→ NotifyFunction（scout.mjs・care.mjs・remind.mjs）→ プッシュ（変化があるときだけ）
鍵（LINE・Claude・Google・求人データ）は Secrets Manager に1件だけ
```

| ファイル | 中身 |
|---|---|
| `src/sites/feed.mjs` | 自社求人の差し込み口（ここを自社のデータに合わせる） |
| `src/lib/normalize.mjs` | 求人を共通の形に整える（報酬・時刻・住所の読み取り） |
| `src/tick.mjs` | 巡回と差分（新着・変更・再掲載・見えなくなった） |
| `src/match.mjs` `src/rank.mjs` | カレンダーの空きとの照合、条件での採点 |
| `src/agent.mjs` | 会話（Claude に道具を持たせる） |
| `src/assistant.mjs` | LINE の受け答えの入口、ボタン操作、連携コード |
| `src/scout.mjs` `src/care.mjs` `src/remind.mjs` | 先回りの知らせ・お節介・リマインド |
| `src/livecheck.mjs` | 「これまだある？」で掲載状況を確かめる |
| `src/lib/line.mjs` | LINE の送信・求人カード |
| `src/lib/google.mjs` `src/schedule.mjs` `src/edit.mjs` | Google カレンダーの読み書き |
| `docs/エージェント設計.md` | 設計の考え方（守る約束・道具・データ・受入テスト） |

## 求人データの形

`JobsFeedUrl` に `?pref=<JIS 都道府県コード>&page=<1始まり>` を付けて GET します（`JOBS_FEED_TOKEN` があれば `Authorization: Bearer`）。返す JSON：

```json
{ "lastPage": 3, "jobs": [
  { "id": "S1001", "url": "https://jobs.example.com/jobs/S1001", "appUrl": "https://app.example.com/jobs/S1001",
    "title": "内科外来（午前）", "facility": "みなと内科クリニック",
    "date": "2026-11-20", "timeText": "09:00-12:00", "hours": 3,
    "payText": "時給 12,000円", "address": "東京都港区芝5-1-1",
    "departmentsText": "内科、小児科", "workOutline": "外来・健診結果説明", "note": "交通費: 全額支給" }
] }
```

| 項目 | 要否 | 説明 |
|---|---|---|
| `id` | 必須 | 求人の ID（無い求人は取り込まない） |
| `date` | 必須 | 勤務日 `YYYY-MM-DD`（`dateText` に「2026年11月20日」でも可） |
| `timeText` | 必須 | `09:00-12:00`、日またぎは `17:00-翌09:00` |
| `payText` | 必須 | 「一回 60,000円」「時給 12,000円」など。時給は `hours` があれば総額も出す |
| `address` | 必須 | 都道府県から（`pref`・`city` を別に渡してもよい） |
| `url` / `appUrl` | 任意 | カードの「求人を見る」「アプリで開く」。ドメインは `JobHosts` に入れたものだけ使う |
| `hours` | 任意 | 実働時間（休憩を除く）。無ければ `timeText` から |
| `title` `facility` `departmentsText` `workOutline` `note` `access` | 任意 | カードと AI の判断に使う |

「これまだある？」に今の掲載状況で答えたいときは `JobsStatusUrl`（例 `https://api.example.com/jobs/{id}/status`）を入れます。404 か `{"status":"ended"}`（`closed` も可）で終了、`{"status":"open"}` で掲載中。

## 動かし方

用意するもの：AWS のアカウントと AWS SAM CLI（Serverless Application Model の道具）、Node.js 22、LINE 公式アカウント（Messaging API）、Anthropic の API キー、Google Cloud の OAuth クライアント（デスクトップ アプリ、Calendar API を有効に）。

```bash
npm install
npm test                                   # 61件のテスト
bash scripts/deploy.sh "JobsFeedUrl=https://api.example.com/doctor-jobs JobHosts=jobs.example.com,app.example.com"
bash scripts/set-line-secret.sh            # LINE のチャネルシークレット・長期アクセストークン・Claude の API キー（伏せ字で入力）
node scripts/google-auth.mjs               # Google カレンダーの許可（client_secret_*.json を指定。鍵は Secrets Manager へ）
node scripts/line-link.mjs                 # 出た6桁を Bot の LINE に送ると、その友だちが本人になる
```

- LINE Developers の Webhook URL には、スタックの出力 `LineWebhookUrl` を貼る。応答設定は「応答メッセージ」オフ・「Webhook」オン
- 求人データの鍵は Secrets Manager の `JOBS_FEED_TOKEN` に入れる
- 手元で試す：`node src/local.mjs`（取り込みを1ページ、`data/local.json` に保存。AWS は使わない）
- デプロイ後に本物の求人・カレンダーで試す（LINE には送らず DynamoDB にも書かない）：`node scripts/try-agent.mjs "土曜の午前で探して"`、`node scripts/try-scout.mjs 2026-11-05T20:15`（その時刻に送る知らせを画面に出す）
- ログ：`aws logs tail /aws/lambda/<関数名> --since 30m`

## 知っておくとよいこと（元の実装で分かったこと）

- **アプリのリンク**：ユニバーサルリンクを LINE のボタンから直接 Safari で開くと、アプリに渡らず App Store に回ることがありました。別のドメインに中継ページを置き、そこでもう1回押してもらうと開きました。
- **LINE の通数**：無料プランは月200通。プッシュ1回（最大5メッセージ）で1通、返信は数えません。送る前に `quota` で残りを見て、残り20通を切ったら急がない知らせを止めます。
- **LINE のボタン**：クイックリプライは最後のメッセージにしか出ません。URI のボタンは http・https・line・tel だけです（アプリ独自のスキームは入れられない）。
- **共有カレンダー**：医局の共有カレンダーには他の医師の終日予定が並びます。本人が所有者だと書けてしまうので、件名に本人の名前（LINE で「名前は山田」）がある予定だけを本人の予定として扱います。
- **Gmail**：読み取りの権限は Google の「制限付き」で、多人数に出すと毎年の外部のセキュリティ診断が要ります。この写しでは使っていません。
- **個人情報**：予定の件名・場所・説明の先頭は AI に渡しますが保存しません。会話から覚えたことは DynamoDB に残ります。利用者向けのプライバシーポリシーにこの範囲を書いてください。
- **求人の扱い**：求人情報を利用者に届けるサービスは、職業安定法の募集情報等提供事業にあたることがあります。届出などは運用する側で確かめてください。

## 費用の目安（医師1人）

Lambda 約1万回/月・DynamoDB オンデマンド・Secrets Manager 1件（$0.40/月）で月数十〜百円台の想定。Claude は会話1往復あたり数円。LINE は無料プランの範囲（多人数ならプランの見直しが要る）。
