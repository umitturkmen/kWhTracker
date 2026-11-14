export const trendSensors = ['TCPUPKG', 'TCPU', 'TGPU1', 'SCPUUTI', 'SGPU1UTI', 'SMEMUTI', 'PCPUPKG', 'PCPU', 'PGPU1'];

export function numericSensor(value) {
  const match = value?.match(/^(-?\d+(?:[.,]\d+)?)\s*(?:°?C|%|W)?$/i);
  return match ? Number(match[1].replace(',', '.')) : null;
}
