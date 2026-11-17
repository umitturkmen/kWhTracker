import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const origin = 'https://panel.example.test';
const credentials = { user: 'operator', password: 'test-panel-password' };
const agentToken = 'test-collector-token-at-least-32-bytes';
const jsonPost = (body, headers) => ({ method: 'POST', headers, body: JSON.stringify(body) });
const cookie = response => response.headers.get('set-cookie')?.split(';')[0];

function authenticatorCode(key, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...key].map(letter => alphabet.indexOf(letter).toString(2).padStart(5, '0')).join('');
  const secret = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const value = (digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

test('panel sessions, Authenticator enrollment and replay protection', { timeout: 15_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'kwh-auth-'));
  const env = { ...process.env, PORT: '0', BIND_HOST: '127.0.0.1', PANEL_USER: credentials.user,
    PANEL_PASSWORD: credentials.password, AGENT_TOKEN: agentToken, PUBLIC_ORIGIN: origin,
    DB_PATH: join(folder, 'test.sqlite') };
  let child;
  let base;
  async function start() {
    child = spawn(process.execPath, ['src/server.mjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const output = createInterface({ input: child.stdout });
    const [url] = await once(output, 'line');
    base = url.split(' ').at(-1);
    output.close();
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    child.kill();
    await exit;
  }
  t.after(async () => {
    await stop();
    await rm(folder, { recursive: true, force: true });
  });
  const request = (path, options = {}) => fetch(base + path, {
    ...options, headers: { Origin: origin, 'Content-Type': 'application/json', ...options.headers }
  });
  const login = (fields = {}) => request('/api/login', jsonPost({ ...credentials, ...fields }));
  const privatePage = value => request('/api/dashboard', { headers: { Cookie: value } });
  await start();

  assert.match(await (await request('/cihaz/abc')).text(), /id="login-form"/);
  const basic = 'Basic ' + Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64');
  const denied = await request('/api/dashboard', { headers: { Authorization: basic } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.has('www-authenticate'), false);
  const crossSite = await request('/api/login', jsonPost(credentials, { Origin: 'https://other.example' }));
  assert.equal(crossSite.status, 403);
  assert.equal((await login({ password: 'wrong' })).status, 401);
  const regular = await login();
  assert.doesNotMatch(regular.headers.get('set-cookie'), /Max-Age/);
  const remembered = await login({ remember: true });
  assert.match(remembered.headers.get('set-cookie'), /^__Host-.*HttpOnly; SameSite=Lax; Secure; Max-Age=2592000$/);
  const previous = cookie(remembered);
  assert.equal((await privatePage(previous)).status, 200);
  const agent = await request('/api/agent/request', { headers: { Authorization: 'Bearer ' + agentToken } });
  assert.equal(agent.status, 200);
  const setup = input => request('/api/authenticator/setup', jsonPost(input, { Cookie: previous }));
  assert.equal((await setup({ password: 'wrong' })).status, 403);
  const { key } = await (await setup({ password: credentials.password })).json();
  assert.match(key, /^[A-Z2-7]{32}$/);

  // Stay away from a step boundary while sending the previous and current codes.
  if (Date.now() % 30_000 > 28_000) await delay(2200);
  const step = Math.floor(Date.now() / 30_000);
  const enabled = await request('/api/authenticator/enable', jsonPost({ code: authenticatorCode(key, step - 1) }, { Cookie: previous }));
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).enabled, true);
  assert.equal((await privatePage(previous)).status, 401);
  assert.equal((await privatePage(cookie(regular))).status, 401);
  const challenge = await login();
  assert.equal((await challenge.json()).needsCode, true);
  assert.equal(cookie(challenge), undefined);
  const code = authenticatorCode(key, step);
  const verified = await login({ code, remember: true });
  assert.equal(verified.status, 200);
  assert.equal((await login({ code })).status, 400);

  await stop();
  await start();
  const active = cookie(verified);
  assert.equal((await privatePage(active)).status, 200);
  assert.equal((await (await login()).json()).needsCode, true);
  assert.equal((await login({ code })).status, 400);
  const logout = await request('/api/logout', { method: 'POST', headers: { Cookie: active } });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await privatePage(active)).status, 401);
});
