import { isIPv4 } from 'node:net';

export function macAddress(value) {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}$/i.test(value)) return null;
  const mac = value.toLowerCase().replaceAll('-', ':');
  return parseInt(mac.slice(0, 2), 16) % 2 || mac === '00:00:00:00:00:00' ? null : mac;
}

export function lanIp(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  if (c === 255 && d === 255) return false;
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export const pcIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const sensorIdPattern = /^[a-z\d_.-]{1,80}$/i;
const label = (value, limit = 100) => typeof value === 'string' ? value.trim().slice(0, limit) || null : null;

function sensorList(rows, limit) {
  if (rows === undefined) return null;
  if (!Array.isArray(rows) || rows.length > limit) throw new Error('PC sensör listesi geçersiz.');
  return [...new Map(rows.filter(row => typeof row?.id === 'string' && sensorIdPattern.test(row.id))
    .map(row => [row.id, { id: row.id, label: label(row.label, 160) ?? row.id, value: label(row.value, 512) }])).values()];
}

function pcDetails(pc, time) {
  const sensors = sensorList(pc.sensors, 2048);
  const native = sensorList(pc.native, 64);
  let inventory = null;
  if (pc.inventory !== undefined) {
    const { time: capturedAt, components } = pc.inventory ?? {};
    if (!Number.isSafeInteger(capturedAt) || Math.abs(capturedAt - time) > 120_000 ||
        !Array.isArray(components) || !components.length || components.length > 150) {
      throw new Error('Donanım envanteri geçersiz.');
    }
    inventory = { time: capturedAt, components: components.map(item => {
      const group = label(item?.group, 80);
      const name = label(item?.name, 160);
      if (!group || !name || !Array.isArray(item.fields) || !item.fields.length || item.fields.length > 30) {
        throw new Error('Donanım bileşeni geçersiz.');
      }
      return { group, name, fields: item.fields.map(field => ({
        label: label(field?.label, 100), value: label(field?.value, 200)
      })).filter(field => field.label && field.value) };
    }) };
  }
  const activitySession = typeof pc.activitySession === 'string' && pcIdPattern.test(pc.activitySession)
    ? pc.activitySession : null;
  const bootAt = Number.isSafeInteger(pc.bootAt) && pc.bootAt >= Date.UTC(2000, 0, 1) && pc.bootAt <= time
    ? pc.bootAt : null;
  return { id: pc.id, activitySession, bootAt, sensors, native, inventory };
}

export function report(input) {
  if (!input || !Number.isSafeInteger(input.time) || input.time < Date.UTC(2000, 0, 1) || input.time > Date.now() + 60_000) {
    throw new Error('Ölçüm saati geçersiz. Toplayıcının saat ayarını kontrol et.');
  }
  function array(key, limit) {
    if (!Array.isArray(input[key]) || input[key].length > limit) throw new Error('Ölçüm listesi geçersiz.');
    return input[key];
  }
  const source = value => {
    if (!['openwrt', 'windows'].includes(value)) throw new Error('Ağ kaynağı geçersiz.');
    return value;
  };
  const ip = value => isIPv4(value) ? value : null;
  const devices = array('devices', 1024).map(item => {
    const mac = macAddress(item?.mac);
    if (!mac) throw new Error('Cihaz MAC adresi geçersiz.');
    return {
      id: mac, mac, ip: ip(item.ip), name: label(item.name), kind: label(item.kind),
      source: source(item.source), associated: item.associated === true ? 1 : null,
      signal: Number.isFinite(item.signal) && item.signal <= 0 && item.signal >= -130 ? item.signal : null
    };
  });
  const ids = new Set();
  const meters = array('meters', 128).map(item => {
    if (!item || !/^shelly:[a-f0-9]{12}:\d{1,2}$/.test(item.id) || ids.has(item.id) ||
        !Number.isFinite(item.counterWh) || item.counterWh < 0 || item.counterWh > 1e12) {
      throw new Error('Sayaç kaydı geçersiz veya yinelenmiş.');
    }
    ids.add(item.id);
    const mac = macAddress(item.id.split(':')[1].match(/../g).join(':'));
    if (!mac) throw new Error('Sayaç MAC adresi geçersiz.');
    const deviceMac = item.deviceMac === undefined ? mac : macAddress(item.deviceMac);
    if (!deviceMac) throw new Error('Ölçülen cihazın MAC adresi geçersiz.');
    return {
      id: item.id, deviceId: deviceMac, mac: deviceMac, ip: deviceMac === mac ? ip(item.ip) : null,
      kind: deviceMac === mac ? 'Enerji sayacı' : null,
      name: label(item.name) ?? 'Shelly', counterWh: item.counterWh,
      watts: Number.isFinite(item.watts) && Math.abs(item.watts) <= 100_000 ? item.watts : null
    };
  });
  const interval = Number.isInteger(input.interval) && input.interval >= 15 && input.interval <= 3600 ? input.interval : 60;
  if (input.pc) {
    const pc = input.pc;
    const name = label(pc.name);
    if (!name || !pcIdPattern.test(pc.id) || !pcIdPattern.test(pc.session) || !Array.isArray(pc.readings) || pc.readings.length > 2) {
      throw new Error('PC sensör paketi geçersiz.');
    }
    devices.push({ id: pc.id, name, ip: null, mac: null, kind: 'Windows PC', source: 'pc', associated: null, signal: null });
    const channels = new Set();
    for (const reading of pc.readings) {
      const key = reading?.id === 'pc:' + pc.id + ':cpu' ? 'cpu' : reading?.id === 'pc:' + pc.id + ':gpu' ? 'gpu' : null;
      const allowed = key === 'cpu' ? ['AIDA64', 'CPU güç sayacı'] : ['AIDA64', 'NVIDIA'];
      if (!key || channels.has(key) || !allowed.includes(reading.sensor) ||
          !Number.isFinite(reading.watts) || reading.watts < 0 || reading.watts > 2500) {
        throw new Error('PC sensör değeri geçersiz.');
      }
      channels.add(key);
      meters.push({ id: reading.id, deviceId: pc.id, mac: null, ip: null, kind: 'Windows PC',
        name: label(reading.name) ?? key.toUpperCase(), counterWh: 0, watts: reading.watts,
        session: pc.session, sensor: reading.sensor });
    }
  }
  return { time: input.time, interval, devices, meters, pc: input.pc ? pcDetails(input.pc, input.time) : null,
    complete: array('complete', 2).map(source),
    issues: array('issues', 130).map(value => label(value, 200)).filter(Boolean) };
}
