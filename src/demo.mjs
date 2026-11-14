import { hourMs, ranges } from './calendar.mjs';

const examples = [
  ['Buzdolabı', 'Beyaz eşya', 132, 0.9],
  ['Çalışma bilgisayarı', 'Bilgisayar', 186, 1.6],
  ['Oturma odası TV', 'Televizyon', 84, 1.1],
  ['Wi-Fi yönlendirici', 'Ağ cihazı', 12, 0.4],
  ['Salon lambası', 'Aydınlatma', 48, 0.6],
  ['Hava temizleyici', 'Ev aleti', 33, 0.5],
  ['Telefon', 'Mobil cihaz', null, 0],
  ['Tablet', 'Mobil cihaz', null, 0]
];

export function seedDemo(store, now) {
  const devices = examples.map(([name, kind], i) => {
    const mac = '02:12:34:56:78:' + String(i + 10);
    return { id: mac, mac, name, kind, ip: '192.168.1.' + (i + 21), source: 'openwrt',
      signal: -42 - i * 4, associated: i < 7 ? 1 : 0 };
  });
  const { today } = ranges(now);
  const start = today - 113 * 24 * hourMs;
  const counters = examples.map(() => 0);
  store.setTariff(3.25);
  function samples(time, previous, live) {
    const hour = ((previous - today) / hourMs % 24 + 24) % 24;
    return examples.flatMap(([name, kind, watts, weight], i) => {
      if (!weight) return [];
      const { id, ip, mac } = devices[i];
      const load = [0.51, 0.44, 0.36, 0.31, 0.27, 0.36, 0.58, 0.86, 0.71, 0.49, 0.53, 0.74,
        0.63, 0.88, 0.78, 0.64, 0.92, 1.18, 1.4, 1.11, 1.24, 0.99, 0.72, 0.58][Math.floor(hour)];
      counters[i] += load * weight * (72 + 14 * Math.sin(time / (13 * hourMs) + i) + 16 * Math.cos(time / (31 * hourMs))) *
        (time - previous) / hourMs;
      return [{ id: 'shelly:' + mac.replaceAll(':', '') + ':0', deviceId: id, name, ip, mac, kind,
        watts: live ? watts : null, counterWh: counters[i] }];
    });
  }
  let previous = start;
  for (let time = start; time < now; time += hourMs) {
    store.ingest({ time, devices: [], meters: samples(time, previous, false), complete: [], issues: [] });
    previous = time;
  }
  store.ingest({ time: now, devices, meters: samples(now, previous, true), complete: ['openwrt'], issues: [] });
}
