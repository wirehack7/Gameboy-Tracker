import { describe, expect, it } from 'vitest';
import {
  AIR_FRAMES,
  GROUND_Y,
  MAX_SPEED,
  PLAYER_X,
  START_SPEED,
  createGame,
  hits,
  onGround,
  press,
  step,
} from '../../src/ui/game';

const run = (s: ReturnType<typeof createGame>, frames: number) => {
  for (let i = 0; i < frames; i++) s = step(s);
  return s;
};

describe('about mini game', () => {
  it('waits for the first press', () => {
    const s = createGame(1);
    expect(run(s, 100)).toBe(s);
    expect(press(s).mode).toBe('run');
  });

  it('jumps, lands again after AIR_FRAMES and only jumps from the ground', () => {
    let s = { ...press(createGame(1)), gap: 1e9 };
    s = step(s);
    expect(s.y).toBeLessThan(GROUND_Y);
    expect(press(s).vy).toBe(s.vy); // no double jump
    s = run(s, AIR_FRAMES - 1);
    expect(onGround(s)).toBe(true);
    expect(s.y).toBe(GROUND_Y);
  });

  it('jumps high enough to clear the tallest block', () => {
    let s = { ...press(createGame(1)), gap: 1e9 };
    let top = GROUND_Y;
    for (let i = 0; i < AIR_FRAMES; i++) top = Math.min(top, (s = step(s)).y);
    expect(GROUND_Y - top).toBeGreaterThan(16 + 8);
  });

  it('ends the game on a block and restarts on the next press', () => {
    const s = { ...createGame(1), mode: 'run' as const, blocks: [{ x: PLAYER_X + 2, w: 8, h: 8 }], gap: 1e9 };
    expect(hits(s, s.blocks[0])).toBe(true);
    const over = step(s);
    expect(over.mode).toBe('over');
    expect(step(over)).toBe(over);
    const again = press(over);
    expect(again.mode).toBe('run');
    expect(again.blocks).toEqual([]);
    expect(again.score).toBe(0);
  });

  it('does not count a block it is above', () => {
    const s = { ...createGame(1), y: GROUND_Y - 10 };
    expect(hits(s, { x: PLAYER_X, w: 8, h: 8 })).toBe(false);
  });

  it('a jump at the right time clears every block of a long seeded run', () => {
    // A simple bot: jump when the next block is close. If gaps were too short to land
    // and jump again, it would crash.
    for (const seed of [1, 2, 3, 42, 1234]) {
      let s = press(createGame(seed));
      for (let i = 0; i < 60 * 120 && s.mode === 'run'; i++) {
        const next = s.blocks.find((b) => b.x + b.w > PLAYER_X);
        if (next && onGround(s) && next.x - PLAYER_X < s.speed * 8 + 4) s = press(s);
        s = step(s);
      }
      expect(s.mode, `seed ${seed}`).toBe('run');
      expect(s.speed).toBeGreaterThan(START_SPEED);
      expect(s.speed).toBeLessThanOrEqual(MAX_SPEED);
      expect(s.score).toBeGreaterThan(1000);
    }
  });

  it('is deterministic for a seed', () => {
    const a = run(press(createGame(7)), 600);
    const b = run(press(createGame(7)), 600);
    expect(a).toEqual(b);
  });
});
