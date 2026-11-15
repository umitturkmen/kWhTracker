import { bucketLabel, dateFormat, language, t } from './i18n.js';

const $ = id => document.getElementById(id);
const spans = { day: 'Bugün', week: 'Bu hafta', month: 'Bu ay', year: 'Bu yıl', all: 'Toplam' };
const namespace = 'http://www.w3.org/2000/svg';
let currentKey = '';
let tick;

function node(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function svg(tag, attributes) {
  const element = document.createElementNS(namespace, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function duration(ms) {
  if (ms === null) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (ms > 0 && minutes === 0) return '< 1 ' + t('dk');
  const hours = Math.floor(minutes / 60);
  return (hours ? hours + ' ' + t('sa') + ' ' : '') + minutes % 60 + ' ' + t('dk');
}

function elapsedTime(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  return (hours ? hours + ' ' + t('sa') + ' ' : '') +
    Math.floor(total / 60) % 60 + ' ' + t('dk') + ' ' +
    String(total % 60).padStart(2, '0') + ' ' + t('sn');
}

function startCounter(session, hasBoot, now) {
  clearTimeout(tick);
  const syncedAt = performance.now();
  const time = dateFormat({ dateStyle: 'medium', timeStyle: 'short' });
  function update() {
    const current = now + performance.now() - syncedAt;
    const online = session && current <= session.expires;
    $('activity-live-label').textContent = t(hasBoot
      ? (online ? 'Windows açılışından beri' : 'Son bildirilen Windows süresi')
      : (session && !online ? 'Son takip oturumu' : 'Takip oturumu'));
    $('activity-live-state').textContent = session
      ? online ? t('Başlangıç') + ' · ' + time.format(session.start) : t('Toplayıcı çevrimdışı')
      : t('Toplayıcıdan ilk çalışma kaydı bekleniyor.');
    $('activity-live-value').textContent = session ? elapsedTime((online ? current : session.last) - session.start) : '—';
    if (online) tick = setTimeout(update, 1000);
  }
  update();
}

function chart(activity, period) {
  const graph = svg('svg', { viewBox: '0 0 600 90', role: 'img', 'aria-label': t(spans[period]) + ' · ' + t('açık kalma grafiği') });
  const inset = 20;
  const plotWidth = 600 - inset * 2;
  const axis = svg('line', { x1: inset, x2: 600 - inset, y1: 66, y2: 66, class: 'activity-rule' });
  graph.append(axis);
  const width = plotWidth / activity.buckets.length;
  const peak = Math.max(...activity.buckets.map(bucket => bucket.ms), 60_000);
  const labelEvery = Math.max(1, Math.ceil(activity.buckets.length / 8));
  const clock = dateFormat({ hour: '2-digit', minute: '2-digit' });
  for (const [index, bucket] of activity.buckets.entries()) {
    const left = inset + index * width;
    const caption = bucketLabel(bucket, period);
    if (bucket.ms > 0) {
      const interval = period === 'day' ? caption + '–' + clock.format(bucket.end) : caption;
      const height = Math.max(2, 57 * bucket.ms / peak);
      const bar = svg('rect', { x: left + width * .14, y: 66 - height, width: width * .72,
        height, rx: 3, tabindex: 0, role: 'img', 'aria-label': interval + ', ' + duration(bucket.ms) });
      const tip = svg('title', {});
      tip.textContent = interval + ' · ' + duration(bucket.ms);
      bar.append(tip);
      graph.append(bar);
    }
    if (index % labelEvery === 0) {
      const label = svg('text', { x: left + width / 2, y: 84, 'text-anchor': 'middle', 'aria-hidden': 'true' });
      label.textContent = caption;
      graph.append(label);
    }
  }
  return graph;
}

export function renderActivity(activity, period, now) {
  $('pc-activity').hidden = false;
  const session = activity?.boot ?? activity?.session;
  startCounter(session, Boolean(activity?.boot), now);
  const online = Boolean(session && now <= session.expires);
  const key = JSON.stringify([language, activity, period, online]);
  if (key === currentKey) return;
  currentKey = key;
  const day = dateFormat({ day: 'numeric', month: 'short', year: 'numeric' });
  const clock = dateFormat({ hour: '2-digit', minute: '2-digit' });
  $('activity-caption').textContent = activity
    ? t('Kayıt başlangıcı') + ' ' + day.format(activity.since) + ' · ' + (online ? t('Toplayıcı bağlı') : t('Son veri') + ' ' + day.format(activity.last) + ' ' + clock.format(activity.last))
    : t('Toplayıcıdan ilk çalışma kaydı bekleniyor.');
  $('activity-summary').replaceChildren(...Object.entries(spans).map(([id, label]) => {
    const item = node('div');
    item.append(node('dt', t(label)), node('dd', duration(activity?.summary[id] ?? null)));
    return item;
  }));
  $('activity-graph').replaceChildren(...(activity ? [chart(activity, period)] : []));
  const rows = (activity?.sessions ?? []).map(({ start, end }) => {
    const sameDay = day.format(start) === day.format(end);
    const item = node('li');
    item.append(node('span', day.format(start) + ' · ' + clock.format(start) + ' – ' +
      (sameDay ? '' : day.format(end) + ' ') + clock.format(end)), node('strong', duration(end - start)));
    return item;
  });
  $('activity-sessions').replaceChildren(...(rows.length ? rows : [node('li', t('Bu dönemde kayıt yok.'))]));
}
