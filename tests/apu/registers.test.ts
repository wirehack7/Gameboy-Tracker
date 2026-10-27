// Mirrors Blargg dmg_sound 01-registers and 11-regs after power.
import { describe, expect, it } from 'vitest';
import { Apu, NR10, NR11, NR12, NR50, NR51, NR52, PCM12, PCM34, READ_MASKS } from '../../src/apu/apu';
import { poweredApu } from './helpers';

const REGISTERS = Array.from({ length: 0x20 }, (_, i) => 0x10 + i).filter((a) => a !== NR52);

describe('register read masks (01-registers)', () => {
  it.each(['dmg', 'cgb'] as const)('%s: writing 0x00 reads back the OR mask', (model) => {
    const apu = poweredApu(model);
    for (const a of REGISTERS) {
      apu.write(a, 0x00);
      expect(apu.read(a), `FF${a.toString(16)}`).toBe(READ_MASKS[a - 0x10]);
    }
  });

  it.each(['dmg', 'cgb'] as const)('%s: writing 0xFF reads back 0xFF', (model) => {
    const apu = poweredApu(model);
    for (const a of REGISTERS) {
      apu.write(a, 0xff);
      expect(apu.read(a), `FF${a.toString(16)}`).toBe(0xff);
    }
  });

  it('matches the documented mask table', () => {
    expect(READ_MASKS.slice(0, 0x17)).toEqual([
      0x80, 0x3f, 0x00, 0xff, 0xbf, 0xff, 0x3f, 0x00, 0xff, 0xbf, 0x7f, 0xff, 0x9f, 0xff, 0xbf, 0xff, 0xff, 0x00,
      0x00, 0xbf, 0x00, 0x00, 0x70,
    ]);
  });

  it('NR52 reads 0x70 with power off and 0xF0 with power on and no channel playing', () => {
    const apu = new Apu();
    expect(apu.read(NR52)).toBe(0x70);
    apu.write(NR52, 0x80);
    expect(apu.read(NR52)).toBe(0xf0);
    apu.write(NR52, 0x00);
    expect(apu.read(NR52)).toBe(0x70);
  });

  it('only bit 7 of NR52 is writable', () => {
    const apu = poweredApu();
    apu.write(NR52, 0x8f);
    expect(apu.read(NR52)).toBe(0xf0);
  });

  it('unmapped addresses read 0xFF', () => {
    const apu = poweredApu();
    expect(apu.read(0x15)).toBe(0xff);
    expect(apu.read(0x1f)).toBe(0xff);
    for (let a = 0x27; a < 0x30; a++) expect(apu.read(a)).toBe(0xff);
  });
});

describe('power control (11-regs after power)', () => {
  it.each(['dmg', 'cgb'] as const)('%s: powering off clears all registers', (model) => {
    const apu = poweredApu(model);
    for (const a of REGISTERS) apu.write(a, 0xff);
    apu.write(NR52, 0x00);
    apu.write(NR52, 0x80);
    for (const a of REGISTERS) expect(apu.read(a), `FF${a.toString(16)}`).toBe(READ_MASKS[a - 0x10]);
  });

  it.each(['dmg', 'cgb'] as const)('%s: register writes are ignored while powered off', (model) => {
    const apu = new Apu({ model });
    apu.write(NR10, 0x7f);
    apu.write(NR12, 0xf0);
    apu.write(NR50, 0x77);
    apu.write(NR51, 0xff);
    expect(apu.read(NR10)).toBe(0x80);
    expect(apu.read(NR12)).toBe(0x00);
    expect(apu.read(NR50)).toBe(0x00);
    expect(apu.read(NR51)).toBe(0x00);
  });

  it('DMG: writing the length of NR11 while off does not change duty', () => {
    const apu = new Apu({ model: 'dmg' });
    apu.write(NR11, 0xff);
    expect(apu.read(NR11)).toBe(0x3f);
  });

  it.each(['dmg', 'cgb'] as const)('%s: wave RAM is accessible while powered off', (model) => {
    const apu = new Apu({ model });
    for (let i = 0; i < 16; i++) apu.write(0x30 + i, i * 17);
    for (let i = 0; i < 16; i++) expect(apu.read(0x30 + i)).toBe(i * 17);
  });

  it.each(['dmg', 'cgb'] as const)('%s: power cycling keeps wave RAM', (model) => {
    const apu = poweredApu(model);
    for (let i = 0; i < 16; i++) apu.write(0x30 + i, 0xa5);
    apu.write(NR52, 0);
    apu.write(NR52, 0x80);
    for (let i = 0; i < 16; i++) expect(apu.read(0x30 + i)).toBe(0xa5);
  });

  it('power on resets the frame sequencer so the next step is 0', () => {
    const apu = poweredApu();
    apu.run(8192 * 3);
    apu.write(NR52, 0);
    apu.write(NR52, 0x80);
    expect(apu.frameStep).toBe(0);
  });

  it('power on resets pulse duty position', () => {
    const apu = poweredApu();
    apu.write(0x12, 0xf0);
    apu.write(0x13, 0x00);
    apu.write(0x14, 0x87);
    apu.run(3000);
    expect(apu.ch1.dutyPos).not.toBe(0);
    apu.write(NR52, 0);
    apu.write(NR52, 0x80);
    expect(apu.ch1.dutyPos).toBe(0);
  });
});

describe('initial wave RAM', () => {
  it('differs between DMG and CGB', () => {
    expect(new Apu({ model: 'dmg' }).read(0x30)).toBe(0x84);
    expect(new Apu({ model: 'cgb' }).read(0x31)).toBe(0xff);
  });
});

describe('PCM12 / PCM34 (CGB only)', () => {
  it('reads 0xFF on DMG', () => {
    const apu = poweredApu('dmg');
    expect(apu.read(PCM12)).toBe(0xff);
    expect(apu.read(PCM34)).toBe(0xff);
  });

  it('reflects the digital channel outputs on CGB', () => {
    const apu = poweredApu('cgb');
    apu.write(0x16, 0xc0); // 75 % duty: position 1 is high
    apu.write(0x17, 0xa0);
    apu.write(0x18, 0x00);
    apu.write(0x19, 0x80);
    apu.run(apu.ch2.timer); // advance to duty position 1
    expect(apu.read(PCM12)).toBe(0xa0);
    expect(apu.read(PCM34)).toBe(0x00);
  });
});
