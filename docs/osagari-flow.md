# おさがりシェアリング機能 データ・通知フロー

登録〜申込み〜管理者対応の間に、どのタイミングで誰にメールが飛び、
どのデータがどこ（スプレッドシート／Airtable）に書き込まれるかをまとめる。
実装コードの対応箇所：`gas/コード.gs`（GAS本体）／`workers/osagari-worker.js`（中継）。

## 0. 全体構成

```mermaid
flowchart LR
  Browser["ブラウザ\n/osagari/配下\n(Cloudflare Accessで会員限定)"]
  Worker["Cloudflare Workers\n/osagari/api/*\n(GASのURL・鍵を秘匿\nitems/item/imageはエッジキャッシュ)"]
  GAS["GAS Web App\n(コード.gs)"]
  Sheet["Googleスプレッドシート\n公開商品／提供者情報／申込み"]
  Admin["管理者(担当者)\nADMIN_EMAILのメール"]
  Airtable["Airtable\nおさがりシェアリングベース\n(BaaKeeテーブル)"]
  Drive["Google Drive\n画像の複製先"]

  Browser -- "同一オリジンfetch" --> Worker
  Worker -- "SHARED_SECRET付き" --> GAS
  GAS <--> Sheet
  GAS -- "MailApp.sendEmail" --> Admin
  Admin -- "手動で表示チェックON\n/申込み対応状況を更新" --> Sheet
  Airtable -. "importFromAirtable()\n手動実行のみ・自動連携なし" .-> GAS
  GAS -. "画像を複製" .-> Drive
```

**ポイント**：
- Airtableは常時連携ではなく、GASエディタで `importFromAirtable` 関数を手動実行したときだけ呼ばれる一括インポート用。会員登録・申込みの通常フローにAirtableは登場しない。
- 一覧(`/osagari/api/items`)・詳細(`/osagari/api/item`)・画像(`/osagari/api/image`)はCloudflare Workersのエッジキャッシュを経由する（一覧・詳細は30秒、画像は1日）。登録・掲載状況の変更が一覧に反映されるまで、キャッシュ分＋Cloudflareゾーンのブラウザキャッシュ（最大4時間）のタイムラグが生じうる。

---

## 1. 会員が「モノ・たすけあい」を登録する（register.html）

### フローチャート

```mermaid
flowchart TD
  A["会員が register.html で入力\n(タイトル/説明/地域/連絡先など)"] --> B{"ハニーポット項目が\n空欄か？"}
  B -- "埋まっている(bot)" --> Z["送信できませんでしたと表示\n※どこにも記録されない"]
  B -- "空欄(人間)" --> C["Workers経由でGASへPOST\naction=register"]
  C --> D["公開商品シートに1行追加\n「表示」チェックはOFF(非公開)"]
  D --> E["提供者情報シートに1行追加\n(氏名/住所/連絡先/メール)"]
  E --> F["notifyAdminRegistration()\nADMIN_EMAILへメール通知"]
  F --> G["管理者がメールを見て\n内容を確認"]
  G --> H{"掲載してよい内容か？"}
  H -- "OK" --> I["スプレッドシートで\n『表示』チェックボックスをON"]
  I --> J["一覧(index.html)に公開される\n(エッジキャッシュ分の遅延あり)"]
  H -- "要修正/NG" --> K["管理者が登録者へ\n個別に連絡(電話/LINE等)"]
```

### シーケンス図

```mermaid
sequenceDiagram
  actor 提供者 as 提供者(会員)
  participant HTML as register.html
  participant Worker as Cloudflare Workers
  participant GAS as GAS Web App
  participant Sheet as スプレッドシート
  actor Admin as 管理者(担当者)

  提供者->>HTML: フォーム入力・送信
  HTML->>Worker: POST /osagari/api/register
  Worker->>GAS: POST (SHARED_SECRET付き, action=register)
  GAS->>Sheet: 公開商品シートに追加(表示=false)
  GAS->>Sheet: 提供者情報シートに追加
  GAS-->>Admin: メール通知「【新規登録】〇〇」
  GAS-->>Worker: {ok:true, itemId}
  Worker-->>HTML: 登録受付メッセージ
  Note over Admin,Sheet: 管理者がメール内容を確認
  Admin->>Sheet: 「表示」チェックボックスをON
  Note over Sheet: この時点で一覧に公開される\n(Workersのエッジキャッシュ分の遅延あり)
```

---

## 2. 希望者が「譲ってほしい／頼みたい」と申し込む（item.html）

### フローチャート

```mermaid
flowchart TD
  A["希望者が item.html で\n商品を選び申込みフォーム入力"] --> B{"メール確認欄と一致？"}
  B -- "不一致" --> Y["エラー表示・再入力を促す"]
  B -- "一致" --> C{"ハニーポット項目が空欄か？"}
  C -- "埋まっている(bot)" --> Z["送信できませんでしたと表示"]
  C -- "空欄(人間)" --> D["Workers経由でGASへPOST\naction=apply"]
  D --> E["申込みシートに1行追加\n対応状況=未対応"]
  E --> F["notifyAdmin()\nADMIN_EMAILへメール通知"]
  F --> G["管理者が申込みシートの\n商品IDを見て提供者情報シートを参照"]
  G --> H["管理者が提供者と希望者の\n間を仲介・受渡し調整"]
  H --> I["管理者が申込みシートの\n『対応状況』を手動更新"]
```

### シーケンス図

```mermaid
sequenceDiagram
  actor 希望者
  participant HTML as item.html
  participant Worker as Cloudflare Workers
  participant GAS as GAS Web App
  participant Sheet as スプレッドシート
  actor Admin as 管理者(担当者)
  actor 提供者

  希望者->>HTML: 申込みフォーム入力・送信
  HTML->>Worker: POST /osagari/api/apply
  Worker->>GAS: POST (SHARED_SECRET付き, action=apply)
  GAS->>Sheet: 申込みシートに追加(対応状況=未対応)
  GAS-->>Admin: メール通知「【おさがり申込み】〇〇」
  GAS-->>Worker: {ok:true, applicationId}
  Worker-->>HTML: 申込み受付メッセージ
  Note over Admin,Sheet: 管理者が申込みシートと\n提供者情報シートを突き合わせ
  Admin->>提供者: 電話/LINE等で仲介連絡(手動・システム外)
  Admin->>Sheet: 対応状況を更新(対応中/完了 等)
```

**注意（現状の設計）**：希望者・提供者どうしを直接つなげる自動メールは存在しない。管理者が申込みシートと提供者情報シートを見比べて、電話やLINEなど**システム外で手動仲介**する運用（`gas/README.md`に明記されている「提供者情報シートはAPIから一切参照しない＝個人情報を公開しない設計」の裏返し）。

---

## 3. Airtableからの一括インポート（手動運用・GASエディタから実行）

```mermaid
flowchart TD
  A["管理者がGASエディタで\nimportFromAirtable()を手動実行"] --> B["Airtable API から\nBaaKeeテーブルの全レコード取得"]
  B --> C{"商品ID(at-<レコードID>)は\n既に取込み済みか？"}
  C -- "済み" --> D["スキップ"]
  C -- "未取込み" --> E["画像添付があれば\nGoogle Driveへ複製・共有設定"]
  E --> F["公開商品シートに1行追加\n(掲載状況は「猶予」列から自動判定)"]
  F --> G["提供者情報シートに1行追加\n(住所プレースホルダーは空欄化)"]
  G --> H["ログに「新規◯件・スキップ◯件」を出力"]
```

**ポイント**：
- Airtable連携はWebアプリからのリアルタイム連携ではなく、**担当者がGASエディタを開いて手動でボタンを押す**ときだけ動く一括バッチ処理。
- 何度実行しても、商品IDの重複判定（`at-<AirtableレコードID>`）により二重取込みは起きない。
- 取り込んだ商品も、`公開商品`シートの「表示」チェックがOFFなら一覧には出ない（インポート元の「猶予」列が「終了」でない限りONで取り込まれる）。
- Airtableの「お名前」「ご住所」「連絡先」「Email」は`提供者情報`シートにのみ書き込まれ、公開APIには一切出さない（会員自己登録と同じ個人情報保護方針）。

---

## メール通知が発生するタイミング一覧

| きっかけ | 送信元関数 | 宛先 | 件名例 |
|---|---|---|---|
| 会員がモノ・たすけあいを登録 | `notifyAdminRegistration()` | `ADMIN_EMAIL`（管理者のみ） | 【新規登録】〇〇（itemId） |
| 希望者が申込みフォームを送信 | `notifyAdmin()` | `ADMIN_EMAIL`（管理者のみ） | 【おさがり申込み】〇〇（applicationId） |
| Airtable一括インポート実行時 | なし | — | メール通知は発生しない（ログ出力のみ） |

登録者・希望者本人には自動返信メールは送られない（フォーム送信後の画面メッセージのみ）。`ADMIN_EMAIL`はスクリプトプロパティ未設定の場合、通知自体がスキップされる（登録・申込み自体は成立する）。

## 管理者(担当者)がシステム外で必ずやること

1. 登録通知メールを見て内容を確認し、問題なければ**公開商品シートの「表示」チェックをON**にする（これをしないと一覧に永久に出ない）。
2. 申込み通知メールを見て、**申込みシートの商品ID→提供者情報シートを手動で突き合わせ**、電話やLINEで提供者・希望者を仲介する。
3. 対応が進んだら**申込みシートの「対応状況」列を手動更新**する（未対応→対応中→完了など。選択肢はシステムで固定されていないので運用ルールとして統一するとよい）。
4. Airtableの新規データを取り込みたいときだけ、GASエディタで`importFromAirtable`を手動実行する。
