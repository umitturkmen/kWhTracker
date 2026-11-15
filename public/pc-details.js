import { dateFormat, language, locale, t } from './i18n.js';
import { renderSensorCharts } from './sensor-chart.js';

const $ = id => document.getElementById(id);
const date = value => dateFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(value);
const searchable = value => value.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replaceAll('ı', 'i');
let state;
let sourceKey = '';
let inventoryKey = '';
let sourceChosen = false;
let categoryLanguage;
const expanded = new Set(['Sıcaklık', 'Güç']);

function el(tag, name, value) {
  const node = document.createElement(tag);
  if (name) node.className = name;
  if (value !== undefined) node.textContent = value;
  return node;
}

function group(id) {
  if (/^S.*(?:CLK|MUL|FSB|SPEED|TIM)$/.test(id) || /^SCC-/.test(id)) return 'Frekans ve zamanlama';
  if (/^SGPU/.test(id)) return 'Ekran kartı';
  if (/^S(?:DSK|DRV|SMA)/.test(id)) return 'Depolama';
  if (/^S.*(?:UTI|MEM|THR)/.test(id)) return 'Kullanım ve bellek';
  return { T: 'Sıcaklık', P: 'Güç', V: 'Voltaj', F: 'Fanlar ve akış', C: 'Akım' }[id[0]] ?? 'Sistem ve diğer';
}

function unit(id, value) {
  if (!/^-?\d+(?:[.,]\d+)?$/.test(value ?? '')) return '';
  if (/^PGPU\d+TDPP$/.test(id) || /^S.*(?:UTI|THR|ACT)$/.test(id)) return '%';
  if (/^S(?:CC-|.*CLK$|CPUFSB$)/.test(id)) return 'MHz';
  return { T: '°C', P: 'W', V: 'V', C: 'A', F: 'RPM' }[id[0]] ?? '';
}

function sensorList() {
  if (!state) return;
  const source = $('sensor-source').value;
  const sensors = state[source]?.sensors ?? [];
  const categories = [...new Set(sensors.map(row => group(row.id)))].sort((a, b) => a.localeCompare(b, 'tr'));
  const select = $('sensor-category');
  if (categoryLanguage !== language || select.options.length !== categories.length + 1 || categories.some((name, index) => select.options[index + 1]?.value !== name)) {
    categoryLanguage = language;
    const selected = select.value;
    select.replaceChildren(new Option(t('Tümü'), ''), ...categories.map(name => new Option(t(name), name)));
    if (categories.includes(selected)) select.value = selected;
  }
  const query = searchable($('sensor-search').value.trim());
  const rows = sensors.filter(item => (!select.value || group(item.id) === select.value)
    && searchable(t(item.label) + ' ' + item.label + ' ' + item.id).includes(query));
  $('sensor-filter-status').textContent = sensors.length ? rows.length + ' / ' + sensors.length + ' ' + t('sensör')
    : t('Bu kaynaktan sensör verisi bekleniyor.');
  $('pc-sensor-list').replaceChildren(...categories.flatMap(name => {
    const children = rows.filter(row => group(row.id) === name);
    if (!children.length) return [];
    const section = el('details', 'sensor-group');
    section.open = Boolean(query || select.value || expanded.has(name));
    const title = el('summary', '');
    title.append(el('span', '', t(name)), el('small', '', String(children.length)));
    section.append(title);
    const list = el('dl', 'sensor-values');
    for (const row of children) {
      const item = el('div', '');
      const label = el('dt', '', t(row.label));
      label.append(el('small', '', row.id));
      const suffix = unit(row.id, row.value);
      item.append(label, el('dd', '', row.value === null ? '—' : row.value + (suffix ? ' ' + suffix : '')));
      list.append(item);
    }
    title.addEventListener('click', () => {
      if (section.open) expanded.delete(name);
      else expanded.add(name);
    });
    section.append(list);
    return [section];
  }));
}

function renderInventory() {
  if (!state) return;
  const inventory = state.inventory;
  $('inventory-time').textContent = inventory ? t('Kaydedildi') + ' · ' + date(inventory.time) : t('Bilgisayarın donanım kaydı bekleniyor.');
  const query = searchable($('inventory-search').value.trim());
  const components = inventory?.components ?? [];
  const matching = components.filter(component => searchable([
    component.name, component.group, ...component.fields.flatMap(field => [field.label, field.value])
  ].flatMap(value => [value, hardwareCopy(value)]).join(' ')).includes(query));
  const sections = new Map();
  for (const component of matching) {
    if (!sections.has(component.group)) sections.set(component.group, []);
    sections.get(component.group).push(component);
  }
  $('pc-disks').hidden = Boolean(query);
  $('pc-disks').replaceChildren(...components.filter(item => ['Disk bölümleri', 'Disk bolumleri'].includes(item.group)).flatMap(item => {
    const value = item.fields.find(field => field.label === 'Doluluk')?.value;
    const percent = Number.parseFloat(value);
    if (!Number.isFinite(percent)) return [];
    const free = item.fields.find(field => ['Boş alan', 'Bos alan'].includes(field.label))?.value;
    const card = el('article', 'disk-card');
    const head = el('div', 'trend-times');
    const percentage = new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 1 }).format(percent / 100);
    head.append(el('strong', '', item.name), el('span', '', percentage + ' ' + t('dolu')));
    const meter = el('meter', '');
    meter.min = 0;
    meter.max = 100;
    meter.high = 90;
    meter.optimum = 0;
    meter.value = percent;
    meter.setAttribute('aria-label', item.name + ' ' + t('disk doluluğu'));
    card.append(head, meter, el('small', '', free ? free + ' ' + t('boş') : ''));
    return [card];
  }));
  const cards = [...sections].map(([group, items]) => {
    const section = el('section', 'hardware-card');
    section.append(el('h3', '', hardwareCopy(group)));
    for (const item of items) {
      const component = el('details', 'hardware-item');
      component.open = items.length <= 2 || Boolean(query);
      component.append(el('summary', '', hardwareCopy(item.name)));
      const list = el('dl', '');
      for (const field of item.fields) {
        const row = el('div', '');
        row.append(el('dt', '', hardwareCopy(field.label)), el('dd', '', hardwareCopy(field.value)));
        list.append(row);
      }
      component.append(list);
      section.append(component);
    }
    return section;
  });
  $('pc-components').replaceChildren(...(query && !cards.length ? [el('p', 'pc-caption', t('Aramana uyan donanım yok.'))] : cards));
}

const legacyLabels = {
  'Isletim sistemi': 'İşletim sistemi', Surum: 'Sürüm', Uretici: 'Üretici', 'Urun adi': 'Ürün adı',
  'Seri numarasi': 'Seri numarası', 'Varlik etiketi': 'Varlık etiketi', Islemci: 'İşlemci', Cekirdek: 'Çekirdek',
  'Mantiksal islemci': 'Mantıksal işlemci', 'L2 onbellek': 'L2 önbellek', 'L3 onbellek': 'L3 önbellek',
  'Yayin tarihi': 'Yayın tarihi', 'Parca numarasi': 'Parça numarası', 'Veri hizi': 'Veri hızı',
  'Bellek turu': 'Bellek türü', 'Bellek hizi': 'Bellek hızı', 'Video bellegi': 'Video belleği', Surucu: 'Sürücü',
  Cozunurluk: 'Çözünürlük', 'Yenileme hizi': 'Yenileme hızı', Baglanti: 'Bağlantı', 'Bolum sayisi': 'Bölüm sayısı',
  'Disk bolumleri': 'Disk bölümleri', 'Bos alan': 'Boş alan', 'Cevre birimleri': 'Çevre birimleri',
  'Ag bagdastiricisi': 'Ağ bağdaştırıcısı', 'Ses aygiti': 'Ses aygıtı', Sinif: 'Sınıf', Tur: 'Tür'
};
const hardwareCopy = value => t(legacyLabels[value] ?? value);

function renderSource() {
  const selected = state?.[$('sensor-source').value];
  $('telemetry-time').textContent = selected?.time
    ? t(selected.live ? 'Son okuma' : 'Son kayıt, veri güncel değil') + ' · ' + date(selected.time)
    : t('Bu kaynaktan sensör verisi bekleniyor.');
}

export function renderPc(device, now, freshMs) {
  state = device;
  $('pc-sections').hidden = false;
  $('pc-telemetry').hidden = false;
  $('pc-inventory').hidden = false;
  const { aida, native, inventory, trends = [], trendStatistics } = device;
  if (!sourceChosen) $('sensor-source').value = aida?.live || !native?.sensors.length ? 'aida' : 'native';
  const source = $('sensor-source').value;
  renderSource();
  renderSensorCharts(trends, trendStatistics, now, freshMs);
  const newSourceKey = JSON.stringify([language, source, aida, native]);
  if (newSourceKey !== sourceKey) {
    sourceKey = newSourceKey;
    sensorList();
  }
  const newInventoryKey = JSON.stringify([language, inventory]);
  if (inventoryKey !== newInventoryKey) {
    inventoryKey = newInventoryKey;
    renderInventory();
  }
}

$('sensor-search').addEventListener('input', sensorList);
$('sensor-category').addEventListener('change', sensorList);
$('sensor-source').addEventListener('change', () => {
  sourceChosen = true;
  renderSource();
  sensorList();
});
$('inventory-search').addEventListener('input', renderInventory);
