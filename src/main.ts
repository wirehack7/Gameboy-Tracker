import './style.css';
import { AudioClient } from './audio/client';
import { demoSong } from './tracker/demo';
import { gbdkProject } from './export/gbdk';
import { captureStream } from './export/stream';
import { buildGbs, buildRom, romExtension } from './export/rom';
import { encodeVgm } from './export/vgm';
import { encodeWav, renderSong } from './export/wav';
import { MidiInput, MidiStatus, midiToNote } from './input/midi';
import { NOTE_COUNT } from './tracker/notes';
import { pianoKeys, pianoOctaves } from './ui/piano';
import {
  CHANNEL_KINDS,
  CHANNEL_COUNT,
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
const VOLUME_KEY = 'gb-tracker.volume';
const PIANO_KEY = 'gb-tracker.piano';
const MIDI_KEY = 'gb-tracker.midi';
const REC_KEY = 'gb-tracker.rec';
const DEFAULT_VOLUME = 35;

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

// -------------------------------------------------------------------- state

let song = initialSong();
let order = 0;
let cursor: Cursor = { row: 0, ch: 0, field: 0 };
let octave = 4;
let step = 1;
let instrument = 0;
let playing = false;
let playPos = { order: -1, row: -1 };
let follow = true;
let pianoVisible = loadStored(PIANO_KEY) !== 'off';
/** Record mode: off means notes are only played, nothing is edited. */
let rec = loadStored(REC_KEY) !== 'off';
let pianoState = '';
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
app.dataset.view = 'pattern';
const stepper = (id: string, label: string, title: string) =>
  `<span class="field" title="${title}">${label} <span class="stepper"><button type="button" id="${id}-down" aria-label="${title} down">‹</button><output id="${id}"></output><button type="button" id="${id}-up" aria-label="${title} up">›</button></span></span>`;
app.innerHTML = `
  <header class="toolbar">
    <div class="brand"><span class="led" id="play-led" title="Playing"></span><h1>GB TRACKER<span>DMG · CGB</span></h1></div>
    <div class="transport">
      <button type="button" class="round-btn" id="play-song" title="Play song (Space)" aria-label="Play song">▶</button>
      <button type="button" class="round-btn" id="play-pattern" title="Loop pattern from cursor (Shift+Space)" aria-label="Loop pattern">⟳</button>
      <button type="button" class="round-btn dark" id="stop" title="Stop" aria-label="Stop">■</button>
      <button type="button" class="round-btn rec" id="rec" title="Record mode (Esc): on = notes are entered, off = only played" aria-label="Record mode">●</button>
    </div>
    <div class="fields">
      ${stepper('ord', 'ORD', 'Order position')}
      <span class="field">PAT <output id="pat"></output></span>
      ${stepper('oct', 'OCT', 'Octave')}
      ${stepper('ins', 'INS', 'Instrument')}
      ${stepper('stp', 'STEP', 'Edit step')}
      ${stepper('spd', 'SPD', 'Speed')}
      <span class="field"><output class="badge" id="model"></output></span>
    </div>
    <div class="spacer"></div>
    <button class="pill-btn" id="piano-toggle" type="button" title="Show or hide the on-screen piano">KEYS</button>
    <button class="pill-btn" id="midi" type="button" title="Play and enter notes from a MIDI keyboard">MIDI</button>
    <label class="field volume" title="Master volume (playback only, exports are unaffected)">VOL <input type="range" id="vol" min="0" max="100" step="1"><output id="vol-out"></output></label>
    <button class="pill-btn" id="theme" type="button"></button>
  </header>
  <div class="workspace">
    <aside class="sidebar left" aria-label="Order and instruments">
      <section class="box">
        <h2>ORDER</h2>
        <div class="order-list" id="order-list"></div>
        <div class="mini-btns">
          <button type="button" id="o-dec" title="Previous pattern number">PAT−</button>
          <button type="button" id="o-inc" title="Next pattern number">PAT+</button>
          <button type="button" id="o-ins" title="Insert position (same pattern)">INS</button>
          <button type="button" id="o-dup" title="Insert a copy of this pattern">DUP</button>
          <button type="button" id="o-del" title="Delete position">DEL</button>
        </div>
      </section>
      <section class="box grow">
        <h2 id="inst-title">INSTRUMENTS</h2>
        <div class="inst-list" id="inst-list"></div>
      </section>
    </aside>
    <main class="editor" aria-label="Pattern editor">
      <div class="chan-head" id="chan-head"></div>
      <div class="pattern" id="pattern" tabindex="0" role="grid" aria-label="Pattern"></div>
      <div class="piano" id="piano" aria-label="Piano"></div>
      <div class="keypad" id="keypad"></div>
    </main>
    <aside class="sidebar right" aria-label="Editors">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="inst">INSTR</button>
        <button type="button" role="tab" data-tab="wave">WAVE</button>
        <button type="button" role="tab" data-tab="song">SONG</button>
        <button type="button" role="tab" data-tab="file">FILE</button>
        <button type="button" role="tab" data-tab="help">HELP</button>
      </div>
      <div class="panel" id="panel"></div>
    </aside>
  </div>
  <nav class="mobile-nav" aria-label="Views">
    <button type="button" data-view="pattern">PATTERN</button>
    <button type="button" data-view="lists">ORDER · INSTR</button>
    <button type="button" data-view="edit">EDIT</button>
  </nav>
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

// ------------------------------------------------------------------- volume

const volumeInput = $('vol') as HTMLInputElement;

function applyVolume(percent: number) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  volumeInput.value = String(v);
  $('vol-out').textContent = String(v).padStart(3, '\u2007');
  // Squared for a roughly perceptual curve.
  audio.setVolume((v / 100) ** 2);
  return v;
}

const storedVolume = Number(loadStored(VOLUME_KEY) ?? NaN);
applyVolume(Number.isFinite(storedVolume) ? storedVolume : DEFAULT_VOLUME);
volumeInput.addEventListener('input', () => store(VOLUME_KEY, String(applyVolume(Number(volumeInput.value)))));

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

const KIND_LABEL = { pulse: 'PULSE', wave: 'WAVE', noise: 'NOISE' };
const instKindOf = (ch: number) => CHANNEL_KINDS[ch];
const instrumentsOf = (kind: 'pulse' | 'wave' | 'noise') =>
  kind === 'pulse' ? song.pulseInstruments : kind === 'wave' ? song.waveInstruments : song.noiseInstruments;

function renderHeader() {
  $('ord').textContent = hex2(order);
  $('pat').textContent = hex2(song.order[order]);
  $('oct').textContent = String(octave);
  $('ins').textContent = (instrument + 1).toString(16).toUpperCase();
  $('stp').textContent = String(step);
  $('spd').textContent = String(song.speed);
  $('model').textContent = song.model === 'cgb' ? 'GBC' : 'DMG';
  renderOrderList();
  renderInstList();
  renderPiano();
}

function renderOrderList() {
  const el = $('order-list');
  el.innerHTML = song.order
    .map(
      (p, i) =>
        `<button type="button" data-o="${i}" aria-current="${i === order}"><span class="pos">${hex2(i)}</span><span class="pat">${hex2(p)}</span></button>`,
    )
    .join('');
  (el.children[order] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
}

function renderInstList() {
  const kind = instKindOf(cursor.ch);
  $('inst-title').textContent = `${KIND_LABEL[kind]} INSTRUMENTS`;
  $('inst-list').innerHTML = instrumentsOf(kind)
    .map((ins, i) => {
      const editing = tab === 'inst' && instKind === kind && instIndex === i ? ' class="editing"' : '';
      return `<button type="button" data-i="${i}" aria-current="${i === instrument}"${editing}><span class="idx">${(i + 1).toString(16).toUpperCase()}</span><span class="name">${escapeHtml(ins.name)}</span></button>`;
    })
    .join('');
}

function escapeHtml(t: string) {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function renderChannelHead() {
  $('chan-head').innerHTML =
    '<span class="num"></span>' +
    CHANNEL_KINDS.map(
      (k, i) => `<div class="chan${muted[i] ? ' muted' : ''}" data-ch="${i}">
        <div class="chan-title"><span>CH${i + 1} <span class="kind">${KIND_LABEL[k]}</span></span><button type="button" class="mute" aria-pressed="${muted[i]}" title="Mute channel ${i + 1}">M</button></div>
        <canvas></canvas>
      </div>`,
    ).join('');
  scopeCanvases = [...$('chan-head').querySelectorAll('canvas')];
}

/** Empty fields are shown as dots, like in most trackers. */
const EMPTY_GLYPH = ['···', '·', '·', '·', '·', '·'];

function rowHtml(r: number) {
  const rows = pattern().rows;
  const cls = ['prow'];
  if (r % 16 === 0) cls.push('bar');
  else if (r % 4 === 0) cls.push('beat');
  if (r === cursor.row) cls.push('cursor-row');
  if (playing && playPos.row === r && playPos.order === order) cls.push('play-row');
  let html = `<div class="${cls.join(' ')}" data-row="${r}"><span class="num">${hex2(r)}</span>`;
  for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
    const cell = rows[r][ch];
    const fields = formatCell(cell);
    html += '<span class="cell">';
    fields.forEach((text, f) => {
      const empty = text.startsWith('-');
      let c = `f${f}`;
      if (empty) c += ' empty';
      if (f === 0 && cell.note === NOTE_OFF) c += ' off';
      if (r === cursor.row && ch === cursor.ch && f === cursor.field) c += ' cursor';
      html += `<span class="${c}" data-ch="${ch}" data-f="${f}">${empty ? EMPTY_GLYPH[f] : text}</span>`;
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
  const kindChanged = instKindOf(cursor.ch) !== instKindOf(next.ch);
  cursor = next;
  if (kindChanged) renderInstList();
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
  if (!rec) return;
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
  highlightKey(note);
}

function release(ch: number) {
  if (!playing) audio.send({ type: 'release', channel: ch });
  highlightKey(-1);
}

/** Piano, MIDI and touch note input: enter on a note field, otherwise just play it. */
function playNote(note: number) {
  if (rec && FIELDS[cursor.field] === 'note') putNote(note);
  else preview(cursor.ch, note);
}

function putNote(note: number) {
  const ch = cursor.ch;
  if (!rec) {
    preview(ch, note);
    return;
  }
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
  $('play-song').setAttribute('aria-pressed', String(playing && !loopPattern));
  $('play-pattern').setAttribute('aria-pressed', String(playing && loopPattern));
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
    case 'Escape':
      setRec(!rec);
      break;
    case 'Insert':
      if (!rec) break;
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

  // Without record mode the note keys play on every field.
  if (field === 'note' || !rec) {
    if (rec && (e.code === 'Digit1' || e.code === 'Backquote')) {
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
  const state = `${octave}/${pianoVisible}`;
  if (kind === (isNote ? 'note' : 'hex') && keypadEl.dataset.state === state) return;
  keypadEl.dataset.kind = isNote ? 'note' : 'hex';
  keypadEl.dataset.state = state;
  const navRow = `<div class="row">${key('◀', 'action', 'data-act="prev" aria-label="Previous field"')}${key('▲', 'action', 'data-act="up" aria-label="Row up"')}${key('▼', 'action', 'data-act="down" aria-label="Row down"')}${key('▶', 'action', 'data-act="next" aria-label="Next field"')}</div>`;
  if (isNote) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keys = names.map((n, i) => key(n, n.includes('#') ? 'sharp' : '', `data-semi="${i}"`));
    const noteRows = pianoVisible
      ? ''
      : `<div class="row">${keys.slice(0, 6).join('')}</div><div class="row">${keys.slice(6).join('')}</div>`;
    keypadEl.innerHTML = `
      ${noteRows}
      <div class="row">
        ${key('OCT−', 'action', 'data-act="oct-"')}${key('OCT+', 'action', 'data-act="oct+"')}
        ${key('OFF', 'action', 'data-act="off"')}${key('DEL', 'red', 'data-act="del"')}
      </div>
      ${navRow}`;
  } else {
    const keys = Array.from({ length: 16 }, (_, i) => key(i.toString(16).toUpperCase(), '', `data-hex="${i}"`));
    keypadEl.innerHTML = `
      <div class="row">${keys.slice(0, 8).join('')}</div>
      <div class="row">${keys.slice(8).join('')}</div>
      <div class="row">${key('DEL', 'red', 'data-act="del"')}</div>
      ${navRow}`;
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
      case 'up':
        setCursor(moveCursor(cursor, rows, -1));
        break;
      case 'down':
        setCursor(moveCursor(cursor, rows, 1));
        break;
    }
  renderHeader();
  renderKeypad();
});
keypadEl.addEventListener('pointerup', () => release(cursor.ch));
keypadEl.addEventListener('pointercancel', () => release(cursor.ch));

// --------------------------------------------------------------- rec mode

function setRec(on: boolean) {
  rec = on;
  store(REC_KEY, on ? 'on' : 'off');
  app.dataset.rec = on ? 'on' : 'off';
  $('rec').setAttribute('aria-pressed', String(on));
}
$('rec').addEventListener('click', () => setRec(!rec));
setRec(rec);

// ------------------------------------------------------------------- piano

function renderPiano() {
  const pianoEl = document.getElementById('piano');
  if (!pianoEl) return;
  pianoEl.hidden = !pianoVisible;
  $('piano-toggle').setAttribute('aria-pressed', String(pianoVisible));
  if (!pianoVisible) return;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const octaves = pianoOctaves(pianoEl.clientWidth || window.innerWidth, coarse ? 46 : 26);
  const state = `${octave}/${octaves}`;
  if (state === pianoState) return;
  pianoState = state;
  const keys = pianoKeys(Math.min(octave, 8), octaves);
  const whites = keys.filter((k) => !k.black).length;
  pianoEl.style.setProperty('--whites', String(whites));
  pianoEl.innerHTML = keys
    .map(
      (k) =>
        `<button type="button" tabindex="-1" class="pkey ${k.black ? 'black' : 'white'}" data-note="${k.note}" style="--i:${k.white}" aria-label="${k.label || k.note}">${k.label ? `<span>${k.label}</span>` : ''}</button>`,
    )
    .join('');
}

const pianoEl = $('piano');

function highlightKey(note: number) {
  for (const el of pianoEl.querySelectorAll('.pkey.down')) el.classList.remove('down');
  if (note >= 0) pianoEl.querySelector(`[data-note="${note}"]`)?.classList.add('down');
}

let pianoPointer: number | null = null;
let pianoNote = -1;
const keyAt = (x: number, y: number) =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>('.pkey[data-note]') ?? null;

pianoEl.addEventListener('pointerdown', (e) => {
  const k = keyAt(e.clientX, e.clientY);
  if (!k) return;
  e.preventDefault();
  pianoPointer = e.pointerId;
  pianoEl.setPointerCapture(e.pointerId);
  pianoNote = Number(k.dataset.note);
  playNote(pianoNote);
});
// Gliding over the keys plays them without entering more notes.
pianoEl.addEventListener('pointermove', (e) => {
  if (e.pointerId !== pianoPointer) return;
  const k = keyAt(e.clientX, e.clientY);
  if (!k || Number(k.dataset.note) === pianoNote) return;
  pianoNote = Number(k.dataset.note);
  preview(cursor.ch, pianoNote);
});
const pianoUp = (e: PointerEvent) => {
  if (e.pointerId !== pianoPointer) return;
  pianoPointer = null;
  pianoNote = -1;
  release(cursor.ch);
};
pianoEl.addEventListener('pointerup', pianoUp);
pianoEl.addEventListener('pointercancel', pianoUp);

$('piano-toggle').addEventListener('click', () => {
  pianoVisible = !pianoVisible;
  store(PIANO_KEY, pianoVisible ? 'on' : 'off');
  pianoState = '';
  renderPiano();
  renderKeypad();
});
window.addEventListener('resize', () => renderPiano());
renderPiano();

// -------------------------------------------------------------------- MIDI

const midi = new MidiInput();
const midiHeld = new Set<number>();

function renderMidi(s: MidiStatus) {
  const b = $('midi');
  b.setAttribute('aria-pressed', String(s.enabled));
  b.textContent = s.enabled ? `MIDI ${s.inputs.length}` : 'MIDI';
  b.title = s.error ?? (s.enabled ? `MIDI inputs: ${s.inputs.join(', ') || 'none connected'}` : 'Play and enter notes from a MIDI keyboard');
  if (s.error) toast(s.error);
}
midi.onStatus = renderMidi;
midi.onEvent = (e) => {
  const note = midiToNote(e.note);
  if (note === null) return;
  if (e.type === 'on') {
    midiHeld.add(note);
    playNote(note);
  } else {
    midiHeld.delete(note);
    if (midiHeld.size === 0) release(cursor.ch);
  }
};
$('midi').addEventListener('click', () => {
  if (midi.status.enabled) {
    midi.disable();
    store(MIDI_KEY, 'off');
  } else {
    void midi.enable().then((s) => store(MIDI_KEY, s.enabled ? 'on' : 'off'));
  }
});
if (!midi.status.supported) $('midi').title = 'Web MIDI is not supported by this browser.';
if (loadStored(MIDI_KEY) === 'on' && midi.status.supported) void midi.enable();

// ---------------------------------------------------------------- toolbar

$('play-song').addEventListener('click', () => {
  if (playing) togglePlay();
  togglePlay(false);
});
$('play-pattern').addEventListener('click', () => {
  if (playing) togglePlay();
  togglePlay(true);
});
$('stop').addEventListener('click', () => playing && togglePlay());

const bump = (id: string, apply: (d: number) => void) => {
  $(`${id}-down`).addEventListener('click', () => {
    apply(-1);
    renderHeader();
    renderKeypad();
  });
  $(`${id}-up`).addEventListener('click', () => {
    apply(1);
    renderHeader();
    renderKeypad();
  });
};
bump('ord', (d) => setOrder(order + d));
bump('oct', (d) => (octave = Math.max(2, Math.min(8, octave + d))));
bump('ins', (d) => (instrument = (instrument + d + INSTRUMENT_COUNT) % INSTRUMENT_COUNT));
bump('stp', (d) => (step = Math.max(0, Math.min(16, step + d))));
bump('spd', (d) => {
  song.speed = Math.max(1, Math.min(31, song.speed + d));
  changed();
  if (tab === 'song') renderPanel();
});

// ------------------------------------------------------------- side lists

$('order-list').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-o]');
  if (b) setOrder(Number(b.dataset.o));
});

$('inst-list').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
  if (!b) return;
  instrument = Number(b.dataset.i);
  instKind = instKindOf(cursor.ch);
  instIndex = instrument;
  tab = 'inst';
  renderHeader();
  renderPanel();
});

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
$('o-dup').addEventListener('click', () => {
  song.patterns.push(clonePattern(pattern()));
  song.order.splice(order + 1, 0, song.patterns.length - 1);
  order++;
  changed(true);
});
$('o-del').addEventListener('click', () => {
  if (song.order.length <= 1) return toast('The last position cannot be deleted');
  song.order.splice(order, 1);
  order = Math.min(order, song.order.length - 1);
  changed(true);
});

// ------------------------------------------------------------ mobile views

app.querySelectorAll<HTMLButtonElement>('.mobile-nav [data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    app.dataset.view = b.dataset.view;
    renderMobileNav();
    if (b.dataset.view === 'pattern') scrollToRow(cursor.row);
  }),
);

function renderMobileNav() {
  app
    .querySelectorAll<HTMLButtonElement>('.mobile-nav [data-view]')
    .forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === app.dataset.view)));
}

// ------------------------------------------------------------------- scopes

let scopeCanvases: HTMLCanvasElement[] = [];
$('chan-head').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.mute');
  if (!b) return;
  const ch = Number(b.closest<HTMLElement>('[data-ch]')!.dataset.ch);
  muted[ch] = !muted[ch];
  renderChannelHead();
  audio.send({ type: 'mute', muted: [...muted] });
});

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
    form += `<label for="i-duty">Duty</label><select id="i-duty">${['12.5 %', '25 %', '50 %', '75 %'].map((d, i) => `<option value="${i}" ${p.duty === i ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    form += slider('i-vol', 'Volume', p.volume, 0, 15);
    form += check('i-up', 'Envelope up', p.envUp);
    form += slider('i-env', 'Envelope period', p.envPeriod, 0, 7);
    form += slider('i-len', 'Length (0 = off)', p.length, 0, 64);
    form += `<label></label><div class="hint">Sweep only affects channel 1.</div>`;
    form += slider('i-sp', 'Sweep period', p.sweepPeriod, 0, 7);
    form += check('i-sn', 'Sweep down', p.sweepNegate);
    form += slider('i-ss', 'Sweep shift', p.sweepShift, 0, 7);
  } else if (instKind === 'wave') {
    const w = song.waveInstruments[instIndex];
    form += slider('i-wave', 'Waveform', w.wave, 0, WAVE_COUNT - 1);
    form += `<label for="i-wvol">Volume</label><select id="i-wvol">${['Mute', '100 %', '50 %', '25 %'].map((d, i) => `<option value="${i}" ${w.volume === i ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    form += slider('i-len', 'Length (0 = off)', w.length, 0, 256);
  } else {
    const n = song.noiseInstruments[instIndex];
    form += slider('i-vol', 'Volume', n.volume, 0, 15);
    form += check('i-up', 'Envelope up', n.envUp);
    form += slider('i-env', 'Envelope period', n.envPeriod, 0, 7);
    form += slider('i-len', 'Length (0 = off)', n.length, 0, 64);
    form += check('i-narrow', '7-bit noise', n.narrow);
  }
  panelEl.innerHTML = `
    <h2>INSTRUMENT</h2>
    <div class="seg" role="group">${kinds.map(([k, l]) => `<button type="button" data-kind="${k}" aria-pressed="${instKind === k}">${l}</button>`).join('')}</div>
    <div class="inst-grid" style="margin-top:8px">${Array.from({ length: INSTRUMENT_COUNT }, (_, i) => `<button type="button" data-i="${i}" aria-pressed="${i === instIndex}">${(i + 1).toString(16).toUpperCase()}</button>`).join('')}</div>
    <h2>${instKind.toUpperCase()} ${(instIndex + 1).toString(16).toUpperCase()}</h2>
    <div class="form">${form}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="i-test">▶ Test</button>
      <button type="button" class="btn" id="i-use">Use for note entry</button>
    </div>
    <p class="hint">Instruments belong to a channel type: channels 1 and 2 use PULSE, channel 3 WAVE, channel 4 NOISE.</p>`;

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
    renderInstList();
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
    toast(`Instrument ${(instIndex + 1).toString(16).toUpperCase()} selected`);
  });
}

function renderWavePanel() {
  const presets = Object.keys(WAVE_PRESETS);
  panelEl.innerHTML = `
    <h2>WAVEFORM</h2>
    <div class="inst-grid">${Array.from({ length: WAVE_COUNT }, (_, i) => `<button type="button" data-w="${i}" aria-pressed="${i === waveIndex}">${i.toString(16).toUpperCase()}</button>`).join('')}</div>
    <h2>WAVE ${waveIndex.toString(16).toUpperCase()} · 32 × 4 BIT</h2>
    <canvas class="wave-canvas" id="wave-canvas" width="320" height="160" aria-label="Draw waveform"></canvas>
    <div class="btn-row">${presets.map((p) => `<button type="button" class="btn" data-preset="${p}">${p}</button>`).join('')}</div>
    <h2>HEX</h2>
    <div class="form"><label for="w-hex">Data</label><input type="text" id="w-hex" spellcheck="false" maxlength="32"></div>
    <p class="hint">Draw with mouse or finger. The wave is loaded on the next note; as on the hardware, the DAC is switched off briefly to do so.</p>`;
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
      toast('Exactly 32 hex digits are required');
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
      <label for="s-title">Title</label><input type="text" id="s-title">
      <label for="s-author">Author</label><input type="text" id="s-author">
      <label>Hardware</label>
      <div class="seg" role="group"><button type="button" data-model="dmg" aria-pressed="${song.model === 'dmg'}">DMG</button><button type="button" data-model="cgb" aria-pressed="${song.model === 'cgb'}">GBC</button></div>
      ${slider('s-speed', 'Speed (ticks/row)', song.speed, 1, 31)}
      <label></label><div class="hint" id="s-bpm">≈ ${bpm.toFixed(1)} BPM at 4 rows per beat</div>
    </div>
    <h2>PATTERN ${hex2(song.order[order])}</h2>
    <div class="btn-row" style="margin-top:0">
      <button type="button" class="btn" id="p-new">New pattern</button>
      <button type="button" class="btn" id="p-clone">Duplicate</button>
      <button type="button" class="btn" id="p-clear">Clear</button>
      <button type="button" class="btn" id="p-up">Channel +1 semitone</button>
      <button type="button" class="btn" id="p-down">Channel −1 semitone</button>
      <button type="button" class="btn" id="p-delrow">Delete row</button>
    </div>
    <div class="form" style="margin-top:10px">${check('s-follow', 'Follow playback', follow)}</div>`;
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
    $('spd').textContent = String(v);
    $('s-bpm').textContent = `≈ ${((59.7275 * 60) / (v * 4)).toFixed(1)} BPM at 4 rows per beat`;
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
    if (!confirm('Really clear this pattern?')) return;
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
    <h2>FILE</h2>
    <div class="btn-row" style="margin-top:0">
      <button type="button" class="btn" id="f-new">New</button>
      <button type="button" class="btn" id="f-open">Open…</button>
      <button type="button" class="btn primary" id="f-save">Save (.json)</button>
      <button type="button" class="btn" id="f-demo">Load demo</button>
    </div>
    <input type="file" id="f-input" accept=".json,application/json" class="visually-hidden">
    <p class="hint">The song is saved in the browser automatically.</p>
    <h2>EXPORT</h2>
    <div class="form">${slider('x-loops', 'Loops', 1, 1, 4)}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="x-wav">Export WAV</button>
      <button type="button" class="btn" id="x-vgm">Export VGM</button>
      <button type="button" class="btn" id="x-gbs">Export GBS</button>
      <button type="button" class="btn" id="x-rom">Game Boy ROM</button>
      <button type="button" class="btn" id="x-gbdk">GBDK project (.zip)</button>
    </div>
    <p class="hint" id="x-status">ROM: runs on hardware and emulators (.gb, or .gbc for CGB songs). GBS and VGM play in music players. GBDK: C array of the register stream, a tiny C driver and a Makefile. More formats (XM, MOD, video) are on the roadmap.</p>`;
  const input = $<HTMLInputElement>('f-input');
  $('f-new').addEventListener('click', () => {
    if (!confirm('Start a new song? The current song will be replaced.')) return;
    loadSong(createSong());
  });
  $('f-demo').addEventListener('click', () => {
    if (!confirm('Load the demo? The current song will be replaced.')) return;
    loadSong(demoSong());
  });
  $('f-open').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      loadSong(parseSong(JSON.parse(await file.text())));
      toast(`Loaded “${song.title}”`);
    } catch (err) {
      toast(`Could not load file: ${(err as Error).message}`);
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
        onProgress: (s) => (status.textContent = `Rendering… ${s.toFixed(0)} s`),
      });
      download(`${fileBase()}.wav`, encodeWav(left, right, sampleRate) as BlobPart, 'audio/wav');
      status.textContent = `WAV ready (${(left.length / sampleRate).toFixed(1)} s).`;
    } finally {
      btn.disabled = false;
    }
  });
  $('x-vgm').addEventListener('click', () => {
    const vgm = encodeVgm(captureStream(structuredClone(song)), { title: song.title, author: song.author });
    download(`${fileBase()}.vgm`, vgm as BlobPart, 'application/octet-stream');
  });
  const exportBinary = (build: () => { name: string; data: Uint8Array }) => {
    try {
      const { name, data } = build();
      download(name, data as BlobPart, 'application/octet-stream');
      $('x-status').textContent = `${name}: ${data.length} bytes.`;
    } catch (err) {
      $('x-status').textContent = (err as Error).message;
    }
  };
  $('x-gbs').addEventListener('click', () =>
    exportBinary(() => ({ name: `${fileBase()}.gbs`, data: buildGbs(structuredClone(song)).data })),
  );
  $('x-rom').addEventListener('click', () =>
    exportBinary(() => ({ name: `${fileBase()}.${romExtension(song)}`, data: buildRom(structuredClone(song)).data })),
  );
  $('x-gbdk').addEventListener('click', () => {
    const { zip, name, size } = gbdkProject(structuredClone(song));
    download(`${name}_gbdk.zip`, zip as BlobPart, 'application/zip');
    $('x-status').textContent = `GBDK project ready: ${size} bytes of song data.`;
  });
}

function renderHelpPanel() {
  const fx: [string, string][] = [
    ['0xy', 'Arpeggio: note, +x, +y semitones per tick'],
    ['1xx', 'Pitch up by xx per tick'],
    ['2xx', 'Pitch down by xx per tick'],
    ['3xx', 'Portamento to note, speed xx'],
    ['4xy', 'Vibrato: speed x, depth y'],
    ['5xx', 'Master volume (NR50)'],
    ['7xx', 'Delay note by xx ticks'],
    ['8xx', 'Panning (NR51)'],
    ['9xx', 'Duty (pulse, 0–3) or waveform (wave)'],
    ['Axy', 'Volume slide: x up, y down'],
    ['Bxx', 'Jump to order position xx'],
    ['Cxy', 'Volume x, envelope y (bit 3 = up)'],
    ['Dxx', 'Pattern break, continue at row xx'],
    ['Exx', 'Cut note after xx ticks'],
    ['Fxx', 'Speed (ticks per row)'],
  ];
  const keys: [string, string][] = [
    ['Z S X D C …', 'Notes, lower row (physical key positions: Y on QWERTZ), Q 2 W 3 E … upper row'],
    ['1', 'Note off (===)'],
    ['0–9, A–F', 'Values in instrument, volume and effect columns'],
    ['Arrows, Tab', 'Move cursor, switch channel'],
    ['Space', 'Play / stop song'],
    ['Shift+Space', 'Loop pattern from cursor'],
    ['Del / ⌫', 'Clear field'],
    ['Ins', 'Insert row'],
    ['Esc', 'Record mode on/off (off: notes are only played, nothing is edited)'],
    ['[ / ]', 'Octave down / up (also numpad − / +)'],
  ];
  const table = (rows: [string, string][]) =>
    `<table class="help-table">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  panelEl.innerHTML = `
    <h2>PATTERN COLUMNS</h2>
    <div class="legend"><span class="f0">C-4 note</span><span class="f1">1 instrument</span><span class="f2">F volume</span><span class="f3">A effect</span><span class="f4">0F param</span></div>
    <h2>KEYBOARD</h2>${table(keys)}
    <h2>TOUCH</h2>
    <p class="hint">Tap a field, then enter notes or hex values on the keypad. The arrow keys move the cursor. ▶ plays the song, ⟳ loops the pattern from the cursor, ■ stops.</p>
    <h2>PIANO AND MIDI</h2>
    <p class="hint">KEYS shows the piano (mouse or touch). With record mode (●) on and the cursor on a note field a key enters the note, otherwise it only plays it; sliding over the keys plays without entering. It starts at the current octave. MIDI connects all MIDI keyboards (Chrome, Edge, Firefox; not Safari). MIDI note 60 is C-4.</p>
    <h2>EFFECTS</h2>${table(fx)}
    <p class="hint">Sound is generated cycle-accurately from the Game Boy APU registers. One tick is one frame (≈ 59.73 Hz).</p>`;
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
  renderInstList();
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
  renderChannelHead();
  renderMobileNav();
  renderHeader();
  renderPattern();
  renderKeypad();
  renderPanel();
}

renderAll();
