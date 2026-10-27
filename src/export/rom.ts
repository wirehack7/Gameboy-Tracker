/**
 * Game Boy binaries built from the register stream: a GBS file (Game Boy
 * Sound System, for music players) and a playable ROM (.gb/.gbc) that shows
 * the song title and a play timer.
 *
 * Both share a small SM83 driver at 0x0400 that does exactly what the C
 * driver (gbtr_update) does. The stream data starts at 0x4000 in bank 1 and
 * may span many 16 KiB banks; the driver switches banks by writing to 0x2000,
 * which is the bank register of MBC1/MBC5 cartridges and of GBS players.
 */
import { SAMPLE_PERIOD, SAMPLE_TAC, SAMPLE_TMA, sampleChunks } from '../tracker/sample';
import { CYCLES_PER_TICK, Song } from '../tracker/song';
import { FONT_FIRST, fontText, fontTiles } from './font';
import { CMD_SAMPLE, CMD_SAMPLE_STOP, captureStream, encodeStream, optimizeStream } from './stream';

export const LOAD_ADDRESS = 0x0400;
export const DATA_START = 0x4000;
const BANK_SIZE = 0x4000;
/** Bank numbers are written to 0x2000 only, so 255 banks (~4 MiB) at most. */
const MAX_BANKS = 256;

// WRAM variables (also present in GBS players).
const VAR_WAIT = 0xc000;
const VAR_BANK = 0xc001;
const VAR_PTR = 0xc002; // little endian
const VAR_FRAMES = 0xc004;
const VAR_SECS = 0xc005; // BCD
const VAR_MINS = 0xc006; // BCD
// Sample streaming.
const VAR_SON = 0xc007; // a sample is playing
const VAR_SBANK = 0xc008; // bank of the next chunk
const VAR_SPTR = 0xc009; // address of the next chunk, little endian
const VAR_SLEFT = 0xc00b; // chunks left, little endian
const VAR_ACC = 0xc00d; // GBS: clocks / 16 towards the next frame, little endian

/** GBS with samples: play runs from the timer at 256 Hz, frames every 70224 clocks on average. */
const ACC_STEP = 16384 / 16;
const ACC_FRAME = CYCLES_PER_TICK / 16;

/** The Nintendo logo every cartridge header must contain (0x104-0x133). */
export const NINTENDO_LOGO = Uint8Array.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11,
  0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e,
  0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);

/** Minimal assembler: raw opcode bytes plus label fixups. */
class Asm {
  readonly bytes: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: { at: number; label: string; rel: boolean }[] = [];

  constructor(readonly origin: number) {}

  get pc() {
    return this.origin + this.bytes.length;
  }

  label(name: string) {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.labels.set(name, this.pc);
  }

  db(...bytes: number[]) {
    for (const b of bytes) this.bytes.push(b & 0xff);
  }

  /** Opcode followed by a 16-bit little endian immediate. */
  op16(opcode: number, value: number) {
    this.db(opcode, value & 0xff, value >> 8);
  }

  /** Opcode followed by the absolute address of a label. */
  abs(opcode: number, label: string) {
    this.db(opcode);
    this.fixups.push({ at: this.bytes.length, label, rel: false });
    this.db(0, 0);
  }

  /** Relative jump (jr / jr cc) to a label. */
  jr(opcode: number, label: string) {
    this.db(opcode);
    this.fixups.push({ at: this.bytes.length, label, rel: true });
    this.db(0);
  }

  addr(label: string): number {
    const a = this.labels.get(label);
    if (a === undefined) throw new Error(`unknown label ${label}`);
    return a;
  }

  link(): Uint8Array {
    for (const f of this.fixups) {
      const target = this.addr(f.label);
      if (f.rel) {
        const d = target - (this.origin + f.at + 1);
        if (d < -128 || d > 127) throw new Error(`jr out of range: ${f.label}`);
        this.bytes[f.at] = d & 0xff;
      } else {
        this.bytes[f.at] = target & 0xff;
        this.bytes[f.at + 1] = target >> 8;
      }
    }
    return Uint8Array.from(this.bytes);
  }
}

// Opcodes used below.
const JR = 0x18,
  JR_NZ = 0x20,
  JR_Z = 0x28,
  JR_NC = 0x30,
  JR_C = 0x38,
  CALL = 0xcd,
  JP = 0xc3,
  LD_A_NN = 0xfa,
  LD_NN_A = 0xea,
  LD_HL_NN = 0x21,
  LD_DE_NN = 0x11,
  LD_BC_NN = 0x01,
  LD_SP_NN = 0x31,
  RET = 0xc9;

/** Song location as the driver sees it: bank + address in 0x4000-0x7FFF. */
function location(offset: number): { bank: number; addr: number } {
  return { bank: 1 + Math.floor(offset / BANK_SIZE), addr: DATA_START + (offset % BANK_SIZE) };
}

interface DriverOptions {
  /** Sample table (bank, address, chunk count per sample); omitted for songs without samples. */
  samples?: { bank: number; addr: number; chunks: number }[];
  /** Mask interrupts while a sample starts (the ROM's timer interrupt). */
  ime?: boolean;
}

/**
 * init (A ignored) and play, mirroring StreamPlayer / gbtr_update, plus the
 * sample streaming of SampleVoice: `stick` is the timer interrupt's work.
 */
function driver(a: Asm, loopOffset: number, opts: DriverOptions = {}) {
  const loop = location(loopOffset);
  const samples = opts.samples;

  a.label('init');
  a.db(0xaf); // xor a
  a.op16(LD_NN_A, VAR_WAIT);
  a.op16(LD_NN_A, VAR_FRAMES);
  a.op16(LD_NN_A, VAR_SECS);
  a.op16(LD_NN_A, VAR_MINS);
  a.op16(LD_NN_A, VAR_SON);
  a.op16(LD_NN_A, VAR_PTR); // DATA_START low byte = 0
  a.db(0x3e, DATA_START >> 8); // ld a,0x40
  a.op16(LD_NN_A, VAR_PTR + 1);
  a.db(0x3e, 1); // ld a,1
  a.op16(LD_NN_A, VAR_BANK);
  a.db(RET);

  a.label('play');
  a.op16(LD_HL_NN, VAR_WAIT);
  a.db(0x7e); // ld a,[hl]
  a.db(0xb7); // or a
  a.jr(JR_Z, 'play.read');
  a.db(0x35); // dec [hl]
  a.db(RET);
  a.label('play.read');
  a.op16(LD_A_NN, VAR_BANK);
  a.op16(LD_NN_A, 0x2000);
  a.op16(LD_A_NN, VAR_PTR);
  a.db(0x6f); // ld l,a
  a.op16(LD_A_NN, VAR_PTR + 1);
  a.db(0x67); // ld h,a
  a.label('play.next');
  a.db(0x2a); // ld a,[hl+]
  a.abs(CALL, 'wrap');
  a.db(0xfe, 0x30); // cp 0x30
  a.jr(JR_NC, 'play.cmd');
  a.db(0xc6, 0x10); // add a,0x10
  a.db(0x4f); // ld c,a
  a.db(0x2a); // ld a,[hl+]
  a.abs(CALL, 'wrap');
  a.db(0xe2); // ldh [c],a
  a.jr(JR, 'play.next');
  a.label('play.cmd');
  a.db(0xfe, 0xff); // cp 0xFF
  a.jr(JR_NZ, 'play.notend');
  a.op16(LD_HL_NN, loop.addr);
  a.db(0x3e, loop.bank); // ld a,bank
  a.op16(LD_NN_A, VAR_BANK);
  a.op16(LD_NN_A, 0x2000);
  a.jr(JR, 'play.next');
  a.label('play.notend');
  if (samples) {
    a.db(0xfe, CMD_SAMPLE); // cp 0x30
    a.jr(JR_Z, 'play.sample');
    a.db(0xfe, CMD_SAMPLE_STOP); // cp 0x31
    a.jr(JR_NZ, 'play.wait');
    a.db(0xaf); // xor a
    a.op16(LD_NN_A, VAR_SON);
    a.jr(JR, 'play.next');
  } else {
    a.jr(JR, 'play.wait');
  }
  a.label('play.wait');
  a.db(0xe6, 0x7f); // and 0x7F
  a.db(0x3d); // dec a
  a.op16(LD_NN_A, VAR_WAIT);
  a.db(0x7d); // ld a,l
  a.op16(LD_NN_A, VAR_PTR);
  a.db(0x7c); // ld a,h
  a.op16(LD_NN_A, VAR_PTR + 1);
  a.db(RET);

  if (samples) sampleCode(a, samples, !!opts.ime);

  // After ld a,[hl+]: if HL reached 0x8000, continue at 0x4000 of the next bank. Keeps A.
  a.label('wrap');
  a.db(0xcb, 0x7c); // bit 7,h
  a.db(0xc8); // ret z
  a.db(0x26, DATA_START >> 8); // ld h,0x40
  a.db(0xf5); // push af
  a.op16(LD_A_NN, VAR_BANK);
  a.db(0x3c); // inc a
  a.op16(LD_NN_A, VAR_BANK);
  a.op16(LD_NN_A, 0x2000);
  a.db(0xf1); // pop af
  a.db(RET);
}

/** Sample start (0x30 nn), the per-reload routine `stick` and the sample table. */
function sampleCode(a: Asm, samples: { bank: number; addr: number; chunks: number }[], ime: boolean) {
  a.label('play.sample');
  a.db(0x2a); // ld a,[hl+]
  a.abs(CALL, 'wrap');
  a.db(0xe5); // push hl
  a.db(0x6f, 0x26, 0x00, 0x54, 0x5d); // ld l,a; ld h,0; ld d,h; ld e,l
  a.db(0x29, 0x29, 0x19); // add hl,hl; add hl,hl; add hl,de (x5)
  a.abs(LD_DE_NN, 'samples');
  a.db(0x19); // add hl,de
  if (ime) a.db(0xf3); // di
  a.db(0x2a);
  a.op16(LD_NN_A, VAR_SBANK);
  a.db(0x2a);
  a.op16(LD_NN_A, VAR_SPTR);
  a.db(0x2a);
  a.op16(LD_NN_A, VAR_SPTR + 1);
  a.db(0x2a);
  a.op16(LD_NN_A, VAR_SLEFT);
  a.db(0x7e); // ld a,[hl]
  a.op16(LD_NN_A, VAR_SLEFT + 1);
  a.db(0x3e, 1);
  a.op16(LD_NN_A, VAR_SON);
  if (ime) {
    // Restart the timer period and drop a pending timer interrupt.
    a.db(0x3e, SAMPLE_TMA, 0xe0, 0x05); // ld a,TMA; ldh [TIMA],a
    a.db(0xf0, 0x0f, 0xe6, 0xfb, 0xe0, 0x0f); // ldh a,[IF]; and ~4; ldh [IF],a
  }
  a.abs(CALL, 'stick');
  a.op16(LD_A_NN, VAR_BANK); // back to the stream's bank
  a.op16(LD_NN_A, 0x2000);
  if (ime) a.db(0xfb); // ei
  a.db(0xe1); // pop hl
  a.abs(JP, 'play.next');

  // One timer tick: load the next chunk into wave RAM and restart CH3, or end the sample.
  a.label('stick');
  a.op16(LD_A_NN, VAR_SON);
  a.db(0xb7, 0xc8); // or a; ret z
  a.op16(LD_HL_NN, VAR_SLEFT);
  a.db(0x2a, 0xb6); // ld a,[hl+]; or [hl]
  a.jr(JR_NZ, 'stick.load');
  a.db(0xaf); // xor a
  a.op16(LD_NN_A, VAR_SON);
  a.db(0xe0, 0x1a); // ldh [NR30],a: DAC off
  a.db(RET);
  a.label('stick.load');
  a.op16(LD_HL_NN, VAR_SLEFT);
  a.db(0x7e, 0xd6, 0x01, 0x22); // ld a,[hl]; sub 1; ld [hl+],a
  a.db(0x7e, 0xde, 0x00, 0x77); // ld a,[hl]; sbc 0; ld [hl],a
  a.op16(LD_A_NN, VAR_SBANK);
  a.op16(LD_NN_A, 0x2000);
  a.op16(LD_A_NN, VAR_SPTR);
  a.db(0x6f); // ld l,a
  a.op16(LD_A_NN, VAR_SPTR + 1);
  a.db(0x67); // ld h,a
  a.db(0xaf, 0xe0, 0x1a); // xor a; ldh [NR30],a: channel off, wave RAM writable
  a.db(0x0e, 0x30); // ld c,0x30
  a.label('stick.copy');
  a.db(0x2a, 0xe2, 0x0c, 0x79, 0xfe, 0x40); // ld a,[hl+]; ldh [c],a; inc c; ld a,c; cp 0x40
  a.jr(JR_NZ, 'stick.copy');
  a.db(0x3e, 0x80, 0xe0, 0x1a); // ld a,0x80; ldh [NR30],a
  a.db(0x3e, SAMPLE_PERIOD & 0xff, 0xe0, 0x1d); // ldh [NR33],a
  a.db(0x3e, 0x80 | (SAMPLE_PERIOD >> 8), 0xe0, 0x1e); // ldh [NR34],a: trigger
  a.db(0xcb, 0x7c); // bit 7,h
  a.jr(JR_Z, 'stick.store');
  a.db(0x26, DATA_START >> 8); // ld h,0x40
  a.op16(LD_A_NN, VAR_SBANK);
  a.db(0x3c); // inc a
  a.op16(LD_NN_A, VAR_SBANK);
  a.label('stick.store');
  a.db(0x7d); // ld a,l
  a.op16(LD_NN_A, VAR_SPTR);
  a.db(0x7c); // ld a,h
  a.op16(LD_NN_A, VAR_SPTR + 1);
  a.db(RET);

  a.label('samples');
  for (const s of samples) a.db(s.bank, s.addr & 0xff, s.addr >> 8, s.chunks & 0xff, s.chunks >> 8);
}

/** GBS play with samples, called by the player's timer at 256 Hz. */
function gbsTimerPlay(a: Asm) {
  a.label('tplay');
  a.abs(CALL, 'stick');
  a.op16(LD_HL_NN, VAR_ACC + 1);
  a.db(0x7e, 0xc6, ACC_STEP >> 8, 0x77); // ld a,[hl]; add a,4; ld [hl],a (ACC_STEP is 0x400)
  a.op16(LD_A_NN, VAR_ACC);
  a.db(0xd6, ACC_FRAME & 0xff, 0x5f); // sub lo; ld e,a
  a.op16(LD_A_NN, VAR_ACC + 1);
  a.db(0xde, ACC_FRAME >> 8); // sbc hi
  a.db(0xd8); // ret c: no frame yet
  a.op16(LD_NN_A, VAR_ACC + 1);
  a.db(0x7b); // ld a,e
  a.op16(LD_NN_A, VAR_ACC);
  a.abs(JP, 'play');

  a.label('tinit');
  a.abs(CALL, 'init');
  // The first call plays the first frame.
  a.db(0x3e, (ACC_FRAME - ACC_STEP) & 0xff);
  a.op16(LD_NN_A, VAR_ACC);
  a.db(0x3e, (ACC_FRAME - ACC_STEP) >> 8);
  a.op16(LD_NN_A, VAR_ACC + 1);
  a.db(RET);
}

export interface EncodedSong {
  data: Uint8Array;
  loopOffset: number;
}

export function encodeSong(song: Song): EncodedSong {
  return encodeStream(optimizeStream(captureStream(song)));
}

interface Layout {
  /** Stream data followed by the samples' wave RAM chunks. */
  data: Uint8Array;
  samples?: { bank: number; addr: number; chunks: number }[];
}

/** Place the samples after the stream, 16-byte aligned so no chunk crosses a bank. */
function layout({ data }: EncodedSong, song: Song): Layout {
  if (!song.samples.length) return { data };
  let offset = Math.ceil(data.length / 16) * 16;
  const chunks = song.samples.map((s) => sampleChunks(s.data));
  const samples = chunks.map((c) => {
    const at = { ...location(offset), chunks: c.length / 16 };
    offset += c.length;
    return at;
  });
  const out = new Uint8Array(offset);
  out.set(data);
  offset = Math.ceil(data.length / 16) * 16;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return { data: out, samples };
}

function checkSize({ data }: { data: Uint8Array }) {
  if (1 + Math.ceil(data.length / BANK_SIZE) > MAX_BANKS - 1) throw new Error('Song too long for a Game Boy ROM.');
}

/** Bank 0 code + stream data from 0x4000, as one flat address space. */
function image(code: Uint8Array, data: Uint8Array, minSize: number): Uint8Array {
  if (LOAD_ADDRESS + code.length > DATA_START) throw new Error('Driver code does not fit into bank 0.');
  const out = new Uint8Array(Math.max(minSize, DATA_START + data.length));
  out.set(code, LOAD_ADDRESS);
  out.set(data, DATA_START);
  return out;
}

function ascii(text: string, length: number): number[] {
  const bytes = [...text]
    .map((c) => c.charCodeAt(0))
    .filter((c) => c >= 0x20 && c < 0x7f)
    .slice(0, length);
  while (bytes.length < length) bytes.push(0);
  return bytes;
}

export interface GbsInfo {
  init: number;
  play: number;
}

/** GBS v1 file. Timer control 0: play is called on every VBlank (59.73 Hz). */
export function buildGbs(song: Song, encoded = encodeSong(song)): { data: Uint8Array; info: GbsInfo } {
  const { data, samples } = layout(encoded, song);
  checkSize({ data });
  const a = new Asm(LOAD_ADDRESS);
  driver(a, encoded.loopOffset, { samples });
  if (samples) gbsTimerPlay(a);
  const init = a.addr(samples ? 'tinit' : 'init');
  const play = a.addr(samples ? 'tplay' : 'play');
  const code = a.link();
  const flat = image(code, data, DATA_START);
  const header = new Uint8Array(0x70);
  const v = new DataView(header.buffer);
  header.set([0x47, 0x42, 0x53, 1, 1, 1]); // "GBS", version 1, 1 song, first song 1
  v.setUint16(0x06, LOAD_ADDRESS, true);
  v.setUint16(0x08, init, true);
  v.setUint16(0x0a, play, true);
  v.setUint16(0x0c, 0xfffe, true);
  // Without samples play runs on VBlank; with samples from the timer at 256 Hz.
  header[0x0e] = samples ? SAMPLE_TMA : 0;
  header[0x0f] = samples ? SAMPLE_TAC : 0;
  header.set(ascii(song.title, 32), 0x10);
  header.set(ascii(song.author, 32), 0x30);
  header.set(ascii(`${new Date().getFullYear()} ${song.author}`.trim(), 32), 0x50);
  const out = new Uint8Array(0x70 + flat.length - LOAD_ADDRESS);
  out.set(header);
  out.set(flat.subarray(LOAD_ADDRESS), 0x70);
  return { data: out, info: { init, play } };
}

// Screen layout (tile coordinates, 20x18 visible).
const SCREEN = 0x9800;
const at = (x: number, y: number) => SCREEN + y * 32 + x;
const TIME_POS = at(6, 11);

/** CGB background palette 0: Game Boy white to the A/B button red. */
function rgb555(hex: number): number {
  return ((hex >> 19) & 31) | (((hex >> 11) & 31) << 5) | (((hex >> 3) & 31) << 10);
}
const CGB_PALETTE = [0xf4f1e8, 0xd9a7b6, 0xbe5d81, 0xa3224f].flatMap((c) => {
  const v = rgb555(c);
  return [v & 0xff, v >> 8];
});

function screenLines(song: Song): [x: number, y: number, text: string][] {
  const clip = (s: string) => s.trim().slice(0, 18);
  return [
    [1, 1, 'GB TRACKER'],
    [1, 4, clip(song.title) || 'UNTITLED'],
    [1, 6, clip(song.author ? `BY ${song.author}` : '')],
    [1, 9, `MODEL ${song.model === 'cgb' ? 'CGB' : 'DMG'}`],
    [1, 11, 'TIME 00:00'],
    [1, 16, 'PLAYS IN A LOOP'],
  ];
}

export function romExtension(song: Song) {
  return song.model === 'cgb' ? 'gbc' : 'gb';
}

/** Playable cartridge image (MBC5 when the song needs more than one data bank). */
export function buildRom(song: Song, encoded = encodeSong(song)): { data: Uint8Array; banks: number; play: number } {
  const { data, samples } = layout(encoded, song);
  checkSize({ data });
  const a = new Asm(LOAD_ADDRESS);
  driver(a, encoded.loopOffset, { samples, ime: true });
  if (samples) {
    // Timer interrupt: stream the sample, then give the stream its bank back.
    a.label('isr');
    a.db(0xf5, 0xc5, 0xd5, 0xe5); // push af, bc, de, hl
    a.abs(CALL, 'stick');
    a.op16(LD_A_NN, VAR_BANK);
    a.op16(LD_NN_A, 0x2000);
    a.db(0xe1, 0xd1, 0xc1, 0xf1); // pop hl, de, bc, af
    a.db(0xd9); // reti
  }

  a.label('main');
  a.db(0xf3); // di
  a.op16(LD_SP_NN, 0xfffe);
  a.label('main.vbl');
  a.db(0xf0, 0x44); // ldh a,[LY]
  a.db(0xfe, 144); // cp 144
  a.jr(JR_C, 'main.vbl');
  a.db(0xaf); // xor a
  a.db(0xe0, 0x40); // ldh [LCDC],a: LCD off (only allowed in VBlank)
  a.op16(LD_HL_NN, 0x8000);
  a.abs(LD_DE_NN, 'font');
  const font = fontTiles();
  a.op16(LD_BC_NN, font.length);
  a.abs(CALL, 'copy');
  a.op16(LD_HL_NN, SCREEN);
  a.op16(LD_BC_NN, 0x400);
  a.abs(CALL, 'clear');
  a.db(0x3e, 0x80); // ld a,0x80: palette index 0, auto increment
  a.db(0xe0, 0x68); // ldh [BCPS],a (ignored on DMG)
  a.abs(LD_HL_NN, 'palette');
  a.db(0x06, CGB_PALETTE.length); // ld b,n
  a.label('main.pal');
  a.db(0x2a); // ld a,[hl+]
  a.db(0xe0, 0x69); // ldh [BCPD],a
  a.db(0x05); // dec b
  a.jr(JR_NZ, 'main.pal');
  const lines = screenLines(song).filter(([, , t]) => t);
  lines.forEach(([x, y], i) => {
    a.op16(LD_HL_NN, at(x, y));
    a.abs(LD_DE_NN, `text${i}`);
    a.abs(CALL, 'puts');
  });
  a.db(0x3e, 0xe4); // ld a,0xE4
  a.db(0xe0, 0x47); // ldh [BGP],a
  a.db(0xaf); // xor a
  a.db(0xe0, 0x42); // ldh [SCY],a
  a.db(0xe0, 0x43); // ldh [SCX],a
  a.db(0x3e, 0x91); // ld a,0x91: LCD on, BG tiles at 0x8000, BG on
  a.db(0xe0, 0x40); // ldh [LCDC],a
  a.abs(CALL, 'init');
  if (samples) {
    a.db(0x3e, SAMPLE_TMA, 0xe0, 0x06); // ldh [TMA],a
    a.db(0x3e, SAMPLE_TAC, 0xe0, 0x07); // ldh [TAC],a: 16384 Hz / 64 = 256 Hz
    a.db(0x3e, 0x04, 0xe0, 0xff); // ldh [IE],a: timer only
    a.db(0xaf, 0xe0, 0x0f); // xor a; ldh [IF],a
    a.db(0xfb); // ei
  }
  a.label('main.frame');
  a.db(0xf0, 0x44); // ldh a,[LY]
  a.db(0xfe, 144); // cp 144
  a.jr(JR_NZ, 'main.frame');
  a.abs(CALL, 'clock'); // VRAM first, while VBlank has just begun
  a.abs(CALL, 'play');
  a.label('main.hold');
  a.db(0xf0, 0x44); // ldh a,[LY]
  a.db(0xfe, 144); // cp 144
  a.jr(JR_Z, 'main.hold');
  a.jr(JR, 'main.frame');

  // copy BC bytes from DE to HL
  a.label('copy');
  a.db(0x1a, 0x22, 0x13, 0x0b, 0x78, 0xb1); // ld a,[de]; ld [hl+],a; inc de; dec bc; ld a,b; or c
  a.jr(JR_NZ, 'copy');
  a.db(RET);
  // zero BC bytes at HL (tile 0 is the space)
  a.label('clear');
  a.db(0xaf, 0x22, 0x0b, 0x78, 0xb1); // xor a; ld [hl+],a; dec bc; ld a,b; or c
  a.jr(JR_NZ, 'clear');
  a.db(RET);
  // zero terminated text at DE to the tile map at HL
  a.label('puts');
  a.db(0x1a, 0xb7, 0xc8); // ld a,[de]; or a; ret z
  a.db(0xd6, FONT_FIRST); // sub 0x20
  a.db(0x22, 0x13); // ld [hl+],a; inc de
  a.jr(JR, 'puts');

  // Count frames; every 60 frames advance the BCD clock and redraw it.
  a.label('clock');
  a.op16(LD_HL_NN, VAR_FRAMES);
  a.db(0x34, 0x7e); // inc [hl]; ld a,[hl]
  a.db(0xfe, 60); // cp 60
  a.db(0xd8); // ret c
  a.db(0x36, 0x00, 0x23); // ld [hl],0; inc hl (secs)
  a.db(0x7e, 0xc6, 0x01, 0x27, 0x77); // ld a,[hl]; add a,1; daa; ld [hl],a
  a.db(0xfe, 0x60); // cp 0x60
  a.jr(JR_C, 'clock.draw');
  a.db(0x36, 0x00, 0x23); // ld [hl],0; inc hl (mins)
  a.db(0x7e, 0xc6, 0x01, 0x27, 0x77); // ld a,[hl]; add a,1; daa; ld [hl],a
  a.label('clock.draw');
  a.op16(LD_HL_NN, TIME_POS);
  a.op16(LD_A_NN, VAR_MINS);
  a.abs(CALL, 'bcd');
  a.db(0x23); // inc hl (skip ':')
  a.op16(LD_A_NN, VAR_SECS);
  a.abs(JP, 'bcd');
  // two BCD digits of A to HL
  a.label('bcd');
  a.db(0x47, 0xcb, 0x37, 0xe6, 0x0f, 0xc6, 0x30 - FONT_FIRST, 0x22); // ld b,a; swap a; and 15; add '0'; ld [hl+],a
  a.db(0x78, 0xe6, 0x0f, 0xc6, 0x30 - FONT_FIRST, 0x22); // ld a,b; and 15; add '0'; ld [hl+],a
  a.db(RET);

  a.label('palette');
  a.db(...CGB_PALETTE);
  lines.forEach(([, , text], i) => {
    a.label(`text${i}`);
    a.db(...fontText(text), 0);
  });
  a.label('font');
  a.db(...font);

  const code = a.link();
  const banks = Math.max(2, 1 << Math.ceil(Math.log2(1 + Math.ceil(data.length / BANK_SIZE))));
  const rom = image(code, data, banks * BANK_SIZE);

  // Entry point, timer interrupt vector and header.
  rom.set([0x00, JP, a.addr('main') & 0xff, a.addr('main') >> 8], 0x100);
  if (samples) rom.set([JP, a.addr('isr') & 0xff, a.addr('isr') >> 8], 0x50);
  rom.set(NINTENDO_LOGO, 0x104);
  rom.set(ascii(song.title.toUpperCase(), 11), 0x134);
  rom[0x143] = song.model === 'cgb' ? 0x80 : 0x00;
  rom[0x146] = 0x00; // no SGB
  rom[0x147] = banks > 2 ? 0x19 : 0x00; // MBC5 or ROM only
  rom[0x148] = Math.log2(banks) - 1; // 32 KiB << n
  rom[0x149] = 0x00; // no cartridge RAM
  rom[0x14a] = 0x01; // non-Japanese
  rom[0x14b] = 0x00;
  rom[0x14d] = headerChecksum(rom);
  const global = globalChecksum(rom);
  rom[0x14e] = global >> 8;
  rom[0x14f] = global & 0xff;
  return { data: rom, banks, play: a.addr('play') };
}

export function headerChecksum(rom: Uint8Array): number {
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff;
  return x;
}

export function globalChecksum(rom: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) sum += rom[i];
  return sum & 0xffff;
}
