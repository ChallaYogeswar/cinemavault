import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Rule {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}
const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')) as {
  headers: Rule[];
  rewrites: { source: string }[];
};

describe('vercel.json', () => {
  it('sends the basic security headers on every path', () => {
    const all = config.headers.find((rule) => rule.source === '/(.*)');
    const sent = new Map(all?.headers.map((h) => [h.key, h.value]));
    expect(sent.get('X-Content-Type-Options')).toBe('nosniff');
    expect(sent.get('X-Frame-Options')).toBe('DENY');
    expect(sent.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(sent.get('Permissions-Policy')).toContain('camera=()');
  });

  it('still keeps the service worker and manifest uncached, and never rewrites /api', () => {
    const sources = config.headers.map((rule) => rule.source);
    expect(sources).toContain('/sw.js');
    expect(sources).toContain('/manifest.webmanifest');
    expect(config.rewrites.every((rule) => rule.source.includes('(?!api/'))).toBe(true);
  });
});
