/**
 * Get day name in Ukrainian by Date
 * @param date - date
 * @returns day name
 */
export const getDayName = (date: Date): string => {
  return date.toLocaleDateString('uk-UA', { weekday: 'long' });
};