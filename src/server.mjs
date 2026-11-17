import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { periods } from './calendar.mjs';
import { seedDemo } from './demo.mjs';
import { same } from './panel-auth.mjs';
import { macAddress, pcIdPattern, report } from './report.mjs';
import { openStore } from './store.mjs';
import { translate } from '../public/i18n.js';

const demo = process.argv.includes('--demo');
const host = demo ? '127.0.0.1' : process.env.BIND_HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const user = process.env.PANEL_USER ?? 'admin';
const password = process.env.PANEL_PASSWORD ?? '';
const agentToken = process.env.AGENT_TOKEN ?? '';
const origin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
const freshMs = Number(process.env.STALE_AFTER_SECONDS ?? 180) * 1000;
const pcOnly = process.env.PC_ONLY === '1' && !demo;
const trustProxy = process.env.TRUST_PROXY === '1';
const cliLanguage = process.env.KWHTRACKER_LANG ?? process.env.WATTIZ_LANG;
const consoleCopy = value => translate(value, cliLanguage);

if (!demo && (password.length < 16 || agentToken.length < 32 || password === agentToken || user.includes(':'))) {
  throw new Error(consoleCopy('.env dosyasında farklı PANEL_PASSWORD (en az 16 karakter) ve AGENT_TOKEN (en az 32 karakter) tanımla.'));
}
if (!Number.isFinite(freshMs) || freshMs < 60_000) throw new Error(consoleCopy('STALE_AFTER_SECONDS en az 60 olmalı.'));

const secure = origin?.startsWith('https://');
const store = openStore(demo ? ':memory:' : resolve(process.env.DB_PATH ?? 'data/cihaz-takip.sqlite'),
  demo ? undefined : { user, password, secure });
const panel = store.panelAuth;
if (process.argv.includes('--reset-authenticator')) {
  if (!panel) throw new Error('The demo has no authenticator to reset.');
  panel.reset();
  store.close();
  console.log(consoleCopy('Google Authenticator sıfırlandı.'));
  process.exit(0);
}
const demoTime = demo ? Date.now() : null;
if (demo) seedDemo(store, demoTime);
const loginPage = readFileSync(new URL('../public/login.html', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/auth.css', ['auth.css', 'text/css; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/account.js', ['account.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/pc-details.js', ['pc-details.js', 'text/javascript; charset=utf-8']],
  ['/sensor-chart.js', ['sensor-chart.js', 'text/javascript; charset=utf-8']],
  ['/activity.js', ['activity.js', 'text/javascript; charset=utf-8']],
  ['/preferences.js', ['preferences.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/icons.svg', ['icons.svg', 'image/svg+xml']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/instrument.woff2', ['instrument.woff2', 'font/woff2']],
  ['/instrument-ext.woff2', ['instrument-ext.woff2', 'font/woff2']]
].map(([path, [file, type]]) => [path, [type, readFileSync(new URL('../public/' + file, import.meta.url))]]));
assets.set('/sensor-types.mjs', ['text/javascript; charset=utf-8', readFileSync(new URL('./sensor-types.mjs', import.meta.url))]);

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    fail(415, 'İstek JSON biçiminde olmalı.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256_000) fail(413, 'Veri paketi çok büyük.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(400, 'JSON verisi okunamadı.');
  }
}

const localOrigins = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port, origin]);
const failedAuth = new Map();
const failureWindow = 60_000;
const codeLimit = 'panel:authenticator';
const authenticatorActions = {
  '/api/authenticator/setup': 'startSetup',
  '/api/authenticator/enable': 'finishSetup',
  '/api/authenticator/disable': 'disable'
};
function addressOf(request) {
  const forwarded = trustProxy ? request.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
  return forwarded && isIP(forwarded) ? forwarded : request.socket.remoteAddress;
}
function checkLimit(key, limit, response) {
  const entry = failedAuth.get(key);
  const now = Date.now();
  if (entry && now < entry.until && entry.count >= limit) {
    response.setHeader('Retry-After', Math.ceil((entry.until - now) / 1000));
    fail(429, 'Çok fazla kimlik doğrulama denemesi. Bir dakika sonra tekrar dene.');
  }
}
function recordFailure(key) {
  const now = Date.now();
  const entry = failedAuth.get(key);
  if (!entry || now >= entry.until) {
    if (failedAuth.size >= 4096) {
      const keys = failedAuth.keys();
      const oldest = keys.next().value;
      failedAuth.delete(oldest === codeLimit ? keys.next().value : oldest);
    }
    failedAuth.set(key, { until: now + failureWindow, count: 1 });
  } else entry.count++;
}
function rejectAgent(request, response) {
  const key = 'agent:' + addressOf(request);
  checkLimit(key, 20, response);
  recordFailure(key);
  fail(401, 'Toplayıcı anahtarı geçersiz.');
}
let refresh = null;
function refreshState() {
  if (refresh?.status === 'pending' && Date.now() >= refresh.expires) refresh.status = 'timeout';
  return refresh;
}
function requireOrigin(request) {
  if (!request.headers.origin || !localOrigins.has(request.headers.origin)) fail(403, 'İstek panel adresinden gelmeli.');
}

const server = createServer(async (request, response) => {
  const requestLanguage = /^en(?:[-;,\s]|$)/i.test(request.headers['accept-language'] ?? '') ? 'en' : 'tr';
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
  const json = (status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const auth = request.headers.authorization ?? '';
    if (request.method === 'GET' && path === '/api/agent/request' && !demo) {
      if (!same(auth, 'Bearer ' + agentToken)) rejectAgent(request, response);
      const pending = refreshState();
      return json(200, { requestId: pending?.status === 'pending' ? pending.id : null });
    }
    if (request.method === 'POST' && path === '/api/ingest' && !demo) {
      if (!same(auth, 'Bearer ' + agentToken)) rejectAgent(request, response);
      const input = await readJson(request);
      let batch;
      try {
        batch = report(input);
        if (pcOnly && (!input.pc || input.devices.length || input.meters.length || input.complete.length)) {
          throw new Error('Bu panel PC sensör paketleri alır.');
        }
      } catch (error) {
        fail(400, error.message);
      }
      store.ingest(batch);
      const pending = refreshState();
      if (pending?.status === 'pending' && pending.id === input.requestId) {
        pending.status = 'done';
        pending.meters = batch.meters.length;
        pending.issues = batch.issues.length;
      }
      return json(200, { saved: true });
    }
    const devicePage = path.match(/^\/cihaz\/([a-f0-9:-]+)$/);
    if (request.method === 'GET' && (assets.has(path) || devicePage)) {
      const [type, body] = assets.get(devicePage ? '/' : path);
      response.writeHead(200, { 'Content-Type': type });
      return response.end((path === '/' || devicePage) && panel && !panel.session(request) ? loginPage : body);
    }
    if (panel && request.method === 'POST' && path === '/api/login') {
      requireOrigin(request);
      const body = await readJson(request);
      const key = 'panel:' + addressOf(request);
      checkLimit(key, 10, response);
      if (body?.code) checkLimit(codeLimit, 10, response);
      const result = panel.login(request, body);
      if (result.error) {
        recordFailure(key);
        if (result.error === 'code') recordFailure(codeLimit);
        fail(result.error === 'code' ? 400 : 401, result.error === 'code'
          ? 'Kod geçersiz veya daha önce kullanılmış. Yeni kodu dene.' : 'Kullanıcı adı veya parola hatalı.');
      }
      if (result.needsCode) return json(200, { needsCode: true });
      response.setHeader('Set-Cookie', result.cookie);
      return json(200, { signedIn: true });
    }
    if (panel && request.method === 'POST' && path === '/api/logout') {
      requireOrigin(request);
      response.setHeader('Set-Cookie', panel.logout(panel.session(request)));
      return json(200, { signedOut: true });
    }
    if (panel && !panel.session(request)) fail(401, 'Oturumun sona erdi. Tekrar giriş yap.');
    if (panel && request.method === 'GET' && path === '/api/authenticator') {
      return json(200, { enabled: panel.enabled() });
    }
    if (panel && request.method === 'POST' && Object.hasOwn(authenticatorActions, path)) {
      requireOrigin(request);
      const body = await readJson(request);
      const current = panel.session(request);
      if (!current) fail(401, 'Oturumun sona erdi. Tekrar giriş yap.');
      const key = 'panel:' + addressOf(request);
      checkLimit(key, 10, response);
      if (path !== '/api/authenticator/setup') checkLimit(codeLimit, 10, response);
      const result = panel[authenticatorActions[path]](current, body);
      if (result.error === 'password') {
        recordFailure(key);
        fail(403, 'Parola hatalı.');
      }
      if (result.error === 'code') {
        recordFailure(key);
        recordFailure(codeLimit);
        fail(400, 'Kod geçersiz veya daha önce kullanılmış. Yeni kodu dene.');
      }
      if (result.error === 'enabled') fail(409, 'Google Authenticator zaten etkin.');
      if (result.error === 'expired') fail(409, 'Kurulum süresi doldu. Yeni bir kurulum anahtarı oluştur.');
      if (result.cookie) {
        response.setHeader('Set-Cookie', result.cookie);
        return json(200, { enabled: panel.enabled() });
      }
      return json(200, result);
    }
    if (request.method === 'GET' && path === '/api/dashboard') {
      const period = url.searchParams.get('period') ?? 'week';
      if (!periods.includes(period)) fail(400, 'Dönem geçersiz.');
      const id = url.searchParams.get('device');
      if (id !== null && !pcIdPattern.test(id) && macAddress(id) !== id) fail(400, 'Cihaz kimliği geçersiz.');
      const activityPeriod = url.searchParams.get('activity') ?? 'day';
      if (!periods.includes(activityPeriod)) fail(400, 'Çalışma süresi dönemi geçersiz.');
      const dashboard = store.dashboard(period, demoTime ?? Date.now(), freshMs, id, activityPeriod);
      if (id && !dashboard.devices.length) fail(404, 'Cihaz bulunamadı.');
      return json(200, { ...dashboard, demo, pcOnly, activityPeriod, refresh: refreshState() });
    }
    if (request.method === 'POST' && path === '/api/refresh') {
      requireOrigin(request);
      if (demo) fail(409, 'Örnek verilerde canlı ölçüm kaynağı yok.');
      if (refreshState()?.status !== 'pending') {
        refresh = { id: randomUUID(), status: 'pending', expires: Date.now() + 65_000 };
      }
      return json(202, refresh);
    }
    if (request.method === 'PUT' && path === '/api/tariff') {
      requireOrigin(request);
      const body = await readJson(request);
      const rate = body?.rate;
      if (!Number.isFinite(rate) || rate <= 0 || rate > 10_000) fail(400, '0 ile 10.000 arasında pozitif bir fiyat gir.');
      store.setTariff(rate);
      return json(200, { rate });
    }
    fail(404, 'Sayfa bulunamadı.');
  } catch (error) {
    if (!error.status) console.error(error);
    if (!response.headersSent && !response.destroyed) {
      const message = error.status ? error.message : 'Sunucu işlemi tamamlayamadı.';
      json(error.status ?? 500, { error: message, message: translate(message, requestLanguage) });
    }
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => console.log(`kWhTracker${demo ? ' (' + consoleCopy('örnek veriler') + ')' : ''} http://${host}:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => store.close()));
}
