import { trendCharts, trendValue } from './sensor-types.mjs';
import { dateFormat, language, locale, t } from './i18n.js';

const section = document.getElementById('pc-trends');
const controls = document.getElementById('trend-range');
const svgNs = 'http://www.w3.org/2000/svg';
const hour = 3_600_000;
const minute = 60_000;
const plot = { width: 320, height: 118, left: 6, right: 314, top: 10, bottom: 108 };
const selections = new Map();
const expanded = new Set();
let range = 6;
let view;
let changeKey;

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function svg(tag, attributes) {
  const item = document.createElementNS(svgNs, tag);
  for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
  return item;
}

function nearest(samples, time) {
  let start = 0;
  let end = samples.length - 1;
  while (start < end) {
    const mid = Math.floor((start + end) / 2);
    if (samples[mid].time < time) start = mid + 1;
    else end = mid;
  }
  return start > 0 && time - samples[start - 1].time < samples[start].time - time ? start - 1 : start;
}

function statistics(values) {
  if (!values.length) return null;
  return { minimum: Math.min(...values), maximum: Math.max(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length };
}

function statisticsTable(rows, formatValue, caption) {
  const table = el('table', 'trend-statistics');
  table.append(el('caption', 'sr-only', caption));
  const head = el('tr');
  for (const column of ['Sensör', 'En düşük', 'En yüksek', 'Ortalama']) {
    const cell = el('th', '', t(column));
    cell.scope = 'col';
    head.append(cell);
  }
  table.createTHead().append(head);
  const body = table.createTBody();
  for (const [name, stats] of rows) {
    const row = body.insertRow();
    const label = el('th', '', name);
    label.scope = 'row';
    row.append(label);
    for (const key of ['minimum', 'maximum', 'average']) {
      row.append(el('td', '', formatValue(stats?.[key])));
    }
  }
  return table;
}

function chart(definition, samples, start, end, freshMs, lifetime) {
  const { id, title, unit, series } = definition;
  const caption = t(title);
  const card = el('article', 'trend-card');
  card.append(el('h3', '', caption));
  const formatter = new Intl.NumberFormat(locale(), { maximumFractionDigits: 2, style: 'decimal' });
  const formatValue = value => Number.isFinite(value) ? formatter.format(value) + ' ' + unit : '—';
  const tracks = series.map(([name, keys]) => ({ name, points: samples.map(sample => trendValue(sample.values, keys)) }));
  const values = tracks.map(track => track.points.filter(Number.isFinite));
  const available = samples.filter((_, index) => tracks.some(track => Number.isFinite(track.points[index])));
  const rangeTable = statisticsTable(tracks.map(({ name }, index) => [name, statistics(values[index])]), formatValue, t('Seçili aralık istatistikleri'));
  const cumulative = series.map(([name]) => [name, lifetime?.[id + ':' + name]]);
  const chartDetail = el('div', 'trend-readout');

  if (available.length) {
    const legend = el('div', 'trend-legend');
    tracks.forEach(({ name }, index) => legend.append(el('span', 'trend-tag trend-' + index, name)));
    card.append(legend);
    const min = Math.min(0, ...values.flat());
    const max = unit === '%' ? Math.max(100, ...values.flat()) : Math.max(10, ...values.flat()) * 1.10;
    const x = time => plot.left + (plot.right - plot.left) * (time - start) / (end - start);
    const y = value => plot.bottom - (plot.bottom - plot.top) * (value - min) / (max - min);
    const interactive = el('div', 'trend-inspect');
    interactive.tabIndex = 0;
    interactive.dataset.chart = id;
    interactive.setAttribute('role', 'group');
    interactive.setAttribute('aria-label', caption + ' · ' + t('Grafikteki ölçümleri ok tuşlarıyla incele.'));
    const graph = svg('svg', { viewBox: '0 0 ' + plot.width + ' ' + plot.height, 'aria-hidden': 'true' });
    for (const position of [plot.top, (plot.bottom + plot.top) / 2, plot.bottom]) {
      graph.append(svg('line', { x1: plot.left, x2: plot.right, y1: position, y2: position, class: 'trend-gridline' }));
    }
    tracks.forEach(({ points }, index) => {
      let previous = null;
      let path = '';
      for (const [sampleIndex, value] of points.entries()) {
        if (!Number.isFinite(value)) { previous = null; continue; }
        const time = samples[sampleIndex].time;
        const connects = previous !== null && time - previous <= freshMs;
        const position = x(time).toFixed(2) + ' ' + y(value).toFixed(2);
        path += (connects ? 'L' : 'M') + position + (connects ? '' : 'h.5');
        previous = time;
      }
      graph.append(svg('path', { d: path, class: 'trend-line trend-' + index }));
    });
    const cursor = svg('g', { visibility: 'hidden' });
    graph.append(cursor);
    interactive.append(graph);
    const times = el('div', 'trend-times');
    const clock = dateFormat({ hour: '2-digit', minute: '2-digit' });
    times.append(...[start, (start + end) / 2, end].map(time => el('span', '', clock.format(time))));
    const date = dateFormat({ dateStyle: 'medium', timeStyle: 'medium' });
    const status = el('div', 'sr-only');
    status.setAttribute('aria-live', 'polite');
    const redraw = () => {
      const selection = selections.get(id);
      const index = selection ? nearest(available, selection.time) : -1;
      const reading = available[index];
      const latest = available.at(-1);
      const displayed = reading ?? latest;
      chartDetail.replaceChildren(el('strong', '', t(reading ? 'Seçili ölçüm' : 'Son ölçüm')),
        el('time', '', date.format(displayed.time)));
      const items = el('div', 'trend-legend');
      const spoken = [];
      series.forEach(([name, keys], track) => {
        const value = formatValue(trendValue(displayed.values, keys));
        const label = el('span', 'trend-tag trend-' + track, name);
        label.append(el('strong', '', value));
        items.append(label);
        spoken.push(name + ' ' + value);
      });
      chartDetail.append(items);
      if (!reading) {
        cursor.setAttribute('visibility', 'hidden');
        return;
      }
      const position = x(reading.time);
      cursor.replaceChildren(svg('line', { x1: position, x2: position, y1: plot.top, y2: plot.bottom, class: 'trend-crosshair' }));
      series.forEach(([, keys], track) => {
        const value = trendValue(reading.values, keys);
        if (value !== undefined) cursor.append(svg('circle', { cx: position, cy: y(value), r: 3.5,
          class: 'trend-marker trend-' + track }));
      });
      cursor.setAttribute('visibility', 'visible');
      return date.format(reading.time) + '. ' + spoken.join(', ');
    };
    function select(index, pin, announce = false) {
      const point = available[Math.max(0, Math.min(available.length - 1, index))];
      const current = selections.get(id);
      if (current?.time === point.time && current.pin === pin) return;
      selections.set(id, { time: point.time, pin });
      const message = redraw();
      if (announce) status.textContent = message;
    }
    function pointAt(event) {
      const rect = graph.getBoundingClientRect();
      const relative = (event.clientX - rect.left) * plot.width / rect.width;
      return nearest(available, start + (relative - plot.left) * (end - start) / (plot.right - plot.left));
    }
    interactive.addEventListener('pointermove', event => {
      if (event.pointerType === 'mouse') select(pointAt(event), false);
    });
    interactive.addEventListener('pointerleave', () => {
      if (!selections.get(id)?.pin && document.activeElement !== interactive) {
        selections.delete(id);
        redraw();
      }
    });
    interactive.addEventListener('click', event => select(pointAt(event), true, true));
    interactive.addEventListener('keydown', event => {
      const current = selections.get(id);
      const index = current ? nearest(available, current.time) : available.length - 1;
      const target = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: available.length - 1 }[event.key];
      if (target !== undefined) {
        event.preventDefault();
        select(target, true, true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        selections.delete(id);
        redraw();
      }
    });
    const selected = selections.get(id);
    if (selected && (selected.time < start || selected.time > end)) selections.delete(id);
    redraw();
    card.append(interactive, times, chartDetail, status, rangeTable);
  } else {
    card.append(el('p', 'trend-empty', t('Bu aralıkta ölçüm yok.')), rangeTable);
  }

  if (cumulative.some(([, stats]) => stats)) {
    const details = el('details', 'trend-history');
    details.open = expanded.has(id);
    details.append(el('summary', '', t('Birikmiş istatistikler')));
    const since = Math.min(...cumulative.flatMap(([, stats]) => stats ? [stats.since] : []));
    const from = dateFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(since);
    details.append(el('p', 'pc-caption', t('Kayıt başlangıcı') + ' · ' + from),
      statisticsTable(cumulative, formatValue, t('Birikmiş istatistikler')));
    details.addEventListener('toggle', () => {
      if (details.open) expanded.add(id);
      else expanded.delete(id);
    });
    card.append(details);
  }
  return card;
}

function draw() {
  if (!view) return;
  const { trends, statistics: totals, now, freshMs } = view;
  const end = now;
  const start = end - range * hour;
  const samples = trends.filter(sample => sample.time >= start && sample.time <= end);
  const key = JSON.stringify([language, range, Math.floor(end / minute), freshMs, samples, totals]);
  if (key === changeKey) return;
  changeKey = key;
  const focused = document.activeElement?.dataset.chart;
  section.replaceChildren(...trendCharts.map(definition => chart(definition, samples, start, end, freshMs, totals)));
  if (focused) section.querySelector('[data-chart="' + focused + '"]')?.focus({ preventScroll: true });
}

controls.addEventListener('click', event => {
  const button = event.target.closest('button[data-hours]');
  if (!button) return;
  range = Number(button.dataset.hours);
  for (const option of controls.querySelectorAll('button')) {
    option.setAttribute('aria-pressed', String(option === button));
  }
  draw();
});

export function renderSensorCharts(trends, statistics, now, freshMs) {
  view = { trends, statistics, now, freshMs };
  draw();
}
