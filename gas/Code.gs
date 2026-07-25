/**
 * てぃあんだぁクラブ おさがりシェアリング機能 - GAS バックエンド（フェーズ1・最小試作版）
 *
 * データは3シート構成：公開商品／提供者情報／申込み
 * 呼び出し元は Cloudflare Workers のみを想定（ブラウザから直接叩かせない）。
 * Web App は「アクセスできるユーザー：全員」でデプロイするため、
 * スクリプトプロパティ SHARED_SECRET と一致する key パラメータがない限り全リクエストを拒否する。
 */

const SHEET_ITEMS = '公開商品';
const SHEET_PROVIDERS = '提供者情報';
const SHEET_APPLICATIONS = '申込み';

const ITEM_HEADERS = ['商品ID', '商品名', '分類', '画像URL', 'サイズ', '地域', '状態', '受渡方法', '掲載状況', '説明文', '更新日時'];
const PROVIDER_HEADERS = ['商品ID', '提供者名', '住所', '電話番号', 'メールアドレス', '同意確認'];
const APPLICATION_HEADERS = ['申込ID', '商品ID', '申込者名', 'メールアドレス', '電話番号', 'メッセージ', '受取希望日', '対応状況', '申込日時'];

/**
 * 初回セットアップ用。Apps Scriptエディタの関数選択で setupSheets を選び、実行ボタンを押す。
 * 3シートが無ければ作成し、ヘッダー行が無ければ書き込む（既存データがあれば触らない）。
 * 既定の空シート「シート1」「Sheet1」は3シート作成後に削除する。
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  createSheetIfMissing_(ss, SHEET_ITEMS, ITEM_HEADERS);
  createSheetIfMissing_(ss, SHEET_PROVIDERS, PROVIDER_HEADERS);
  createSheetIfMissing_(ss, SHEET_APPLICATIONS, APPLICATION_HEADERS);

  ['シート1', 'Sheet1'].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() === 0) ss.deleteSheet(sheet);
  });
}

function createSheetIfMissing_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
}

function doGet(e) {
  try {
    if (!isAuthorized(e)) return jsonResponse({ error: '認証エラー' }, 401);

    const action = e.parameter.action;
    if (action === 'items') return jsonResponse({ items: getItems() });
    if (action === 'item') return jsonResponse({ item: getItem(e.parameter.id) });
    return jsonResponse({ error: '不正なリクエストです' }, 400);
  } catch (err) {
    return jsonResponse({ error: 'サーバーエラー: ' + err.message }, 500);
  }
}

function doPost(e) {
  try {
    if (!isAuthorized(e)) return jsonResponse({ error: '認証エラー' }, 401);

    const body = JSON.parse(e.postData.contents);
    if (body.action === 'apply') return jsonResponse(submitApplication(body));
    return jsonResponse({ error: '不正なリクエストです' }, 400);
  } catch (err) {
    return jsonResponse({ error: 'サーバーエラー: ' + err.message }, 500);
  }
}

function isAuthorized(e) {
  const secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  return !!secret && e.parameter.key === secret;
}

function jsonResponse(obj, status) {
  // GASのContentServiceはHTTPステータスコードを設定できないため、bodyに status を含めて返す
  const payload = Object.assign({ status: status || 200 }, obj);
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error(`シート「${name}」が見つかりません`);
  return sheet;
}

function sheetToObjects(sheet, headers) {
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1); // ヘッダー行を除く
  return rows
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

function getItems() {
  const sheet = getSheet(SHEET_ITEMS);
  const items = sheetToObjects(sheet, ITEM_HEADERS);
  // 「掲載終了」「非公開」は一覧に出さない
  return items.filter(item => item['掲載状況'] !== '掲載終了' && item['掲載状況'] !== '非公開');
}

function getItem(id) {
  if (!id) throw new Error('商品IDが指定されていません');
  const item = getItems().find(i => String(i['商品ID']) === String(id));
  if (!item) throw new Error('商品が見つかりません');
  return item;
}

function submitApplication(body) {
  // ハニーポット：フォームに隠しフィールドを仕込み、bot送信ならここで弾く
  if (body.website) return { error: '送信できませんでした' };

  const required = ['itemId', 'name', 'email'];
  for (const key of required) {
    if (!body[key] || String(body[key]).trim() === '') {
      return { error: `${key} は必須です` };
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return { error: 'メールアドレスの形式が正しくありません' };
  }

  const item = getItem(body.itemId); // 存在しない商品IDならここで例外→上位でキャッチされ500

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET_APPLICATIONS);
    const applicationId = 'A' + new Date().getTime();
    const now = new Date();
    sheet.appendRow([
      applicationId,
      body.itemId,
      body.name,
      body.email,
      body.phone || '',
      body.message || '',
      body.preferredDate || '',
      '未対応',
      now,
    ]);
    notifyAdmin(item, body, applicationId);
    return { ok: true, applicationId };
  } finally {
    lock.releaseLock();
  }
}

function notifyAdmin(item, body, applicationId) {
  const adminEmail = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  if (!adminEmail) return; // 未設定なら通知をスキップ（申込み自体は成立させる）

  const subject = `【おさがり申込み】${item['商品名']}（${applicationId}）`;
  const body_ = [
    `商品：${item['商品名']}（ID: ${item['商品ID']}）`,
    `申込者：${body.name}`,
    `メール：${body.email}`,
    `電話：${body.phone || '(未入力)'}`,
    `受取希望日：${body.preferredDate || '(未入力)'}`,
    `メッセージ：${body.message || '(なし)'}`,
    '',
    'スプレッドシートの「申込み」シートで対応状況を更新してください。',
  ].join('\n');

  MailApp.sendEmail(adminEmail, subject, body_);
}
