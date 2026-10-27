/**
 * The video timeline: frame by frame it must produce exactly the audio of the
 * WAV export, and report the row the player is on, so the picture stays in
 * sync with the sound.
 */
import { describe, expect, it } from 'vitest';
import { Timeline, VIDEO_FPS } from '../../src/export/video';
import { renderSong } from '../../src/export/wav';
import { demoSong } from '../../src/tracker/demo';
import { CYCLES_PER_TICK } from '../../src/tracker/song';

const RATE = 48000;

describe('video timeline', () => {
  it('renders exactly the audio of the WAV export, frame by frame', async () => {
    const song = demoSong();
    const wav = await renderSong(structuredClone(song), { sampleRate: RATE, tail: 0.5 });
    const timeline = new Timeline(structuredClone(song), RATE, VIDEO_FPS, 1, 0.5);
    const left = new Float32Array(wav.left.length + RATE);
    let n = 0;
    let frames = 0;
    for (let f = timeline.next(); f; f = timeline.next()) {
      expect(f.left.length).toBeLessThanOrEqual(RATE / VIDEO_FPS);
      expect(f.channels.length).toBe(f.left.length * 4);
      left.set(f.left, n);
      n += f.left.length;
      frames++;
    }
    // Both stop once the song has looped (checked per 512-sample chunk or per
    // video frame), then add the same tail; up to there the samples are identical.
    expect(Math.abs(n - wav.left.length)).toBeLessThanOrEqual(RATE / VIDEO_FPS);
    const m = Math.min(n, wav.left.length) - RATE / 2 - RATE / VIDEO_FPS;
    expect(m).toBeGreaterThan(RATE * 5);
    let diff = 0;
    for (let i = 0; i < m; i++) diff = Math.max(diff, Math.abs(left[i] - wav.left[i]));
    expect(diff).toBe(0);
    expect(frames).toBe(Math.ceil((n * VIDEO_FPS) / RATE));
  });

  it('keeps frames on the 30 fps grid and follows the playing row', () => {
    const song = demoSong();
    const timeline = new Timeline(song, RATE, VIDEO_FPS, 1, 0);
    const rowSeconds = (song.speed * CYCLES_PER_TICK) / 4194304;
    const seen: string[] = [];
    let total = 0;
    for (let i = 0; i < 90; i++) {
      const f = timeline.next()!;
      total += f.left.length;
      // Rounded per frame, exact over time.
      expect(total).toBe(Math.round(((i + 1) * RATE) / VIDEO_FPS));
      expect(f.time).toBeCloseTo((i + 1) / VIDEO_FPS, 9);
      seen.push(`${f.order}:${f.row}`);
      // The row shown is the one started last (the song has no speed changes at the start).
      const expectedRow = Math.floor(f.time / rowSeconds + 1e-9) % song.patterns[song.order[0]].rows.length;
      if (f.order === 0) expect(Math.abs(f.row - expectedRow)).toBeLessThanOrEqual(1);
    }
    expect(new Set(seen).size).toBeGreaterThan(10);
  });

  it('captures each channel for the scopes', () => {
    const timeline = new Timeline(demoSong(), RATE, VIDEO_FPS, 1, 0);
    const active = [0, 0, 0, 0];
    for (let i = 0; i < 120; i++) {
      const f = timeline.next()!;
      for (let s = 0; s < f.left.length; s++)
        for (let ch = 0; ch < 4; ch++) if (f.channels[s * 4 + ch] !== f.channels[ch]) active[ch]++;
    }
    expect(active.every((a) => a > 0)).toBe(true);
  });
});
