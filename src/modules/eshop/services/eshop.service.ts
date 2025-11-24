import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import * as puppeteer from "puppeteer";
import { BotService, PendingMessageType } from "../../bot/services/bot.service";
import { BotMessageText } from "src/modules/bot/helpers/bot-message-text.helper";

@Injectable()
export class EshopService implements OnApplicationBootstrap, OnApplicationShutdown {

  private readonly logger = new Logger(EshopService.name);
  private browser: puppeteer.Browser;
  private pageUrl: string = `https://www.zara.com/ua/uk/%D1%82%D1%80%D0%B8%D0%BA%D0%BE%D1%82%D0%B0%D0%B6%D0%BD%D0%B0-%D1%81%D1%83%D0%BA%D0%BD%D1%8F-%D0%BC%D1%96%D0%B4%D1%96-%D0%B7-%D0%B2%D0%B8%D1%80%D1%96%D0%B7%D0%BE%D0%BC-p04938124.html`;
  private productSize = 'S';
  private checkTimeoutMs = 1000 * 60; // 1 minute
  private checkTimeout: NodeJS.Timeout;

  constructor(
    private readonly botService: BotService,
  ) {
  }

  async onApplicationBootstrap(): Promise<void> {
    // this.init().then();

    this.botService.events.on(PendingMessageType.EshopGetInfo, () => {
      this.sendEshopInfo().then();
    });
  }

  async onApplicationShutdown(): Promise<void> {
    clearTimeout(this.checkTimeout);
    if (this.browser) {
      await this.browser.close();
    }
  }

  private async init(): Promise<void> {
    try {
      await this.startBrowser();
    } catch (error) {
      this.logger.error(`Starting browser: Failed: ${error.message}`, error.stack);
      return;
    }

    this.logger.debug(`Checking size availability...`);
    await this.checkSizeAvailability();
    this.logger.log(`Checking size availability: Finished 1st check`);
  }

  private async startBrowser(): Promise<void> {
    this.logger.debug(`Starting browser...`);
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath || undefined, // Use installed Chromium in Docker, bundled locally
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });

    this.logger.log(`Starting browser: Finished`);
  }

  private async checkSizeAvailability(): Promise<void> {
    try {
      const products = await this.parseEshopPage();
      const product = products.find((product) => product.size === this.productSize);
      if (!product) {
        this.botService.sendMessageToOwner(new BotMessageText(`Product not found in the page`));
        this.checkTimeout = setTimeout(() => {
          this.checkSizeAvailability().then();
        }, this.checkTimeoutMs * 10);
        return;
      }

      if (product.offers.availability === 'https://schema.org/InStock') {
        const text = new BotMessageText(BotMessageText.bold(`🎉 Розмір ${this.productSize} в наявності! 🎉`))
          .newLine()
          .newLine()
          .addLine(`Мерщій замовляти:`)
          .add(BotMessageText.link({ url: product.offers.url }, product.name)).add(`, ${product.offers.price} ${product.offers.priceCurrency}`);
        this.botService.sendPhotoToEshop(product.image, text);
        return;
      }
    } catch (error) {
      this.logger.error(`Error while checking size availability: ${error.message}`, error.stack);
      this.botService.sendMessageToOwner(new BotMessageText(`Error while checking size availability: ${error.message}`));
    }

    this.checkTimeout = setTimeout(() => {
      this.checkSizeAvailability().then();
    }, this.checkTimeoutMs);
  }

  private async sendEshopInfo(): Promise<void> {
    try {
      const products = await this.parseEshopPage();
      const sizesAvailability = products.map(product => {
        return {
          size: product.size,
          isAvailable: product.offers.availability === 'https://schema.org/InStock',
        };
      });
      
      const text = new BotMessageText(BotMessageText.link({ url: products[0].offers.url }, products[0].name))
        .addLine(`${products[0].offers.price} ${products[0].offers.priceCurrency}`)
        .newLine();
      for (const size of sizesAvailability) {
        text.addLine(`${BotMessageText.bold(BotMessageText.inlineCode(size.size))}: ${size.isAvailable ? `В наявності` : `Немає в наявності 🙅‍♀️😞`}`);

        if (this.productSize === size.size) {
          text.prependToLastLine(` (відстежується)`);
        }
      }
      this.botService.sendPhotoToEshop(products[0].image, text);
    } catch (error) {
      this.logger.error(`Error while sending eshop info: ${error.message}`, error.stack);
      this.botService.sendMessageToOwner(new BotMessageText(`Error while sending eshop info: ${error.message}`));
    }
  }

  private async parseEshopPage(): Promise<any> {
    let page: puppeteer.Page | null = null;
    try {
      if (!this.browser) {
        await this.startBrowser();
      }

      page = await this.browser.newPage();

      // Set viewport to mimic a real browser
      await page.setViewport({
        width: 1920,
        height: 1080,
      });

      // Set user agent using new non-deprecated syntax
      await page.setUserAgent({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        platform: 'macOS',
      });

      // Set extra headers
      await page.setExtraHTTPHeaders({
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'cache-control': 'no-cache',
        'dnt': '1',
        'pragma': 'no-cache',
        'priority': 'u=0, i',
        'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      });

      // Remove webdriver property to avoid detection
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
      });

      // Navigate to the page with a more lenient wait strategy
      // Using 'domcontentloaded' instead of 'networkidle2' to avoid timeout
      // on sites with continuous network activity
      try {
        await page.goto(this.pageUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      } catch (error) {
        // If domcontentloaded times out, try with just 'load'
        this.logger.warn('domcontentloaded timeout, trying with load strategy');
        await page.goto(this.pageUrl, {
          waitUntil: 'load',
          timeout: 60000,
        });
      }

      // Wait a bit for any dynamic content and JavaScript to execute
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Extract JSON-LD Product data
      const products = await page.evaluate(() => {
        const products: any[] = [];
        
        // Find all script tags with type="application/ld+json"
        const scriptTags = document.querySelectorAll('script[type="application/ld+json"]');
        
        scriptTags.forEach((script) => {
          try {
            const jsonData = JSON.parse(script.textContent || '');
            
            // Handle both single objects and arrays
            const dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];
            
            dataArray.forEach((item) => {
              // Check if it's a Product type
              if (item['@type'] === 'Product' || item['@type'] === 'https://schema.org/Product') {
                products.push(item);
              }
              
              // Also check if it's a graph with items
              if (item['@graph'] && Array.isArray(item['@graph'])) {
                item['@graph'].forEach((graphItem: any) => {
                  if (graphItem['@type'] === 'Product' || graphItem['@type'] === 'https://schema.org/Product') {
                    products.push(graphItem);
                  }
                });
              }
            });
          } catch (error) {
          }
        });
        
        return products;
      });

      return products;

    } catch (error) {
      throw error;
    } finally {
      if (page) {
        await page.close();
      }
    }
  }
}