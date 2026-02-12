import * as process from 'node:process';

const resolveEnvNumber = (envVarValue: string, defaultValue: number): number => {
  return envVarValue
    ? Number(envVarValue)
    : defaultValue;
};

const defaultPollIntervalMs = resolveEnvNumber(
  process.env.DEFAULT_SCHEDULE_POLL_INTERVAL_MS,
  30 * 1000, // 30 sec
);
const defaultStreet = process.env.DEFAULT_STREET;

export const CONFIG = {
  port: 3500,
  appEnv: process.env.APP_ENV,
  mongoUri: process.env.MONGO_URI,
  botToken: process.env.BOT_TOKEN,
  socks5Proxy: process.env.SOCKS5_PROXY,
  kyivDigital: {
    phoneNumber: process.env.PHONE_NUMBER,
    dtekObjectId: Number(process.env.KD_DTEK_OBJECT_ID),
    feedRequestIntervalMs: 15 * 1000, // 15 sec
    dtekObjectsRequestIntervalMs: 60 * 1000, // 1 min,
    schedulePollIntervalMs: resolveEnvNumber(process.env.KD_SCHEDULE_POLL_INTERVAL_MS, defaultPollIntervalMs),
  },
  dtek: {
    street: process.env.DTEK_STREET ?? defaultStreet,
    building: process.env.DTEK_BUILDING,
    pollIntervalMs: resolveEnvNumber(process.env.DTEK_POLL_INTERVAL_MS, defaultPollIntervalMs),
  },
  yasno: {
    regionId: process.env.YASNO_REGION_ID,
    dsoId: process.env.YASNO_DSO_ID,
    street: process.env.YASNO_STREET ?? defaultStreet,
    building: process.env.YASNO_BUILDING,
    pollIntervalMs: resolveEnvNumber(process.env.YASNO_POLL_INTERVAL_MS, defaultPollIntervalMs),
  },
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
};
