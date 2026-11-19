// Cloudflare Worker behind the app's status notification: keeps the list of subscribed devices and
// nudges each of them on a schedule. A nudge carries nothing; the app's service worker loads the
// schedule on the phone and shows the status itself.

// Only addresses of the browsers' own push services are accepted, so the endpoint cannot be used to
// make this worker call arbitrary hosts.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.push\.apple\.com$/,
                    /\.notify\.windows\.com$/];
const MAX_SUBSCRIPTIONS = 500;
// The free plan allows 50 outgoing requests per run; a longer list is nudged in turns, one batch
// per run. PERIOD_MS is the cron period in wrangler.toml: the turn must advance by one each run.
const BATCH = 45;
const PERIOD_MS = 5 * 60e3;
// A nudge the device has not fetched within TTL is dropped, and a newer one under the same topic
// replaces it, so a phone that was asleep wakes up to a single nudge.
const TTL = 15 * 60;
const TOPIC = 'status';

const bytes = base64url => Uint8Array.from(atob(base64url.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const base64url = data => btoa(String.fromCharCode(...new Uint8Array(data)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const text = string => new TextEncoder().encode(string);

function pushEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && value.length <= 1000 && PUSH_HOSTS.some(host => host.test(url.hostname)) ? url.href : null;
  } catch {
    return null;
  }
}

const forget = (env, endpoint) => env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(endpoint).run();

// Adds the device in the request to the list or, on the unsubscribe route, removes it; returns the HTTP status.
async function register(request, env, remove) {
  const endpoint = pushEndpoint((await request.json().catch(() => ({}))).endpoint);
  if (!endpoint) return 400;
  if (remove) {
    await forget(env, endpoint);
    return 204;
  }
  // A device already on the list is welcome back even when the list is full.
  if (await env.DB.prepare('SELECT 1 FROM subscriptions WHERE endpoint = ?').bind(endpoint).first()) return 204;
  const {total} = await env.DB.prepare('SELECT COUNT(*) AS total FROM subscriptions').first();
  if (total >= MAX_SUBSCRIPTIONS) return 507;
  await env.DB.prepare('INSERT OR IGNORE INTO subscriptions (endpoint) VALUES (?)').bind(endpoint).run();
  return 204;
}

// The Authorization header that proves to a push service the nudge comes from the app's key holder.
async function vapid(env, audience) {
  const point = bytes(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY.trim(),
    x: base64url(point.slice(1, 33)), y: base64url(point.slice(33, 65)),
  }, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
  const claims = {aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.CONTACT};
  const unsigned = `${base64url(text(JSON.stringify({typ: 'JWT', alg: 'ES256'})))}.${base64url(text(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, text(unsigned));
  return `vapid t=${unsigned}.${base64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function nudge(env) {
  const {results} = await env.DB.prepare('SELECT endpoint FROM subscriptions ORDER BY endpoint').all();
  const turn = Math.floor(Date.now() / PERIOD_MS) % Math.max(1, Math.ceil(results.length / BATCH));
  const headers = new Map();
  const outcomes = await Promise.all(results.slice(turn * BATCH, (turn + 1) * BATCH).map(async ({endpoint}) => {
    const audience = new URL(endpoint).origin;
    if (!headers.has(audience)) headers.set(audience, vapid(env, audience));
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {Authorization: await headers.get(audience), TTL: String(TTL), Topic: TOPIC},
      });
      // The push service no longer knows the device: the app was removed or its data cleared.
      if (response.status === 404 || response.status === 410) {
        await forget(env, endpoint);
        return 'expired';
      }
      return response.ok ? 'sent' : `refused ${response.status}`;
    } catch (e) {
      return `failed ${e.message}`;
    }
  }));
  const tally = {};
  for (const outcome of outcomes) tally[outcome] = (tally[outcome] ?? 0) + 1;
  console.log(`subscriptions ${results.length}:`, JSON.stringify(tally));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (!env.ALLOWED_ORIGINS.split(',').includes(origin)) return new Response(null, {status: 403});
    const cors = {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400', Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    const path = new URL(request.url).pathname;
    const known = request.method === 'POST' && ['/subscribe', '/unsubscribe'].includes(path);
    return new Response(null, {status: known ? await register(request, env, path === '/unsubscribe') : 404, headers: cors});
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(nudge(env));
  },
};
