import * as process from 'node:process';

export const config = {
  port: 3500,
  mongoUri: process.env.MONGO_URI,
  botToken: process.env.BOT_TOKEN,
  phoneNumber: process.env.PHONE_NUMBER,
  address: process.env.ADDRESS,
  dtekObjectId: Number(process.env.DTEK_OBJECT_ID),
  kdFeedRequestIntervalMs: 15 * 1000, // 15 sec
  kdDtekObjectsRequestIntervalMs: 60 * 1000, // 1 min
  appEnv: process.env.APP_ENV,
  socks5Proxy: process.env.SOCKS5_PROXY,
  dtekStreet: process.env.DTEK_STREET ?? 'вул. Здановської Юлії',
  dtekBuilding: process.env.DTEK_BUILDING ?? '71/З',
  dtekPollIntervalMs: Number(process.env.DTEK_POLL_INTERVAL_MS ?? 15 * 60 * 1000),
  dtekPuppeteerHeadless: process.env.DTEK_PUPPETEER_HEADLESS ?? 'new',
};
