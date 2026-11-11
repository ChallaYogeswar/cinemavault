import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';

/** File kinds that make up the app shell. Anything else in dist is left to the network. */
const SHELL_FILE = /\.(?:js|css|html|png|svg|webmanifest|ico|woff2)$/;
const SW_FILE = 'sw.js';

export interface ShellFile {
  /** URL path, starting with "/". */
  readonly url: string;
  readonly bytes: Uint8Array;
}

/** Pure: decides what the worker precaches and what version it carries. */
export function selectShellFiles(all: readonly ShellFile[]): ShellFile[] {
  return all
    .filter((file) => file.url !== `/${SW_FILE}` && SHELL_FILE.test(file.url))
    .sort((a, b) => (a.url < b.url ? -1 : 1));
}

export function versionOf(files: readonly ShellFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.url);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** Pure: fills the template. Throws if the shell is unusable or a placeholder is missing. */
export function renderServiceWorker(template: string, all: readonly ShellFile[]): string {
  const files = selectShellFiles(all);
  if (!files.some((file) => file.url === '/index.html')) {
    throw new Error('PWA: /index.html is missing from the build output.');
  }
  if (!template.includes('__VERSION__') || !template.includes('__PRECACHE__')) {
    throw new Error('PWA: the service worker template lost its placeholders.');
  }
  // Function replacers: a `$` in the replacement text must never be treated as a pattern.
  const out = template
    .replace('__VERSION__', () => versionOf(files))
    .replace('__PRECACHE__', () => JSON.stringify(files.map((file) => file.url)));
  if (out.includes('__VERSION__') || out.includes('__PRECACHE__')) {
    throw new Error('PWA: a placeholder appears more than once or was left unfilled.');
  }
  return out;
}

function* walk(root: string): Generator<string> {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

export function readShellFiles(dist: string): ShellFile[] {
  return [...walk(dist)].map((path) => ({
    url: '/' + relative(dist, path).split(sep).join('/'),
    bytes: readFileSync(path),
  }));
}

/** Reads the finished build in `outDir` and writes `sw.js` next to it. */
export function writeServiceWorker(outDir: string, templatePath: string): void {
  const template = readFileSync(templatePath, 'utf8');
  writeFileSync(join(outDir, SW_FILE), renderServiceWorker(template, readShellFiles(outDir)));
}

/** Writes `dist/sw.js` after the bundle is complete, so the precache list is exact. */
export function pwaPlugin(options: { readonly template: string }): Plugin {
  let outDir = 'dist';
  return {
    name: 'cinemavault-pwa',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      writeServiceWorker(outDir, options.template);
    },
  };
}
