import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { renderManual } from './render';

/**
 * Fills manual.html with docs/MANUAL.md at build time (and on every request
 * in the dev server), so the repository and the site share one source.
 */
export function manualPage(root: string): Plugin {
  const source = resolve(root, 'docs/MANUAL.md');
  return {
    name: 'gb-tracker-manual',
    configureServer(server) {
      server.watcher.add(source);
      server.watcher.on('change', (file) => {
        if (resolve(file) === source) server.ws.send({ type: 'full-reload' });
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('manual.html')) return html;
        const { html: body, sections } = renderManual(readFileSync(source, 'utf8'), './docs/');
        const nav = sections.map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`).join('');
        return html.replace('<!-- manual:nav -->', nav).replace('<!-- manual:body -->', body);
      },
    },
  };
}
