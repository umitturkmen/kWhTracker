import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { periods } from './calendar.mjs';
import { seedDemo } from './demo.mjs';
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

const store = openStore(demo ? ':memory:' : resolve(process.env.DB_PATH ?? 'data/cihaz-takip.sqlite'));
const demoTime = demo ? Date.now() : null;
if (demo) seedDemo(store, demoTime);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/pc-details.js', ['pc-details.js', 'text/javascript; charset=utf-8']],
  ['/activity.js', ['activity.js', 'text/javascript; charset=utf-8']],
  ['/preferences.js', ['preferences.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/icons.svg', ['icons.svg', 'image/svg+xml']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/instrument.woff2', ['instrument.woff2', 'font/woff2']],
  ['/instrument-ext.woff2', ['instrument-ext.woff2', 'font/woff2']]
].map(([path, [file, type]]) => [path, [type, readFileSync(new URL('../public/' + file, import.meta.url))]]));

function same(value, expected) {
  const digest = input => createHash('sha256').update(input).digest();
  return timingSafeEqual(digest(value), digest(expected));
}

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

const basic = 'Basic ' + Buffer.from(user + ':' + password, 'utf8').toString('base64');
const localOrigins = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port, origin]);
const failedAuth = new Map();
const failureWindow = 60_000;
function rejectAuth(request, response, reason, panel = false) {
  const forwarded = trustProxy ? request.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
  const address = forwarded && isIP(forwarded) ? forwarded : request.socket.remoteAddress;
  const now = Date.now();
  const entry = failedAuth.get(address);
  if (entry && now < entry.until && entry.count >= 20) {
    response.setHeader('Retry-After', Math.ceil((entry.until - now) / 1000));
    fail(429, 'Çok fazla kimlik doğrulama denemesi.');
  }
  if (!entry || now >= entry.until) {
    if (failedAuth.size >= 4096) failedAuth.delete(failedAuth.keys().next().value);
    failedAuth.set(address, { until: now + failureWindow, count: 1 });
  } else entry.count++;
  if (panel) response.setHeader('WWW-Authenticate', 'Basic realm="Cihaz Takip", charset="UTF-8"');
  fail(401, reason);
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
  if (origin?.startsWith('https://')) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
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
      if (!same(auth, 'Bearer ' + agentToken)) rejectAuth(request, response, 'Toplayıcı anahtarı geçersiz.');
      const pending = refreshState();
      return json(200, { requestId: pending?.status === 'pending' ? pending.id : null });
    }
    if (request.method === 'POST' && path === '/api/ingest' && !demo) {
      if (!same(auth, 'Bearer ' + agentToken)) rejectAuth(request, response, 'Toplayıcı anahtarı geçersiz.');
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
    if (!demo && !same(auth, basic)) {
      rejectAuth(request, response, 'Panel kullanıcı adı ve şifresi gerekli.', true);
    }
    const devicePage = path.match(/^\/cihaz\/([a-f0-9:-]+)$/);
    if (request.method === 'GET' && (assets.has(path) || devicePage)) {
      const [type, body] = assets.get(devicePage ? '/' : path);
      response.writeHead(200, { 'Content-Type': type });
      return response.end(body);
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
server.listen(port, host, () => console.log(`kWhTracker${demo ? ' (' + consoleCopy('örnek veriler') + ')' : ''} http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => store.close()));
}
