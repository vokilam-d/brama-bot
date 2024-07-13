import * as process from 'node:process';

export const config = {
  port: 3500,
  mongoUri: process.env.MONGO_URI,
  botToken: process.env.BOT_TOKEN,
  phoneNumber: process.env.PHONE_NUMBER,
  address: process.env.ADDRESS,
  kdFeedRequestTimeout: 30 * 1000 // 30 sec
};
