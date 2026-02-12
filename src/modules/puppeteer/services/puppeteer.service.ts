import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';
import { CONFIG } from '../../../config';

const RELAUNCH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
];

@Injectable()
export class PuppeteerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);

  private browser: Browser | null = null;
  private inUseCount = 0;
  private whenIdleResolve: (() => void) | null = null;
  private whenIdlePromise = Promise.resolve();
  private relaunchMutex = Promise.resolve();
  private relaunchMutexResolve: (() => void) | null = null;
  private relaunchTimer?: NodeJS.Timeout;

  async onApplicationBootstrap(): Promise<void> {
    puppeteer.use(StealthPlugin());

    try {
      await this.launch();
      this.logger.log('Browser launched');
      this.scheduleRelaunch();
    } catch (e) {
      this.logger.error(`Browser launch failed: ${e.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.relaunchTimer) {
      clearTimeout(this.relaunchTimer);
    }
    try {
      await this.close();

      this.logger.log('Browser closed');
    } catch (e) {
      this.logger.error(`Browser close failed: ${e.message}`);
    }
  }

  /**
   * Execute a function with a new page. The page is created and closed automatically.
   * Relaunch waits for all in-flight executions to finish, then restarts the browser.
   * New calls wait if a relaunch is in progress.
   */
  async executeWithPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    await this.relaunchMutex;
    this.inUseCount++;
    if (this.inUseCount === 1) {
      this.whenIdlePromise = new Promise<void>((resolve) => {
        this.whenIdleResolve = resolve;
      });
    }
    try {
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      try {
        return await fn(page);
      } finally {
        await page.close();
      }
    } finally {
      this.inUseCount--;
      if (this.inUseCount === 0) {
        this.whenIdleResolve?.();
        this.whenIdleResolve = null;
      }
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) {
      return this.browser;
    }
    await this.launch();
    return this.browser!;
  }

  private async launch(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: CONFIG.puppeteerExecutablePath || undefined,
      args: LAUNCH_ARGS,
    });
  }

  private async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private scheduleRelaunch(): void {
    this.relaunchTimer = setTimeout(async () => {
      this.relaunchMutex = new Promise<void>((resolve) => {
        this.relaunchMutexResolve = resolve;
      });
      await this.whenIdlePromise;
      try {
        await this.close();
        await this.launch();
      } catch (e) {
        this.logger.error(`Browser relaunch failed: ${(e as Error).message}`);
      } finally {
        this.relaunchMutexResolve?.();
        this.relaunchMutexResolve = null;
        this.relaunchMutex = Promise.resolve();
      }
      this.scheduleRelaunch();
    }, RELAUNCH_INTERVAL_MS);
  }
}
