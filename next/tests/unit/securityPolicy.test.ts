import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applySecurityHeaders,
  buildCsp,
  cspDirectives,
  securityHeaderMap,
} from '../../security/policy.mjs';

const vercelJson = readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8');

describe('Content-Security-Policy', () => {
  const directives = cspDirectives();

  it('allows scripts only from this site (no inline, no eval, no CDN)', () => {
    expect(directives['script-src']).toEqual(["'self'"]);
    const all = buildCsp();
    expect(all).not.toContain('unsafe-inline');
    expect(all).not.toContain('unsafe-eval');
    expect(all).not.toMatch(/\bhttp:/);
  });

  it('refuses framing, plugins, <base> tricks and other-origin form posts', () => {
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-src']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    expect(directives['form-action']).toEqual(["'self'"]);
    expect(directives).toHaveProperty('upgrade-insecure-requests');
  });

  it('talks only to itself and Supabase, and loads posters only from TMDB', () => {
    expect(directives['connect-src']).toEqual(["'self'", 'https://*.supabase.co']);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'https://image.tmdb.org']);
  });

  it('has no directive that falls back to a wider default silently', () => {
    expect(directives['default-src']).toEqual(["'self'"]);
    for (const name of ['worker-src', 'manifest-src', 'media-src', 'font-src', 'style-src']) {
      expect(directives).toHaveProperty(name);
    }
  });

  it('adds only what a test asks for, and can drop the https upgrade for http localhost', () => {
    const test = cspDirectives({ connect: ['http://127.0.0.1:1'], upgradeInsecure: false });
    expect(test['connect-src']).toContain('http://127.0.0.1:1');
    expect(test).not.toHaveProperty('upgrade-insecure-requests');
    expect(cspDirectives()['connect-src']).not.toContain('http://127.0.0.1:1');
  });
});

describe('security headers', () => {
  it('include HSTS, a strict opener policy, and no accidental preload', () => {
    const headers = securityHeaderMap();
    expect(headers['Strict-Transport-Security']).toMatch(/^max-age=\d{8,}; includeSubDomains$/);
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });
});

describe('vercel.json', () => {
  it('is exactly what security/policy.mjs generates (run: node scripts/sync-security-headers.mjs)', () => {
    const wanted = `${JSON.stringify(applySecurityHeaders(JSON.parse(vercelJson) as object), null, 2)}\n`;
    expect(vercelJson).toBe(wanted);
  });

  it('carries the Content-Security-Policy on every path', () => {
    const config = JSON.parse(vercelJson) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const all = config.headers.find((rule) => rule.source === '/(.*)');
    expect(all?.headers.find((h) => h.key === 'Content-Security-Policy')?.value).toBe(buildCsp());
  });

  it('leaves the other rules alone when the policy is re-applied', () => {
    const config = { rewrites: [{ source: '/x' }], headers: [{ source: '/sw.js', headers: [] }] };
    const next = applySecurityHeaders(config);
    expect(next.rewrites).toEqual(config.rewrites);
    expect(next.headers.map((r: { source: string }) => r.source)).toEqual(['/(.*)', '/sw.js']);
  });
});
