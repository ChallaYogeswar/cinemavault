const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  const name = MONTH_NAMES[Number(month) - 1] ?? key;
  return `${name} ${String(year)}`;
}

export function formatHours(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} h`;
}
