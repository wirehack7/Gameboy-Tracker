import { t } from '../i18n';
import { SCREEN_H, SCREEN_W, createGame, drawGame, press, step } from './game';

const BEST_KEY = 'gb-tracker.about-best';
const REPO_URL = 'https://github.com/wirehack7/Gameboy-Tracker';
/** Keys that jump: Space, the arrow up, Enter and the keys emulators usually map to A. */
const JUMP_KEYS = new Set(['Space', 'ArrowUp', 'Enter', 'KeyX', 'KeyZ', 'KeyY']);

let dialog: HTMLDialogElement | null = null;

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeBest(best: number) {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    // Private mode: the high score is just not kept.
  }
}

const pad = (n: number) => String(n).padStart(5, '0');

/** Opens the About dialog with its mini game; built on first use, translated each time it opens. */
export function openAbout() {
  if (!dialog) dialog = buildDialog();
  dialog.querySelector('#about-close')!.setAttribute('aria-label', t('about.close'));
  dialog.querySelector('#about-body')!.innerHTML = body();
  dialog.dispatchEvent(new Event('about-open'));
  dialog.showModal();
}

function body() {
  const author = '<a href="https://github.com/wirehack7" target="_blank" rel="noopener">wirehack7</a>';
  return `
    <h2 id="about-title">GB TRACKER</h2>
    <p class="about-version" id="about-version">${t('about.version', { version: __APP_VERSION__ })}</p>
    <p>${t('about.text')}</p>
    <p>${t('about.credits', { author })}</p>
    <div class="btn-row">
      <a class="btn" id="about-repo" href="${REPO_URL}" target="_blank" rel="noopener">${t('about.repo')}</a>
      <a class="btn" id="about-manual" href="./manual.html" target="_blank" rel="noopener">${t('about.manual')}</a>
    </div>
    <div class="about-game">
      <div class="about-score"><span>${t('about.score')} <output id="about-score">${pad(0)}</output></span><span>${t('about.best')} <output id="about-best">${pad(readBest())}</output></span></div>
      <canvas id="about-lcd" width="${SCREEN_W}" height="${SCREEN_H}" aria-describedby="about-hint"></canvas>
      <div class="about-pad">
        <p class="hint" id="about-hint" aria-live="polite"></p>
        <button type="button" class="about-a" id="about-jump" aria-label="${t('about.jump')}" autofocus>A</button>
      </div>
    </div>`;
}

function buildDialog(): HTMLDialogElement {
  const el = document.createElement('dialog');
  el.className = 'about';
  el.id = 'about';
  el.setAttribute('aria-labelledby', 'about-title');
  el.innerHTML = `
    <form method="dialog" class="about-close"><button class="btn" id="about-close" value="close">✕</button></form>
    <div id="about-body"></div>`;
  document.body.append(el);

  let game = createGame();
  let best = 0;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let shownMode = '';
  const frame = 1000 / 60;

  const render = () => {
    const ctx = (el.querySelector('#about-lcd') as HTMLCanvasElement).getContext('2d')!;
    drawGame(ctx, game);
    el.querySelector('#about-score')!.textContent = pad(game.score);
    el.querySelector('#about-best')!.textContent = pad(best);
    if (game.mode !== shownMode) {
      shownMode = game.mode;
      el.querySelector('#about-hint')!.textContent = t(game.mode === 'over' ? 'about.over' : 'about.hint');
      el.dataset.game = game.mode;
    }
  };

  const tick = (now: number) => {
    // Fixed 60 Hz steps whatever the display rate; a long pause (hidden tab) is not caught up.
    acc = Math.min(acc + now - (last || now), 10 * frame);
    last = now;
    while (acc >= frame) {
      game = step(game);
      acc -= frame;
    }
    if (game.mode === 'over' && game.score > best) {
      best = game.score;
      writeBest(best);
    }
    render();
    raf = requestAnimationFrame(tick);
  };

  const jump = (e: Event) => {
    e.preventDefault();
    game = press(game);
    render();
  };

  el.addEventListener('about-open', () => {
    game = createGame();
    best = readBest();
    shownMode = '';
    last = 0;
    acc = 0;
    // The body is rebuilt on every open, so the canvas and the A button are new each time.
    el.querySelector('#about-lcd')!.addEventListener('pointerdown', jump);
    el.querySelector('#about-jump')!.addEventListener('pointerdown', jump);
    // Draw the first frame now, so the dialog never shows a blank screen or a stale state.
    render();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  el.addEventListener('close', () => cancelAnimationFrame(raf));
  el.addEventListener('keydown', (e) => {
    // Keep keys away from the tracker behind the dialog; Esc still closes it.
    e.stopPropagation();
    if (!JUMP_KEYS.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
    // Links and the close button keep their own Space / Enter.
    if ((e.target as HTMLElement).closest('a, button:not(#about-jump)')) return;
    if (e.repeat) e.preventDefault();
    else jump(e);
  });
  el.addEventListener('keyup', (e) => e.stopPropagation());
  // A click on the backdrop closes the dialog.
  el.addEventListener('click', (e) => {
    const r = el.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (e.target === el && !inside) el.close();
  });
  return el;
}
