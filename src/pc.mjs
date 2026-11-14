import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const options = { windowsHide: true, timeout: 6000 };
const validWatts = value => Number.isFinite(value) && value >= 0 && value <= 2500;
const cpuSnapshot = join(process.env.ProgramData ?? 'C:\\ProgramData', 'WattIz', 'cpu.json');

async function readCpuPackage() {
  try {
    const sample = JSON.parse(await readFile(cpuSnapshot, 'utf8'));
    const age = Date.now() - sample.time;
    if (age >= 0 && age < 45_000 && validWatts(sample.watts) && sample.watts > 0) return sample;
  } catch {
    // The optional CPU reader may be absent or updating its snapshot.
  }
  return null;
}

export function parseSensors(output) {
  const values = new Map();
  const labels = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s+(Value|Label)\.([\w.-]+)\s+REG_\w+\s+(.*?)\s*$/);
    if (!match || !match[3]) continue;
    (match[1] === 'Value' ? values : labels).set(match[2], match[3].slice(0, 512));
  }
  return [...values].map(([id, value]) => ({ id, label: labels.get(id) ?? id, value }));
}

function sensorWatts(values, key) {
  const value = values.get(key)?.match(/^(\d+(?:[.,]\d+)?)\s*(?:W)?$/i);
  return value ? Number(value[1].replace(',', '.')) : null;
}

const gpuFields = [
  ['power.draw', 'PGPU1', 'GPU gücü', 'W'],
  ['temperature.gpu', 'TGPU1', 'GPU sıcaklığı', '°C'],
  ['utilization.gpu', 'SGPU1UTI', 'GPU kullanımı', '%'],
  ['memory.used', 'SGPU1USEDDEMEM', 'Kullanılan VRAM', 'MiB'],
  ['memory.total', 'SGPU1TOTALMEM', 'Toplam VRAM', 'MiB'],
  ['clocks.current.graphics', 'SGPU1CLK', 'GPU frekansı', 'MHz'],
  ['clocks.current.memory', 'SGPU1MEMCLK', 'VRAM frekansı', 'MHz'],
  ['fan.speed', 'FGPU1PCT', 'GPU fan hızı', '%']
];

function cpuTimes() {
  const processors = cpus();
  let total = 0;
  let idle = 0;
  for (const { times } of processors) {
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  return { total, idle };
}

async function readNvidia() {
  const result = await exec('nvidia-smi.exe', [
    '--query-gpu=name,' + gpuFields.map(([field]) => field).join(','),
    '--format=csv,noheader,nounits'
  ], options).catch(() => null);
  const [name, ...values] = result?.stdout.split(/\r?\n/)[0]?.split(',').map(value => value.trim()) ?? [];
  const sensors = gpuFields.flatMap(([, id, label, unit], index) =>
    /^\d+(?:\.\d+)?$/.test(values[index] ?? '') ? [{ id, label, value: values[index] + ' ' + unit }] : []);
  const watts = sensors.some(sensor => sensor.id === 'PGPU1') ? Number(values[0]) : null;
  return { name, sensors, watts };
}

export function createPcReader(config, deviceId) {
  let previous = cpuTimes();
  return async function readPc() {
    const [output, nvidia, cpuSample] = await Promise.all([
      config.aida64 === false ? '' : exec(
        'reg.exe', ['query', 'HKCU\\Software\\FinalWire\\AIDA64\\SensorValues'], options
      ).then(result => result.stdout, () => ''),
      config.nvidia === false ? null : readNvidia(),
      readCpuPackage()
    ]);
    const sensors = parseSensors(output);
    const values = new Map(sensors.map(({ id, value }) => [id, value]));
    const native = nvidia?.sensors ?? [];
    if (cpuSample) {
      native.push({ id: 'PCPUPKG', label: 'CPU paket gücü', value: cpuSample.watts.toFixed(2) + ' W' });
      if (Number.isFinite(cpuSample.temperature)) {
        native.push({ id: 'TCPUPKG', label: 'CPU paket sıcaklığı', value: cpuSample.temperature.toFixed(1) + ' °C' });
      }
    }
    const current = cpuTimes();
    const elapsed = current.total - previous.total;
    if (elapsed > 0) {
      const busy = 100 * (1 - (current.idle - previous.idle) / elapsed);
      native.push({ id: 'SCPUUTI', label: 'CPU kullanımı', value: Math.max(0, Math.min(100, busy)).toFixed(1) + ' %' });
    }
    previous = current;
    const total = totalmem();
    const free = freemem();
    if (total > 0) {
      native.push({ id: 'SMEMUTI', label: 'RAM kullanımı', value: (100 * (1 - free / total)).toFixed(1) + ' %' },
        { id: 'SFREEMEM', label: 'Boş RAM', value: (free / 1_048_576).toFixed(0) + ' MiB' });
    }
    const cpu = sensorWatts(values, 'PCPUPKG') ?? sensorWatts(values, 'PCPU');
    const readings = [];
    const add = (key, name, watts, sensor) => {
      if (validWatts(watts)) readings.push({ id: 'pc:' + deviceId + ':' + key, name, watts, sensor });
    };
    if (cpuSample) add('cpu', 'CPU paketi', cpuSample.watts, 'CPU güç sayacı');
    else add('cpu', 'CPU paketi', cpu, 'AIDA64');
    const gpu = sensorWatts(values, 'PGPU1');
    if (validWatts(gpu)) {
      add('gpu', 'Ekran kartı', gpu, 'AIDA64');
    } else if (nvidia) add('gpu', nvidia.name ?? 'Ekran kartı', nvidia.watts, 'NVIDIA');
    return { readings, sensors, native };
  };
}
