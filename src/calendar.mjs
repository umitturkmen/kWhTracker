const dayMs = 86_400_000;
export const hourMs = 3_600_000;
export const zone = 'Europe/Istanbul';
const month = new Intl.DateTimeFormat('tr-TR', { timeZone: zone, month: 'short' });
const local = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
});
const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' });

function midnight(year, monthIndex, day) {
  const utc = Date.UTC(year, monthIndex, day);
  const label = offset.formatToParts(utc).find(part => part.type === 'timeZoneName').value;
  const match = label.match(/GMT([+-])(\d{2}):(\d{2})/);
  const minutes = match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1) : 0;
  return utc - minutes * 60_000;
}

export const periods = ['day', 'week', 'month', 'year', 'all'];

export function ranges(now, oldest = now) {
  const [year, m, day] = local.format(now).split('-').map(Number);
  const monthIndex = m - 1;
  const today = midnight(year, monthIndex, day);
  const weekday = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
  const monday = midnight(year, monthIndex, day - ((weekday + 6) % 7));
  const thisMonth = midnight(year, monthIndex, 1);
  const thisYear = midnight(year, 0, 1);
  const calendarDays = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const [firstYear, firstMonth] = local.format(oldest).split('-').map(Number);
  const monthCount = (year - firstYear) * 12 + m - firstMonth + 1;

  function make(count, boundary, label, start = boundary(0)) {
    return { start, end: boundary(count), buckets: Array.from({ length: count }, (_, i) => {
      const time = boundary(i);
      return { time, end: boundary(i + 1), label: label(time, i) };
    }) };
  }

  return {
    day: make(24, i => today + i * hourMs, (_, i) => String(i).padStart(2, '0') + ':00'),
    week: make(7, i => monday + i * dayMs, (_, i) => ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'][i]),
    month: make(calendarDays, i => midnight(year, monthIndex, i + 1), (_, i) => String(i + 1)),
    year: make(12, i => midnight(year, i, 1), time => month.format(time), thisYear),
    all: monthCount <= 24
      ? make(monthCount, i => midnight(firstYear, firstMonth - 1 + i, 1), time => month.format(time))
      : make(year - firstYear + 1, i => midnight(firstYear + i, 0, 1), (_, i) => String(firstYear + i)),
    today, monday, thisMonth, thisYear
  };
}
