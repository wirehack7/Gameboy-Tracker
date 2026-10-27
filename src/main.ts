import './style.css';
import { AudioClient } from './audio/client';
import { encodeWav, renderSong } from './export/wav';
import { NOTE_COUNT, noteName } from './tracker/notes';
import { FX } from './tracker/player';
import {
  CHANNEL_KINDS,
  CHANNEL_COUNT,
  EMPTY,
  INSTRUMENT_COUNT,
  NOTE_OFF,
  Song,
  WAVE_COUNT,
  WAVE_PRESETS,
  clonePattern,
  createSong,
  emptyPattern,
  parseSong,
} from './tracker/song';
import {
  Cursor,
  FIELDS,
  clearField,
  deleteRow,
  enterDigit,
  enterNote,
  formatCell,
  insertRow,
  jumpChannel,
  moveCursor,
  noteFromKey,
  transpose,
} from './ui/editor';

const STORAGE_KEY = 'gb-tracker.song';
const THEME_KEY = 'gb-tracker.theme';

// ------------------------------------------------------------------ storage

function loadStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) */
  }
}

function initialSong(): Song {
  const raw = loadStored(STORAGE_KEY);
  if (raw) {
    try {
      return parseSong(JSON.parse(raw));
    } catch {
      /* fall through to a new song */
    }
  }
  return demoSong();
}

/** A short demo so the first visit makes a sound. */
function demoSong(): Song {
  const s = createSong();
  s.title = 'Demo';
  const p = s.patterns[0];
  const n = (name: string) => {
    for (let i = 0; i < NOTE_COUNT; i++) if (noteName(i) === name) return i;
    return EMPTY;
  };
  const bass = ['C-3', 'C-3', 'G-2', 'A#2'];
  const lead = ['E-5', 'G-5', 'C-6', 'G-5', 'D-5', 'F-5', 'B-5', 'F-5'];
  s.pulseInstruments[0] = { ...s.pulseInstruments[0], name: 'Lead', duty: 2, volume: 12, envPeriod: 2 };
  s.pulseInstruments[1] = { ...s.pulseInstruments[1], name: 'Arp', duty: 1, volume: 9, envPeriod: 0 };
  s.waveInstruments[0] = { ...s.waveInstruments[0], name: 'Bass', wave: 0 };
  s.noiseInstruments[0] = { ...s.noiseInstruments[0], name: 'Kick', volume: 15, envPeriod: 1, narrow: false };
  s.noiseInstruments[1] = { ...s.noiseInstruments[1], name: 'Hat', volume: 8, envPeriod: 1, narrow: true };
  for (let r = 0; r < 64; r++) {
    if (r % 4 === 0) Object.assign(p.rows[r][0], { note: n(lead[(r / 4) % 8]), instrument: 0 });
    if (r % 16 === 0)
      Object.assign(p.rows[r][1], { note: n('C-4'), instrument: 1, effect: FX.ARPEGGIO, param: r % 32 ? 0x58 : 0x47 });
    if (r % 8 === 0) Object.assign(p.rows[r][2], { note: n(bass[(r / 16) | 0]), instrument: 0 });
    if (r % 8 === 4) Object.assign(p.rows[r][2], { note: n(bass[(r / 16) | 0]) + 12, instrument: 0 });
    if (r % 8 === 0) Object.assign(p.rows[r][3], { note: n('C-3'), instrument: 0 });
    else if (r % 4 === 2) Object.assign(p.rows[r][3], { note: n('C-8'), instrument: 1 });
  }
  return s;
}

// -------------------------------------------------------------------- state

let song = initialSong();
let order = 0;
let cursor: Cursor = { row: 0, ch: 0, field: 0 };
let octave = 4;
let step = 1;
let instrument = 0;
let lastNote = EMPTY;
let playing = false;
let playPos = { order: -1, row: -1 };
let follow = true;
const muted = [false, false, false, false];
let tab: 'inst' | 'wave' | 'song' | 'file' | 'help' = 'inst';
let instKind: 'pulse' | 'wave' | 'noise' = 'pulse';
let instIndex = 0;
let waveIndex = 0;

const audio = new AudioClient();
audio.setSong(song);

let saveTimer = 0;
function changed(structure = false) {
  audio.setSong(song);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => store(STORAGE_KEY, JSON.stringify(song)), 400);
  if (structure) renderAll();
}

const pattern = () => song.patterns[song.order[order]] ?? song.patterns[0];
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

// ---------------------------------------------------------------------- DOM

const app = document.getElementById('app')!;
app.className = 'gb';
app.innerHTML = `
  <header class="topbar">
    <span class="led on" title="Power"></span>
    <h1 class="logo">GB TRACKER<small>DMG · CGB</small></h1>
    <button class="icon-btn" id="theme" type="button"></button>
  </header>
  <div class="layout">
    <section aria-label="Pattern-Editor">
      <div class="bezel">
        <div class="bezel-top"><span class="stripe"></span>DOT MATRIX WITH STEREO SOUND<span class="stripe"></span></div>
        <div class="screen-row">
          <div class="battery"><span class="led" id="play-led"></span>PLAY</div>
          <div class="lcd">
            <div class="lcd-head">
              <span class="nav">ORD <button type="button" id="ord-prev" aria-label="Vorherige Position">◀</button><span id="ord"></span><button type="button" id="ord-next" aria-label="Nächste Position">▶</button></span>
              <span id="pat"></span>
              <span class="nav">OCT <button type="button" id="oct-down" aria-label="Oktave runter">-</button><span id="oct"></span><button type="button" id="oct-up" aria-label="Oktave hoch">+</button></span>
              <span class="nav">INS <button type="button" id="ins-down" aria-label="Instrument zurück">-</button><span id="ins"></span><button type="button" id="ins-up" aria-label="Instrument vor">+</button></span>
              <span class="nav">STP <button type="button" id="stp" aria-label="Schrittweite"></button></span>
              <span id="model"></span>
            </div>
            <div class="scopes" id="scopes"></div>
            <div class="chan-head" id="chan-head"></div>
            <div class="pattern" id="pattern" tabindex="0" role="grid" aria-label="Pattern"></div>
          </div>
        </div>
      </div>
      <div class="controls">
        <div class="dpad" aria-label="Cursor">
          <button class="up" type="button" data-move="up" aria-label="Hoch">▲</button>
          <button class="left" type="button" data-move="left" aria-label="Links">◀</button>
          <span class="mid"></span>
          <button class="right" type="button" data-move="right" aria-label="Rechts">▶</button>
          <button class="down" type="button" data-move="down" aria-label="Runter">▼</button>
        </div>
        <div class="pills">
          <div class="pill"><button type="button" id="btn-select" aria-label="Select: Pattern abspielen"></button>SELECT</div>
          <div class="pill"><button type="button" id="btn-start" aria-label="Start: Song abspielen/stoppen"></button>START</div>
        </div>
        <div class="ab">
          <div class="round"><button type="button" id="btn-b" aria-label="B: Feld löschen"></button>B</div>
          <div class="round"><button type="button" id="btn-a" aria-label="A: letzte Note einfügen"></button>A</div>
        </div>
      </div>
      <div class="keypad" id="keypad"></div>
    </section>
    <aside class="panels">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="inst">INSTR</button>
        <button type="button" role="tab" data-tab="wave">WAVE</button>
        <button type="button" role="tab" data-tab="song">SONG</button>
        <button type="button" role="tab" data-tab="file">DATEI</button>
        <button type="button" role="tab" data-tab="help">HILFE</button>
      </div>
      <div class="panel" id="panel"></div>
    </aside>
  </div>
  <div class="toast" id="toast" role="status"></div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const patternEl = $('pattern');

let toastTimer = 0;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

// -------------------------------------------------------------------- theme

function applyTheme(theme: string | null) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $('theme').textContent = theme === 'dark' ? '☾ DARK' : theme === 'light' ? '☀ LIGHT' : '◐ AUTO';
}
applyTheme(loadStored(THEME_KEY));
$('theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ?? 'auto';
  const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
  store(THEME_KEY, next);
  applyTheme(next);
});

// ------------------------------------------------------------------ pattern

const KIND_LABEL = { pulse: 'PU', wave: 'WAV', noise: 'NOI' };

function renderHeader() {
  $('ord').textContent = `${hex2(order)}/${hex2(song.order.length - 1)}`;
  $('pat').textContent = `PAT ${hex2(song.order[order])}`;
  $('oct').textContent = String(octave);
  $('ins').textContent = (instrument + 1).toString(16).toUpperCase();
  $('stp').textContent = String(step);
  $('model').textContent = song.model === 'cgb' ? '[CGB]' : '[DMG]';
  $('chan-head').innerHTML =
    '<span class="num">  </span>' +
    CHANNEL_KINDS.map((k, i) => `<span class="cell">CH${i + 1} ${KIND_LABEL[k]}${k === 'pulse' ? i + 1 : ''}</span>`).join('');
}

function rowHtml(r: number) {
  const rows = pattern().rows;
  const cls = ['prow'];
  if (r % 4 === 0) cls.push('beat');
  if (r === cursor.row) cls.push('cursor-row');
  if (playing && playPos.row === r && playPos.order === order) cls.push('play-row');
  let html = `<div class="${cls.join(' ')}" data-row="${r}"><span class="num">${hex2(r)}</span>`;
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const fields = formatCell(rows[r][ch]);
    html += '<span class="cell">';
    fields.forEach((text, f) => {
      const empty = text.startsWith('-') ? ' empty' : '';
      const cur = r === cursor.row && ch === cursor.ch && f === cursor.field ? ' cursor' : '';
      html += `<span class="f${f}${empty}${cur}" data-ch="${ch}" data-f="${f}">${text}</span>`;
    });
    html += '</span>';
  }
  return html + '</div>';
}

function renderPattern() {
  const rows = pattern().rows;
  let html = '';
  for (let r = 0; r < rows.length; r++) html += rowHtml(r);
  patternEl.innerHTML = html;
  scrollToRow(playing && follow && playPos.order === order ? playPos.row : cursor.row);
}

function updateRow(r: number) {
  const el = patternEl.children[r];
  if (el) el.outerHTML = rowHtml(r);
}

function scrollToRow(r: number) {
  const el = patternEl.children[r] as HTMLElement | undefined;
  if (!el) return;
  const top = el.offsetTop - patternEl.offsetTop;
  const target = top - patternEl.clientHeight / 2 + el.offsetHeight / 2;
  patternEl.scrollTop = Math.max(0, target);
}

function setCursor(next: Cursor) {
  const prevRow = cursor.row;
  cursor = next;
  updateRow(prevRow);
  if (next.row !== prevRow) updateRow(next.row);
  if (!(playing && follow)) scrollToRow(cursor.row);
  renderKeypad();
}

function setOrder(o: number) {
  order = Math.max(0, Math.min(song.order.length - 1, o));
  if (cursor.row >= pattern().rows.length) cursor = { ...cursor, row: 0 };
  renderHeader();
  renderPattern();
  if (tab === 'song') renderPanel();
}

// Keep the channel header aligned when the pattern scrolls sideways on small screens.
patternEl.addEventListener('scroll', () => ($('chan-head').scrollLeft = patternEl.scrollLeft));

patternEl.addEventListener('pointerdown', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
  if (!row) return;
  const r = Number(row.dataset.row);
  if (t) setCursor({ row: r, ch: Number(t.dataset.ch), field: Number(t.dataset.f) });
  else setCursor({ ...cursor, row: r });
});

// ------------------------------------------------------------------ editing

function editCell(fn: (c: ReturnType<typeof pattern>['rows'][0][0]) => void, advance = true) {
  const r = cursor.row;
  fn(pattern().rows[r][cursor.ch]);
  changed();
  updateRow(r);
  if (advance && step) setCursor(moveCursor(cursor, pattern().rows.length, step));
}

async function ensureAudio() {
  await audio.start();
}

function preview(ch: number, note: number) {
  if (note < 0) return;
  void ensureAudio();
  audio.send({ type: 'preview', channel: ch, note, instrument });
}

function release(ch: number) {
  if (!playing) audio.send({ type: 'release', channel: ch });
}

function putNote(note: number) {
  if (note !== NOTE_OFF) lastNote = note;
  const ch = cursor.ch;
  editCell((c) => enterNote(c, note, instrument));
  if (note >= 0) preview(ch, note);
}

function putDigit(d: number) {
  editCell((c) => enterDigit(c, cursor.field, d));
}

function clearCurrent() {
  editCell((c) => clearField(c, cursor.field));
}

function togglePlay(loopPattern = false) {
  void ensureAudio();
  if (playing) {
    playing = false;
    audio.send({ type: 'stop' });
  } else {
    playing = true;
    audio.send({ type: 'play', order, row: loopPattern ? cursor.row : 0, loopPattern });
  }
  $('play-led').classList.toggle('on', playing);
  renderPattern();
}

audio.onRow = (o, r) => {
  if (!playing) return;
  const prev = playPos;
  playPos = { order: o, row: r };
  if (follow && o !== order) {
    order = o;
    renderHeader();
    renderPattern();
    return;
  }
  if (prev.order === order) updateRow(prev.row);
  if (o === order) {
    updateRow(r);
    if (follow) scrollToRow(r);
  }
};

const noteKeysDown = new Map<string, number>();

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const rows = pattern().rows.length;
  const field = FIELDS[cursor.field];
  let handled = true;

  switch (e.code) {
    case 'ArrowUp':
      setCursor(moveCursor(cursor, rows, -1));
      break;
    case 'ArrowDown':
      setCursor(moveCursor(cursor, rows, 1));
      break;
    case 'ArrowLeft':
      setCursor(moveCursor(cursor, rows, 0, -1));
      break;
    case 'ArrowRight':
      setCursor(moveCursor(cursor, rows, 0, 1));
      break;
    case 'PageUp':
      setCursor({ ...cursor, row: Math.max(0, cursor.row - 16) });
      break;
    case 'PageDown':
      setCursor({ ...cursor, row: Math.min(rows - 1, cursor.row + 16) });
      break;
    case 'Home':
      setCursor({ ...cursor, row: 0 });
      break;
    case 'End':
      setCursor({ ...cursor, row: rows - 1 });
      break;
    case 'Tab':
      setCursor(jumpChannel(cursor, e.shiftKey ? -1 : 1));
      break;
    case 'Space':
      togglePlay(e.shiftKey);
      break;
    case 'Delete':
    case 'Backspace':
      clearCurrent();
      break;
    case 'Insert':
      insertRow(pattern(), cursor.ch, cursor.row);
      changed();
      renderPattern();
      break;
    case 'BracketLeft':
    case 'NumpadSubtract':
      octave = Math.max(2, octave - 1);
      renderHeader();
      break;
    case 'BracketRight':
    case 'NumpadAdd':
      octave = Math.min(8, octave + 1);
      renderHeader();
      break;
    default:
      handled = false;
  }
  if (handled) {
    e.preventDefault();
    return;
  }
  if (e.repeat) return;

  if (field === 'note') {
    if (e.code === 'Digit1' || e.code === 'Backquote') {
      putNote(NOTE_OFF);
      e.preventDefault();
      return;
    }
    const note = noteFromKey(e.code, octave);
    if (note !== null) {
      noteKeysDown.set(e.code, cursor.ch);
      putNote(note);
      e.preventDefault();
    }
    return;
  }
  const digit = /^[0-9a-f]$/i.test(e.key) ? parseInt(e.key, 16) : -1;
  if (digit >= 0) {
    putDigit(digit);
    e.preventDefault();
  }
});

document.addEventListener('keyup', (e) => {
  const ch = noteKeysDown.get(e.code);
  if (ch !== undefined) {
    noteKeysDown.delete(e.code);
    if (noteKeysDown.size === 0) release(ch);
  }
});

// ------------------------------------------------------------ touch keypad

const keypadEl = $('keypad');
function key(label: string, cls: string, data: string) {
  return `<button type="button" class="key ${cls}" ${data}>${label}</button>`;
}

function renderKeypad() {
  const isNote = FIELDS[cursor.field] === 'note';
  const kind = keypadEl.dataset.kind;
  if (kind === (isNote ? 'note' : 'hex') && keypadEl.dataset.oct === String(octave)) return;
  keypadEl.dataset.kind = isNote ? 'note' : 'hex';
  keypadEl.dataset.oct = String(octave);
  if (isNote) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keys = names.map((n, i) => key(n, n.includes('#') ? 'sharp' : '', `data-semi="${i}"`));
    keypadEl.innerHTML = `
      <div class="row">${keys.slice(0, 6).join('')}</div>
      <div class="row">${keys.slice(6).join('')}</div>
      <div class="row">
        ${key('OCT-', 'action', 'data-act="oct-"')}${key('OCT ' + octave, 'action', 'data-act="none"')}${key('OCT+', 'action', 'data-act="oct+"')}
        ${key('OFF', 'action', 'data-act="off"')}${key('DEL', 'red', 'data-act="del"')}
      </div>`;
  } else {
    const keys = Array.from({ length: 16 }, (_, i) => key(i.toString(16).toUpperCase(), '', `data-hex="${i}"`));
    keypadEl.innerHTML = `
      <div class="row">${keys.slice(0, 8).join('')}</div>
      <div class="row">${keys.slice(8).join('')}</div>
      <div class="row">${key('◀ FELD', 'action', 'data-act="prev"')}${key('FELD ▶', 'action', 'data-act="next"')}${key('DEL', 'red', 'data-act="del"')}</div>`;
  }
}

keypadEl.addEventListener('pointerdown', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b) return;
  e.preventDefault();
  const rows = pattern().rows.length;
  if (b.dataset.semi) {
    const note = (octave - 2) * 12 + Number(b.dataset.semi);
    if (note < NOTE_COUNT) putNote(note);
  } else if (b.dataset.hex) putDigit(Number(b.dataset.hex));
  else
    switch (b.dataset.act) {
      case 'oct-':
        octave = Math.max(2, octave - 1);
        break;
      case 'oct+':
        octave = Math.min(8, octave + 1);
        break;
      case 'off':
        putNote(NOTE_OFF);
        break;
      case 'del':
        clearCurrent();
        break;
      case 'prev':
        setCursor(moveCursor(cursor, rows, 0, -1));
        break;
      case 'next':
        setCursor(moveCursor(cursor, rows, 0, 1));
        break;
    }
  renderHeader();
  renderKeypad();
});
keypadEl.addEventListener('pointerup', () => release(cursor.ch));
keypadEl.addEventListener('pointercancel', () => release(cursor.ch));

// ----------------------------------------------------------- d-pad, A, B

document.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) => {
  let repeat = 0;
  const move = () => {
    const rows = pattern().rows.length;
    const d = b.dataset.move;
    setCursor(
      d === 'up'
        ? moveCursor(cursor, rows, -1)
        : d === 'down'
          ? moveCursor(cursor, rows, 1)
          : moveCursor(cursor, rows, 0, d === 'left' ? -1 : 1),
    );
  };
  const stop = () => clearInterval(repeat);
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    move();
    stop();
    repeat = window.setInterval(move, 140);
  });
  b.addEventListener('pointerup', stop);
  b.addEventListener('pointerleave', stop);
  b.addEventListener('pointercancel', stop);
});

$('btn-start').addEventListener('click', () => togglePlay(false));
$('btn-select').addEventListener('click', () => togglePlay(true));
$('btn-b').addEventListener('click', clearCurrent);
$('btn-a').addEventListener('click', () => {
  if (lastNote >= 0) {
    if (FIELDS[cursor.field] !== 'note') cursor = { ...cursor, field: 0 };
    putNote(lastNote);
    setTimeout(() => release(cursor.ch), 250);
  } else toast('Noch keine Note eingegeben');
});

$('ord-prev').addEventListener('click', () => setOrder(order - 1));
$('ord-next').addEventListener('click', () => setOrder(order + 1));
$('oct-down').addEventListener('click', () => {
  octave = Math.max(2, octave - 1);
  renderHeader();
  renderKeypad();
});
$('oct-up').addEventListener('click', () => {
  octave = Math.min(8, octave + 1);
  renderHeader();
  renderKeypad();
});
$('ins-down').addEventListener('click', () => {
  instrument = (instrument + INSTRUMENT_COUNT - 1) % INSTRUMENT_COUNT;
  renderHeader();
});
$('ins-up').addEventListener('click', () => {
  instrument = (instrument + 1) % INSTRUMENT_COUNT;
  renderHeader();
});
$('stp').addEventListener('click', () => {
  step = (step + 1) % 9;
  renderHeader();
});

// ------------------------------------------------------------------- scopes

const scopesEl = $('scopes');
scopesEl.innerHTML = Array.from(
  { length: 4 },
  (_, i) =>
    `<div class="scope" data-ch="${i}"><canvas></canvas><button type="button" aria-pressed="false" aria-label="Kanal ${i + 1} stumm">${i + 1}</button></div>`,
).join('');
const scopeCanvases = [...scopesEl.querySelectorAll('canvas')];
scopesEl.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) =>
  b.addEventListener('click', () => {
    muted[i] = !muted[i];
    b.parentElement!.classList.toggle('muted', muted[i]);
    b.setAttribute('aria-pressed', String(muted[i]));
    audio.send({ type: 'mute', muted: [...muted] });
  }),
);

let scopeData: Float32Array | null = null;
let scopeFrames = 0;
audio.onScope = (samples, frames) => {
  scopeData = samples;
  scopeFrames = frames;
};

function drawScopes() {
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--lcd-ink').trim();
  scopeCanvases.forEach((canvas, ch) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = ink;
    g.lineWidth = 1.5;
    g.beginPath();
    if (!scopeData) {
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
    } else {
      const n = Math.min(scopeFrames, 512);
      const start = scopeFrames - n;
      for (let i = 0; i < n; i++) {
        const v = scopeData[(start + i) * 4 + ch];
        const x = (i / (n - 1)) * w;
        const y = h / 2 - v * (h / 2 - 3);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
    }
    g.stroke();
  });
  requestAnimationFrame(drawScopes);
}
requestAnimationFrame(drawScopes);

// ------------------------------------------------------------------- panels

const panelEl = $('panel');
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab as typeof tab;
    renderPanel();
  }),
);

function slider(id: string, label: string, value: number, min: number, max: number) {
  return `<label for="${id}">${label}</label><div class="range"><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"><output>${value}</output></div>`;
}

function check(id: string, label: string, value: boolean) {
  return `<label for="${id}">${label}</label><div><input type="checkbox" id="${id}" ${value ? 'checked' : ''}></div>`;
}

function bindRange(id: string, apply: (v: number) => void) {
  const el = $<HTMLInputElement>(id);
  if (!el) return;
  el.addEventListener('input', () => {
    (el.nextElementSibling as HTMLOutputElement).textContent = el.value;
    apply(Number(el.value));
    changed();
  });
}

function bindCheck(id: string, apply: (v: boolean) => void) {
  const el = $<HTMLInputElement>(id);
  el?.addEventListener('change', () => {
    apply(el.checked);
    changed();
  });
}

function renderInstrumentPanel() {
  const kinds = [
    ['pulse', 'PULSE'],
    ['wave', 'WAVE'],
    ['noise', 'NOISE'],
  ] as const;
  const list =
    instKind === 'pulse' ? song.pulseInstruments : instKind === 'wave' ? song.waveInstruments : song.noiseInstruments;
  const ins = list[instIndex];
  let form = `<label for="i-name">Name</label><input type="text" id="i-name" value="${ins.name.replace(/"/g, '&quot;')}">`;
  if (instKind === 'pulse') {
    const p = song.pulseInstruments[instIndex];
    form += `<label for="i-duty">Duty</label><select id="i-duty">${['12,5 %', '25 %', '50 %', '75 %'].map((d, i) => `<option value="${i}" ${p.duty === i ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    form += slider('i-vol', 'Lautstärke', p.volume, 0, 15);
    form += check('i-up', 'Envelope steigt', p.envUp);
    form += slider('i-env', 'Envelope-Tempo', p.envPeriod, 0, 7);
    form += slider('i-len', 'Länge (0 = aus)', p.length, 0, 64);
    form += `<label></label><div class="hint">Sweep wirkt nur auf Kanal 1.</div>`;
    form += slider('i-sp', 'Sweep-Tempo', p.sweepPeriod, 0, 7);
    form += check('i-sn', 'Sweep abwärts', p.sweepNegate);
    form += slider('i-ss', 'Sweep-Shift', p.sweepShift, 0, 7);
  } else if (instKind === 'wave') {
    const w = song.waveInstruments[instIndex];
    form += slider('i-wave', 'Wellenform', w.wave, 0, WAVE_COUNT - 1);
    form += `<label for="i-wvol">Lautstärke</label><select id="i-wvol">${['Stumm', '100 %', '50 %', '25 %'].map((d, i) => `<option value="${i}" ${w.volume === i ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    form += slider('i-len', 'Länge (0 = aus)', w.length, 0, 256);
  } else {
    const n = song.noiseInstruments[instIndex];
    form += slider('i-vol', 'Lautstärke', n.volume, 0, 15);
    form += check('i-up', 'Envelope steigt', n.envUp);
    form += slider('i-env', 'Envelope-Tempo', n.envPeriod, 0, 7);
    form += slider('i-len', 'Länge (0 = aus)', n.length, 0, 64);
    form += check('i-narrow', '7-Bit-Rauschen', n.narrow);
  }
  panelEl.innerHTML = `
    <h2>INSTRUMENT</h2>
    <div class="seg" role="group">${kinds.map(([k, l]) => `<button type="button" data-kind="${k}" aria-pressed="${instKind === k}">${l}</button>`).join('')}</div>
    <div class="inst-grid" style="margin-top:8px">${Array.from({ length: INSTRUMENT_COUNT }, (_, i) => `<button type="button" data-i="${i}" aria-pressed="${i === instIndex}">${(i + 1).toString(16).toUpperCase()}</button>`).join('')}</div>
    <h2>${instKind.toUpperCase()} ${(instIndex + 1).toString(16).toUpperCase()}</h2>
    <div class="form">${form}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="i-test">▶ Testen</button>
      <button type="button" class="btn" id="i-use">Zum Eingeben wählen</button>
    </div>
    <p class="hint">Instrumente gelten je Kanaltyp: Kanal 1 und 2 nutzen PULSE, Kanal 3 WAVE, Kanal 4 NOISE.</p>`;

  panelEl.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      instKind = b.dataset.kind as typeof instKind;
      renderPanel();
    }),
  );
  panelEl.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) =>
    b.addEventListener('click', () => {
      instIndex = Number(b.dataset.i);
      renderPanel();
    }),
  );
  $<HTMLInputElement>('i-name').addEventListener('input', (e) => {
    ins.name = (e.target as HTMLInputElement).value;
    changed();
  });
  if (instKind === 'pulse') {
    const p = song.pulseInstruments[instIndex];
    $<HTMLSelectElement>('i-duty').addEventListener('change', (e) => {
      p.duty = Number((e.target as HTMLSelectElement).value);
      changed();
    });
    bindRange('i-vol', (v) => (p.volume = v));
    bindCheck('i-up', (v) => (p.envUp = v));
    bindRange('i-env', (v) => (p.envPeriod = v));
    bindRange('i-len', (v) => (p.length = v));
    bindRange('i-sp', (v) => (p.sweepPeriod = v));
    bindCheck('i-sn', (v) => (p.sweepNegate = v));
    bindRange('i-ss', (v) => (p.sweepShift = v));
  } else if (instKind === 'wave') {
    const w = song.waveInstruments[instIndex];
    bindRange('i-wave', (v) => (w.wave = v));
    $<HTMLSelectElement>('i-wvol').addEventListener('change', (e) => {
      w.volume = Number((e.target as HTMLSelectElement).value);
      changed();
    });
    bindRange('i-len', (v) => (w.length = v));
  } else {
    const n = song.noiseInstruments[instIndex];
    bindRange('i-vol', (v) => (n.volume = v));
    bindCheck('i-up', (v) => (n.envUp = v));
    bindRange('i-env', (v) => (n.envPeriod = v));
    bindRange('i-len', (v) => (n.length = v));
    bindCheck('i-narrow', (v) => (n.narrow = v));
  }
  const testChannel = instKind === 'pulse' ? 0 : instKind === 'wave' ? 2 : 3;
  const test = $('i-test');
  test.addEventListener('pointerdown', () => {
    const prev = instrument;
    instrument = instIndex;
    preview(testChannel, (octave - 2) * 12);
    instrument = prev;
  });
  test.addEventListener('pointerup', () => release(testChannel));
  test.addEventListener('pointerleave', () => release(testChannel));
  $('i-use').addEventListener('click', () => {
    instrument = instIndex;
    renderHeader();
    toast(`Instrument ${(instIndex + 1).toString(16).toUpperCase()} gewählt`);
  });
}

function renderWavePanel() {
  const presets = Object.keys(WAVE_PRESETS);
  panelEl.innerHTML = `
    <h2>WELLENFORM</h2>
    <div class="inst-grid">${Array.from({ length: WAVE_COUNT }, (_, i) => `<button type="button" data-w="${i}" aria-pressed="${i === waveIndex}">${i.toString(16).toUpperCase()}</button>`).join('')}</div>
    <h2>WAVE ${waveIndex.toString(16).toUpperCase()} · 32 × 4 BIT</h2>
    <canvas class="wave-canvas" id="wave-canvas" width="320" height="160" aria-label="Wellenform zeichnen"></canvas>
    <div class="btn-row">${presets.map((p) => `<button type="button" class="btn" data-preset="${p}">${p}</button>`).join('')}</div>
    <h2>HEX</h2>
    <div class="form"><label for="w-hex">Daten</label><input type="text" id="w-hex" spellcheck="false" maxlength="32"></div>
    <p class="hint">Mit Maus oder Finger zeichnen. Die Wellenform wird beim nächsten Notenanschlag geladen; wie auf der Hardware wird dafür der DAC kurz abgeschaltet.</p>`;
  const wave = song.waves[waveIndex];
  const canvas = $<HTMLCanvasElement>('wave-canvas');
  const hexInput = $<HTMLInputElement>('w-hex');
  const draw = () => {
    const g = canvas.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--lcd-bg');
    g.fillRect(0, 0, 320, 160);
    g.fillStyle = css.getPropertyValue('--lcd-ink');
    wave.forEach((v, i) => g.fillRect(i * 10 + 1, 160 - (v + 1) * 10, 8, (v + 1) * 10));
    hexInput.value = wave.map((v) => v.toString(16).toUpperCase()).join('');
  };
  draw();
  let drawing = false;
  const paint = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const i = Math.max(0, Math.min(31, Math.floor(((e.clientX - r.left) / r.width) * 32)));
    const v = Math.max(0, Math.min(15, 15 - Math.floor(((e.clientY - r.top) / r.height) * 16)));
    if (wave[i] !== v) {
      wave[i] = v;
      draw();
      changed();
    }
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    paint(e);
  });
  canvas.addEventListener('pointermove', (e) => drawing && paint(e));
  canvas.addEventListener('pointerup', () => (drawing = false));
  hexInput.addEventListener('change', () => {
    const s = hexInput.value.replace(/[^0-9a-f]/gi, '');
    if (s.length !== 32) {
      toast('Es werden genau 32 Hex-Ziffern gebraucht');
      draw();
      return;
    }
    [...s].forEach((c, i) => (wave[i] = parseInt(c, 16)));
    draw();
    changed();
  });
  panelEl.querySelectorAll<HTMLButtonElement>('[data-w]').forEach((b) =>
    b.addEventListener('click', () => {
      waveIndex = Number(b.dataset.w);
      renderPanel();
    }),
  );
  panelEl.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      WAVE_PRESETS[b.dataset.preset!].forEach((v, i) => (wave[i] = v));
      draw();
      changed();
    }),
  );
}

function renderSongPanel() {
  const bpm = (59.7275 * 60) / (song.speed * 4);
  panelEl.innerHTML = `
    <h2>SONG</h2>
    <div class="form">
      <label for="s-title">Titel</label><input type="text" id="s-title">
      <label for="s-author">Autor</label><input type="text" id="s-author">
      <label>Hardware</label>
      <div class="seg" role="group"><button type="button" data-model="dmg" aria-pressed="${song.model === 'dmg'}">DMG</button><button type="button" data-model="cgb" aria-pressed="${song.model === 'cgb'}">GBC</button></div>
      ${slider('s-speed', 'Speed (Ticks/Zeile)', song.speed, 1, 31)}
      <label></label><div class="hint" id="s-bpm">≈ ${bpm.toFixed(1)} BPM bei 4 Zeilen pro Schlag</div>
    </div>
    <h2>ORDER-LISTE</h2>
    <div class="order-list">${song.order.map((p, i) => `<button type="button" data-o="${i}" aria-current="${i === order}">${hex2(i)}:${hex2(p)}</button>`).join('')}</div>
    <div class="btn-row">
      <button type="button" class="btn" id="o-dec">Pattern −</button>
      <button type="button" class="btn" id="o-inc">Pattern +</button>
      <button type="button" class="btn" id="o-ins">Position einfügen</button>
      <button type="button" class="btn" id="o-del">Position löschen</button>
    </div>
    <h2>PATTERN ${hex2(song.order[order])}</h2>
    <div class="btn-row" style="margin-top:0">
      <button type="button" class="btn" id="p-new">Neues Pattern</button>
      <button type="button" class="btn" id="p-clone">Duplizieren</button>
      <button type="button" class="btn" id="p-clear">Leeren</button>
      <button type="button" class="btn" id="p-up">Kanal +1 Halbton</button>
      <button type="button" class="btn" id="p-down">Kanal −1 Halbton</button>
      <button type="button" class="btn" id="p-delrow">Zeile entfernen</button>
    </div>
    <div class="form" style="margin-top:10px">${check('s-follow', 'Wiedergabe folgen', follow)}</div>`;
  const title = $<HTMLInputElement>('s-title');
  const author = $<HTMLInputElement>('s-author');
  title.value = song.title;
  author.value = song.author;
  title.addEventListener('input', () => {
    song.title = title.value;
    changed();
  });
  author.addEventListener('input', () => {
    song.author = author.value;
    changed();
  });
  panelEl.querySelectorAll<HTMLButtonElement>('[data-model]').forEach((b) =>
    b.addEventListener('click', () => {
      song.model = b.dataset.model as Song['model'];
      changed(true);
    }),
  );
  bindRange('s-speed', (v) => {
    song.speed = v;
    $('s-bpm').textContent = `≈ ${((59.7275 * 60) / (v * 4)).toFixed(1)} BPM bei 4 Zeilen pro Schlag`;
  });
  panelEl.querySelectorAll<HTMLButtonElement>('[data-o]').forEach((b) =>
    b.addEventListener('click', () => setOrder(Number(b.dataset.o))),
  );
  const setPatternAt = (delta: number) => {
    const next = song.order[order] + delta;
    if (next < 0) return;
    while (next >= song.patterns.length) song.patterns.push(emptyPattern());
    song.order[order] = next;
    changed(true);
  };
  $('o-dec').addEventListener('click', () => setPatternAt(-1));
  $('o-inc').addEventListener('click', () => setPatternAt(1));
  $('o-ins').addEventListener('click', () => {
    song.order.splice(order + 1, 0, song.order[order]);
    order++;
    changed(true);
  });
  $('o-del').addEventListener('click', () => {
    if (song.order.length <= 1) return toast('Die letzte Position bleibt erhalten');
    song.order.splice(order, 1);
    order = Math.min(order, song.order.length - 1);
    changed(true);
  });
  $('p-new').addEventListener('click', () => {
    song.patterns.push(emptyPattern());
    song.order.splice(order + 1, 0, song.patterns.length - 1);
    order++;
    changed(true);
  });
  $('p-clone').addEventListener('click', () => {
    song.patterns.push(clonePattern(pattern()));
    song.order.splice(order + 1, 0, song.patterns.length - 1);
    order++;
    changed(true);
  });
  $('p-clear').addEventListener('click', () => {
    if (!confirm('Pattern wirklich leeren?')) return;
    song.patterns[song.order[order]] = emptyPattern(pattern().rows.length);
    changed(true);
  });
  $('p-up').addEventListener('click', () => {
    transpose(pattern(), cursor.ch, 1);
    changed(true);
  });
  $('p-down').addEventListener('click', () => {
    transpose(pattern(), cursor.ch, -1);
    changed(true);
  });
  $('p-delrow').addEventListener('click', () => {
    deleteRow(pattern(), cursor.ch, cursor.row);
    changed(true);
  });
  bindCheck('s-follow', (v) => (follow = v));
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => (song.title || 'song').replace(/[^\w-]+/g, '_');

function renderFilePanel() {
  panelEl.innerHTML = `
    <h2>DATEI</h2>
    <div class="btn-row" style="margin-top:0">
      <button type="button" class="btn" id="f-new">Neu</button>
      <button type="button" class="btn" id="f-open">Öffnen…</button>
      <button type="button" class="btn primary" id="f-save">Speichern (.json)</button>
      <button type="button" class="btn" id="f-demo">Demo laden</button>
    </div>
    <input type="file" id="f-input" accept=".json,application/json" class="visually-hidden">
    <p class="hint">Der Song wird automatisch im Browser gespeichert.</p>
    <h2>EXPORT</h2>
    <div class="form">${slider('x-loops', 'Durchläufe', 1, 1, 4)}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="x-wav">WAV exportieren</button>
    </div>
    <p class="hint" id="x-status">Weitere Formate (GBDK-C-Arrays, VGM, GBS/ROM, XM, MOD, Video) folgen laut Roadmap.</p>`;
  const input = $<HTMLInputElement>('f-input');
  $('f-new').addEventListener('click', () => {
    if (!confirm('Neuen Song anlegen? Der aktuelle Song wird ersetzt.')) return;
    loadSong(createSong());
  });
  $('f-demo').addEventListener('click', () => {
    if (!confirm('Demo laden? Der aktuelle Song wird ersetzt.')) return;
    loadSong(demoSong());
  });
  $('f-open').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      loadSong(parseSong(JSON.parse(await file.text())));
      toast(`„${song.title}“ geladen`);
    } catch (err) {
      toast(`Datei konnte nicht geladen werden: ${(err as Error).message}`);
    }
  });
  $('f-save').addEventListener('click', () =>
    download(`${fileBase()}.gbt.json`, JSON.stringify(song), 'application/json'),
  );
  bindRange('x-loops', () => {});
  $('x-wav').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('x-wav');
    const status = $('x-status');
    btn.disabled = true;
    try {
      const loops = Number($<HTMLInputElement>('x-loops').value);
      const { left, right, sampleRate } = await renderSong(structuredClone(song), {
        loops,
        onProgress: (s) => (status.textContent = `Rendere… ${s.toFixed(0)} s`),
      });
      download(`${fileBase()}.wav`, encodeWav(left, right, sampleRate) as BlobPart, 'audio/wav');
      status.textContent = `WAV fertig (${(left.length / sampleRate).toFixed(1)} s).`;
    } finally {
      btn.disabled = false;
    }
  });
}

function renderHelpPanel() {
  const fx: [string, string][] = [
    ['0xy', 'Arpeggio: Note, +x, +y Halbtöne pro Tick'],
    ['1xx', 'Pitch hoch um xx pro Tick'],
    ['2xx', 'Pitch runter um xx pro Tick'],
    ['3xx', 'Portamento zur Note, Tempo xx'],
    ['4xy', 'Vibrato: Tempo x, Tiefe y'],
    ['5xx', 'Master-Lautstärke (NR50)'],
    ['7xx', 'Note um xx Ticks verzögern'],
    ['8xx', 'Panning (NR51)'],
    ['9xx', 'Duty (Pulse, 0–3) bzw. Wellenform (Wave)'],
    ['Axy', 'Lautstärke-Slide: x hoch, y runter'],
    ['Bxx', 'Sprung zu Order-Position xx'],
    ['Cxy', 'Lautstärke x, Envelope y (Bit 3 = steigend)'],
    ['Dxx', 'Pattern-Break, weiter in Zeile xx'],
    ['Exx', 'Note nach xx Ticks abschneiden'],
    ['Fxx', 'Speed (Ticks pro Zeile)'],
  ];
  const keys: [string, string][] = [
    ['Y S X D C …', 'Noten (untere Reihe), Q 2 W 3 E … obere Reihe'],
    ['1', 'Note aus (===)'],
    ['0–9, A–F', 'Werte in Instrument-, Lautstärke- und Effektspalte'],
    ['Pfeile, Tab', 'Cursor bewegen, Kanal wechseln'],
    ['Leertaste', 'Song abspielen / stoppen'],
    ['Shift+Leertaste', 'Pattern ab Cursor in Schleife'],
    ['Entf / ⌫', 'Feld löschen'],
    ['Einfg', 'Zeile einfügen'],
    ['Ü / +', 'Oktave runter / hoch (auch Numpad − / +)'],
  ];
  const table = (rows: [string, string][]) =>
    `<table class="help-table">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  panelEl.innerHTML = `
    <h2>TASTATUR</h2>${table(keys)}
    <h2>TOUCH</h2>
    <p class="hint">Feld antippen, dann über das Keypad Noten oder Hex-Werte eingeben. Steuerkreuz bewegt den Cursor, START spielt den Song, SELECT das Pattern, A setzt die letzte Note, B löscht.</p>
    <h2>EFFEKTE</h2>${table(fx)}
    <p class="hint">Der Klang wird zyklusgenau aus den Registern der Game-Boy-APU erzeugt. Jeder Tick entspricht einem Frame (≈ 59,73 Hz).</p>`;
}

function renderPanel() {
  document
    .querySelectorAll<HTMLButtonElement>('[data-tab]')
    .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab === 'inst') renderInstrumentPanel();
  else if (tab === 'wave') renderWavePanel();
  else if (tab === 'song') renderSongPanel();
  else if (tab === 'file') renderFilePanel();
  else renderHelpPanel();
}

function loadSong(next: Song) {
  if (playing) togglePlay();
  song = next;
  order = 0;
  cursor = { row: 0, ch: 0, field: 0 };
  changed(true);
}

function renderAll() {
  if (order >= song.order.length) order = song.order.length - 1;
  renderHeader();
  renderPattern();
  renderKeypad();
  renderPanel();
}

renderAll();
