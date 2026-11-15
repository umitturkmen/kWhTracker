export const trendCharts = [
  { id: 'temperature', title: 'Sıcaklık', unit: '°C', series: [['CPU', ['TCPUPKG', 'TCPU']], ['GPU', ['TGPU1']]] },
  { id: 'utilization', title: 'Kullanım', unit: '%', series: [['CPU', ['SCPUUTI']], ['GPU', ['SGPU1UTI']], ['RAM', ['SMEMUTI']]] },
  { id: 'power', title: 'Bileşen gücü', unit: 'W', series: [['CPU', ['PCPUPKG', 'PCPU']], ['GPU', ['PGPU1']]] }
];

export const trendSensors = trendCharts.flatMap(chart => chart.series.flatMap(([, ids]) => ids));
export const trendValue = (values, ids) => ids.map(id => values[id]).find(Number.isFinite);

export function numericSensor(value) {
  const match = value?.match(/^(-?\d+(?:[.,]\d+)?)\s*(?:°?C|%|W)?$/i);
  return match ? Number(match[1].replace(',', '.')) : null;
}
