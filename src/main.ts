import './style.css';
import { AudioClient } from './audio/client';
import { sampleFromAudio, toMono, waveFromAudio } from './audio/import';
import { SAMPLE_COUNT, SAMPLE_RATE } from './tracker/sample';
import { demoSong } from './tracker/demo';
import { gbdkProject } from './export/gbdk';
import { captureStream } from './export/stream';
import { buildGbs, buildRom, romExtension } from './export/rom';
import { encodeMod } from './export/mod';
import { encodeXm } from './export/xm';
import { encodeVgm } from './export/vgm';
import { encodeFlac } from './export/flac';
import { RenderOptions, encodeWav, renderSong, renderStems } from './export/wav';
import { canEncode, exportOpus, exportVideo, themeColors } from './export/video';
import { unzip, zip } from './export/zip';
import { MidiInput, MidiStatus, midiToNote } from './input/midi';
import { NOTE_COUNT } from './tracker/notes';
import { SongLibrary, SongMeta, copySounds, fileName, openStore, uniqueNames } from './tracker/library';
import { openAbout } from './ui/about';
import { pianoKeys, pianoOctaves, pianoWhites } from './ui/piano';
import { scopeTrace } from './ui/scope';
import { Block, clearBlock, contains, copyBlock, normalize, pasteBlock, transposeBlock } from './tracker/block';
import { History } from './tracker/history';
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
  deleteSample,
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
import { LOCALES, MessageKey, getLocale, matchLocale, onLocaleChange, setLocale, t, translateDom } from './i18n';

const STORAGE_KEY = 'gb-tracker.song';
const THEME_KEY = 'gb-tracker.theme';
const VOLUME_KEY = 'gb-tracker.volume';
const PIANO_KEY = 'gb-tracker.piano';
const MIDI_KEY = 'gb-tracker.midi';
const LANG_KEY = 'gb-tracker.lang';
const REC_KEY = 'gb-tracker.rec';
/** Which library entry the working copy belongs to, and whether it has unsaved changes. */
const SESSION_KEY = 'gb-tracker.session';
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

function initialSong(): Song | null {
  const raw = loadStored(STORAGE_KEY);
  if (raw) {
    try {
      return parseSong(JSON.parse(raw));
    } catch {
      /* fall through to the demo */
    }
  }
  return null;
}

function initialSession(): { id: string | null; dirty: boolean } | null {
  try {
    const s = JSON.parse(loadStored(SESSION_KEY) ?? 'null');
    return s && typeof s === 'object' ? { id: typeof s.id === 'string' ? s.id : null, dirty: !!s.dirty } : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- state

const restored = initialSong();
let song = restored ?? demoSong();
const session = initialSession();
/** Library entry of the working copy; null when it is not in the library. */
let songId = restored ? (session?.id ?? null) : null;
/** The working copy differs from its library entry (or is not in the library and has been edited). */
let dirty = restored ? (session?.dirty ?? false) : false;
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
/** Keeps the working copy in localStorage, so a reload or a crash loses nothing. */
function persist(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    store(STORAGE_KEY, JSON.stringify(song));
    store(SESSION_KEY, JSON.stringify({ id: songId, dirty }));
  };
  if (now) write();
  else saveTimer = window.setTimeout(write, 400);
}

// Undo history: edits within half a second become one step.
const history = new History(JSON.stringify(song));
let historyTimer = 0;
function commitHistory() {
  clearTimeout(historyTimer);
  historyTimer = 0;
  history.commit(JSON.stringify(song));
  updateUndoButtons();
}

function changed(structure = false) {
  audio.setSong(song);
  setDirty(true);
  persist();
  clearTimeout(historyTimer);
  historyTimer = window.setTimeout(commitHistory, 500);
  updateUndoButtons();
  if (structure) renderAll();
}

function updateUndoButtons() {
  const undoable = history.canUndo || historyTimer !== 0;
  for (const id of ['undo', 'redo'])
    document.getElementById(id)?.toggleAttribute('disabled', id === 'undo' ? !undoable : !history.canRedo);
}

/** Step back (or forward) in the history; the cursor and order stay where they are. */
function undoRedo(redo: boolean) {
  if (historyTimer) commitHistory();
  const snapshot = redo ? history.redo() : history.undo();
  if (snapshot === null) return;
  song = parseSong(JSON.parse(snapshot));
  order = Math.min(order, song.order.length - 1);
  if (cursor.row >= pattern().rows.length) cursor = { ...cursor, row: 0 };
  selection = null;
  audio.setSong(song);
  setDirty(true);
  persist();
  updateUndoButtons();
  renderAll();
  toast(t(redo ? 'edit.redone' : 'edit.undone'));
}

const pattern = () => song.patterns[song.order[order]] ?? song.patterns[0];
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

// ---------------------------------------------------------------------- DOM

const app = document.getElementById('app')!;
app.dataset.view = 'pattern';
setLocale(loadStored(LANG_KEY) ?? matchLocale(navigator.languages ?? [navigator.language]));
document.documentElement.lang = getLocale();
const stepper = (id: string, label: MessageKey, title: MessageKey) =>
  `<span class="field" data-i18n-title="${title}"><span data-i18n="${label}"></span> <span class="stepper"><button type="button" id="${id}-down" data-step-name="${title}" data-step-dir="down">‹</button><output id="${id}"></output><button type="button" id="${id}-up" data-step-name="${title}" data-step-dir="up">›</button></span></span>`;
app.innerHTML = `
  <header class="toolbar">
    <div class="brand"><span class="led" id="play-led" data-i18n-title="app.playing"></span><h1>GB TRACKER<span>DMG · CGB</span></h1></div>
    <div class="transport">
      <button type="button" class="round-btn" id="play-song" data-i18n-title="transport.playSong" data-i18n-aria-label="transport.playSongLabel">▶</button>
      <button type="button" class="round-btn" id="play-pattern" data-i18n-title="transport.loopPattern" data-i18n-aria-label="transport.loopPatternLabel">⟳</button>
      <button type="button" class="round-btn dark" id="stop" data-i18n-title="transport.stop" data-i18n-aria-label="transport.stop">■</button>
      <button type="button" class="round-btn rec" id="rec" data-i18n-title="transport.rec" data-i18n-aria-label="transport.recLabel">●</button>
    </div>
    <div class="fields">
      ${stepper('ord', 'field.ord', 'field.ordTitle')}
      <span class="field"><span data-i18n="field.pat"></span> <output id="pat"></output></span>
      ${stepper('oct', 'field.oct', 'field.octTitle')}
      ${stepper('ins', 'field.ins', 'field.insTitle')}
      ${stepper('stp', 'field.step', 'field.stepTitle')}
      ${stepper('spd', 'field.spd', 'field.spdTitle')}
      <span class="field"><output class="badge" id="model"></output></span>
    </div>
    <div class="toolbar-end">
      <span class="undo-btns"><button class="pill-btn" id="undo" type="button" data-i18n-title="edit.undoTitle" data-i18n-aria-label="edit.undo" disabled>↶</button><button class="pill-btn" id="redo" type="button" data-i18n-title="edit.redoTitle" data-i18n-aria-label="edit.redo" disabled>↷</button></span>
      <button class="pill-btn" id="piano-toggle" type="button" data-i18n-title="piano.toggleTitle" data-i18n="piano.toggle"></button>
      <button class="pill-btn" id="midi" type="button"></button>
      <label class="field volume" data-i18n-title="volume.title"><span data-i18n="volume.label"></span> <input type="range" id="vol" min="0" max="100" step="1"><output id="vol-out"></output></label>
      <select class="pill-btn lang" id="lang" data-i18n-title="language.title" data-i18n-aria-label="language.title">${LOCALES.map((l) => `<option value="${l.code}" lang="${l.code}" title="${l.name}">${l.code.toUpperCase()}</option>`).join('')}</select>
      <button class="pill-btn" id="theme" type="button"></button>
    </div>
  </header>
  <div class="workspace">
    <aside class="sidebar left" data-i18n-aria-label="layout.lists">
      <section class="box">
        <h2 data-i18n="order.title"></h2>
        <div class="order-list" id="order-list"></div>
        <div class="mini-btns">
          <button type="button" id="o-dec" data-i18n-title="order.patDownTitle" data-i18n="order.patDown"></button>
          <button type="button" id="o-inc" data-i18n-title="order.patUpTitle" data-i18n="order.patUp"></button>
          <button type="button" id="o-ins" data-i18n-title="order.insertTitle" data-i18n="order.insert"></button>
          <button type="button" id="o-dup" data-i18n-title="order.duplicateTitle" data-i18n="order.duplicate"></button>
          <button type="button" id="o-del" data-i18n-title="order.deleteTitle" data-i18n="order.delete"></button>
        </div>
      </section>
      <section class="box grow">
        <h2 id="inst-title"></h2>
        <div class="inst-list" id="inst-list"></div>
      </section>
    </aside>
    <main class="editor" data-i18n-aria-label="layout.editor">
      <div class="chan-head" id="chan-head"></div>
      <div class="pattern" id="pattern" tabindex="0" role="grid" data-i18n-aria-label="layout.pattern"></div>
      <div class="piano" id="piano" data-i18n-aria-label="piano.label"></div>
      <div class="keypad" id="keypad"></div>
    </main>
    <aside class="sidebar right" data-i18n-aria-label="layout.editors">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="inst" data-i18n="tab.inst"></button>
        <button type="button" role="tab" data-tab="wave" data-i18n="tab.wave"></button>
        <button type="button" role="tab" data-tab="song" data-i18n="tab.song"></button>
        <button type="button" role="tab" data-tab="file" data-i18n="tab.file"></button>
        <button type="button" role="tab" data-tab="help" data-i18n="tab.help"></button>
      </div>
      <div class="panel" id="panel"></div>
    </aside>
  </div>
  <nav class="mobile-nav" data-i18n-aria-label="nav.views">
    <button type="button" data-view="pattern" data-i18n="nav.pattern"></button>
    <button type="button" data-view="lists" data-i18n="nav.lists"></button>
    <button type="button" data-view="edit" data-i18n="nav.edit"></button>
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
  $('theme').textContent = t(theme === 'dark' ? 'theme.dark' : theme === 'light' ? 'theme.light' : 'theme.auto');
}
applyTheme(loadStored(THEME_KEY));
$('theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ?? 'auto';
  const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
  store(THEME_KEY, next);
  applyTheme(next);
});

// ----------------------------------------------------------------- language

/** Applies the current locale to the static shell; dynamic parts are re-rendered. */
function translateShell() {
  translateDom(app);
  app.querySelectorAll<HTMLElement>('[data-step-name]').forEach((b) => {
    const name = t(b.dataset.stepName as MessageKey);
    b.setAttribute('aria-label', t(b.dataset.stepDir === 'up' ? 'field.up' : 'field.down', { name }));
  });
  ($('lang') as HTMLSelectElement).value = getLocale();
}
translateShell();
$('lang').addEventListener('change', (e) => {
  const code = (e.target as HTMLSelectElement).value;
  store(LANG_KEY, code);
  setLocale(code);
});
onLocaleChange(() => {
  translateShell();
  renderMidi({ ...midi.status, error: undefined });
  applyTheme(document.documentElement.dataset.theme ?? null);
  renderAll();
});

/** Formats a number with the current locale's decimal separator. */
const num = (v: number, digits: number) =>
  v.toLocaleString(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

// ------------------------------------------------------------------ pattern

const kindLabel = (k: 'pulse' | 'wave' | 'noise') => t(`kind.${k}`);
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
  $('inst-title').textContent = t('instList.title', { kind: kindLabel(kind) });
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
        <div class="chan-title"><span>${t('channel.name', { n: i + 1 })} <span class="kind">${kindLabel(k)}</span></span><button type="button" class="mute" aria-pressed="${muted[i]}" title="${t('channel.mute', { n: i + 1 })}">M</button></div>
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
    html += selection && contains(selection, r, ch) ? '<span class="cell sel">' : '<span class="cell">';
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
  selection = null;
  if (cursor.row >= pattern().rows.length) cursor = { ...cursor, row: 0 };
  renderHeader();
  renderPattern();
  if (tab === 'song') renderPanel();
}

// Keep the channel header aligned when the pattern scrolls sideways on small screens.
patternEl.addEventListener('scroll', () => ($('chan-head').scrollLeft = patternEl.scrollLeft));

/** Row and channel of the cell under a pointer event, if any. */
function cellAt(e: PointerEvent) {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
  if (!row) return null;
  return { row: Number(row.dataset.row), ch: f ? Number(f.dataset.ch) : cursor.ch, field: f ? Number(f.dataset.f) : cursor.field };
}

let dragAnchor: { row: number; ch: number } | null = null;
patternEl.addEventListener('pointerdown', (e) => {
  const at = cellAt(e);
  if (!at) return;
  if (e.shiftKey) {
    // Shift-click extends the block from the cursor.
    select({ r0: selection?.r0 ?? cursor.row, c0: selection?.c0 ?? cursor.ch, r1: at.row, c1: at.ch });
    setCursor(at);
    return;
  }
  if (selection) select(null);
  if (e.pointerType === 'mouse') dragAnchor = { row: at.row, ch: at.ch };
  setCursor(at);
});
patternEl.addEventListener('pointermove', (e) => {
  if (!dragAnchor || !(e.buttons & 1)) return;
  const at = cellAt(e);
  if (!at || (selection?.r1 === at.row && selection.c1 === at.ch)) return;
  if (!selection && at.row === dragAnchor.row && at.ch === dragAnchor.ch) return;
  select({ r0: dragAnchor.row, c0: dragAnchor.ch, r1: at.row, c1: at.ch });
  setCursor(at);
});
window.addEventListener('pointerup', () => (dragAnchor = null));

// ------------------------------------------------------------------- blocks

/** Selected block in the current pattern (corners as dragged, unsorted). */
let selection: Block | null = null;
let clipboard: ReturnType<typeof copyBlock> | null = null;

function select(next: Block | null) {
  selection = next;
  renderPattern();
}

/** The selection, or the cell under the cursor. */
function target(): Block {
  return selection ?? { r0: cursor.row, r1: cursor.row, c0: cursor.ch, c1: cursor.ch };
}

function extendSelection(dRow: number, dCh: number) {
  const rows = pattern().rows.length;
  const b = selection ?? { r0: cursor.row, r1: cursor.row, c0: cursor.ch, c1: cursor.ch };
  const r1 = Math.max(0, Math.min(rows - 1, b.r1 + dRow));
  const c1 = Math.max(0, Math.min(CHANNEL_COUNT - 1, b.c1 + dCh));
  selection = { ...b, r1, c1 };
  cursor = { ...cursor, row: r1, ch: c1 };
  renderPattern();
  renderKeypad();
}

function copySelection(cut: boolean) {
  const b = normalize(target(), pattern().rows.length);
  clipboard = copyBlock(pattern(), b);
  if (cut) {
    if (!rec) return;
    clearBlock(pattern(), b);
    changed();
    renderPattern();
  }
  toast(t(cut ? 'edit.cut' : 'edit.copied', { rows: b.r1 - b.r0 + 1, channels: b.c1 - b.c0 + 1 }));
}

function paste(mix: boolean) {
  if (!clipboard || !rec) return;
  const at = pasteBlock(pattern(), cursor.row, cursor.ch, clipboard, mix);
  if (!at) return;
  selection = at;
  changed();
  renderPattern();
}

function transposeSelection(semitones: number) {
  if (!rec) return;
  transposeBlock(pattern(), target(), semitones);
  changed();
  renderPattern();
}

$('undo').addEventListener('click', () => undoRedo(false));
$('redo').addEventListener('click', () => undoRedo(true));

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
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    void saveToLibrary();
    return;
  }
  if ((e.target as HTMLElement).closest('input, textarea, select')) return;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const shortcuts: Record<string, () => void> = {
      KeyZ: () => undoRedo(e.shiftKey),
      KeyY: () => undoRedo(true),
      KeyC: () => copySelection(false),
      KeyX: () => copySelection(true),
      KeyV: () => paste(e.shiftKey),
      KeyA: () => select({ r0: 0, r1: pattern().rows.length - 1, c0: e.shiftKey ? cursor.ch : 0, c1: e.shiftKey ? cursor.ch : CHANNEL_COUNT - 1 }),
      ArrowUp: () => transposeSelection(e.shiftKey ? 12 : 1),
      ArrowDown: () => transposeSelection(e.shiftKey ? -12 : -1),
    };
    const run = shortcuts[e.code];
    if (run) {
      e.preventDefault();
      run();
    }
    return;
  }
  if (e.altKey) return;
  if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.code)) {
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-16, 0], PageDown: [16, 0] }[e.code]!;
    extendSelection(d[0], d[1]);
    e.preventDefault();
    return;
  }
  if (selection && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab'].includes(e.code))
    select(null);
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
      if (selection && rec) {
        clearBlock(pattern(), selection);
        changed();
        renderPattern();
      } else clearCurrent();
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
  const state = `${octave}/${pianoVisible}/${getLocale()}`;
  if (kind === (isNote ? 'note' : 'hex') && keypadEl.dataset.state === state) return;
  keypadEl.dataset.kind = isNote ? 'note' : 'hex';
  keypadEl.dataset.state = state;
  const navRow = `<div class="row">${key('◀', 'action', `data-act="prev" aria-label="${t('keypad.prev')}"`)}${key('▲', 'action', `data-act="up" aria-label="${t('keypad.up')}"`)}${key('▼', 'action', `data-act="down" aria-label="${t('keypad.down')}"`)}${key('▶', 'action', `data-act="next" aria-label="${t('keypad.next')}"`)}${key('↶', 'action', `data-act="undo" aria-label="${t('edit.undo')}"`)}${key('↷', 'action', `data-act="redo" aria-label="${t('edit.redo')}"`)}</div>`;
  if (isNote) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keys = names.map((n, i) => key(n, n.includes('#') ? 'sharp' : '', `data-semi="${i}"`));
    const noteRows = pianoVisible
      ? ''
      : `<div class="row">${keys.slice(0, 6).join('')}</div><div class="row">${keys.slice(6).join('')}</div>`;
    keypadEl.innerHTML = `
      ${noteRows}
      <div class="row">
        ${key(t('keypad.octDown'), 'action', 'data-act="oct-"')}${key(t('keypad.octUp'), 'action', 'data-act="oct+"')}
        ${key(t('keypad.off'), 'action', 'data-act="off"')}${key(t('keypad.del'), 'red', 'data-act="del"')}
      </div>
      ${navRow}`;
  } else {
    const keys = Array.from({ length: 16 }, (_, i) => key(i.toString(16).toUpperCase(), '', `data-hex="${i}"`));
    keypadEl.innerHTML = `
      <div class="row">${keys.slice(0, 8).join('')}</div>
      <div class="row">${keys.slice(8).join('')}</div>
      <div class="row">${key(t('keypad.del'), 'red', 'data-act="del"')}</div>
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
      case 'undo':
      case 'redo':
        undoRedo(b.dataset.act === 'redo');
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
  // A fixed slot count keeps the key size when the top octave has no closing C.
  pianoEl.style.setProperty('--whites', String(pianoWhites(octaves)));
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

function midiTitle(s: MidiStatus) {
  if (!s.supported) return t('midi.unsupported');
  if (s.error) return s.error;
  if (!s.enabled) return t('midi.title');
  return t('midi.inputs', { inputs: s.inputs.join(', ') || t('midi.noInputs') });
}

function renderMidi(s: MidiStatus) {
  const b = $('midi');
  b.setAttribute('aria-pressed', String(s.enabled));
  b.textContent = s.enabled ? `MIDI ${s.inputs.length}` : 'MIDI';
  b.title = midiTitle(s);
  if (s.error) toast(s.supported ? s.error : t('midi.unsupported'));
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
renderMidi({ ...midi.status, error: undefined });
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
  if (song.order.length <= 1) return toast(t('order.lastPosition'));
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
      const trace = scopeTrace(scopeData, scopeFrames, ch);
      const n = trace.length;
      for (let i = 0; i < n; i++) {
        const v = trace[i];
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
  const kinds = ['pulse', 'wave', 'noise'] as const;
  const list =
    instKind === 'pulse' ? song.pulseInstruments : instKind === 'wave' ? song.waveInstruments : song.noiseInstruments;
  const ins = list[instIndex];
  let form = `<label for="i-name">${t('inst.name')}</label><input type="text" id="i-name" value="${ins.name.replace(/"/g, '&quot;')}">`;
  if (instKind === 'pulse') {
    const p = song.pulseInstruments[instIndex];
    form += `<label for="i-duty">${t('inst.duty')}</label><select id="i-duty">${['12.5 %', '25 %', '50 %', '75 %'].map((d, i) => `<option value="${i}" ${p.duty === i ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    form += slider('i-vol', t('inst.volume'), p.volume, 0, 15);
    form += check('i-up', t('inst.envUp'), p.envUp);
    form += slider('i-env', t('inst.envPeriod'), p.envPeriod, 0, 7);
    form += slider('i-len', t('inst.length'), p.length, 0, 64);
    form += `<label></label><div class="hint">${t('inst.sweepHint')}</div>`;
    form += slider('i-sp', t('inst.sweepPeriod'), p.sweepPeriod, 0, 7);
    form += check('i-sn', t('inst.sweepDown'), p.sweepNegate);
    form += slider('i-ss', t('inst.sweepShift'), p.sweepShift, 0, 7);
  } else if (instKind === 'wave') {
    const w = song.waveInstruments[instIndex];
    const sampleOptions = [t('inst.noSample'), ...song.samples.map((x, i) => `${i.toString(16).toUpperCase()} ${escapeHtml(x.name)}`)];
    form += `<label for="i-sample">${t('inst.sample')}</label><select id="i-sample">${sampleOptions.map((d, i) => `<option value="${i - 1}" ${w.sample === i - 1 ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    form += slider('i-wave', t('inst.waveform'), w.wave, 0, WAVE_COUNT - 1);
    form += `<label for="i-wvol">${t('inst.volume')}</label><select id="i-wvol">${[t('inst.waveMute'), '100 %', '50 %', '25 %'].map((d, i) => `<option value="${i}" ${w.volume === i ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
    form += slider('i-len', t('inst.length'), w.length, 0, 256);
  } else {
    const n = song.noiseInstruments[instIndex];
    form += slider('i-vol', t('inst.volume'), n.volume, 0, 15);
    form += check('i-up', t('inst.envUp'), n.envUp);
    form += slider('i-env', t('inst.envPeriod'), n.envPeriod, 0, 7);
    form += slider('i-len', t('inst.length'), n.length, 0, 64);
    form += check('i-narrow', t('inst.narrow'), n.narrow);
  }
  panelEl.innerHTML = `
    <h2>${t('inst.title')}</h2>
    <div class="seg" role="group">${kinds.map((k) => `<button type="button" data-kind="${k}" aria-pressed="${instKind === k}">${kindLabel(k)}</button>`).join('')}</div>
    <div class="inst-grid" style="margin-top:8px">${Array.from({ length: INSTRUMENT_COUNT }, (_, i) => `<button type="button" data-i="${i}" aria-pressed="${i === instIndex}">${(i + 1).toString(16).toUpperCase()}</button>`).join('')}</div>
    <h2>${t('inst.heading', { kind: kindLabel(instKind), n: (instIndex + 1).toString(16).toUpperCase() })}</h2>
    <div class="form">${form}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="i-test">${t('inst.test')}</button>
      <button type="button" class="btn" id="i-use">${t('inst.use')}</button>
    </div>
    <p class="hint">${t('inst.hint')}</p>`;

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
    $<HTMLSelectElement>('i-sample').addEventListener('change', (e) => {
      w.sample = Number((e.target as HTMLSelectElement).value);
      changed();
    });
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
    toast(t('inst.selected', { n: (instIndex + 1).toString(16).toUpperCase() }));
  });
}

function renderWavePanel() {
  const presets = Object.keys(WAVE_PRESETS);
  panelEl.innerHTML = `
    <h2>${t('wave.title')}</h2>
    <div class="inst-grid">${Array.from({ length: WAVE_COUNT }, (_, i) => `<button type="button" data-w="${i}" aria-pressed="${i === waveIndex}">${i.toString(16).toUpperCase()}</button>`).join('')}</div>
    <h2>${t('wave.heading', { n: waveIndex.toString(16).toUpperCase() })}</h2>
    <canvas class="wave-canvas" id="wave-canvas" width="320" height="160" aria-label="${t('wave.draw')}"></canvas>
    <div class="btn-row">${presets.map((p) => `<button type="button" class="btn" data-preset="${p}">${t(`wave.preset.${p}` as MessageKey)}</button>`).join('')}</div>
    <div class="btn-row"><button type="button" class="btn" id="w-import">${t('wave.import')}</button></div>
    <input type="file" id="w-file" accept="audio/*,.wav" class="visually-hidden">
    <p class="hint">${t('wave.importHint')}</p>
    <h2>${t('wave.hex')}</h2>
    <div class="form"><label for="w-hex">${t('wave.data')}</label><input type="text" id="w-hex" spellcheck="false" maxlength="32"></div>
    <p class="hint">${t('wave.hint')}</p>
    <h2>${t('sample.title')}</h2>
    <div class="sample-list">${song.samples
      .map(
        (x, i) => `<div class="sample-row">
          <span class="sample-num">${i.toString(16).toUpperCase()}</span>
          <input type="text" data-sname="${i}" value="${escapeHtml(x.name)}" aria-label="${t('sample.name')}">
          <span class="sample-len">${num(x.data.length / SAMPLE_RATE, 2)} s</span>
          <button type="button" class="btn" data-splay="${i}" aria-label="${t('sample.play')}">▶</button>
          <button type="button" class="btn" data-sdel="${i}" aria-label="${t('sample.delete')}">✕</button>
        </div>`,
      )
      .join('')}</div>
    <div class="btn-row"><button type="button" class="btn" id="s-import" ${song.samples.length >= SAMPLE_COUNT ? 'disabled' : ''}>${t('sample.import')}</button></div>
    <input type="file" id="s-file" accept="audio/*,.wav" class="visually-hidden">
    <p class="hint">${t('sample.hint')}</p>`;
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
      toast(t('wave.hexError'));
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
  const fileInput = $<HTMLInputElement>('w-file');
  $('w-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const { channels, rate } = await decodeAudioFile(file);
      waveFromAudio(toMono(channels), rate).forEach((v, i) => (wave[i] = v));
      draw();
      changed();
      toast(t('wave.imported', { name: file.name }));
    } catch (err) {
      toast(t('wave.importError', { error: (err as Error).message }));
    }
  });
  bindSamples();
}

function bindSamples() {
  panelEl.querySelectorAll<HTMLInputElement>('[data-sname]').forEach((el) =>
    el.addEventListener('input', () => {
      song.samples[Number(el.dataset.sname)].name = el.value;
      changed();
    }),
  );
  panelEl.querySelectorAll<HTMLButtonElement>('[data-splay]').forEach((b) =>
    b.addEventListener('click', () => {
      void ensureAudio();
      audio.send({ type: 'sample', index: Number(b.dataset.splay) });
    }),
  );
  panelEl.querySelectorAll<HTMLButtonElement>('[data-sdel]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.sdel);
      if (!confirm(t('sample.confirmDelete', { name: song.samples[i].name }))) return;
      deleteSample(song, i);
      changed();
      renderPanel();
    }),
  );
  const input = $<HTMLInputElement>('s-file');
  $('s-import').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || song.samples.length >= SAMPLE_COUNT) return;
    try {
      const { channels, rate } = await decodeAudioFile(file);
      const data = sampleFromAudio(toMono(channels), rate);
      song.samples.push({ name: file.name.replace(/\.[^.]*$/, '').slice(0, 22), data });
      changed();
      renderPanel();
      toast(t('sample.imported', { n: (song.samples.length - 1).toString(16).toUpperCase(), seconds: num(data.length / SAMPLE_RATE, 2) }));
    } catch (err) {
      toast(t('wave.importError', { error: (err as Error).message }));
    }
  });
}

/** Decode any audio file the browser understands to PCM. */
async function decodeAudioFile(file: File): Promise<{ channels: Float32Array[]; rate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  return { channels, rate: buffer.sampleRate };
}

function renderSongPanel() {
  const bpm = (speed: number) => t('song.bpm', { bpm: num((59.7275 * 60) / (speed * 4), 1) });
  panelEl.innerHTML = `
    <h2>${t('song.title')}</h2>
    <div class="form">
      <label for="s-title">${t('song.songTitle')}</label><input type="text" id="s-title">
      <label for="s-author">${t('song.author')}</label><input type="text" id="s-author">
      <label>${t('song.hardware')}</label>
      <div class="seg" role="group"><button type="button" data-model="dmg" aria-pressed="${song.model === 'dmg'}">DMG</button><button type="button" data-model="cgb" aria-pressed="${song.model === 'cgb'}">GBC</button></div>
      ${slider('s-speed', t('song.speed'), song.speed, 1, 31)}
      <label></label><div class="hint" id="s-bpm">${bpm(song.speed)}</div>
    </div>
    <h2>${t('song.pattern', { n: hex2(song.order[order]) })}</h2>
    <div class="btn-row" style="margin-top:0">
      <button type="button" class="btn" id="p-new">${t('song.newPattern')}</button>
      <button type="button" class="btn" id="p-clone">${t('song.duplicate')}</button>
      <button type="button" class="btn" id="p-clear">${t('song.clear')}</button>
      <button type="button" class="btn" id="p-up">${t('song.up')}</button>
      <button type="button" class="btn" id="p-down">${t('song.down')}</button>
      <button type="button" class="btn" id="p-delrow">${t('song.deleteRow')}</button>
    </div>
    <div class="form" style="margin-top:10px">${check('s-follow', t('song.follow'), follow)}</div>`;
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
    $('s-bpm').textContent = bpm(v);
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
    if (!confirm(t('song.confirmClear'))) return;
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
  // Following playback is a view setting, not a change to the song.
  $<HTMLInputElement>('s-follow').addEventListener('change', (e) => (follow = (e.target as HTMLInputElement).checked));
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = () => fileName(song.title);

function renderFilePanel() {
  panelEl.innerHTML = `
    <h2>${t('file.title')}</h2>
    <div class="current-song"><strong>${escapeHtml(song.title || t('lib.untitled'))}</strong> <span class="song-state" id="f-state"></span></div>
    <div class="btn-row">
      <button type="button" class="btn" id="f-new">${t('file.new')}</button>
      <button type="button" class="btn primary" id="f-store" title="${t('file.storeTitle')}">${t('file.store')}</button>
      <button type="button" class="btn" id="f-saveas">${t('file.saveAs')}</button>
      <button type="button" class="btn" id="f-demo">${t('file.demo')}</button>
    </div>
    <h2>${t('lib.title', { count: libraryList.length })}</h2>
    <div class="lib-list" id="lib-list"></div>
    <p class="hint">${t(!library ? 'lib.loading' : libraryPersistent ? 'lib.hint' : 'lib.memory')}</p>
    <div class="btn-row">
      <button type="button" class="btn" id="f-open">${t('file.open')}</button>
      <button type="button" class="btn" id="f-save">${t('file.save')}</button>
      <button type="button" class="btn" id="f-backup">${t('file.backup')}</button>
    </div>
    <input type="file" id="f-input" accept=".json,.zip,application/json,application/zip" multiple class="visually-hidden">
    <p class="hint">${t('file.autosave')}</p>
    <h2>${t('export.title')}</h2>
    <div class="form">${slider('x-loops', t('export.loops'), 1, 1, 4)}</div>
    <div class="btn-row">
      <button type="button" class="btn primary" id="x-wav">${t('export.wav')}</button>
      <button type="button" class="btn" id="x-flac">${t('export.flac')}</button>
      <button type="button" class="btn" id="x-stems">${t('export.stems')}</button>
      <button type="button" class="btn" id="x-opus">${t('export.opus')}</button>
      <button type="button" class="btn" id="x-video">${t('export.video')}</button>
      <button type="button" class="btn" id="x-vgm">${t('export.vgm')}</button>
      <button type="button" class="btn" id="x-gbs">${t('export.gbs')}</button>
      <button type="button" class="btn" id="x-rom">${t('export.rom')}</button>
      <button type="button" class="btn" id="x-xm">${t('export.xm')}</button>
      <button type="button" class="btn" id="x-mod">${t('export.mod')}</button>
      <button type="button" class="btn" id="x-gbdk">${t('export.gbdk')}</button>
    </div>
    <p class="hint" id="x-status">${t('export.hint')}</p>`;
  renderSongState();
  renderLibraryList();
  const input = $<HTMLInputElement>('f-input');
  $('f-new').addEventListener('click', () => {
    if (confirmDiscard()) loadSong(createSong(), null);
  });
  $('f-demo').addEventListener('click', () => {
    if (confirmDiscard()) loadSong(demoSong(), null);
  });
  $('f-store').addEventListener('click', () => void saveToLibrary());
  $('f-saveas').addEventListener('click', () => {
    const title = prompt(t('lib.saveAsPrompt'), song.title + t('lib.copySuffix'));
    if (title === null) return;
    song.title = title.trim() || song.title;
    void saveToLibrary(true);
  });
  $('lib-list').addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    const id = button?.closest<HTMLElement>('[data-id]')?.dataset.id;
    if (button && id) void libraryAction(button.dataset.act!, id);
  });
  $('f-open').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) await importFiles(files);
  });
  $('f-save').addEventListener('click', () =>
    download(`${fileBase()}.gbt.json`, JSON.stringify(song), 'application/json'),
  );
  $('f-backup').addEventListener('click', () => void backupLibrary());
  bindRange('x-loops', () => {});
  /** Render audio with progress in the status line, then hand over the file. */
  const exportAudio = (
    id: string,
    build: (opts: RenderOptions) => Promise<{ name: string; data: Uint8Array; type: string; seconds: number }>,
  ) =>
    $(id).addEventListener('click', async () => {
      const btn = $<HTMLButtonElement>(id);
      const status = $('x-status');
      btn.disabled = true;
      try {
        const { name, data, type, seconds } = await build({
          loops: Number($<HTMLInputElement>('x-loops').value),
          onProgress: (s) => (status.textContent = t('export.rendering', { seconds: num(s, 0) })),
        });
        download(name, data as BlobPart, type);
        status.textContent = t('export.audioReady', { name, seconds: num(seconds, 1) });
      } catch (err) {
        status.textContent = (err as Error).message;
      } finally {
        btn.disabled = false;
      }
    });
  exportAudio('x-wav', async (opts) => {
    const { left, right, sampleRate } = await renderSong(structuredClone(song), opts);
    const data = encodeWav(left, right, sampleRate);
    return { name: `${fileBase()}.wav`, data, type: 'audio/wav', seconds: left.length / sampleRate };
  });
  exportAudio('x-flac', async (opts) => {
    const { left, right, sampleRate } = await renderSong(structuredClone(song), opts);
    const data = encodeFlac(left, right, sampleRate);
    return { name: `${fileBase()}.flac`, data, type: 'audio/flac', seconds: left.length / sampleRate };
  });
  exportAudio('x-stems', async (opts) => {
    const stems = await renderStems(song, opts);
    const data = zip(
      stems.map(({ left, right, sampleRate }, ch) => ({
        name: `${fileBase()}_ch${ch + 1}_${CHANNEL_KINDS[ch]}.wav`,
        data: encodeWav(left, right, sampleRate),
      })),
    );
    const { left, sampleRate } = stems[0];
    return { name: `${fileBase()}_stems.zip`, data, type: 'application/zip', seconds: left.length / sampleRate };
  });
  exportAudio('x-opus', async (opts) => {
    if (!canEncode('audio')) throw new Error(t('export.unsupportedError'));
    const { data, seconds } = await exportOpus(structuredClone(song), { loops: opts.loops ?? 1, onProgress: opts.onProgress });
    // Firefox renames audio/ogg downloads to .ogx, so hand the file over untyped.
    return { name: `${fileBase()}.opus`, data, type: 'application/octet-stream', seconds };
  });
  exportAudio('x-video', async (opts) => {
    if (!canEncode('video')) throw new Error(t('export.unsupportedError'));
    const colors = themeColors(getComputedStyle(document.documentElement));
    const { data, seconds } = await exportVideo(structuredClone(song), {
      loops: opts.loops ?? 1,
      onProgress: opts.onProgress,
      colors,
    });
    return { name: `${fileBase()}.webm`, data, type: 'video/webm', seconds };
  });
  $('x-vgm').addEventListener('click', () => {
    const vgm = encodeVgm(captureStream(structuredClone(song)), { title: song.title, author: song.author });
    download(`${fileBase()}.vgm`, vgm as BlobPart, 'application/octet-stream');
  });
  const exportBinary = (build: () => { name: string; data: Uint8Array; warnings?: string[] }) => {
    try {
      const { name, data, warnings } = build();
      download(name, data as BlobPart, 'application/octet-stream');
      $('x-status').textContent = t('export.size', { name, bytes: data.length });
      if (warnings?.length) $('x-status').textContent += ` ${t('export.approxHint', { list: warnings.join(', ') })}`;
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
  $('x-xm').addEventListener('click', () =>
    exportBinary(() => ({ name: `${fileBase()}.xm`, ...encodeXm(structuredClone(song)) })),
  );
  $('x-mod').addEventListener('click', () =>
    exportBinary(() => ({ name: `${fileBase()}.mod`, ...encodeMod(structuredClone(song)) })),
  );
  $('x-gbdk').addEventListener('click', () => {
    const { zip, name, size } = gbdkProject(structuredClone(song));
    download(`${name}_gbdk.zip`, zip as BlobPart, 'application/zip');
    $('x-status').textContent = t('export.gbdkReady', { bytes: size });
  });
}

function renderHelpPanel() {
  const fx = ['0xy', '1xx', '2xx', '3xx', '4xy', '5xx', '7xx', '8xx', '9xx', 'Axy', 'Bxx', 'Cxy', 'Dxx', 'Exx', 'Fxx'].map(
    (code): [string, string] => [code, t(`help.fx.${code[0]}` as MessageKey)],
  );
  const keys: [string, MessageKey][] = [
    ['Z S X D C …', 'help.key.notes'],
    ['1', 'help.key.noteOff'],
    ['0–9, A–F', 'help.key.values'],
    [t('help.keyName.arrows'), 'help.key.move'],
    [t('help.keyName.space'), 'help.key.play'],
    [t('help.keyName.shiftSpace'), 'help.key.loop'],
    [t('help.keyName.del'), 'help.key.clear'],
    [t('help.keyName.ins'), 'help.key.insert'],
    ['Esc', 'help.key.rec'],
    ['[ / ]', 'help.key.octave'],
    ['Ctrl+Z / Ctrl+Y', 'help.key.undo'],
    [t('help.keyName.shiftArrows'), 'help.key.select'],
    ['Ctrl+C / Ctrl+X', 'help.key.copy'],
    ['Ctrl+V', 'help.key.paste'],
    ['Ctrl+↑ / Ctrl+↓', 'help.key.transpose'],
    [t('help.keyName.save'), 'help.key.save'],
  ];
  const table = (rows: [string, string][]) =>
    `<table class="help-table">${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  panelEl.innerHTML = `
    <div class="btn-row" style="margin-top:0"><a class="btn primary" href="./manual.html" target="_blank" rel="noopener">${t('help.manual')}</a><button type="button" class="btn" id="about-open">${t('help.about')}</button></div>
    <h2>${t('help.columns')}</h2>
    <div class="legend"><span class="f0">C-4 ${t('help.col.note')}</span><span class="f1">1 ${t('help.col.instrument')}</span><span class="f2">F ${t('help.col.volume')}</span><span class="f3">A ${t('help.col.effect')}</span><span class="f4">0F ${t('help.col.param')}</span></div>
    <h2>${t('help.keyboard')}</h2>${table(keys.map(([k, m]) => [k, t(m)]))}
    <h2>${t('help.touch')}</h2>
    <p class="hint">${t('help.touchHint')}</p>
    <h2>${t('help.piano')}</h2>
    <p class="hint">${t('help.pianoHint')}</p>
    <h2>${t('help.effects')}</h2>${table(fx)}
    <p class="hint">${t('help.footer')}</p>`;
  $('about-open').addEventListener('click', openAbout);
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

function loadSong(next: Song, id: string | null) {
  if (playing) togglePlay();
  song = next;
  songId = id;
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = 0;
  history.reset(JSON.stringify(next));
  selection = null;
  updateUndoButtons();
  dirty = false;
  order = 0;
  cursor = { row: 0, ch: 0, field: 0 };
  audio.setSong(song);
  persist(true);
  renderAll();
}

// ------------------------------------------------------------------ library

let library: SongLibrary | null = null;
let libraryPersistent = true;
let libraryList: SongMeta[] = [];

function setDirty(value: boolean) {
  if (dirty === value) return;
  dirty = value;
  renderSongState();
}

/** Shows whether the working copy is saved, in the FILE tab and as a dot on the tab. */
function renderSongState() {
  document.querySelector('[data-tab="file"]')?.classList.toggle('dirty', dirty);
  const el = document.getElementById('f-state');
  if (!el) return;
  const state = !songId ? 'lib.notInLibrary' : dirty ? 'lib.unsaved' : 'lib.saved';
  el.textContent = t(state);
  el.dataset.state = state.slice(4);
}

function renderLibraryList() {
  const el = document.getElementById('lib-list');
  if (!el) return;
  const date = (ms: number) =>
    new Date(ms).toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' });
  const action = (act: string, icon: string, label: MessageKey, title: string) =>
    `<button type="button" class="lib-act" data-act="${act}" title="${escapeHtml(t(label, { title }))}" aria-label="${escapeHtml(t(label, { title }))}">${icon}</button>`;
  el.innerHTML = libraryList.length
    ? libraryList
        .map((m) => {
          const title = m.title || t('lib.untitled');
          const info = [m.author, m.model === 'cgb' ? 'GBC' : 'DMG', t('lib.patterns', { count: m.patterns }), date(m.updated)]
            .filter(Boolean)
            .map(escapeHtml)
            .join(' · ');
          const current = m.id === songId;
          return `<div class="lib-row" data-id="${m.id}" aria-current="${current}">
            <button type="button" class="lib-open" data-act="open" title="${escapeHtml(t('lib.open', { title }))}"><span class="lib-title">${escapeHtml(title)}</span><span class="lib-info">${info}</span></button>
            ${action('rename', '✎', 'lib.rename', title)}${action('duplicate', '⧉', 'lib.duplicate', title)}${current ? '<span class="lib-act" aria-hidden="true"></span>' : action('sounds', '♫', 'lib.sounds', title)}${action('delete', '✕', 'lib.delete', title)}
          </div>`;
        })
        .join('')
    : `<p class="hint">${t(library ? 'lib.empty' : 'lib.loading')}</p>`;
}

async function refreshLibrary() {
  if (!library) return;
  libraryList = await library.list();
  if (tab === 'file') renderPanel();
}

/** True when nothing unsaved would be lost, or the user agrees to lose it. */
function confirmDiscard() {
  return !dirty || confirm(t('lib.confirmDiscard', { title: song.title || t('lib.untitled') }));
}

async function saveToLibrary(asCopy = false) {
  if (!library) return;
  try {
    const meta = await library.save(structuredClone(song), asCopy ? undefined : (songId ?? undefined));
    songId = meta.id;
    dirty = false;
    persist(true);
    toast(t('lib.savedToast', { title: meta.title || t('lib.untitled') }));
  } catch (err) {
    toast(t('lib.error', { error: (err as Error).message }));
  }
  renderSongState();
  await refreshLibrary();
}

async function libraryAction(act: string, id: string) {
  if (!library) return;
  const meta = libraryList.find((m) => m.id === id);
  if (!meta) return;
  const title = meta.title || t('lib.untitled');
  try {
    if (act === 'open') {
      if (id === songId && !dirty) return;
      if (!confirmDiscard()) return;
      const next = await library.load(id);
      if (next) loadSong(next, id);
      toast(t('file.loaded', { title }));
    } else if (act === 'rename') {
      const name = prompt(t('lib.renamePrompt'), meta.title);
      if (name === null || !name.trim()) return;
      await library.rename(id, name.trim());
      if (id === songId) {
        song.title = name.trim();
        persist(true);
        renderAll();
      }
    } else if (act === 'duplicate') {
      await library.duplicate(id, t('lib.copySuffix'));
    } else if (act === 'sounds') {
      if (!confirm(t('lib.confirmSounds', { title }))) return;
      const source = await library.load(id);
      if (!source) return;
      copySounds(song, source);
      changed(true);
      toast(t('lib.soundsToast', { title }));
    } else if (act === 'delete') {
      if (!confirm(t('lib.confirmDelete', { title }))) return;
      await library.remove(id);
      if (id === songId) {
        songId = null;
        dirty = true;
        persist(true);
        renderSongState();
      }
    }
  } catch (err) {
    toast(t('lib.error', { error: (err as Error).message }));
  }
  await refreshLibrary();
}

/** Adds song files and library backups (.zip) to the library; a single song is also opened. */
async function importFiles(files: File[]) {
  if (!library) return;
  const songs: Song[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      if (/\.zip$/i.test(file.name)) {
        const dec = new TextDecoder();
        for (const entry of unzip(new Uint8Array(await file.arrayBuffer()))) {
          if (!/\.json$/i.test(entry.name)) continue;
          const text = typeof entry.data === 'string' ? entry.data : dec.decode(entry.data);
          songs.push(parseSong(JSON.parse(text)));
        }
      } else {
        songs.push(parseSong(JSON.parse(await file.text())));
      }
    } catch (err) {
      failed.push(`${file.name}: ${(err as Error).message}`);
    }
  }
  if (failed.length) toast(t('file.loadError', { error: failed.join(', ') }));
  if (!songs.length) return;
  const single = songs.length === 1 && files.length === 1 && !/\.zip$/i.test(files[0].name);
  if (single && !confirmDiscard()) return;
  try {
    const metas = [];
    for (const s of songs) metas.push(await library.save(s));
    if (single) {
      loadSong(songs[0], metas[0].id);
      toast(t('file.loaded', { title: songs[0].title }));
    } else if (!failed.length) {
      toast(t('lib.imported', { count: songs.length }));
    }
  } catch (err) {
    toast(t('lib.error', { error: (err as Error).message }));
  }
  await refreshLibrary();
}

/** Downloads every library song as a .gbt.json file in one ZIP. */
async function backupLibrary() {
  if (!library) return;
  if (!libraryList.length) {
    toast(t('lib.empty'));
    return;
  }
  const songs = (await Promise.all(libraryList.map((m) => library!.load(m.id)))).filter((s): s is Song => !!s);
  const names = uniqueNames(songs.map((s) => fileName(s.title)));
  const data = zip(songs.map((s, i) => ({ name: `${names[i]}.gbt.json`, data: JSON.stringify(s) })));
  download(`gb-tracker-library-${new Date().toISOString().slice(0, 10)}.zip`, data as BlobPart, 'application/zip');
}

void (async () => {
  const opened = await openStore();
  library = new SongLibrary(opened.store);
  libraryPersistent = opened.persistent;
  libraryList = await library.list();
  if (restored && !session && !libraryList.length) {
    // Songs from before the library existed: keep the working copy as the first library song.
    const meta = await library.save(structuredClone(song));
    songId = meta.id;
    dirty = false;
    persist(true);
    libraryList = await library.list();
  } else if (songId && !libraryList.some((m) => m.id === songId)) {
    // Its entry was deleted (in another tab, say): the working copy is not in the library any more.
    songId = null;
    dirty = true;
    persist(true);
  }
  renderSongState();
  if ((tab as string) === 'file') renderPanel();
})().catch((err) => toast(t('lib.error', { error: (err as Error).message })));

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

// The installed app (PWA): the service worker keeps the whole site for offline use.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const sw = navigator.serviceWorker;
  const firstInstall = !sw.controller;
  sw.addEventListener('controllerchange', () => toast(t(firstInstall ? 'pwa.offline' : 'pwa.updated')));
  addEventListener('load', () => sw.register('./sw.js').catch(() => {}));
}
