/**
 * Get month name in Ukrainian by Date
 * @param date - date
 * @returns month name
 */
export const getMonthName = (date: Date): string => {
  const monthNameByJsMonth = {
    0: 'січ.',
    1: 'лют.',
    2: 'бер.',
    3: 'квіт.',
    4: 'трав.',
    5: 'черв.',
    6: 'лип.',
    7: 'серп.',
    8: 'вер.',
    9: 'жовт.',
    10: 'лист.',
    11: 'груд.',
  };
  return monthNameByJsMonth[date.getMonth()];
};