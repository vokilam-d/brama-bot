/**
 * Normalize date to 12 PM to avoid timezone/DST issues
 */
export function normalizeScheduleDate(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(12, 0, 0, 0);
  return normalized;
}
