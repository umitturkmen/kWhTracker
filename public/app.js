import { renderPc } from './pc-details.js';
import { renderActivity } from './activity.js';
import { setupAccount } from './account.js';
import { bucketLabel, dateFormat as localDate, language, locale, setupPreferences, t, translateIssue } from './i18n.js';

const $ = id => document.getElementById(id);
const captions = { day: 'Günlük', week: 'Haftalık', month: 'Aylık', year: 'Yıllık', all: 'Toplam' };
let date, clock, fullTime, number, energyNumber, integer, money;
const ns = 'http://www.w3.org/2000/svg';
const deviceId = location.pathname.split('/')[1] === 'cihaz' ? location.pathname.split('/')[2] : null;
let period = 'week';
let data = null;
let sequence = 0;
let requestId = null;
let requested = false;
let chartKey = '';
let tableKey = '';

const txt = (id, value) => { $(id).textContent = t(value); };
const kwh = value => value === null ? '—' : energyNumber.format(value) + ' kWh';
const watts = value => value === null ? '—' : number.format(value) + ' W';
const cost = value => value === null || data.tariff === null ? '—' : money.format(value * data.tariff);
function svg(tag, attrs = {}) {
  const element = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}
function icon(name) {
  const picture = svg('svg', { 'aria-hidden': 'true' });
  picture.append(svg('use', { href: '/icons.svg#' + name }));
  return picture;
}
function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
let noticeCopy = () => '';
function drawNotice() {
  const text = noticeCopy();
  $('notice').textContent = text;
  $('notice').hidden = !text;
}
function notice(message = '') {
  noticeCopy = typeof message === 'function' ? message : () => t(message);
  drawNotice();
}

async function api(url, options) {
  const response = await fetch(url, { ...options, headers: { ...options?.headers, 'Accept-Language': language } });
  if (!response.ok) {
    if (response.status === 401) location.reload();
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error ?? 'Sunucudan yanıt alınamadı.');
  }
  return response.json();
}
const renderAccount = setupAccount(api);

function getStatus(device) {
  if (device.source === 'pc') {
    return data.now - device.seen <= data.freshMs ? ['PC veri gönderiyor', true] : ['Son durum eski', false];
  }
  if (device.source === 'openwrt' && !device.associated) return ['Bağlı değil', false];
  if (device.source === 'openwrt' && data.now - device.seen <= data.freshMs) return ['Wi-Fi bağlı', true];
  if (device.meters.some(meter => meter.live)) return ['Sayaç erişilebilir', true];
  if (device.source === 'windows' && data.now - device.seen <= data.freshMs) return ['Önbellekte', false];
  return ['Son durum eski', false];
}

const title = device => (data.demo ? t(device.name) : device.name) ?? t(device.meters[0]?.name) ?? device.ip ?? device.mac ?? t('Cihaz');
function renderDetails(device) {
  const name = title(device);
  const pc = device.source === 'pc';
  document.title = name + ' | kWhTracker';
  $('page-title').textContent = name;
  $('device-back').hidden = false;
  $('date').hidden = true;
  $('device-page').hidden = false;
  $('cihazlar').hidden = true;
  $('export').disabled = !data.hasEnergy;
  const details = [
    ['Durum', t(getStatus(device)[0])], ['Cihaz türü', t(device.kind)],
    ['Son cihaz verisi', device.seen ? fullTime.format(device.seen) : null],
    [pc ? 'Son sensör okuması' : 'Son sayaç okuması', device.meters.length ? fullTime.format(Math.max(...device.meters.map(m => m.seen))) : null],
    ['Veri kaynağı', pc ? [...new Set(device.meters.map(meter => t(meter.sensor)))].filter(Boolean).join(' / ') || t('Windows toplayıcı')
      : t({ openwrt: 'OpenWrt', windows: 'Windows komşu önbelleği' }[device.source])]
  ];
  if (!pc) details.push(['IP adresi', device.ip], ['MAC adresi', device.mac],
    ['Wi-Fi sinyali', device.signal === null ? null : device.signal + ' dBm']);
  const resets = device.meters.reduce((sum, meter) => sum + meter.resets, 0);
  if (resets) details.push(['Sayaç sıfırlamaları', integer.format(resets)]);
  descriptionList('device-details', details);
  descriptionList('device-periods', Object.entries(data.summary).map(([key, amount]) =>
    [captions[key], [kwh(amount), cost(amount)].filter(value => value !== '—').join(' / ') || '—']));
  $('device-sensors').hidden = !device.meters.length;
  $('sensor-rows').replaceChildren(...device.meters.map(meter => {
    const row = document.createElement('div');
    row.className = 'sensor-row';
    const label = span('', t(meter.name));
    const source = document.createElement('small');
    source.textContent = [t(meter.sensor), fullTime.format(meter.seen)].filter(Boolean).join(' / ');
    label.append(source);
    row.append(label, span('amount', watts(meter.watts)), span('amount', kwh(meter.kwh)));
    return row;
  }));
  if (pc) {
    renderPc(device, data.now, data.freshMs);
    renderActivity(device.activity, data.activityPeriod, data.now);
  }
}

function descriptionList(id, details) {
  $(id).replaceChildren(...details.map(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = t(label);
    description.textContent = value ?? '—';
    row.append(term, description);
    return row;
  }));
}

function renderDevices() {
  if (!data) return;
  const search = $('search').value.trim().toLocaleLowerCase(locale());
  const rows = data.devices.filter(device => [title(device), device.ip, device.mac, t(device.kind)]
    .some(value => value?.toLocaleLowerCase(locale()).includes(search)))
    .sort((a, b) => (b.kwh ?? -1) - (a.kwh ?? -1) || title(a).localeCompare(title(b), locale()));
  const nextKey = JSON.stringify([language, rows, rows.map(getStatus), data.tariff, search, data.period]);
  if (tableKey === nextKey) return;
  tableKey = nextKey;
  const focused = document.activeElement?.dataset.deviceId;
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t(search ? 'Aramana uyan cihaz bulunamadı.' : 'Toplayıcı cihazları gördüğünde burada listelenecek.');
    $('devices').replaceChildren(empty);
    return;
  }
  $('devices').replaceChildren(...rows.map(device => {
    const row = document.createElement('a');
    row.className = 'device-row';
    row.href = '/cihaz/' + device.id;
    row.dataset.deviceId = device.id;
    row.setAttribute('aria-label', title(device) + ' ' + t('ayrıntıları'));
    const cell = span('device-cell');
    const symbol = span('device-icon');
    symbol.append(icon(device.kind === 'Ağ cihazı' ? 'wifi' : device.meters.length ? 'plug' : 'devices'));
    const name = span('device-name');
    const titleText = document.createElement('strong');
    const secondary = document.createElement('small');
    titleText.textContent = title(device);
    secondary.textContent = [t(device.kind), device.ip].filter(Boolean).join(' / ') || device.mac;
    name.append(titleText, secondary);
    cell.append(symbol, name);
    const [label, live] = getStatus(device);
    const status = span('device-status');
    status.append(span(live ? 'status-dot online' : 'status-dot'), span('', t(label)));
    row.append(cell, status, span('amount', watts(device.watts)), span('amount', kwh(device.kwh)), span('amount', cost(device.kwh)));
    return row;
  }));
  if (focused) [...$('devices').children].find(row => row.dataset.deviceId === focused)?.focus({ preventScroll: true });
}

function chartLabel(bucket) {
  if (data.period === 'day') return bucket.label;
  if (data.period === 'all' && /^\d{4}$/.test(bucket.label)) return bucket.label;
  return data.period === 'year' || data.period === 'all'
    ? localDate({ month: 'long', year: 'numeric' }).format(bucket.time) : date.format(bucket.time);
}

function renderChart() {
  if (!data) return;
  const chart = $('chart');
  const width = Math.floor(chart.getBoundingClientRect().width);
  const key = JSON.stringify([language, data.period, width, data.buckets]);
  if (key === chartKey || width < 120) return;
  chartKey = key;
  const focused = document.activeElement?.dataset?.bucket;
  txt('chart-focus', 'kWh');
  if (!data.buckets.some(bucket => bucket.kwh !== null)) {
    chart.replaceChildren();
    $('chart-empty').hidden = false;
    return;
  }
  $('chart-empty').hidden = true;
  const peak = Math.max(...data.buckets.map(bucket => bucket.kwh ?? 0), 0.0004);
  const unit = 10 ** Math.floor(Math.log10(peak / 4));
  const step = [1, 2, 2.5, 5, 10].map(n => n * unit).find(n => n >= peak / 4);
  const maximum = step * 4;
  const left = 49;
  const right = width - 8;
  const bottom = 190;
  const top = 10;
  const slot = (right - left) / data.buckets.length;
  const graph = svg('svg', { viewBox: '0 0 ' + width + ' 220', 'aria-label': t('Tüketim grafiği, kWh') });
  function label(x, y, content, anchor = 'middle') {
    const text = svg('text', { x, y, 'text-anchor': anchor, 'aria-hidden': 'true' });
    text.textContent = content;
    graph.append(text);
  }
  for (let i = 0; i <= 4; i++) {
    const y = bottom - (bottom - top) * i / 4;
    graph.append(svg('line', { x1: left, y1: y, x2: right, y2: y, class: 'grid' }));
    label(left - 8, y + 4, energyNumber.format(step * i), 'end');
  }
  const labelEvery = Math.max(1, Math.ceil(33 / slot));
  const barWidth = Math.min(64, slot * .64);
  for (const [index, bucket] of data.buckets.entries()) {
    const x = left + (index + .5) * slot;
    if (index % labelEvery === 0) label(x, 212, data.period === 'day' && labelEvery > 2
      ? bucket.label.slice(0, 2) : bucketLabel(bucket, data.period));
    if (bucket.kwh === null) continue;
    const value = chartLabel(bucket) + ' / ' + kwh(bucket.kwh);
    const group = svg('g', { class: bucket.kwh === peak ? 'bar peak' : 'bar', tabindex: 0,
      role: 'img', 'aria-label': value, 'data-bucket': bucket.time });
    const height = Math.max(2, (bottom - top) * bucket.kwh / maximum);
    group.append(svg('rect', { x: x - barWidth / 2, y: bottom - height, width: barWidth, height, rx: Math.min(4, barWidth / 3) }));
    const tooltip = svg('title');
    tooltip.textContent = value;
    group.append(tooltip);
    group.addEventListener('focus', () => txt('chart-focus', value));
    group.addEventListener('blur', () => txt('chart-focus', 'kWh'));
    group.addEventListener('pointerenter', () => txt('chart-focus', value));
    group.addEventListener('pointerleave', () => {
      if (document.activeElement !== group) txt('chart-focus', 'kWh');
    });
    graph.append(group);
  }
  chart.replaceChildren(graph);
  if (focused) [...graph.querySelectorAll('[data-bucket]')].find(el => el.dataset.bucket === focused)?.focus({ preventScroll: true });
}

function render() {
  $('account').hidden = data.demo;
  const prefix = t(captions[data.period]);
  const amount = data.summary[data.period];
  const pc = data.pcOnly || data.devices[0]?.source === 'pc';
  $('device-scope').hidden = !pc;
  const wifi = data.devices.filter(device => device.source === 'openwrt' && device.associated && data.now - device.seen <= data.freshMs).length;
  const cached = data.devices.filter(device => device.source === 'windows' && data.now - device.seen <= data.freshMs).length;
  const live = data.demo || (data.lastSeen && data.now - data.lastSeen <= data.freshMs);
  txt('date', localDate({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(data.now));
  $('demo').hidden = !data.demo;
  txt('collector-status', data.demo ? 'Örnek panel' : live ? 'Toplayıcı bağlı' : data.lastSeen ? 'Toplayıcı bekleniyor' : 'Toplayıcı kurulumu');
  txt('collector-time', data.lastSeen ? t('Son veri') + ' ' + clock.format(data.lastSeen) : 'Henüz veri alınmadı');
  $('collector-dot').classList.toggle('online', Boolean(live));
  txt('power', watts(data.watts));
  txt('power-caption', data.meterCount ? data.liveMeters + ' / ' + data.meterCount + ' ' + t(pc ? 'sensör güncel' : 'sayaç güncel')
    : pc ? 'PC sensörü bekleniyor' : 'Sayaç verisi bekleniyor');
  txt('energy-label', prefix + ' ' + t('tüketim'));
  txt('energy', kwh(amount));
  txt('energy-caption', data.hasEnergy ? (pc ? 'Sensörlerden hesaplanan' : 'Ölçülen tüketim') : 'Ölçüm bekleniyor');
  txt('chart-legend', pc ? 'Sensörlerden hesaplanan tüketim' : 'Ölçülen tüketim');
  txt('cost-label', prefix + ' ' + t('maliyet'));
  txt('cost', cost(amount));
  txt('cost-caption', data.tariff === null ? 'Tarife girilmedi' : money.format(data.tariff) + ' / kWh');
  const hasRouter = data.sources.includes('openwrt');
  const hasWindows = data.sources.includes('windows');
  txt('network-label', pc ? (deviceId ? 'Aktif sensörler' : 'Bilgisayarlar') : 'Ağdaki cihazlar');
  txt('network-count', pc ? integer.format(deviceId ? data.liveMeters : data.devices.length)
    : hasRouter || hasWindows ? integer.format(hasRouter ? wifi : cached) : '—');
  txt('network-caption', pc ? (deviceId ? 'Güncel güç verisi' : 'Kayıtlı Windows cihazı')
    : hasRouter ? 'Wi-Fi bağlantısı doğrulanan' : hasWindows ? 'Windows önbelleğinde görülen' : 'Ağ verisi bekleniyor');
  txt('device-caption', data.devices.length ? integer.format(data.devices.length) + ' ' + t('kayıtlı cihaz')
    : pc ? 'Windows toplayıcısı bağlandığında burada görünecek.' : 'Ağ ve enerji ölçüm kayıtları');
  const first = data.buckets[0];
  const last = data.buckets.at(-1);
  txt('range', !first ? '' : data.period === 'day' ? date.format(first.time)
    : data.period === 'year' ? localDate({ year: 'numeric' }).format(first.time)
    : data.period === 'month' ? localDate({ month: 'long', year: 'numeric' }).format(first.time)
    : chartLabel(first) + ' – ' + chartLabel(last));
  for (const button of $('periods').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === period));
  }
  $('issues').hidden = data.issues.length === 0;
  txt('issues', data.issues.map(translateIssue).join(' / '));
  if (requestId && data.refresh?.id === requestId && data.refresh.status !== 'pending') {
    const result = data.refresh;
    if (result.status === 'timeout') notice('Toplayıcı zamanında yanıt vermedi.');
    else if (result.meters === 0) notice('Toplayıcı yanıt verdi. Bu istekte enerji ölçümü alınamadı.');
    else notice(() => result.meters + ' ' + t(pc ? 'sensör okuması alındı.' : 'sayaç ölçümü alındı.') +
      (result.issues ? ' ' + t('Bazı kaynaklar yanıt vermedi.') : ''));
    requestId = null;
  } else if (requestId && data.refresh?.id !== requestId) {
    notice('Ölçüm isteği artık beklemiyor. Yeni bir ölçüm isteyebilirsin.');
    requestId = null;
  }
  $('refresh').disabled = data.demo || requested || data.refresh?.status === 'pending';
  if (data.demo) $('refresh').title = t('Canlı ölçüm için toplayıcıyı bağla');
  renderChart();
  if (deviceId) renderDetails(data.devices[0]);
  else renderDevices();
}

async function load() {
  const current = ++sequence;
  try {
    const query = new URLSearchParams({ period });
    if (deviceId) {
      query.set('device', deviceId);
      query.set('activity', $('activity-period').value);
    }
    const result = await api('/api/dashboard?' + query);
    if (current !== sequence) return;
    data = result;
    render();
  } catch (error) {
    if (current === sequence) notice(() => t('Panel güncellenemedi.') + ' ' + translateIssue(error.message));
  }
}

$('refresh').addEventListener('click', async () => {
  requested = true;
  $('refresh').disabled = true;
  notice('Toplayıcıdan yeni ölçüm bekleniyor…');
  try {
    const result = await api('/api/refresh', { method: 'POST' });
    requestId = result.id;
    data.refresh = result;
  } catch (error) {
    notice(() => translateIssue(error.message));
  } finally {
    requested = false;
    await load();
  }
});

$('periods').addEventListener('click', event => {
  const chosen = event.target.closest('button[data-period]');
  if (chosen && chosen.dataset.period !== period) {
    period = chosen.dataset.period;
    load();
  }
});

$('search').addEventListener('input', renderDevices);
$('activity-period').addEventListener('change', load);
$('export').addEventListener('click', () => {
  if (!data?.hasEnergy) return;
  const decimal = (value, digits) => language === 'tr' ? value.toFixed(digits).replace('.', ',') : value.toFixed(digits);
  const rows = data.buckets.filter(item => item.kwh !== null).map(item => [
    chartLabel(item), decimal(item.kwh, 6),
    data.tariff === null ? '' : decimal(item.kwh * data.tariff, 4)
  ].join(';'));
  const file = new Blob(['\uFEFF' + t('Zaman;kWh;Maliyet (TL)') + '\r\n' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = href;
  link.download = t('tuketim') + '-' + data.period + '.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
});
$('settings').addEventListener('click', () => {
  $('tariff').value = data?.tariff == null ? '' : String(data.tariff).replace('.', language === 'tr' ? ',' : '.');
  $('tariff-error').hidden = true;
  $('tariff-dialog').showModal();
});
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
$('tariff-form').addEventListener('submit', async event => {
  event.preventDefault();
  const value = $('tariff').value.trim();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    if (!/^\d+(?:[.,]\d+)?$/.test(value)) throw new Error('Geçerli bir fiyat gir.');
    await api('/api/tariff', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate: Number(value.replace(',', '.')) }) });
    $('tariff-dialog').close();
    await load();
  } catch (error) {
    $('tariff-error').dataset.message = error.message;
    txt('tariff-error', translateIssue(error.message));
    $('tariff-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
});

function navigation() {
  const active = deviceId ? '#cihazlar' : location.hash || '#genel';
  for (const link of document.querySelectorAll('nav a')) {
    if (link.hash === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', navigation);
navigation();
setupPreferences(() => {
  renderAccount();
  date = localDate({ day: 'numeric', month: 'long', year: 'numeric' });
  clock = localDate({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
  fullTime = localDate({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  number = new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 });
  energyNumber = new Intl.NumberFormat(locale(), { maximumFractionDigits: 4 });
  integer = new Intl.NumberFormat(locale());
  money = new Intl.NumberFormat(locale(), { style: 'currency', currency: 'TRY' });
  drawNotice();
  if (!$('tariff-error').hidden) txt('tariff-error', translateIssue($('tariff-error').dataset.message));
  if (data) render();
});
new ResizeObserver(renderChart).observe($('chart'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
let lastPoll = Date.now();
setInterval(() => {
  if (!document.hidden && (requestId || Date.now() - lastPoll >= 15_000)) {
    lastPoll = Date.now();
    load();
  }
}, 2000);
load();
