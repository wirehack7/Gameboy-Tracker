/**
 * A tiny Game Boy style runner for the About dialog: jump over the blocks, the screen gets faster.
 * Pure game state here, drawing in drawGame(). All units are LCD pixels (160 × 144) and frames (60 Hz).
 */

export const SCREEN_W = 160;
export const SCREEN_H = 144;
export const GROUND_Y = 120;
export const PLAYER_X = 24;
export const PLAYER_SIZE = 8;
export const GRAVITY = 0.35;
export const JUMP_VELOCITY = -5.2;
export const START_SPEED = 1.5;
export const MAX_SPEED = 4;
const ACCELERATION = 0.0008;
/** Frames per score point. */
const FRAMES_PER_POINT = 6;

/** The four DMG shades, lightest first. */
export const DMG_SHADES = ['#9bbc0f', '#8bac0f', '#306230', '#0f380f'] as const;

export interface Block {
  x: number;
  w: number;
  h: number;
}

export interface GameState {
  mode: 'ready' | 'run' | 'over';
  frame: number;
  /** Bottom edge of the player. */
  y: number;
  vy: number;
  speed: number;
  /** Scrolled distance, for the ground and hills. */
  dist: number;
  blocks: Block[];
  /** Pixels until the next block appears at the right edge. */
  gap: number;
  seed: number;
  score: number;
}

/** mulberry32: small, deterministic, good enough for level layout. */
function random(state: GameState): number {
  let s = (state.seed = (state.seed + 0x6d2b79f5) | 0);
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

export function createGame(seed = Date.now()): GameState {
  return { mode: 'ready', frame: 0, y: GROUND_Y, vy: 0, speed: START_SPEED, dist: 0, blocks: [], gap: 40, seed, score: 0 };
}

export const onGround = (s: GameState) => s.y >= GROUND_Y && s.vy >= 0;

/** Frames a jump stays in the air. */
export const AIR_FRAMES = Math.ceil((2 * -JUMP_VELOCITY) / GRAVITY);

/** A (or tap): starts, jumps, or restarts after a game over. */
export function press(s: GameState): GameState {
  if (s.mode === 'over') return { ...createGame(s.seed), mode: 'run' };
  const next = { ...s, mode: 'run' as const };
  if (onGround(s)) next.vy = JUMP_VELOCITY;
  return next;
}

export function hits(s: GameState, b: Block): boolean {
  // One pixel of slack on each side so near misses count as misses.
  const left = PLAYER_X + 1;
  const right = PLAYER_X + PLAYER_SIZE - 1;
  return right > b.x && left < b.x + b.w && s.y - 1 > GROUND_Y - b.h;
}

/** Advances one frame. Nothing moves before the first press or after a game over. */
export function step(s: GameState): GameState {
  if (s.mode !== 'run') return s;
  const next: GameState = { ...s, frame: s.frame + 1, blocks: [] };
  next.vy += GRAVITY;
  next.y += next.vy;
  if (next.y >= GROUND_Y) {
    next.y = GROUND_Y;
    next.vy = 0;
  }
  next.speed = Math.min(MAX_SPEED, s.speed + ACCELERATION);
  next.dist += next.speed;
  for (const b of s.blocks) {
    const x = b.x - next.speed;
    if (x + b.w > 0) next.blocks.push({ ...b, x });
  }
  next.gap -= next.speed;
  if (next.gap <= 0) {
    const tall = next.speed > 2.2 && random(next) < 0.35;
    const wide = random(next) < 0.25;
    next.blocks.push({ x: SCREEN_W, w: wide ? 14 : 8, h: tall ? 16 : 8 });
    // Always leave room to land and jump again: one jump's width plus some run-up.
    next.gap = AIR_FRAMES * next.speed + 28 + random(next) * 90;
  }
  next.score = Math.floor(next.frame / FRAMES_PER_POINT);
  if (next.blocks.some((b) => hits(next, b))) next.mode = 'over';
  return next;
}

// --------------------------------------------------------------------- drawing

const SPRITES = {
  run1: ['..3333..', '.300003.', '.303303.', '.300003.', '..3333..', '.322223.', '..3..3..', '.33..33.'],
  run2: ['..3333..', '.300003.', '.303303.', '.300003.', '..3333..', '.322223.', '...33...', '...33...'],
  jump: ['..3333..', '.300003.', '.303303.', '.300003.', '3.3333.3', '.322223.', '.3....3.', '........'],
  hurt: ['..3333..', '.300003.', '.3.33.3.', '.300003.', '..3333..', '.322223.', '.3....3.', '.33..33.'],
};

function sprite(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const c = row[dx];
      if (c === '.') continue;
      ctx.fillStyle = DMG_SHADES[Number(c)];
      ctx.fillRect(x + dx, y + dy, 1, 1);
    }
  });
}

export function drawGame(ctx: CanvasRenderingContext2D, s: GameState) {
  const [c0, c1, c2, c3] = DMG_SHADES;
  ctx.fillStyle = c0;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

  // Hills scroll at a quarter of the speed.
  ctx.fillStyle = c1;
  const far = s.dist / 4;
  for (let x = 0; x < SCREEN_W; x++) {
    const h = Math.round(10 + 6 * Math.sin((x + far) / 14) + 3 * Math.sin((x + far) / 5));
    ctx.fillRect(x, GROUND_Y - h, 1, h);
  }

  // Ground: a dark line and dashes that move with the blocks.
  ctx.fillStyle = c3;
  ctx.fillRect(0, GROUND_Y, SCREEN_W, 1);
  ctx.fillStyle = c2;
  ctx.fillRect(0, GROUND_Y + 1, SCREEN_W, SCREEN_H - GROUND_Y - 1);
  ctx.fillStyle = c1;
  const off = Math.floor(s.dist) % 12;
  for (let x = -off; x < SCREEN_W; x += 12) ctx.fillRect(x, GROUND_Y + 4, 6, 1);
  for (let x = 6 - off; x < SCREEN_W; x += 12) ctx.fillRect(x, GROUND_Y + 9, 4, 1);

  for (const b of s.blocks) {
    const x = Math.round(b.x);
    ctx.fillStyle = c3;
    ctx.fillRect(x, GROUND_Y - b.h, b.w, b.h);
    ctx.fillStyle = c2;
    ctx.fillRect(x + 1, GROUND_Y - b.h + 1, b.w - 2, b.h - 2);
    ctx.fillStyle = c1;
    ctx.fillRect(x + 2, GROUND_Y - b.h + 2, b.w - 4, 1);
  }

  const look =
    s.mode === 'over' ? SPRITES.hurt : !onGround(s) ? SPRITES.jump : Math.floor(s.frame / 6) % 2 ? SPRITES.run2 : SPRITES.run1;
  sprite(ctx, look, PLAYER_X, Math.round(s.y) - PLAYER_SIZE);
}
