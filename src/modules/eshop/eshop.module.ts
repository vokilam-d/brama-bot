import { BotModule } from "../bot/bot.module";
import { Module } from "@nestjs/common";
import { EshopService } from "./services/eshop.service";

@Module({
  imports: [BotModule],
  providers: [EshopService],
})
export class EshopModule {}