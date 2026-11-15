import assert from 'node:assert/strict';
import { test } from 'node:test';
import { report } from '../src/report.mjs';
import { openStore } from '../src/store.mjs';

const id = '01234567-89ab-4def-8111-111111111111';
const firstCollector = '19db6e3e-e776-451a-b1e8-90672f04de15';
const nextCollector = '19db6e3e-e776-451a-b1e8-90672f04de16';
const minute = 60_000;
const bootAt = Date.parse('2025-11-15T07:04:24Z');

function reading(time, session, boot = bootAt) {
  return report({
    time, interval: 60, devices: [], complete: [], meters: [], issues: [],
    pc: { id, session, activitySession: session, name: 'PC', readings: [], bootAt: boot }
  });
}

test('Windows uptime keeps the boot time across a collector restart', () => {
  const store = openStore(':memory:');
  try {
    store.ingest(reading(bootAt + minute, firstCollector));
    store.ingest(reading(bootAt + 2 * minute, firstCollector));
    store.ingest(reading(bootAt + 14 * minute, nextCollector));
    const now = bootAt + 14 * minute;
    const getActivity = () => store.dashboard('day', now, 180_000, id).devices[0].activity;
    assert.deepEqual(getActivity().boot, { start: bootAt, last: now, expires: now + 105_000 });
    assert.equal(getActivity().session.start, now);
    assert.equal(getActivity().summary.day, minute);
    assert.equal(getActivity().sessions.length, 1);

    store.ingest(reading(bootAt + 13 * minute, firstCollector, bootAt - minute));
    assert.equal(getActivity().boot.start, bootAt);
  } finally {
    store.close();
  }
});

test('Windows reboot resets the boot time and older collectors still work', () => {
  const store = openStore(':memory:');
  try {
    store.ingest(reading(bootAt, firstCollector, null));
    const getActivity = now => store.dashboard('day', now, 180_000, id).devices[0].activity;
    assert.equal(getActivity(bootAt).boot, null);
    assert.equal(getActivity(bootAt).session.start, bootAt);
    store.ingest(reading(bootAt + minute, firstCollector));
    const reboot = bootAt + 10 * minute;
    store.ingest(reading(reboot + minute, nextCollector, reboot));
    assert.equal(getActivity(reboot + minute).boot.start, reboot);
  } finally {
    store.close();
  }
});

test('activity groups short report gaps and uses the same intervals in all displays', () => {
  const store = openStore(':memory:');
  try {
    for (const [offset, collector] of [[0, firstCollector], [1, firstCollector], [5, nextCollector], [6, nextCollector], [11, nextCollector]]) {
      store.ingest(reading(bootAt + offset * minute, collector, null));
    }
    const now = bootAt + 11 * minute;
    const { session, sessions, summary, buckets } = store.dashboard('day', now, 180_000, id).devices[0].activity;
    assert.equal(session.start, now);
    assert.deepEqual(sessions, [{ start: bootAt, end: bootAt + 6 * minute }]);
    for (const total of Object.values(summary)) assert.equal(total, 6 * minute);
    assert.equal(buckets[10].ms, 6 * minute);
  } finally {
    store.close();
  }
});

test('activity keeps a reboot boundary even when reporting resumes within four minutes', () => {
  const store = openStore(':memory:');
  try {
    const reboot = bootAt + 3 * minute;
    for (const [time, boot] of [[bootAt, bootAt], [bootAt + minute, bootAt], [reboot, reboot], [reboot + minute, reboot]]) {
      store.ingest(reading(time, firstCollector, boot));
    }
    const { session, sessions, summary } = store.dashboard('day', reboot + minute, 180_000, id).devices[0].activity;
    assert.equal(session.start, reboot);
    assert.equal(summary.day, 2 * minute);
    assert.deepEqual(sessions, [{ start: reboot, end: reboot + minute }, { start: bootAt, end: bootAt + minute }]);
  } finally {
    store.close();
  }
});
