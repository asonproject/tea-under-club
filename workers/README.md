# おさがりシェアリング Cloudflare Workers セットアップ

`gas/.env.local` に控えてある `GAS_WEBAPP_URL` と `SHARED_SECRET` を使う。この2つの実値はここにも書かない。

## 初回のみ

```bash
npm install -g wrangler   # 未導入なら
wrangler login             # Cloudflareアカウントでブラウザ認証
```

## デプロイ

```bash
cd workers
wrangler secret put GAS_WEBAPP_URL
# プロンプトが出たら .env.local の GAS_WEBAPP_URL の値を貼り付け

wrangler secret put SHARED_SECRET
# プロンプトが出たら .env.local の SHARED_SECRET の値を貼り付け

wrangler deploy
```

`wrangler.toml` の `routes` で `tea-under.club/osagari/api/*` にルーティングされる。それ以外のパス（`/osagari/index.html`等）は今まで通りGitHub Pagesが配信するので、既存サイトへの影響はない。

## 動作確認

Cloudflare Accessでログイン済みのブラウザから：

```
https://tea-under.club/osagari/api/items
```

`{"items":[]}` 等が返ればOK（GAS側に未対応ならエラーJSONが返る）。

## セキュリティ設計の要点
- `SHARED_SECRET`はこのWorkerの環境変数にのみ存在し、ブラウザ側コード（`osagari/`配下のHTML/JS）には一切書かない
- **Cloudflare Accessの保護パスは`/osagari`（サブパス込み）にすること**。`/osagari/api/*`もこの配下にあるため、Access未認証のブラウザはAPIも含めて一切アクセスできない設計
- コード変更後は`wrangler deploy`を再実行すれば同じURLのまま更新される

## コードを更新した後

```bash
cd workers
wrangler deploy
```
