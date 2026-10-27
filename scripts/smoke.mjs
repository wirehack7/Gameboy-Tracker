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
 * - the theme button cycles auto, light and dark;
 * - German, Spanish and French browsers get their UI language, still without sideways scrolling;
 * - the manual page loads its sections, contents list and images on desktop and phone;
 * - the scope traces stay centred while playing (Chromium) and the piano keys keep their size at every octave.
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

async function open(screen, { locale = 'en-US', path = '', ready = '#pattern .prow' } = {}) {
  const { name, defaultBrowserType, ...options } = screen;
  // Firefox has no mobile emulation; touch and the small viewport still apply.
  if (engine === 'firefox') delete options.isMobile;
  const context = await browser.newContext({ locale, serviceWorkers: 'block', acceptDownloads: true, ...options });
  // Without this, an action that never completes (such as a tap) waits forever.
  context.setDefaultTimeout(15000);
  const page = await context.newPage();
  const errors = [];
  // Firefox rejects the old page's pending promises with this when it reloads; that is not a bug.
  const unload = /Navigated away from page/;
  page.on('pageerror', (e) => unload.test(e.message) || errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !unload.test(m.text()) && errors.push(m.text()));
  await page.goto(base + path, { waitUntil: 'load' });
  await page.waitForSelector(ready);
  return { context, page, errors };
}

/** Rejects when `promise` takes longer than `ms`: a hung browser call must fail, not stall CI. */
function within(ms, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took longer than ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function check(name, run) {
  try {
    await within(180000, run());
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
        // The scope traces stay centred while playing (the DAC output is unipolar).
        const off = await page.evaluate(() =>
          [...document.querySelectorAll('#chan-head canvas')].map((c) => {
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let top = c.height;
            let bottom = -1;
            for (let i = 3; i < d.length; i += 4)
              if (d[i] > 100) {
                const y = Math.floor((i - 3) / 4 / c.width);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
              }
            return bottom < 0 ? 1 : Math.abs((top + bottom) / 2 / c.height - 0.5);
          }),
        );
        assert(off.every((o) => o < 0.2), `scope traces are off-centre by ${off.map((o) => o.toFixed(2)).join(' ')}`);
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

  await check(`${screen.name}: piano keys keep their size at every octave`, async () => {
    const { context, page, errors } = await open(screen);
    try {
      const width = () => page.locator('#piano .pkey.white').first().evaluate((el) => el.getBoundingClientRect().width);
      const first = await width();
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press(']');
        const w = await width();
        assert(Math.abs(w - first) < 1, `white keys are ${w.toFixed(1)}px at octave ${await page.textContent('#oct')}, ${first.toFixed(1)}px before`);
      }
      assert((await page.textContent('#oct')) === '8', '] did not raise the octave to 8');
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
        // The keypad comes with a coarse pointer or a narrow screen. Firefox has no mobile
        // emulation, so a wide touch screen there reports a fine pointer and shows no keypad.
        if (!(await page.evaluate(() => matchMedia('(pointer: coarse), (max-width: 759px)').matches))) {
          assert(engine === 'firefox', 'a touch screen reports a fine pointer');
          console.log(`skip ${screen.name}: Firefox reports a fine pointer at this width`);
          return;
        }
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

/** A mono 16-bit WAV file of `seconds` of `fn(t)` (t in seconds). */
function wavFile(name, seconds, fn, rate = 22050) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(20000 * fn(i / rate)), 44 + i * 2);
  return { name, mimeType: 'audio/wav', buffer: b };
}

await check('audio imports as a waveform and as a sample that goes into the exports', async () => {
  const { context, page, errors } = await open(desktop);
  try {
    await page.locator('.tabs [data-tab="wave"]').click();
    const hexBefore = await page.inputValue('#w-hex');
    await page.setInputFiles('#w-file', wavFile('organ.wav', 0.5, (t) => Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 660 * t)));
    await page.waitForFunction((before) => document.querySelector('#w-hex')?.value !== before, hexBefore);
    await page.setInputFiles('#s-file', wavFile('kick.wav', 0.3, (t) => Math.exp(-t * 15) * Math.sin(2 * Math.PI * (60 + 200 * Math.exp(-t * 40)) * t)));
    await page.waitForSelector('[data-splay="0"]');
    await page.locator('[data-splay="0"]').click();
    await page.locator('.tabs [data-tab="inst"]').click();
    await page.locator('[data-kind="wave"]').click();
    await page.selectOption('#i-sample', '0');
    const song = JSON.parse(await storedSong(page));
    assert(song.samples?.length === 1 && song.samples[0].name === 'kick', `samples: ${JSON.stringify(song.samples?.map((x) => x.name))}`);
    assert(Math.abs(song.samples[0].data.length / 7936 - 0.3) < 0.05, `sample length ${song.samples[0].data.length}`);
    assert(song.waveInstruments[0].sample === 0, 'the wave instrument does not use the sample');
    // GBS files of songs with samples run from the timer at 256 Hz.
    await page.locator('.tabs [data-tab="file"]').click();
    const gbs = await download(page, 'x-gbs', 120000);
    assert(gbs.bytes[0x0e] === 0xc0 && gbs.bytes[0x0f] === 0x07, `GBS timer ${gbs.bytes[0x0e]}/${gbs.bytes[0x0f]}`);
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

const phone = screens.find((s) => s.hasTouch && (s.viewport?.width ?? 0) < 760);

for (const [locale, lang] of [['de-DE', 'de'], ['es-ES', 'es'], ['fr-FR', 'fr']]) {
  await check(`${locale} browser gets the ${lang} UI and it fits a phone`, async () => {
    for (const screen of [desktop, phone]) {
      const { context, page, errors } = await open(screen, { locale });
      try {
        const got = await page.evaluate(() => document.documentElement.lang);
        assert(got === lang, `${screen.name}: page language is ${got}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 1, `${screen.name}: page scrolls sideways by ${overflow}px`);
        if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-${lang}.png`) });
        assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    }
  });
}

await check('manual loads with its contents and images', async () => {
  for (const screen of [desktop, phone]) {
    const { context, page, errors } = await open(screen, { path: 'manual.html', ready: '.m-doc h2' });
    try {
      const { headings, links, images } = await page.evaluate(() => ({
        headings: document.querySelectorAll('.m-doc h2').length,
        links: document.querySelectorAll('#m-nav a').length,
        // The images load lazily, so fetch them instead of waiting for them to scroll into view.
        images: [...document.querySelectorAll('.m-doc img')].map((img) => img.src),
      }));
      const broken = [];
      for (const src of images) {
        const res = await page.request.get(src);
        if (!res.ok() || !/^image\//.test(res.headers()['content-type'] ?? '')) broken.push(src);
      }
      assert(headings >= 3, `${screen.name}: the manual has only ${headings} sections`);
      assert(links >= 3, `${screen.name}: the contents list has only ${links} links`);
      assert(broken.length === 0, `${screen.name}: images do not load: ${broken.join(', ')}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `${screen.name}: the manual scrolls sideways by ${overflow}px`);
      if (shots) await page.screenshot({ path: join(shots, `${engine}-${screen.name}-manual.png`) });
      assert(errors.length === 0, `errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }
});

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed in ${engine}`);
  process.exit(1);
}
console.log(`\nall checks passed in ${engine}`);
