import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hourMs, ranges } from './calendar.mjs';
import { trendCharts, trendSensors, trendValue, numericSensor } from './sensor-types.mjs';

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT, ip TEXT, mac TEXT, kind TEXT, source TEXT,
      signal REAL, associated INTEGER, seen INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS meters (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
      name TEXT NOT NULL, watts REAL, counter_wh REAL NOT NULL, seen INTEGER NOT NULL,
      resets INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS energy (
      meter_id TEXT NOT NULL REFERENCES meters(id), hour INTEGER NOT NULL, wh REAL NOT NULL,
      PRIMARY KEY (meter_id, hour)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS energy_hour ON energy(hour);
    CREATE INDEX IF NOT EXISTS meters_device ON meters(device_id);
    CREATE TABLE IF NOT EXISTS pc_samples (
      meter_id TEXT PRIMARY KEY REFERENCES meters(id), session TEXT NOT NULL, sensor TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pc_sensors (
      device_id TEXT PRIMARY KEY REFERENCES devices(id), seen INTEGER NOT NULL,
      available INTEGER NOT NULL, sensor_time INTEGER, payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pc_inventory (
      device_id TEXT PRIMARY KEY REFERENCES devices(id), captured INTEGER NOT NULL, payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pc_sensor_trends (
      device_id TEXT NOT NULL REFERENCES devices(id), time INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(device_id, time)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pc_sensor_statistics (
      device_id TEXT NOT NULL REFERENCES devices(id), series TEXT NOT NULL,
      minimum REAL NOT NULL, maximum REAL NOT NULL, total REAL NOT NULL, samples INTEGER NOT NULL,
      since INTEGER NOT NULL, PRIMARY KEY(device_id, series)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pc_native_sensors (
      device_id TEXT PRIMARY KEY REFERENCES devices(id), time INTEGER NOT NULL, payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS pc_activity (
      device_id TEXT NOT NULL REFERENCES devices(id), started INTEGER NOT NULL,
      ended INTEGER NOT NULL, session TEXT NOT NULL, PRIMARY KEY(device_id, started)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `);
  const get = db.prepare('SELECT value FROM state WHERE key = ?');
  const set = db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const device = db.prepare(`
    INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name, devices.name),
      ip=COALESCE(excluded.ip, devices.ip), mac=COALESCE(excluded.mac, devices.mac),
      kind=COALESCE(excluded.kind, devices.kind), source=excluded.source, signal=excluded.signal,
      associated=excluded.associated, seen=excluded.seen
    WHERE excluded.seen >= COALESCE(devices.seen, 0)
  `);
  const disconnected = db.prepare(`
    UPDATE devices SET associated=0, signal=NULL WHERE source=? AND associated=1 AND seen<?
  `);
  const meterDevice = db.prepare(`
    INSERT INTO devices (id, ip, mac, kind) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ip=COALESCE(excluded.ip,devices.ip), mac=COALESCE(excluded.mac,devices.mac),
      kind=COALESCE(devices.kind,excluded.kind)
  `);
  const getMeter = db.prepare('SELECT counter_wh, seen, watts FROM meters WHERE id=?');
  const getSample = db.prepare('SELECT session, sensor FROM pc_samples WHERE meter_id=?');
  const sample = db.prepare('INSERT INTO pc_samples VALUES (?,?,?) ON CONFLICT(meter_id) DO UPDATE SET session=excluded.session,sensor=excluded.sensor');
  const saveSensors = db.prepare(`
    INSERT INTO pc_sensors VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET seen=excluded.seen, available=excluded.available,
      sensor_time=COALESCE(excluded.sensor_time,pc_sensors.sensor_time),
      payload=CASE WHEN excluded.available=1 THEN excluded.payload ELSE pc_sensors.payload END
    WHERE excluded.seen>pc_sensors.seen
  `);
  const saveInventory = db.prepare('INSERT OR IGNORE INTO pc_inventory VALUES (?, ?, ?)');
  const selectSensors = db.prepare('SELECT available, sensor_time AS time, payload FROM pc_sensors WHERE device_id=?');
  const selectInventory = db.prepare('SELECT captured AS time, payload FROM pc_inventory WHERE device_id=?');
  const saveTrend = db.prepare('INSERT OR IGNORE INTO pc_sensor_trends VALUES (?, ?, ?)');
  const pruneTrends = db.prepare('DELETE FROM pc_sensor_trends WHERE device_id=? AND time<?');
  const selectTrends = db.prepare('SELECT time, payload FROM pc_sensor_trends WHERE device_id=? AND time>=? AND time<=? ORDER BY time');
  const latestTrend = db.prepare('SELECT MAX(time) AS time FROM pc_sensor_trends WHERE device_id=?');
  const addTrendStatistics = db.prepare(`
    INSERT INTO pc_sensor_statistics VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(device_id, series) DO UPDATE SET
      minimum=MIN(minimum, excluded.minimum), maximum=MAX(maximum, excluded.maximum),
      total=total+excluded.total, samples=samples+1, since=MIN(since, excluded.since)
  `);
  const selectTrendStatistics = db.prepare(`
    SELECT series, minimum, maximum, total / samples AS average, samples, since
    FROM pc_sensor_statistics WHERE device_id=?
  `);
  const saveNative = db.prepare(`
    INSERT INTO pc_native_sensors VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET time=excluded.time, payload=excluded.payload
    WHERE excluded.time>pc_native_sensors.time
  `);
  const selectNative = db.prepare('SELECT time, payload FROM pc_native_sensors WHERE device_id=?');
  const lastActivity = db.prepare('SELECT started, ended, session FROM pc_activity WHERE device_id=? ORDER BY started DESC LIMIT 1');
  const addActivity = db.prepare('INSERT INTO pc_activity VALUES (?, ?, ?, ?)');
  const extendActivity = db.prepare('UPDATE pc_activity SET ended=? WHERE device_id=? AND started=?');
  const allActivity = db.prepare('SELECT MIN(started) AS since, MAX(ended) AS last FROM pc_activity WHERE device_id=?');
  const activityTotal = db.prepare(`
    SELECT COALESCE(SUM(MIN(ended, ?) - MAX(started, ?)), 0) AS ms
    FROM pc_activity WHERE device_id=? AND started<? AND ended>?
  `);
  const recentActivity = db.prepare(`
    SELECT MAX(started, ?) AS start, MIN(ended, ?) AS end
    FROM pc_activity WHERE device_id=? AND started<=? AND ended>=?
    ORDER BY started DESC LIMIT 100
  `);
  const activityGapMs = interval => (interval * 1.5 + 15) * 1000;
  const trendWindow = 24 * hourMs;
  const meter = db.prepare(`
    INSERT INTO meters VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET device_id=excluded.device_id, name=excluded.name, watts=excluded.watts,
      counter_wh=excluded.counter_wh, seen=excluded.seen, resets=meters.resets+excluded.resets
  `);
  const energy = db.prepare(`
    INSERT INTO energy VALUES (?, ?, ?)
    ON CONFLICT(meter_id, hour) DO UPDATE SET wh=energy.wh+excluded.wh
  `);
  function distribute(id, start, stop, fromWatts, toWatts) {
    const duration = stop - start;
    for (let cursor = start; cursor < stop;) {
      const hour = Math.floor(cursor / hourMs) * hourMs;
      const end = Math.min(hour + hourMs, stop);
      const middle = (cursor + (end - cursor) / 2 - start) / duration;
      const watts = fromWatts + middle * (toWatts - fromWatts);
      energy.run(id, hour, watts * (end - cursor) / hourMs);
      cursor = end;
    }
  }
  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try {
      run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function recordTrendStatistics(id, time, values) {
    for (const chart of trendCharts) {
      for (const [name, ids] of chart.series) {
        const value = trendValue(values, ids);
        if (value !== undefined) addTrendStatistics.run(id, chart.id + ':' + name, value, value, value, time);
      }
    }
  }

  transaction(() => {
    if (get.get('pc_sensor_statistics_v1')) return;
    for (const row of db.prepare('SELECT device_id, time, payload FROM pc_sensor_trends').iterate()) {
      recordTrendStatistics(row.device_id, row.time, JSON.parse(row.payload));
    }
    set.run('pc_sensor_statistics_v1', '1');
  });

  function ingest(batch) {
    transaction(() => {
      const sources = new Map(batch.complete.map(source => [
        source, batch.time > Number(get.get('source:' + source)?.value ?? 0)
      ]));
      for (const item of batch.devices) {
        if (sources.get(item.source) === false) continue;
        device.run(item.id, item.name, item.ip, item.mac, item.kind, item.source,
          item.signal, item.associated, batch.time);
      }
      for (const [source, newer] of sources) {
        if (!newer) continue;
        disconnected.run(source, batch.time);
        set.run('source:' + source, String(batch.time));
      }
      if (batch.pc?.activitySession) {
        const { id, activitySession } = batch.pc;
        const recent = lastActivity.get(id);
        if (!recent || batch.time > recent.ended) {
          if (recent?.session === activitySession && batch.time - recent.ended <= activityGapMs(batch.interval)) {
            extendActivity.run(batch.time, id, recent.started);
          } else {
            addActivity.run(id, batch.time, batch.time, activitySession);
          }
          set.run('pc_activity_interval:' + id, String(batch.interval));
        }
      }
      if (batch.pc?.native) saveNative.run(batch.pc.id, batch.time, JSON.stringify(batch.pc.native));
      if (batch.pc?.sensors || batch.pc?.native) {
        const available = Boolean(batch.pc.sensors?.length);
        if (batch.pc.sensors) {
          saveSensors.run(batch.pc.id, batch.time, Number(available), available ? batch.time : null, JSON.stringify(batch.pc.sensors));
        }
        const values = {};
        for (const { id, value } of [...(batch.pc.native ?? []), ...(batch.pc.sensors ?? [])]) {
          if (!trendSensors.includes(id)) continue;
          const number = numericSensor(value);
          if (number !== null) values[id] = number;
        }
        const newest = latestTrend.get(batch.pc.id).time ?? batch.time;
        const cutoff = Math.max(batch.time, newest) - trendWindow;
        if (batch.time >= cutoff && saveTrend.run(batch.pc.id, batch.time, JSON.stringify(values)).changes) {
          recordTrendStatistics(batch.pc.id, batch.time, values);
          pruneTrends.run(batch.pc.id, cutoff);
        }
      }
      if (batch.pc?.inventory) {
        const { time, components } = batch.pc.inventory;
        saveInventory.run(batch.pc.id, time, JSON.stringify(components));
      }

      for (const item of batch.meters) {
        const previous = getMeter.get(item.id);
        if (previous && previous.seen >= batch.time) continue;
        const reset = previous && item.counterWh < previous.counter_wh;
        meterDevice.run(item.deviceId, item.ip, item.mac, item.kind);
        meter.run(item.id, item.deviceId, item.name, item.watts, item.counterWh, batch.time, reset ? 1 : 0);
        if (item.session) {
          const prior = getSample.get(item.id);
          sample.run(item.id, item.session, item.sensor);
          if (previous && prior?.session === item.session && prior.sensor === item.sensor && previous.watts !== null &&
              batch.time - previous.seen <= (batch.interval * 1.5 + 15) * 1000) {
            distribute(item.id, previous.seen, batch.time, previous.watts, item.watts);
          }
          continue;
        }
        if (!previous) continue;
        const wh = reset ? item.counterWh : item.counterWh - previous.counter_wh;
        if (reset) {
          // The reset time is unknown. Only the new counter is known.
          energy.run(item.id, Math.floor(batch.time / hourMs) * hourMs, wh);
          continue;
        }
        const average = wh * hourMs / (batch.time - previous.seen);
        distribute(item.id, previous.seen, batch.time, average, average);
      }
      if (batch.time >= Number(get.get('lastSeen')?.value ?? 0)) {
        set.run('lastSeen', String(batch.time));
        set.run('issues', JSON.stringify(batch.issues));
        if (batch.interval) set.run('interval', String(batch.interval));
        if (batch.complete.length) set.run('sources', JSON.stringify(batch.complete));
      }
    });
  }

  const first = db.prepare('SELECT MIN(seen) AS time FROM meters WHERE (? IS NULL OR device_id=?)');
  const firstEnergy = db.prepare(`
    SELECT MIN(e.hour) AS time FROM energy e JOIN meters m ON m.id=e.meter_id WHERE (? IS NULL OR m.device_id=?)
  `);
  const totals = db.prepare(`
    SELECT meter_id,
      SUM(CASE WHEN hour>=? THEN wh END) / 1000.0 AS day,
      SUM(CASE WHEN hour>=? THEN wh END) / 1000.0 AS week,
      SUM(CASE WHEN hour>=? THEN wh END) / 1000.0 AS month,
      SUM(CASE WHEN hour>=? THEN wh END) / 1000.0 AS year,
      SUM(wh) / 1000.0 AS "all"
    FROM energy e JOIN meters m ON m.id=e.meter_id
    WHERE hour<=? AND (? IS NULL OR m.device_id=?) GROUP BY meter_id
  `);
  const bucket = db.prepare(`
    SELECT SUM(e.wh) / 1000.0 AS kwh, COUNT(*) AS count FROM energy e JOIN meters m ON m.id=e.meter_id
    WHERE hour>=? AND hour<? AND hour<=? AND (? IS NULL OR m.device_id=?)
  `);
  const list = db.prepare(`
    SELECT d.*, m.id AS meter_id, m.name AS meter_name, m.watts, m.seen AS meter_seen, m.resets, p.sensor
    FROM devices d LEFT JOIN meters m ON m.device_id=d.id
    LEFT JOIN pc_samples p ON p.meter_id=m.id
    WHERE (? IS NULL OR d.id=?)
    ORDER BY COALESCE(m.seen,d.seen) DESC, d.id, m.id
  `);
  const savedRate = () => {
    const value = get.get('tariff')?.value;
    return value === undefined ? null : Number(value);
  };

  function dashboard(period, now = Date.now(), freshMs = 180_000, deviceId = null, activityPeriod = 'day') {
    freshMs = Math.max(freshMs, (Number(get.get('interval')?.value ?? 60) + 60) * 1000);
    const oldest = firstEnergy.get(deviceId, deviceId).time ?? first.get(deviceId, deviceId).time ?? now;
    const dates = ranges(now, Math.min(now, oldest));
    const range = dates[period];
    const meterTotals = new Map(totals.all(dates.today, dates.monday, dates.thisMonth, dates.thisYear, now, deviceId, deviceId)
      .map(row => [row.meter_id, row]));
    const tariff = savedRate();
    const devices = new Map();
    const summary = { day: null, week: null, month: null, year: null, all: null };
    let watts = 0;
    let liveMeters = 0;
    let meterCount = 0;
    for (const row of list.all(deviceId, deviceId)) {
      if (!devices.has(row.id)) {
        devices.set(row.id, {
          id: row.id, name: row.name, ip: row.ip, mac: row.mac, kind: row.kind,
          source: row.source, signal: row.signal, associated: row.associated,
          seen: row.seen, meters: [], kwh: null, watts: null
        });
      }
      const entry = devices.get(row.id);
      if (!row.meter_id) continue;
      const values = meterTotals.get(row.meter_id);
      const live = now - row.meter_seen <= freshMs && (row.source !== 'pc' || row.meter_seen >= row.seen);
      if (live && row.watts !== null) {
        liveMeters++;
        watts += row.watts;
        entry.watts = (entry.watts ?? 0) + row.watts;
      }
      if (values) {
        for (const key of Object.keys(summary)) {
          if (values[key] !== null) summary[key] = (summary[key] ?? 0) + values[key];
        }
        if (values[period] !== null) entry.kwh = (entry.kwh ?? 0) + values[period];
      }
      entry.meters.push({ name: row.meter_name, sensor: row.sensor, watts: live ? row.watts : null,
        kwh: values?.[period] ?? null, seen: row.meter_seen, live, resets: row.resets });
      meterCount++;
    }
    const requested = devices.get(deviceId);
    if (requested?.source === 'pc') {
      const sensor = selectSensors.get(deviceId);
      const inventory = selectInventory.get(deviceId);
      const native = selectNative.get(deviceId);
      requested.aida = sensor ? { time: sensor.time, live: Boolean(sensor.available && now - sensor.time <= freshMs),
        sensors: JSON.parse(sensor.payload) } : null;
      requested.inventory = inventory ? { time: inventory.time, components: JSON.parse(inventory.payload) } : null;
      requested.native = native ? { time: native.time, live: now - native.time <= freshMs, sensors: JSON.parse(native.payload) } : null;
      if (sensor || native) requested.trends = selectTrends.all(deviceId, now - trendWindow, now)
        .map(({ time, payload }) => ({ time, values: JSON.parse(payload) }));
      requested.trendStatistics = Object.fromEntries(selectTrendStatistics.all(deviceId)
        .map(({ series, ...statistics }) => [series, statistics]));
      const activity = allActivity.get(deviceId);
      if (activity.since !== null && activity.since <= now) {
        const session = lastActivity.get(deviceId);
        const interval = Number(get.get('pc_activity_interval:' + deviceId)?.value ?? get.get('interval')?.value ?? 60);
        const calendar = ranges(now, activity.since);
        const selected = calendar[activityPeriod];
        const start = activityPeriod === 'all' ? activity.since : selected.start;
        const sum = (from, to) => to <= from ? 0 : activityTotal.get(to, from, deviceId, to, from).ms;
        requested.activity = {
          since: activity.since, last: activity.last, start, end: selected.end,
          session: { start: session.started, last: session.ended, expires: session.ended + activityGapMs(interval) },
          summary: Object.fromEntries(['day', 'week', 'month', 'year', 'all'].map(key =>
            [key, sum(key === 'all' ? activity.since : calendar[key].start, now)])),
          buckets: selected.buckets.map(item => ({ ...item, ms: sum(item.time, Math.min(now, item.end)) })),
          sessions: recentActivity.all(start, now, deviceId, now, start)
        };
      }
    }
    const lastSeen = Number(get.get('lastSeen')?.value ?? 0) || null;
    return {
      period, now, lastSeen, tariff, summary, hasEnergy: summary[period] !== null,
      issues: JSON.parse(get.get('issues')?.value ?? '[]'), freshMs,
      sources: JSON.parse(get.get('sources')?.value ?? '[]'),
      watts: liveMeters ? watts : null, liveMeters, meterCount,
      devices: [...devices.values()],
      buckets: range.buckets.map(({ time, end, label }) => {
        const value = bucket.get(time, end, now, deviceId, deviceId);
        return { time, label, kwh: value.count ? value.kwh : null };
      })
    };
  }
  return { ingest, dashboard, setTariff: value => set.run('tariff', String(value)), close: () => db.close() };
}
