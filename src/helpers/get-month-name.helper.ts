/**
 * Get month name in Ukrainian by Date
 * @param date - date
 * @returns month name
 */
export const getMonthName = (date: Date): string => {
  return date.toLocaleDateString('uk-UA', { month: 'short' });
};