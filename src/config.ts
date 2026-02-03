import * as process from 'node:process';


export const CONFIG = {
  port: 3500,
  appEnv: process.env.APP_ENV,
  mongoUri: process.env.MONGO_URI,
  botToken: process.env.BOT_TOKEN,
  socks5Proxy: process.env.SOCKS5_PROXY,
  kyivDigital: {
    phoneNumber: process.env.PHONE_NUMBER,
    dtekObjectId: Number(process.env.DTEK_OBJECT_ID),
    feedRequestIntervalMs: 15 * 1000, // 15 sec
    dtekObjectsRequestIntervalMs: 60 * 1000, // 1 min
  },
  dtek: {
    street: process.env.DTEK_STREET ?? 'вул. Здановської Юлії',
    building: process.env.DTEK_BUILDING ?? '71/З',
    pollIntervalMs: Number(process.env.DTEK_POLL_INTERVAL_MS ?? 2 * 60 * 1000),
  },
  yasno: {
    regionId: process.env.YASNO_REGION_ID ?? '25',
    dsoId: process.env.YASNO_DSO_ID ?? '902',
    street: process.env.YASNO_STREET ?? 'вул. Здановської Юлії',
    building: process.env.YASNO_BUILDING ?? '71З',
    pollIntervalMs: Number(process.env.YASNO_POLL_INTERVAL_MS ?? 2 * 60 * 1000),
  },
};
