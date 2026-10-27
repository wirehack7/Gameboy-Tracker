/**
 * A small SM83 (Game Boy CPU) interpreter for testing the generated ROM and
 * GBS code. Instructions are decoded from their bit fields (as in the
 * official opcode tables), independently of the hand-assembled bytes in
 * src/export/rom.ts. Unknown opcodes throw. Timing is per instruction in
 * machine cycles, enough to drive LY for VBlank polling.
 */
export interface Bus {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

const R8 = ['b', 'c', 'd', 'e', 'h', 'l', '(hl)', 'a'] as const;

export class Sm83 {
  a = 0;
  f = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  sp = 0xfffe;
  pc = 0x100;
  cycles = 0;
  ime = false;

  constructor(private readonly bus: Bus) {}

  private rd(a: number) {
    this.cycles += 4;
    return this.bus.read(a & 0xffff);
  }
  private wr(a: number, v: number) {
    this.cycles += 4;
    this.bus.write(a & 0xffff, v & 0xff);
  }
  private imm8() {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  private imm16() {
    const lo = this.imm8();
    return lo | (this.imm8() << 8);
  }
  get hl() {
    return (this.h << 8) | this.l;
  }
  set hl(v: number) {
    this.h = (v >> 8) & 0xff;
    this.l = v & 0xff;
  }
  private get zf() {
    return (this.f & 0x80) !== 0;
  }
  private get cf() {
    return (this.f & 0x10) !== 0;
  }
  private flags(z: boolean, n: boolean, h: boolean, c: boolean) {
    this.f = (z ? 0x80 : 0) | (n ? 0x40 : 0) | (h ? 0x20 : 0) | (c ? 0x10 : 0);
  }
  private getR(i: number): number {
    const r = R8[i];
    return r === '(hl)' ? this.rd(this.hl) : this[r];
  }
  private setR(i: number, v: number) {
    const r = R8[i];
    if (r === '(hl)') this.wr(this.hl, v);
    else this[r] = v & 0xff;
  }
  private getRR(i: number): number {
    return [(this.b << 8) | this.c, (this.d << 8) | this.e, this.hl, this.sp][i];
  }
  private setRR(i: number, v: number) {
    v &= 0xffff;
    if (i === 0) [this.b, this.c] = [v >> 8, v & 0xff];
    else if (i === 1) [this.d, this.e] = [v >> 8, v & 0xff];
    else if (i === 2) this.hl = v;
    else this.sp = v;
  }
  private push(v: number) {
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v >> 8);
    this.sp = (this.sp - 1) & 0xffff;
    this.wr(this.sp, v & 0xff);
  }
  private pop(): number {
    const lo = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }
  private cond(i: number): boolean {
    return [!this.zf, this.zf, !this.cf, this.cf][i];
  }
  private alu(op: number, v: number) {
    const a = this.a;
    switch (op) {
      case 0: // add
      case 1: {
        // adc
        const c = op === 1 && this.cf ? 1 : 0;
        const r = a + v + c;
        this.flags((r & 0xff) === 0, false, (a & 15) + (v & 15) + c > 15, r > 0xff);
        this.a = r & 0xff;
        break;
      }
      case 2: // sub
      case 3: // sbc
      case 7: {
        // cp
        const c = op === 3 && this.cf ? 1 : 0;
        const r = a - v - c;
        this.flags((r & 0xff) === 0, true, (a & 15) - (v & 15) - c < 0, r < 0);
        if (op !== 7) this.a = r & 0xff;
        break;
      }
      case 4:
        this.a = a & v;
        this.flags(this.a === 0, false, true, false);
        break;
      case 5:
        this.a = a ^ v;
        this.flags(this.a === 0, false, false, false);
        break;
      case 6:
        this.a = a | v;
        this.flags(this.a === 0, false, false, false);
        break;
    }
  }

  step() {
    const op = this.imm8();
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    if (op === 0x76) throw new Error('halt not supported');
    if (x === 1) return this.setR(y, this.getR(z));
    if (x === 2) return this.alu(y, this.getR(z));
    switch (op) {
      case 0x00:
        return;
      case 0x18: {
        const d = (this.imm8() << 24) >> 24;
        this.pc = (this.pc + d) & 0xffff;
        return;
      }
      case 0x20:
      case 0x28:
      case 0x30:
      case 0x38: {
        const d = (this.imm8() << 24) >> 24;
        if (this.cond(y - 4)) this.pc = (this.pc + d) & 0xffff;
        return;
      }
      case 0x02:
        return this.wr(this.getRR(0), this.a);
      case 0x12:
        return this.wr(this.getRR(1), this.a);
      case 0x0a:
        this.a = this.rd(this.getRR(0));
        return;
      case 0x1a:
        this.a = this.rd(this.getRR(1));
        return;
      case 0x22:
      case 0x32:
        this.wr(this.hl, this.a);
        this.hl = this.hl + (op === 0x22 ? 1 : -1);
        return;
      case 0x2a:
      case 0x3a:
        this.a = this.rd(this.hl);
        this.hl = this.hl + (op === 0x2a ? 1 : -1);
        return;
      case 0x27: {
        let a = this.a;
        const n = (this.f & 0x40) !== 0;
        const h = (this.f & 0x20) !== 0;
        let c = this.cf;
        if (!n) {
          if (c || a > 0x99) {
            a += 0x60;
            c = true;
          }
          if (h || (a & 15) > 9) a += 6;
        } else {
          if (c) a -= 0x60;
          if (h) a -= 6;
        }
        this.a = a & 0xff;
        this.f = (this.a === 0 ? 0x80 : 0) | (this.f & 0x40) | (c ? 0x10 : 0);
        return;
      }
      case 0xc3:
        this.pc = this.imm16();
        return;
      case 0xcd: {
        const t = this.imm16();
        this.push(this.pc);
        this.pc = t;
        return;
      }
      case 0xc9:
        this.pc = this.pop();
        return;
      case 0xe0:
        return this.wr(0xff00 | this.imm8(), this.a);
      case 0xf0:
        this.a = this.rd(0xff00 | this.imm8());
        return;
      case 0xe2:
        return this.wr(0xff00 | this.c, this.a);
      case 0xf2:
        this.a = this.rd(0xff00 | this.c);
        return;
      case 0xea:
        return this.wr(this.imm16(), this.a);
      case 0xfa:
        this.a = this.rd(this.imm16());
        return;
      case 0xf3:
        this.ime = false;
        return;
      case 0xfb:
        this.ime = true;
        return;
      case 0xcb:
        return this.cb(this.imm8());
    }
    if (x === 0 && z === 1) {
      if (y & 1) throw new Error(`unsupported opcode ${op.toString(16)}`); // add hl,rr
      return this.setRR(y >> 1, this.imm16());
    }
    if (x === 0 && z === 3) {
      const i = y >> 1;
      this.cycles += 4;
      return this.setRR(i, this.getRR(i) + (y & 1 ? -1 : 1));
    }
    if (x === 0 && (z === 4 || z === 5)) {
      const v = this.getR(y);
      const r = (v + (z === 4 ? 1 : -1)) & 0xff;
      this.setR(y, r);
      const h = z === 4 ? (v & 15) === 15 : (v & 15) === 0;
      this.f = (r === 0 ? 0x80 : 0) | (z === 5 ? 0x40 : 0) | (h ? 0x20 : 0) | (this.f & 0x10);
      return;
    }
    if (x === 0 && z === 6) return this.setR(y, this.imm8());
    if (x === 3 && z === 6) return this.alu(y, this.imm8());
    if (x === 3 && z === 0 && y < 4) {
      if (this.cond(y)) this.pc = this.pop();
      return;
    }
    if (x === 3 && z === 2 && y < 4) {
      const t = this.imm16();
      if (this.cond(y)) this.pc = t;
      return;
    }
    if (x === 3 && z === 4 && y < 4) {
      const t = this.imm16();
      if (this.cond(y)) {
        this.push(this.pc);
        this.pc = t;
      }
      return;
    }
    if (x === 3 && z === 5 && !(y & 1)) {
      const i = y >> 1;
      return this.push(i === 3 ? (this.a << 8) | this.f : this.getRR(i));
    }
    if (x === 3 && z === 1 && !(y & 1)) {
      const v = this.pop();
      if (y >> 1 === 3) {
        this.a = v >> 8;
        this.f = v & 0xf0;
      } else this.setRR(y >> 1, v);
      return;
    }
    throw new Error(`unsupported opcode ${op.toString(16).padStart(2, '0')} at ${(this.pc - 1).toString(16)}`);
  }

  private cb(op: number) {
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;
    const v = this.getR(z);
    if (x === 1) {
      this.f = (v & (1 << y) ? 0 : 0x80) | 0x20 | (this.f & 0x10);
      return;
    }
    if (x === 2) return this.setR(z, v & ~(1 << y));
    if (x === 3) return this.setR(z, v | (1 << y));
    let r: number;
    let c: boolean;
    switch (y) {
      case 6: // swap
        r = ((v << 4) | (v >> 4)) & 0xff;
        c = false;
        break;
      default:
        throw new Error(`unsupported CB opcode ${op.toString(16)}`);
    }
    this.setR(z, r);
    this.flags(r === 0, false, false, c);
  }

  /** Call a routine and run until it returns. */
  call(addr: number, maxSteps = 1_000_000) {
    const SENTINEL = 0xfeed;
    this.push(SENTINEL);
    this.pc = addr;
    for (let i = 0; i < maxSteps; i++) {
      if (this.pc === SENTINEL) return;
      this.step();
    }
    throw new Error('routine did not return');
  }
}

/**
 * Cartridge + memory map: MBC bank select via writes to 0x2000-0x3FFF,
 * VRAM, WRAM, HRAM/IO. LY is derived from the CPU cycle count. Writes to
 * the APU registers are logged with the cycle they happened at.
 */
export class TestBus implements Bus {
  bank = 1;
  readonly vram = new Uint8Array(0x2000);
  readonly wram = new Uint8Array(0x2000);
  readonly io = new Uint8Array(0x100);
  readonly apuWrites: { cycle: number; addr: number; value: number }[] = [];
  readonly bankWrites: number[] = [];
  cpu!: Sm83;

  constructor(private readonly rom: Uint8Array) {}

  get ly() {
    return Math.floor((this.cpu?.cycles ?? 0) / 456) % 154;
  }

  read(a: number): number {
    if (a < 0x4000) return this.rom[a] ?? 0xff;
    if (a < 0x8000) return this.rom[this.bank * 0x4000 + (a - 0x4000)] ?? 0xff;
    if (a < 0xa000) return this.vram[a - 0x8000];
    if (a >= 0xc000 && a < 0xe000) return this.wram[a - 0xc000];
    if (a >= 0xff00) return a === 0xff44 ? this.ly : this.io[a - 0xff00];
    return 0xff;
  }

  write(a: number, v: number) {
    if (a >= 0x2000 && a < 0x4000) {
      this.bank = v;
      this.bankWrites.push(v);
    } else if (a < 0x8000) {
      /* other MBC registers */
    } else if (a < 0xa000) {
      // VRAM is only reliably writable with the LCD off or during VBlank.
      if (this.io[0x40] & 0x80 && this.ly < 144) throw new Error(`VRAM write outside VBlank (LY ${this.ly})`);
      this.vram[a - 0x8000] = v;
    }
    else if (a >= 0xc000 && a < 0xe000) this.wram[a - 0xc000] = v;
    else if (a >= 0xff00) {
      if (a >= 0xff10 && a < 0xff40) this.apuWrites.push({ cycle: this.cpu.cycles, addr: a & 0xff, value: v });
      this.io[a - 0xff00] = v;
    } else throw new Error(`write to unmapped ${a.toString(16)}`);
  }
}
