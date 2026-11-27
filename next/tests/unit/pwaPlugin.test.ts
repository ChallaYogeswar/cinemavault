import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  renderServiceWorker,
  selectShellFiles,
  versionOf,
  writeServiceWorker,
  type ShellFile,
} from '../../vite-plugins/pwa';

const enc = (text: string) => new TextEncoder().encode(text);
const file = (url: string, text = url): ShellFile => ({ url, bytes: enc(text) });
const TEMPLATE = "const VERSION = '__VERSION__';\nconst PRECACHE = __PRECACHE__;\n";
const SHELL = [file('/index.html'), file('/assets/app-abc.js'), file('/assets/app-abc.css')];

describe('what goes into the app shell', () => {
  it('leaves out the worker itself, source maps and unknown file kinds', () => {
    const urls = selectShellFiles([
      ...SHELL,
      file('/sw.js'),
      file('/assets/app-abc.js.map'),
      file('/robots.txt'),
      file('/data/export.json'),
    ]).map((f) => f.url);
    expect(urls).toEqual(['/assets/app-abc.css', '/assets/app-abc.js', '/index.html']);
  });

  it('is sorted, so the same build always yields the same worker', () => {
    const a = renderServiceWorker(TEMPLATE, SHELL);
    const b = renderServiceWorker(TEMPLATE, [...SHELL].reverse());
    expect(a).toBe(b);
  });
});

describe('the version', () => {
  it('changes when any shipped byte changes, and only then', () => {
    const base = versionOf(SHELL);
    expect(versionOf([...SHELL])).toBe(base);
    expect(versionOf([file('/index.html', 'changed'), ...SHELL.slice(1)])).not.toBe(base);
    expect(versionOf([...SHELL, file('/icons/new.png')])).not.toBe(base);
  });

  it('does not depend on the previous worker (so rebuilding is a no-op)', () => {
    expect(versionOf(selectShellFiles([...SHELL, file('/sw.js', 'old worker')]))).toBe(
      versionOf(selectShellFiles(SHELL)),
    );
  });
});

describe('rendering the worker', () => {
  it('fills in the version and the exact file list', () => {
    const out = renderServiceWorker(TEMPLATE, SHELL);
    expect(out).toMatch(/const VERSION = '[0-9a-f]{12}';/);
    expect(out).toContain('["/assets/app-abc.css","/assets/app-abc.js","/index.html"]');
    expect(out).not.toContain('__VERSION__');
    expect(out).not.toContain('__PRECACHE__');
  });

  it('refuses to build a worker that cannot open the app', () => {
    expect(() => renderServiceWorker(TEMPLATE, [file('/assets/a.js')])).toThrow(/index\.html/);
  });

  it('refuses a template whose placeholders were lost or duplicated', () => {
    expect(() => renderServiceWorker('const x = 1;', SHELL)).toThrow(/placeholders/);
    expect(() => renderServiceWorker(TEMPLATE + '// __VERSION__ mentioned again', SHELL)).toThrow(
      /more than once/,
    );
  });

  it('treats a "$" in a file name literally', () => {
    const out = renderServiceWorker(TEMPLATE, [...SHELL, file("/assets/a$&b$'c.js")]);
    expect(out).toContain("/assets/a$&b$'c.js");
  });
});

describe('writing the worker into a build folder', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes sw.js with the files that are really there, never listing itself or maps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pwa-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'icons'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    writeFileSync(join(dir, 'assets', 'a-1.js'), 'x');
    writeFileSync(join(dir, 'assets', 'a-1.js.map'), '{}');
    writeFileSync(join(dir, 'icons', 'icon.png'), 'png');
    writeFileSync(join(dir, 'sw.js'), 'stale worker from a previous build');
    const template = join(dir, 'template.js');
    writeFileSync(template, TEMPLATE);

    writeServiceWorker(dir, template);

    const out = readFileSync(join(dir, 'sw.js'), 'utf8');
    expect(out).toContain('["/assets/a-1.js","/icons/icon.png","/index.html","/template.js"]');
    expect(out).not.toContain('stale worker');
    expect(out).not.toContain('.map');
  });
});
