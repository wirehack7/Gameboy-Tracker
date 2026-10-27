/**
 * GBDK-2020 export: the register stream as a C array plus a tiny C driver and
 * an example project. The driver only copies bytes to the APU registers once
 * per frame, so playback on hardware matches the tracker exactly.
 */
import { Song } from '../tracker/song';
import { RegisterStream, captureStream, encodeStream, optimizeStream } from './stream';
import { ZipEntry, zip } from './zip';

export function symbolName(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s || s === 'main' || s.startsWith('gbtr_')) return `song_${s}`.replace(/_$/, '');
  return /^[0-9]/.test(s) ? `song_${s}` : s;
}

/** Escape a string for a C comment / string literal. */
function cText(s: string) {
  return s.replace(/[^\x20-\x7e]/g, '?').replace(/\*\//g, '* /').replace(/["\\]/g, '\\$&');
}

export const PLAYER_H = `#ifndef GBTR_PLAYER_H
#define GBTR_PLAYER_H

#include <stdint.h>

/*
 * GB Tracker register stream player.
 *
 * Stream format:
 *   0x00-0x2F vv  write vv to register 0xFF10 + command
 *   0x81-0xFE     wait (command & 0x7F) frames
 *   0xFF          continue at the loop offset
 */

/* Start playing a song. Turns the APU on. */
void gbtr_play(const uint8_t *data, uint16_t loop_offset);

/* Call exactly once per frame (VBlank), e.g. after vsync() or from add_VBL(). */
void gbtr_update(void);

/* Stop playback and silence all channels. */
void gbtr_stop(void);

#endif
`;

export const PLAYER_C = `#include <gb/gb.h>
#include <gb/hardware.h>
#include "gbtr_player.h"

static const uint8_t *gbtr_pos;
static const uint8_t *gbtr_loop;
static uint8_t gbtr_wait;

void gbtr_play(const uint8_t *data, uint16_t loop_offset) {
    gbtr_pos = 0;
    NR52_REG = 0x80;
    NR50_REG = 0x77;
    NR51_REG = 0xFF;
    gbtr_wait = 0;
    gbtr_loop = data + loop_offset;
    gbtr_pos = data;
}

void gbtr_update(void) {
    uint8_t cmd;
    if (!gbtr_pos) return;
    if (gbtr_wait) {
        gbtr_wait--;
        return;
    }
    for (;;) {
        cmd = *gbtr_pos++;
        if (cmd < 0x30) {
            *(volatile uint8_t *)(0xFF10u + cmd) = *gbtr_pos++;
        } else if (cmd == 0xFF) {
            gbtr_pos = gbtr_loop;
        } else {
            gbtr_wait = (cmd & 0x7F) - 1;
            return;
        }
    }
}

void gbtr_stop(void) {
    gbtr_pos = 0;
    NR52_REG = 0x00;
    NR52_REG = 0x80;
}
`;

export function songSources(song: Song, stream: RegisterStream, name = symbolName(song.title)) {
  const { data, loopOffset } = encodeStream(optimizeStream(stream));
  const guard = `${name.toUpperCase()}_H`;
  const header = `#ifndef ${guard}
#define ${guard}

#include <stdint.h>

/* "${cText(song.title)}"${song.author ? ` by ${cText(song.author)}` : ''}, exported from GB Tracker (${song.model.toUpperCase()}). */

#define ${name.toUpperCase()}_SIZE ${data.length}u

extern const uint8_t ${name}_data[];
extern const uint16_t ${name}_loop;

#endif
`;
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 16) {
    lines.push(
      '    ' +
        Array.from(data.subarray(i, i + 16))
          .map((b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`)
          .join(', ') +
        ',',
    );
  }
  const source = `#include "${name}.h"

const uint16_t ${name}_loop = ${loopOffset}u;

const uint8_t ${name}_data[] = {
${lines.join('\n')}
};
`;
  return { header, source, size: data.length, frames: stream.frames.length, loopFrame: stream.loopFrame };
}

export function exampleMain(song: Song, name: string) {
  return `#include <gb/gb.h>
#include <stdio.h>
#include "gbtr_player.h"
#include "${name}.h"

void main(void) {
    printf("\\n GB TRACKER\\n\\n %s\\n", "${cText(song.title).slice(0, 18)}");
    gbtr_play(${name}_data, ${name}_loop);
    while (1) {
        vsync();
        gbtr_update();
    }
}
`;
}

export function makefile(song: Song, name: string) {
  const title = cText(song.title || 'GB TRACKER')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .slice(0, 11) || 'GB TRACKER';
  const cgb = song.model === 'cgb' ? ' -Wm-yc' : '';
  return `# Builds ${name}.gb with GBDK-2020 (https://github.com/gbdk-2020/gbdk-2020).
GBDK_HOME ?= ../gbdk/
LCC = $(GBDK_HOME)bin/lcc

${name}.gb: main.c gbtr_player.c ${name}.c gbtr_player.h ${name}.h
\t$(LCC) -Wm-yn"${title}"${cgb} -o $@ main.c gbtr_player.c ${name}.c

clean:
\trm -f *.gb *.o *.lst *.map *.sym *.ihx *.noi *.asm *.rel *.cdb *.adb

.PHONY: clean
`;
}

export function readme(song: Song, name: string, size: number) {
  return `# ${song.title || 'Song'} – GBDK export

Exported from GB Tracker. The song is stored as a stream of APU register writes
(${size} bytes) and played by a small driver that runs once per frame.

## Build

\`\`\`sh
make GBDK_HOME=/path/to/gbdk/
\`\`\`

This produces \`${name}.gb\`${song.model === 'cgb' ? ' (flagged as Game Boy Color compatible)' : ''}.

## Use in your own project

1. Copy \`gbtr_player.c\`, \`gbtr_player.h\`, \`${name}.c\` and \`${name}.h\` into your project.
2. Start the song with \`gbtr_play(${name}_data, ${name}_loop);\`
3. Call \`gbtr_update();\` once per frame, e.g. right after \`vsync()\`, or register it
   with \`add_VBL(gbtr_update);\`.
4. \`gbtr_stop();\` silences the APU.

The data lives in ROM bank 0/1. Very long songs can exceed the space of a 32 KB ROM;
in that case put \`${name}.c\` in its own bank (\`#pragma bank\`) and switch to it with
\`SWITCH_ROM()\` before calling \`gbtr_update()\`.
`;
}

export function gbdkProject(song: Song): { zip: Uint8Array; name: string; size: number } {
  const name = symbolName(song.title);
  const stream = captureStream(song);
  const src = songSources(song, stream, name);
  const entries: ZipEntry[] = [
    { name: `${name}/gbtr_player.h`, data: PLAYER_H },
    { name: `${name}/gbtr_player.c`, data: PLAYER_C },
    { name: `${name}/${name}.h`, data: src.header },
    { name: `${name}/${name}.c`, data: src.source },
    { name: `${name}/main.c`, data: exampleMain(song, name) },
    { name: `${name}/Makefile`, data: makefile(song, name) },
    { name: `${name}/README.md`, data: readme(song, name, src.size) },
  ];
  return { zip: zip(entries), name, size: src.size };
}
