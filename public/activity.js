import { bucketLabel, dateFormat, language, t } from './i18n.js';

const $ = id => document.getElementById(id);
const spans = { day: 'Bugün', week: 'Bu hafta', month: 'Bu ay', year: 'Bu yıl', all: 'Toplam' };
const namespace = 'http://www.w3.org/2000/svg';
let currentKey = '';

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

function chart(activity, period) {
  const graph = svg('svg', { viewBox: '0 0 600 90', role: 'img', 'aria-label': t(spans[period]) + ' · ' + t('açık kalma grafiği') });
  const inset = 20;
  const plotWidth = 600 - inset * 2;
  const axis = svg('line', { x1: inset, x2: 600 - inset, y1: 66, y2: 66, class: 'activity-rule' });
  graph.append(axis);
  const width = plotWidth / activity.buckets.length;
  const peak = Math.max(...activity.buckets.map(bucket => bucket.ms), 60_000);
  const labelEvery = Math.max(1, Math.ceil(activity.buckets.length / 8));
  for (const [index, bucket] of activity.buckets.entries()) {
    const left = inset + index * width;
    const caption = bucketLabel(bucket, period);
    if (bucket.ms > 0) {
      const height = Math.max(2, 57 * bucket.ms / peak);
      const bar = svg('rect', { x: left + width * .14, y: 66 - height, width: width * .72,
        height, rx: 3, tabindex: 0, role: 'img', 'aria-label': caption + ', ' + duration(bucket.ms) });
      const tip = svg('title', {});
      tip.textContent = caption + ' · ' + duration(bucket.ms);
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

export function renderActivity(activity, period, freshMs, now) {
  $('pc-activity').hidden = false;
  const online = Boolean(activity && now - activity.last <= freshMs);
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
