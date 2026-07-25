/**
 * おさがりシェアリング機能 - Cloudflare Workers 中継
 *
 * ブラウザ（/osagari/配下、Cloudflare Accessで会員限定）→ このWorker（/osagari/api/*）→ GAS Web App
 * GASのURLとSHARED_SECRETはこのWorkerの環境変数（wrangler secret）にのみ置き、ブラウザには一切渡さない。
 *
 * 環境変数（wrangler secret put で設定）:
 *   GAS_WEBAPP_URL : GASのWeb App デプロイURL
 *   SHARED_SECRET  : GAS側スクリプトプロパティと同じ値
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.GAS_WEBAPP_URL || !env.SHARED_SECRET) {
      return jsonResponse({ error: 'サーバー設定エラー（環境変数未設定）' }, 500);
    }

    try {
      if (url.pathname === '/osagari/api/items' && request.method === 'GET') {
        const res = await callGas(env, { method: 'GET', params: { action: 'items' } });
        return passThrough(res);
      }

      if (url.pathname === '/osagari/api/item' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const res = await callGas(env, { method: 'GET', params: { action: 'item', id } });
        return passThrough(res);
      }

      if (url.pathname === '/osagari/api/apply' && request.method === 'POST') {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return jsonResponse({ error: '不正なリクエストです' }, 400);
        }
        payload.action = 'apply';
        const res = await callGas(env, { method: 'POST', body: payload });
        return passThrough(res);
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'サーバーエラー: ' + err.message }, 500);
    }
  },
};

async function callGas(env, { method, params, body }) {
  const target = new URL(env.GAS_WEBAPP_URL);
  target.searchParams.set('key', env.SHARED_SECRET);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) target.searchParams.set(k, v);
    }
  }

  const init = { method, redirect: 'manual' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let res = await fetch(target.toString(), init);

  // GASは302で script.googleusercontent.com へリダイレクトする。
  // このリダイレクト先は「doPost/doGetの処理結果を取得するだけの場所」で、
  // 元のリクエストがPOSTでも常にGET・bodyなしでアクセスする必要がある
  // （POSTのまま再送信すると「ページが見つかりません」というDriveの汎用エラーになる）。
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('Location');
    if (location) res = await fetch(location, { method: 'GET', redirect: 'follow' });
  }
  return res;
}

async function passThrough(res) {
  const text = await res.text();
  let status = res.status;
  try {
    // GASのContentServiceは常にHTTP 200を返すため、実際のstatusはJSON本文に埋め込まれている
    const parsed = JSON.parse(text);
    if (typeof parsed.status === 'number') status = parsed.status;
  } catch {
    // JSON以外のレスポンスならGASの生ステータスをそのまま使う
  }
  return new Response(text, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
