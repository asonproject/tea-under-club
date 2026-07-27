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

const ITEM_HEADERS = ['表示', '商品ID', '商品名', '分類', '画像URL', 'サイズ', '地域', '状態', '受渡方法', '掲載状況', '説明文', '更新日時'];
const PROVIDER_HEADERS = ['商品ID', '提供者名', '住所', '電話番号', 'メールアドレス', '同意確認'];
const APPLICATION_HEADERS = ['申込ID', '商品ID', '申込者名', 'メールアドレス', '電話番号', 'メッセージ', '受取希望日', '対応状況', '申込日時'];
const STATUS_OPTIONS = ['受付中', '要確認', '終了'];

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
  ensureVisibilityCheckboxes_();
  ensureStatusDropdown_();

  ['シート1', 'Sheet1'].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() === 0) ss.deleteSheet(sheet);
  });
}

/**
 * 既存の`公開商品`シートに「表示」チェックボックス列を追加する移行用関数。
 * 一度だけ実行する。列Aに「表示」列を新設し、それまでの「掲載状況」（受付中/掲載終了/非公開）
 * から初期状態（受付中→チェック済み、それ以外→チェックなし）を復元する。
 * 既に「表示」列がある場合は何もしない（再実行しても安全）。
 */
function addVisibilityColumn() {
  const sheet = getSheet(SHEET_ITEMS);
  if (sheet.getRange(1, 1).getValue() === '表示') {
    Logger.log('既に表示列があります。スキップしました。');
    return;
  }

  const lastRow = sheet.getLastRow();
  const OLD_STATUS_COL = 9; // 移行前（表示列追加前）の「掲載状況」列
  const statuses = lastRow > 1
    ? sheet.getRange(2, OLD_STATUS_COL, lastRow - 1, 1).getValues().map(r => r[0])
    : [];

  sheet.insertColumnBefore(1);
  sheet.getRange(1, 1).setValue('表示');

  if (lastRow > 1) {
    const range = sheet.getRange(2, 1, lastRow - 1, 1);
    range.insertCheckboxes();
    range.setValues(statuses.map(s => [s !== '掲載終了' && s !== '非公開']));
  }

  ensureVisibilityCheckboxes_();
  Logger.log('表示列を追加しました。');
}

/**
 * 「表示」列（列A）に、今後追加される行も含めて広めにチェックボックスの検証を適用する。
 * 列Aのヘッダーが「表示」になっている場合のみ動作する（未移行の古いシート構成には触れない安全策）。
 */
function ensureVisibilityCheckboxes_() {
  const sheet = getSheet(SHEET_ITEMS);
  if (sheet.getRange(1, 1).getValue() !== '表示') return;
  sheet.getRange(2, 1, 999, 1).insertCheckboxes();
}

/**
 * 「掲載状況」列をプルダウン選択制（受付中／要確認／終了）にする。
 * 列の位置はヘッダー行から実際に探すため、列順が変わっても安全に動作する。
 * 既存データの旧表記「掲載終了」は新しい選択肢「終了」に統一する。
 * 何度実行しても安全（冪等）。
 */
function ensureStatusDropdown_() {
  const sheet = getSheet(SHEET_ITEMS);
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const statusCol = headerRow.indexOf('掲載状況') + 1; // 1-indexed。見つからなければ0+1=1にはならず0のままなので下でガード
  if (statusCol === 0) return;

  const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build();
  sheet.getRange(2, statusCol, 999, 1).setDataValidation(rule);

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const range = sheet.getRange(2, statusCol, lastRow - 1, 1);
    const values = range.getValues();
    range.setValues(values.map(r => [r[0] === '掲載終了' ? '終了' : r[0]]));
  }
}

/**
 * 移行用に単独実行できる版（setupSheetsからも呼ばれるが、既存シートに対して
 * すぐ反映したい場合はApps Scriptエディタでこの関数を直接実行してもよい）。
 */
function setupStatusDropdown() {
  ensureStatusDropdown_();
  Logger.log('掲載状況のプルダウンを設定しました。');
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

function sheetToObjects(sheet) {
  // ヘッダーは定数(ITEM_HEADERS等)ではなく、シート実物の1行目から読む。
  // 列の並びが移行作業等でずれても、読み取り側は自動的に追従する。
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const rows = values.slice(1);
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
  const items = sheetToObjects(sheet);
  // 「表示」チェックボックスがオンのものだけを一覧・詳細に出す
  return items.filter(item => item['表示'] === true);
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

// ===== Airtable「おさがりシェアリング」ベースからの一括インポート =====

const AIRTABLE_BASE_ID = 'app3Secv8jeKN6wdC';
const AIRTABLE_TABLE_ID = 'tbledL9o9tif2ZUiv'; // BaaKeeテーブル
const AIRTABLE_ADDRESS_PLACEHOLDER = '提供先の住所を教えてください。';

const AIRTABLE_FIELD = {
  name: '名前',
  category: '種類',
  image: '画像',
  size: 'サイズ',
  region: 'どこからあげますか？',
  duration: 'いつまで猶予がありますか？',
  target: '誰にあげたいですか？',
  channel: '分類',
  price: '値段',
  message: 'メッセージ',
  providerName: 'お名前',
  providerAddress: 'ご住所',
  providerPhone: '連絡先',
  providerEmail: 'Email',
  consent: '同意確認',
};

/**
 * Airtableの26件を一括インポートする。Apps Scriptエディタの関数選択で
 * importFromAirtable を選び実行する。商品ID（at-<AirtableレコードID>）で
 * 重複判定するため、何度実行しても取り込み済みの行は増えない。
 * 事前に スクリプトプロパティ AIRTABLE_TOKEN の設定が必要（gas/README.md参照）。
 */
function importFromAirtable() {
  const token = PropertiesService.getScriptProperties().getProperty('AIRTABLE_TOKEN');
  if (!token) throw new Error('スクリプトプロパティ AIRTABLE_TOKEN が未設定です');

  const records = fetchAllAirtableRecords_(token);
  const itemsSheet = getSheet(SHEET_ITEMS);
  const providersSheet = getSheet(SHEET_PROVIDERS);
  const existingIds = new Set(sheetToObjects(itemsSheet).map(i => String(i['商品ID'])));

  let imported = 0;
  let skipped = 0;

  records.forEach(record => {
    const f = record.fields;
    const itemId = 'at-' + record.id;
    if (existingIds.has(itemId) || !f[AIRTABLE_FIELD.name]) { skipped++; return; }

    const durationName = pickName_(f[AIRTABLE_FIELD.duration]);
    const status = durationName === '終了' ? '終了' : '受付中';

    const priceName = pickName_(f[AIRTABLE_FIELD.price]);
    const priceText = priceName ? (priceName === 'あげます' ? '無料でお譲りします。' : `価格：${priceName}`) : '';
    const targetNames = pickNames_(f[AIRTABLE_FIELD.target]);
    const targetText = targetNames.length ? `対象：${targetNames.join('・')}` : '';
    const description = [f[AIRTABLE_FIELD.message] || '', priceText, targetText].filter(Boolean).join('\n');

    const imageUrl = importFirstAttachmentToDrive_(f[AIRTABLE_FIELD.image], itemId);

    itemsSheet.appendRow([
      status !== '終了', // 表示
      itemId,
      f[AIRTABLE_FIELD.name],
      pickName_(f[AIRTABLE_FIELD.category]),
      imageUrl,
      f[AIRTABLE_FIELD.size] || '',
      pickName_(f[AIRTABLE_FIELD.region]),
      '',
      pickName_(f[AIRTABLE_FIELD.channel]),
      status,
      description,
      new Date(),
    ]);

    const address = f[AIRTABLE_FIELD.providerAddress];
    providersSheet.appendRow([
      itemId,
      f[AIRTABLE_FIELD.providerName] || '',
      address === AIRTABLE_ADDRESS_PLACEHOLDER ? '' : (address || ''),
      f[AIRTABLE_FIELD.providerPhone] || '',
      f[AIRTABLE_FIELD.providerEmail] || '',
      !!f[AIRTABLE_FIELD.consent],
    ]);

    imported++;
  });

  Logger.log(`インポート完了: 新規${imported}件、スキップ${skipped}件`);
}

function pickName_(value) {
  return (value && value.name) || '';
}

function pickNames_(values) {
  if (!values || !values.length) return [];
  return values.map(v => v.name).filter(Boolean);
}

function fetchAllAirtableRecords_(token) {
  let records = [];
  let offset = null;
  do {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}` + (offset ? `?offset=${offset}` : '');
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    const json = JSON.parse(res.getContentText());
    if (json.error) throw new Error('Airtable APIエラー: ' + JSON.stringify(json.error));
    records = records.concat(json.records || []);
    offset = json.offset;
  } while (offset);
  return records;
}

function importFirstAttachmentToDrive_(attachments, itemId) {
  if (!attachments || !attachments.length) return '';
  const att = attachments[0];
  try {
    const response = UrlFetchApp.fetch(att.url, { muteHttpExceptions: true });
    const blob = response.getBlob().setName(itemId + '-' + (att.filename || 'image'));
    const file = DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return `https://drive.google.com/uc?export=view&id=${file.getId()}`;
  } catch (err) {
    Logger.log(`画像取り込み失敗（${itemId}）: ${err.message}`);
    return '';
  }
}
