/** Same month names the API uses in its date labels (backend/app/events/dates.py). */
export const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto',
  'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

/** Inserts the slashes while typing a day: 20022026 → 20/02/2026. */
export function maskDay(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
}

/** "dd/mm/aaaa" → "aaaa-mm-dd", or null while incomplete or not a real date. */
export function parseDay(text: string): string | null {
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const date = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return date.getUTCDate() === +m[1] && date.getUTCMonth() === +m[2] - 1 ? date.toISOString().slice(0, 10) : null;
}
