import * as process from 'node:process';

export const config = {
  port: 3500,
  mongoUri: process.env.MONGO_URI,
  botToken: process.env.BOT_TOKEN,
  phoneNumber: process.env.PHONE_NUMBER,
  address: process.env.ADDRESS,
  dtekObjectId: Number(process.env.DTEK_OBJECT_ID),
  kdFeedRequestTimeout: 15 * 1000 // 15 sec
};
