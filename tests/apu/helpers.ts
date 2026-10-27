import { Apu, Model, NR52 } from '../../src/apu/apu';

export function poweredApu(model: Model = 'dmg'): Apu {
  const apu = new Apu({ model });
  apu.write(NR52, 0x80);
  return apu;
}

/** Run until the next frame sequencer step has just been executed. */
export function runStep(apu: Apu, steps = 1) {
  for (let i = 0; i < steps; i++) apu.run(apu.frameCounter);
}

/** Run until the frame sequencer is about to execute `step` next. */
export function syncTo(apu: Apu, step: number) {
  while (apu.frameStep !== step) runStep(apu);
}

export function channelOn(apu: Apu, ch: number): boolean {
  return (apu.read(NR52) & (1 << ch)) !== 0;
}

/** Register base for channel 0-3: NRx1..NRx4 offsets. */
export const BASE = [0x10, 0x15, 0x1a, 0x1f];

/** Enable the DAC of a channel so it can be triggered. */
export function dacOn(apu: Apu, ch: number) {
  if (ch === 2) apu.write(0x1a, 0x80);
  else apu.write(BASE[ch] + 2, 0xf0);
}

export function maxLength(ch: number) {
  return ch === 2 ? 256 : 64;
}

export function writeLength(apu: Apu, ch: number, len: number) {
  apu.write(BASE[ch] + 1, maxLength(ch) - len);
}
