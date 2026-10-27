/**
 * Browser smoke test of the built site:
 *
 *   npm run build && npm run smoke -- [screenshot-dir] [--chromium | --firefox | --webkit]
 *
 * Serves dist/ and checks, in headless Chromium (default), Firefox or WebKit:
 *
 * - at desktop, laptop, tablet and phone sizes (in WebKit: emulated iPhones and an iPad) the
 *   tracker loads without errors and without sideways scrolling, Play starts and Stop stops,
 *   and on phones the bottom bar switches between the pattern, list and editor views;
 * - typing notes on the computer keyboard and tapping the on-screen piano and keypad change the song,
 *   and the song survives a reload (localStorage);
 * - every export (song JSON, WAV, VGM, GBS, ROM, GBDK zip) hands over a file with the right
 *   header;
 * - the theme button cycles auto, light and dark.
 *
 * Headless Firefox and WebKit on CI have no sound device and their audio clock may never run,
 * so the check that the play cursor moves through the rows runs in Chromium only.
 * Screenshots go to the given folder.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, firefox, webkit } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const root = new URL('../dist/', import.meta.url).pathname;
const args = process.argv.slice(2);
const engine = args.includes('--firefox') ? 'firefox' : args.includes('--webkit') ? 'webkit' : 'chromium';
const shots = args.find((arg) => !arg.startsWith('--'));
if (shots) mkdirSync(shots, { recursive: true });

const { base, server } = await serveDist(root);

const browser =
  engine === 'firefox'
    ? await firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 } })
    : engine === 'webkit'
      ? await webkit.launch()
      : await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
console.log(`browser: ${engine} ${browser.version()}`);

/** Context options per screen. WebKit gets real device profiles (iOS user agent, touch, DPR). */
const screens =
  engine === 'webkit'
    ? [
        { name: 'iphone-15', ...devices['iPhone 15'] },
        { name: 'iphone-se', ...devices['iPhone SE'] },
        { name: 'iphone-15-landscape', ...devices['iPhone 15 landscape'] },
        { name: 'ipad-mini', ...devices['iPad Mini'] },
        { name: 'desktop-safari', viewport: { width: 1440, height: 900 } },
      ]
    : [
        { name: 'desktop', viewport: { width: 1440, height: 900 } },
        { name: 'laptop', viewport: { width: 1280, height: 720 } },
        { name: 'tablet', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
        { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
        { name: 'phone-landscape', viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true },
        { name: 'small-phone', viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true },
        { name: 'short-phone-landscape', viewport: { width: 734, height: 343 }, hasTouch: true, isMobile: true },
      ];

const failures = [];

async function open(screen) {
  const { name, defaultBrowserType, ...options } = screen;
  // Firefox has no mobile emulation; touch and the small viewport still apply.
  if (engine === 'firefox') delete options.isMobile;
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block', acceptDownloads: true, ...options });
  // Without this, an action that never completes (such as a tap) waits forever.
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#pattern .prow');
  return { context, page, errors };
}

async function check(name, run) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Clicks or taps, whichever the screen uses. */
async function press(page, locator, touch) {
  if (touch) await locator.tap();
  else await locator.click();
}

/** The song as the app keeps it in localStorage (saved 400 ms after a change). */
async function storedSong(page) {
  await page.waitForTimeout(600);
  return page.evaluate(() => localStorage.getItem('gb-tracker.song'));
}

for (const screen of screens) {
  const touch = !!screen.hasTouch;
  const phone = (screen.viewport?.width ?? 0) < 760;

  await check(`${screen.name}: loads, fits the screen, plays and stops`, async () => {
    const { context, page, errors } = await open(screen);
    try {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `page scrolls sideways by ${overflow}px`);
      assert((await page.locator('#pattern .prow').count()) > 0, 'the pattern shows no rows');

      const play = page.locator('#play-song');
      await press(page, play, touch);
      await page.waitForFunction(() => document.querySelector('#play-song')?.getAttribute('aria-pressed') === 'true');
      assert(await page.locator('#play-led.on').isVisible(), 'the play LED did not light up');
      if (engine === 'chromium') {
        // The worklet reports each row it plays; the play cursor must reach a later row.
        await page.waitForFunction(() => Number(document.querySelector('.play-row')?.dataset.row ?? 0) > 2, null, { timeout: 10000 });
      } else {
        await page.waitForTimeout(500);
      }
      if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}.png`) });
      await press(page, page.locator('#stop'), touch);
      await page.waitForFunction(() => document.querySelector('#play-song')?.getAttribute('aria-pressed') === 'false');
      assert(!(await page.locator('#play-led.on').count()), 'the play LED stayed on after Stop');
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  });

  if (phone) {
    await check(`${screen.name}: bottom bar switches views`, async () => {
      const { context, page, errors } = await open(screen);
      try {
        const nav = page.locator('.mobile-nav');
        assert(await nav.isVisible(), 'the bottom bar is not shown on a phone');
        const views = [
          ['lists', '.sidebar.left'],
          ['edit', '.sidebar.right'],
          ['pattern', '.editor'],
        ];
        for (const [view, selector] of views) {
          await press(page, nav.locator(`[data-view="${view}"]`), touch);
          assert(await page.locator(selector).isVisible(), `${view}: ${selector} is not shown`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert(overflow <= 1, `${view}: page scrolls sideways by ${overflow}px`);
          if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-${view}.png`) });
        }
        assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    });
  }

  if (touch) {
    await check(`${screen.name}: piano and keypad enter notes`, async () => {
      const { context, page, errors } = await open(screen);
      try {
        const note = () => page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]').textContent();
        // Put the cursor on row 00, channel 1, note field, clear it, then play E on the piano
        // and enter a note-off from the keypad.
        await press(page, page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]'), touch);
        assert(await page.locator('#piano').isVisible(), 'the piano is not shown');
        assert(await page.locator('#keypad').isVisible(), 'the keypad is not shown');
        const rows = await page.locator('#pattern').evaluate((el) => el.clientHeight);
        assert(rows >= 64, `the piano and keypad leave the pattern only ${rows}px`);
        await press(page, page.locator('#keypad [data-act="del"]'), touch);
        await press(page, page.locator('#keypad [data-act="up"]'), touch);
        assert((await note()) === '···', `row 00 still shows ${await note()} after DEL`);
        // The third white key from the left is an E.
        await press(page, page.locator('#piano .pkey.white').nth(2), touch);
        assert(/^E-\d$/.test(await note()), `tapping E on the piano wrote ${await note()}`);
        await press(page, page.locator('#keypad [data-act="up"]'), touch);
        await press(page, page.locator('#keypad [data-act="off"]'), touch);
        assert((await note()) === '===', `tapping OFF wrote ${await note()}`);

        // With the piano hidden the keypad has note keys instead.
        await press(page, page.locator('#piano-toggle'), touch);
        assert(await page.locator('#piano').isHidden(), 'KEYS did not hide the piano');
        await press(page, page.locator('#keypad [data-act="up"]'), touch);
        await press(page, page.locator('#keypad [data-semi="7"]'), touch);
        assert(/^G-\d$/.test(await note()), `tapping G on the keypad wrote ${await note()}`);
        assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    });
  }
}

const desktop = screens.find((s) => !s.hasTouch);

await check('keyboard note entry is saved and survives a reload', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    // Start from an empty song so the test does not depend on the demo.
    await page.locator('.tabs [data-tab="file"]').click();
    await page.locator('#f-new').click();
    await page.waitForTimeout(100);
    const empty = await storedSong(page);
    await page.locator('#pattern .prow[data-row="0"] [data-ch="0"][data-f="0"]').click();
    // Z, S, X are C, C#, D in the lower keyboard octave.
    for (const k of ['KeyZ', 'KeyS', 'KeyX']) await page.keyboard.press(k);
    const cells = await page.$$eval('#pattern .prow', (rows) => rows.slice(0, 3).map((r) => r.querySelector('.f0')?.textContent));
    assert(cells.every((t) => /^[A-G][-#]\d$/.test(t ?? '')), `rows 00-02 show ${cells.join(', ')}, expected three notes`);
    const saved = await storedSong(page);
    assert(saved && saved !== empty, 'the typed notes were not saved');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#pattern .prow');
    const reloaded = await page.$$eval('#pattern .prow', (rows) => rows.slice(0, 3).map((r) => r.querySelector('.f0')?.textContent));
    assert(reloaded.join() === cells.join(), `after a reload rows 00-02 show ${reloaded.join(', ')}`);
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

async function download(page, id, timeout = 20000) {
  const pending = page.waitForEvent('download', { timeout });
  await page.locator(`#${id}`).click();
  const file = await pending;
  const failure = await file.failure();
  assert(!failure, `${id}: download failed: ${failure}`);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

const NINTENDO_LOGO = Buffer.from('CEED6666CC0D000B03730083000C000D0008111F8889000EDCCC6EE6DDDDD999BBBB67636E0EECCCDDDC999FBBB9333E', 'hex');
const exports = [
  ['f-save', /\.gbt\.json$/, (b) => typeof JSON.parse(b.toString('utf8')).patterns === 'object'],
  ['x-wav', /\.wav$/, (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE' && b.length > 10000],
  ['x-vgm', /\.vgm$/, (b) => b.subarray(0, 4).toString('latin1') === 'Vgm '],
  ['x-gbs', /\.gbs$/, (b) => b.subarray(0, 3).toString('latin1') === 'GBS'],
  ['x-rom', /\.gbc?$/, (b) => b.subarray(0x104, 0x134).equals(NINTENDO_LOGO)],
  ['x-gbdk', /\.zip$/, (b) => b.subarray(0, 2).toString('latin1') === 'PK'],
];

await check('every export hands over a valid file', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    await page.locator('.tabs [data-tab="file"]').click();
    for (const [id, name, valid] of exports) {
      const file = await download(page, id, 120000);
      assert(name.test(file.name), `${id}: file is called ${file.name}`);
      assert(valid(file.bytes), `${id}: ${file.name} (${file.bytes.length} bytes) has a wrong header`);
    }
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

await check('theme button cycles auto, light and dark', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
    const seen = [await theme()];
    for (let i = 0; i < 3; i++) {
      await page.locator('#theme').click();
      seen.push(await theme());
    }
    assert(seen.join() === 'auto,light,dark,auto', `theme went ${seen.join(' → ')}`);
    assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
});

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed in ${engine}`);
  process.exit(1);
}
console.log(`\nall checks passed in ${engine}`);
