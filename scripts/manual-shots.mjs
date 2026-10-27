// Renders the manual screenshots docs/images/layout-desktop-light.png and layout-phone.png.
// Usage: npm run build && npx vite preview --port 4173 & node scripts/manual-shots.mjs http://localhost:4173/
import { chromium, devices } from 'playwright';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] ?? 'http://localhost:4173/';
const dir = fileURLToPath(new URL('../docs/images', import.meta.url));
// No service worker: its "saved for offline use" toast would cover the screenshot.
const common = { colorScheme: 'light', locale: 'en-US', serviceWorkers: 'block' };

const browser = await chromium.launch();
let ctx = await browser.newContext({ ...common, viewport: { width: 1440, height: 860 } });
let page = await ctx.newPage();
await page.goto(url);
await page.waitForSelector('#play-song');
await page.locator('[data-tab="file"]').click();
await page.mouse.move(0, 400);
await page.waitForTimeout(500);
await page.screenshot({ path: `${dir}/layout-desktop-light.png` });
await ctx.close();

ctx = await browser.newContext({ ...devices['iPhone 13'], ...common, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page = await ctx.newPage();
await page.goto(url);
await page.waitForSelector('#play-song');
await page.waitForTimeout(500);
await page.screenshot({ path: `${dir}/layout-phone.png` });
await browser.close();
console.log(`wrote ${dir}/layout-desktop-light.png, layout-phone.png`);
