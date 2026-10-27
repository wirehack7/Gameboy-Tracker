import { afterEach, describe, expect, it, vi } from 'vitest';
import { analytics, trackingCode, trackingLoader } from '../../src/analytics/plugin';
import { TRACK_EVENT, track } from '../../src/analytics/track';

const SNIPPET =
  '<script defer src="https://stats.example/a.js" data-site="x"></script>\n<script>window.ok = 1;</script>';

describe('tracking code', () => {
  it('is off unless the variable is set', () => {
    expect(trackingCode({})).toBeNull();
    expect(trackingCode({ TRACKING_CODE: '  \n' })).toBeNull();
    expect(trackingCode({ TRACKING_CODE: ` ${SNIPPET}\n` })).toBe(SNIPPET);
  });

  it('is injected only when set', () => {
    const tags = (p: ReturnType<typeof analytics>) => (p.transformIndexHtml as unknown as () => { children: string }[])();
    expect(tags(analytics(null))).toEqual([]);
    const [tag, ...rest] = tags(analytics(SNIPPET));
    expect(rest).toEqual([]);
    // The snippet's own </script> must not close the inline loader.
    expect(tag.children).not.toMatch(/<\/script/i);
  });
});

describe('tracking loader', () => {
  /** Runs the loader against a minimal DOM that parses the snippet's script tags. */
  function run(nav: Record<string, unknown>) {
    const added: { attrs: Record<string, string>; text: string }[] = [];
    const script = () => {
      const attrs: Record<string, string> = {};
      return { nodeType: 1, tagName: 'SCRIPT', text: '', attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) };
    };
    const document = {
      createElement: (tag: string) => {
        if (tag === 'script') return script();
        const t = {
          content: { childNodes: [] as unknown[] },
          set innerHTML(html: string) {
            for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
              const el = script();
              for (const a of m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.attrs[a[1]] = a[2] ?? '';
              el.text = m[2];
              t.content.childNodes.push({
                ...el,
                attributes: Object.entries(el.attrs).map(([name, value]) => ({ name, value })),
              });
            }
          },
        };
        return t;
      },
      importNode: (n: unknown) => n,
      head: { appendChild: (s: { attrs: Record<string, string>; text: string }) => added.push({ attrs: s.attrs, text: s.text }) },
    };
    new Function('navigator', 'window', 'document', trackingLoader(SNIPPET))(nav, {}, document);
    return added;
  }

  it('adds the snippet scripts with their attributes', () => {
    expect(run({})).toEqual([
      { attrs: { defer: '', src: 'https://stats.example/a.js', 'data-site': 'x' }, text: '' },
      { attrs: {}, text: 'window.ok = 1;' },
    ]);
  });

  it('respects Do Not Track and Global Privacy Control', () => {
    expect(run({ doNotTrack: '1' })).toEqual([]);
    expect(run({ globalPrivacyControl: true })).toEqual([]);
    expect(run({ doNotTrack: '0' })).toHaveLength(2);
  });
});

describe('track', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('dispatches a window event', () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener(TRACK_EVENT, (e) => seen.push((e as CustomEvent).detail));
    vi.stubGlobal('window', target);
    track('export', { format: 'xm' });
    track('stop');
    expect(seen).toEqual([{ name: 'export', data: { format: 'xm' } }, { name: 'stop', data: undefined }]);
  });

  it('never throws', () => {
    vi.stubGlobal('window', {
      dispatchEvent: () => {
        throw new Error('blocked');
      },
    });
    expect(() => track('play')).not.toThrow();
  });
});
