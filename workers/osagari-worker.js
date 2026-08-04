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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!env.GAS_WEBAPP_URL || !env.SHARED_SECRET) {
      return jsonResponse({ error: 'サーバー設定エラー（環境変数未設定）' }, 500);
    }

    try {
      // 一覧・詳細はGAS（スプレッドシート読み込み）が絡み体感速度に直結するため、
      // Cloudflareエッジで短時間キャッシュしてGASの往復を省略する（データは頻繁には変わらない前提）
      if (url.pathname === '/osagari/api/items' && request.method === 'GET') {
        return withEdgeCache(request, ctx, 30, async () => {
          const res = await callGas(env, { method: 'GET', params: { action: 'items' } });
          return passThrough(res);
        });
      }

      if (url.pathname === '/osagari/api/item' && request.method === 'GET') {
        return withEdgeCache(request, ctx, 30, async () => {
          const id = url.searchParams.get('id');
          const res = await callGas(env, { method: 'GET', params: { action: 'item', id } });
          return passThrough(res);
        });
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

      if (url.pathname === '/osagari/api/register' && request.method === 'POST') {
        let payload;
        try {
          payload = await request.json();
        } catch {
          return jsonResponse({ error: '不正なリクエストです' }, 400);
        }
        payload.action = 'register';
        const res = await callGas(env, { method: 'POST', body: payload });
        return passThrough(res);
      }

      if (url.pathname === '/osagari/api/image' && request.method === 'GET') {
        return withEdgeCache(request, ctx, 86400, () => proxyImage(url.searchParams.get('src')));
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      return jsonResponse({ error: 'サーバーエラー: ' + err.message }, 500);
    }
  },
};

// Cloudflareのキャッシュ(Cache API)を明示的に使う。ヘッダーのCache-Control任せにせず
// 確実にエッジキャッシュさせ、GAS往復・Drive往復の回数を減らして体感速度を上げる。
// 注: tea-under.clubゾーンのBrowser Cache TTLが4時間固定(Free/Proプランのため「既存ヘッダーを尊重」を選べず、
// Page Ruleでの上書きも効果なし)のため、Cache HIT時のクライアント向けCache-Controlは実際には4時間として
// 扱われる。掲載状況の更新反映が最大4時間遅れうる点は許容のうえ運用する。
async function withEdgeCache(request, ctx, maxAgeSeconds, generate) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const response = await generate();
  if (response.status === 200) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
    const toCache = new Response(response.clone().body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }
  return response;
}

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

// 画像を同一オリジン（tea-under.club）経由で配信する中継。
// 広告ブロッカー・プライバシー系拡張機能がdrive.google.com等を直接ブロックするケースが
// 実際に確認されたため、ブラウザからは常にこのWorker経由でのみ画像を取得させる設計にした。
const IMAGE_ALLOWED_HOSTS = [
  'drive.google.com',
  'drive.usercontent.google.com',
  'v5.airtableusercontent.com',
];

async function proxyImage(src) {
  if (!src) return new Response('missing src', { status: 400 });

  let target;
  try {
    target = new URL(src);
  } catch {
    return new Response('invalid src', { status: 400 });
  }

  // SSRF対策：任意のURLを中継しないよう、許可したホストのみ通す
  if (!IMAGE_ALLOWED_HOSTS.includes(target.hostname)) {
    return new Response('host not allowed', { status: 400 });
  }

  const res = await fetch(target.toString(), { redirect: 'follow' });
  if (!res.ok) return new Response('image fetch failed', { status: 502 });

  const headers = new Headers();
  headers.set('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=86400'); // Cloudflareエッジで1日キャッシュ

  return new Response(res.body, { status: 200, headers });
}
