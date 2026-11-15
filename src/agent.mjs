import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lanIp, macAddress, pcIdPattern } from './report.mjs';
import { createPcReader } from './pc.mjs';
import { translate, translateIssue } from '../public/i18n.js';

const exec = promisify(execFile);
const cliLanguage = process.env.KWHTRACKER_LANG ?? process.env.WATTIZ_LANG;
const copy = value => translate(value, cliLanguage);
const configFile = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'agent.config.json';
const config = JSON.parse(readFileSync(resolve(configFile), 'utf8').replace(/^\uFEFF/, ''));
const remote = new URL(config.server);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(remote.hostname);
if (!(remote.protocol === 'https:' || (remote.protocol === 'http:' && loopback)) ||
    remote.username || remote.password || remote.pathname !== '/' || remote.search || remote.hash) {
  throw new Error(copy('server alanına bir HTTPS panel adresi veya yerel HTTP adresi gir.'));
}
const token = process.env.AGENT_TOKEN ?? '';
if (token.length < 32) throw new Error(copy('Sunucudaki AGENT_TOKEN değerini .env dosyasına gir.'));
const seconds = config.intervalSeconds ?? 60;
if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) throw new Error(copy('intervalSeconds 15–3600 aralığında olmalı.'));
const pc = config.pc;
if (pc && (process.platform !== 'win32' || typeof pc.name !== 'string' || !pc.name.trim() || pc.name.length > 100)) {
  throw new Error(copy('PC sensörleri için Windows ve geçerli bir cihaz adı gerekli.'));
}
const network = pc ? { mode: 'none' } : config.network ?? { mode: 'none' };
if (!['windows', 'openwrt', 'none'].includes(network.mode)) throw new Error(copy('network.mode windows, openwrt veya none olmalı.'));
if (network.mode === 'windows' && process.platform !== 'win32') throw new Error(copy('Windows ağ kaynağı Windows üzerinde çalışır.'));
if (network.mode === 'openwrt' && (!lanIp(network.host) || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(network.user ?? 'root'))) {
  throw new Error(copy('OpenWrt için yerel IPv4 adresi ve geçerli SSH kullanıcı adı gir.'));
}
const meters = pc ? [] : config.meters ?? [];
if (!Array.isArray(meters) || meters.length > 128 || meters.some(meter => !lanIp(meter?.ip) ||
    (meter.channel !== undefined && (!Number.isInteger(meter.channel) || meter.channel < 0 || meter.channel > 99)) ||
    (meter.deviceMac !== undefined && !macAddress(meter.deviceMac)) ||
    (meter.passwordEnv !== undefined && !/^[A-Z_][A-Z\d_]*$/.test(meter.passwordEnv)))) {
  throw new Error(copy('Sayaç IP adresi, kanal, deviceMac veya passwordEnv geçersiz.'));
}

const queuePath = resolve(config.queuePath ?? 'data/toplayici.sqlite');
mkdirSync(dirname(queuePath), { recursive: true });
const queue = new DatabaseSync(queuePath, { timeout: 5000 });
queue.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS queue(time INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT');
queue.exec('CREATE TABLE IF NOT EXISTS agent_state(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
queue.prepare("INSERT OR IGNORE INTO agent_state VALUES ('id', ?)").run(randomUUID());
const pcId = queue.prepare("SELECT value FROM agent_state WHERE key='id'").get().value;
const pcSession = randomUUID();
let activitySession = randomUUID();
let windowsBootAt = null;
const readPc = pc && createPcReader(pc, pcId);
const enqueue = queue.prepare('INSERT OR IGNORE INTO queue VALUES (?, ?)');
const pending = queue.prepare('SELECT time, payload FROM queue ORDER BY time LIMIT 250');
const remove = queue.prepare('DELETE FROM queue WHERE time=?');
const lastQueued = queue.prepare('SELECT MAX(time) AS time FROM queue');
const inventoryQueued = queue.prepare("SELECT 1 FROM agent_state WHERE key='inventory_v1'");
const markInventory = queue.prepare("INSERT OR IGNORE INTO agent_state VALUES ('inventory_v1', 'queued')");
let lastReport = lastQueued.get().time ?? 0;

async function readWindowsBoot() {
  if (windowsBootAt !== null) return windowsBootAt;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; ' +
    '([DateTimeOffset](Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeMilliseconds()'
  ], { windowsHide: true, timeout: 5000 }).catch(() => ({ stdout: '' }));
  const time = Number(stdout.trim());
  if (Number.isSafeInteger(time) && time >= Date.UTC(2000, 0, 1) && time <= Date.now()) windowsBootAt = time;
  return windowsBootAt;
}

async function readInventory() {
  const script = fileURLToPath(new URL('./inventory.ps1', import.meta.url));
  const command = Buffer.from(readFileSync(script, 'utf8'), 'utf16le').toString('base64');
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', command
  ], { windowsHide: true, timeout: 30_000 });
  const components = JSON.parse(stdout);
  if (!Array.isArray(components) || !components.length) throw new Error(copy('Donanım envanteri boş.'));
  if (Array.isArray(pc.hardware)) components.push(...pc.hardware);
  return { time: Date.now(), components };
}

async function windowsDevices() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; ' +
    '$indexes = @(Get-NetIPConfiguration | Where-Object IPv4DefaultGateway | Select-Object -ExpandProperty InterfaceIndex); ' +
    'if ($indexes.Count -eq 0) { "[]" } else { ' +
    'ConvertTo-Json -Compress -InputObject @(Get-NetNeighbor -InterfaceIndex $indexes -AddressFamily IPv4 | ' +
    'Where-Object { $_.State -in @("Reachable", "Stale", "Delay", "Probe") } | Select-Object IPAddress,LinkLayerAddress) }'
  ], { timeout: 20_000, windowsHide: true });
  return JSON.parse(stdout).flatMap(row => {
    const mac = macAddress(row.LinkLayerAddress);
    return mac && lanIp(row.IPAddress) ? [{ mac, ip: row.IPAddress, source: 'windows' }] : [];
  });
}

async function openWrtDevices() {
  const command = "set -e; objects=$(ubus list 'hostapd.*'); " +
    "for object in $objects; do ubus call \"$object\" get_clients; printf '\\n@@CLIENTS@@\\n'; done; " +
    "if [ -r /tmp/dhcp.leases ]; then cat /tmp/dhcp.leases; fi";
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5'];
  if (network.identityFile) args.push('-i', resolve(network.identityFile), '-o', 'IdentitiesOnly=yes');
  args.push((network.user ?? 'root') + '@' + network.host, command);
  const { stdout } = await exec('ssh', args, { timeout: 20_000, windowsHide: true });
  const chunks = stdout.replaceAll('\r\n', '\n').split('\n@@CLIENTS@@\n');
  const leases = new Map();
  for (const line of chunks.pop().trim().split(/\r?\n/)) {
    const [expires, rawMac, ip, name] = line.trim().split(/\s+/);
    const mac = macAddress(rawMac);
    if (mac && lanIp(ip) && (+expires === 0 || +expires > Date.now() / 1000)) {
      leases.set(mac, { ip, name: name && name !== '*' ? name : null });
    }
  }
  const devices = new Map();
  for (const chunk of chunks) {
    const { clients } = JSON.parse(chunk);
    if (!clients || typeof clients !== 'object') throw new Error('Wi-Fi istemci cevabı okunamadı.');
    for (const [rawMac, row] of Object.entries(clients)) {
      const mac = macAddress(rawMac);
      if (!mac || !(row.assoc === true || row.assoc === 1)) continue;
      devices.set(mac, { mac, ...leases.get(mac), source: 'openwrt', associated: true, signal: row.signal });
    }
  }
  return [...devices.values()];
}

function digestHeader(header, uri, password) {
  if (!header?.startsWith('Digest ')) throw new Error('Sayaç Digest kimlik doğrulaması bekleniyordu.');
  const fields = Object.fromEntries([...header.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)]
    .map(([, key, quoted, bare]) => [key.toLowerCase(), quoted ?? bare]));
  const { realm, nonce, algorithm, qop, opaque } = fields;
  if (algorithm?.toUpperCase() !== 'SHA-256' || !realm || !nonce || !qop?.split(',').map(value => value.trim()).includes('auth')) {
    throw new Error('Sayaç Digest doğrulaması desteklenmiyor.');
  }
  const hash = value => createHash('sha256').update(value).digest('hex');
  const cnonce = randomBytes(16).toString('hex');
  const nc = '00000001';
  const response = hash([hash('admin:' + realm + ':' + password), nonce, nc, cnonce, 'auth', hash('GET:' + uri)].join(':'));
  const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  return 'Digest username="admin", realm=' + quote(realm) + ', nonce=' + quote(nonce) +
    ', uri=' + quote(uri) + ', algorithm=SHA-256, qop=auth, nc=' + nc +
    ', cnonce=' + quote(cnonce) + ', response=' + quote(response) + (opaque ? ', opaque=' + quote(opaque) : '');
}

async function pollMeter(meter) {
  const address = 'http://' + meter.ip;
  const channel = meter.channel ?? 0;
  const uri = '/rpc/Switch.GetStatus?id=' + channel;
  const get = (path, headers) => fetch(address + path, { signal: AbortSignal.timeout(4000), redirect: 'error', headers });
  const info = await get('/shelly');
  if (!info.ok) throw new Error('Cihaz bilgisi alınamadı (HTTP ' + info.status + ').');
  const identity = await info.json();
  const mac = typeof identity.mac === 'string' ? macAddress(identity.mac.match(/.{1,2}/g)?.join(':')) : null;
  if (!mac || !Number.isInteger(identity.gen) || identity.gen < 2) throw new Error('Shelly Gen2+ cihazı bulunamadı.');
  let status = await get(uri);
  if (status.status === 401) {
    const password = meter.passwordEnv && process.env[meter.passwordEnv];
    if (!password) throw new Error('Sayaç şifresi için passwordEnv alanını ve .env dosyasını ayarla.');
    const auth = digestHeader(status.headers.get('www-authenticate'), uri, password);
    await status.body?.cancel();
    status = await get(uri, { Authorization: auth });
  }
  if (!status.ok) throw new Error('Ölçüm alınamadı (HTTP ' + status.status + ').');
  const data = await status.json();
  if (!Number.isFinite(data.aenergy?.total) || data.aenergy.total < 0 || data.aenergy.total > 1e12) {
    throw new Error('Bu kanalda birikimli enerji ölçümü bulunamadı.');
  }
  return { id: 'shelly:' + mac.replaceAll(':', '') + ':' + channel, ip: meter.ip, deviceMac: meter.deviceMac,
    name: meter.name ?? identity.name ?? (identity.app ?? 'Shelly') + ' / ' + channel,
    counterWh: data.aenergy.total, watts: data.apower };
}

async function collectNetwork(batch) {
  if (network.mode === 'none') return;
  try {
    batch.devices = await (network.mode === 'openwrt' ? openWrtDevices() : windowsDevices());
    batch.devices = [...new Map(batch.devices.map(item => [item.mac, item])).values()].slice(0, 1024);
    batch.complete.push(network.mode);
  } catch {
    batch.issues.push(network.mode === 'openwrt'
      ? 'OpenWrt listesi alınamadı. Yönlendirici adresini, SSH anahtarı ve bilinen sunucu kaydını kontrol et.'
      : 'Windows ağ listesi okunamadı. Bağlantıyı ve Get-NetNeighbor komutunu kontrol et.');
  }
}

async function sendPending() {
  const deadline = Date.now() + 3000;
  for (const { time, payload } of pending.all()) {
    const response = await fetch(new URL('/api/ingest', remote), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: payload, redirect: 'error', signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('Sunucu paketi kabul etmedi (HTTP ' + response.status + ').');
    await response.body?.cancel();
    remove.run(time);
    if (Date.now() >= deadline) return;
  }
}

async function cycle(requestId) {
  const now = Date.now();
  const batch = { time: now, interval: seconds, devices: [], meters: [], complete: [], issues: [] };
  if (requestId) batch.requestId = requestId;
  const settled = await Promise.allSettled([collectNetwork(batch), ...meters.map(pollMeter)]);
  const unique = new Map();
  for (const [i, result] of settled.slice(1).entries()) {
    if (result.status === 'fulfilled') unique.set(result.value.id, result.value);
    else batch.issues.push(meters[i].ip + ' • ' + result.reason.message);
  }
  batch.meters = [...unique.values()];
  if (readPc) {
    const [readings, bootAt] = await Promise.all([readPc(), readWindowsBoot()]);
    batch.pc = { id: pcId, name: pc.name, session: pcSession, activitySession, bootAt, ...readings };
    if (!batch.pc.readings.length) batch.issues.push('PC güç sensörü okunamadı. AIDA64 sensör paylaşımını kontrol et.');
    if (!inventoryQueued.get()) {
      try {
        batch.pc.inventory = await readInventory();
      } catch (error) {
        console.warn(copy('Donanım envanteri okunamadı') + ': ' + error.message);
      }
    }
  }
  if (now > lastReport) {
    queue.exec('BEGIN IMMEDIATE');
    try {
      const result = enqueue.run(now, JSON.stringify(batch));
      if (result.changes && batch.pc?.inventory) markInventory.run();
      queue.exec('COMMIT');
    } catch (error) {
      queue.exec('ROLLBACK');
      throw error;
    }
    lastReport = now;
  } else {
    console.error(copy('Sistem saati geri alındı. Son kayıt zamanına ulaşılana kadar yeni veriler bekletiliyor.'));
  }
  console.log(readPc ? batch.pc.readings.length + ' ' + copy('PC sensörü okundu.')
    : batch.devices.length + ' ' + copy('ağ cihazı') + ', ' + batch.meters.length + ' ' + copy('sayaç okundu.'));
  for (const issue of batch.issues) console.warn(translateIssue(issue, cliLanguage));
}

async function getRequest() {
  const response = await fetch(new URL('/api/agent/request', remote), {
    headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(2500)
  });
  if (!response.ok) throw new Error('Komut isteği başarısız (HTTP ' + response.status + ').');
  const { requestId } = await response.json();
  return typeof requestId === 'string' && pcIdPattern.test(requestId) ? requestId : null;
}

const once = process.argv.includes('--once');
let handled = null;
let nextSample = 0;
let previousError = null;
let expectedWake = Date.now();
do {
  // An unexpectedly long timer delay can occur when Windows suspends.
  if (Date.now() - expectedWake > 12_000) activitySession = randomUUID();
  let requested = null;
  let connectionError = null;
  try {
    requested = await getRequest();
  } catch (error) {
    connectionError = error.message;
  }
  const due = Date.now() >= nextSample;
  const newRequest = requested && requested !== handled ? requested : null;
  if (due || newRequest) {
    if (due) nextSample = Date.now() + seconds * 1000;
    await cycle(newRequest);
    if (newRequest) handled = newRequest;
  }
  try {
    await sendPending();
  } catch (error) {
    connectionError = error.message;
  }
  if (connectionError && connectionError !== previousError) {
    console.error(copy('Sunucuya erişim bekleniyor. Ölçümler yerel kuyrukta saklanıyor.') + ' ' + translateIssue(connectionError, cliLanguage));
  }
  previousError = connectionError;
  if (once && connectionError) process.exitCode = 1;
  if (!once) {
    const delay = Math.max(100, Math.min(4000, nextSample - Date.now()));
    expectedWake = Date.now() + delay;
    await wait(delay);
  }
} while (!once);
queue.close();
