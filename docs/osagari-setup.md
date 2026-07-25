# おさがりシェアリング機能 全体セットアップ（フェーズ1・電動ベッド試作版）

## 構成
```
ブラウザ（/osagari/、Cloudflare Accessで会員限定）
   ↓ 同一オリジンなのでCORS不要
Cloudflare Workers（/osagari/api/*、GASのURL・鍵を秘匿）
   ↓ SHARED_SECRET付きでサーバー間通信
GAS Web App（Googleスプレッドシート「おさがりシェアリング」を操作）
```

## 進捗状況（2026-07-25時点）
- [x] Googleスプレッドシート作成・3シート自動セットアップ（`gas/Code.gs` の `setupSheets()`）
- [x] GAS Web Appデプロイ・疎通確認済み
- [ ] Cloudflare Access設定（`/osagari` を会員限定に）
- [ ] Cloudflare Workersデプロイ
- [ ] `公開商品`シートへ電動ベッドのテストデータ投入
- [ ] 実際にブラウザから一覧→詳細→申込みの動作確認

## 手順書
1. GASのセットアップ：[`gas/README.md`](../gas/README.md)（完了済み）
2. Cloudflare Accessの設定：Asanaタスク③参照（Domain: `tea-under.club` / Path: `/osagari`）
3. Cloudflare Workersのデプロイ：[`workers/README.md`](../workers/README.md)
4. 静的ファイル：`osagari/index.html`（一覧）・`osagari/item.html`（詳細＋申込みフォーム）は追加設定不要。GitHub Pagesへpushすればそのまま配信される

## 残っている論点
- `osagari/*.html` は今のところ**GitHub Pagesへpushして初めて公開される**。ローカルで動作確認したい場合は、Cloudflare Access・Workersのデプロイが先に必要（`fetch('/osagari/api/...')` が同一オリジン前提のため、ローカルファイルを直接開いても動かない）
- テスト用の電動ベッドデータは `公開商品` シートに直接1行入力する（商品ID等の採番ルールは決めていないので、`item-001` のような簡単な文字列でよい）
