export const pad = (num: number | string, maxLength: number = 2, fillString: string = '0') => {
  return `${num}`.padStart(maxLength, fillString);
}
