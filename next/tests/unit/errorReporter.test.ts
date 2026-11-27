import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REPORTS,
  installGlobalErrorHandlers,
  reportError,
  resetErrorReporting,
  scrub,
  screenOf,
  setErrorSink,
  toReport,
  type ErrorReport,
} from '@/app/errorReporter';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

beforeEach(() => {
  resetErrorReporting();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  setErrorSink(null);
  vi.restoreAllMocks();
});

describe('scrub', () => {
  it('removes tokens, e-mail addresses, ids, query strings and hashes', () => {
    const out = scrub(
      `failed for yoge@example.com id 2e818ae8-f416-47ed-8f65-b1ed26d45ff0 with ${JWT} ` +
        `Authorization: Bearer abc.def at https://app.test/library?query=Inception#access_token=zzz`,
    );
    expect(out).not.toMatch(/yoge|example\.com|2e818ae8|eyJ|abc\.def|Inception|zzz/);
    expect(out).toContain('[email]');
    expect(out).toContain('[id]');
    expect(out).toContain('[token]');
    expect(out).toContain('?[query]');
    expect(out).toContain('#[hash]');
  });

  it('leaves ordinary code messages readable', () => {
    expect(scrub("Cannot read properties of undefined (reading 'map')")).toBe(
      "Cannot read properties of undefined (reading 'map')",
    );
  });
});

describe('screenOf', () => {
  it('keeps the screen, drops ids and query strings', () => {
    expect(screenOf('/library/2e818ae8-f416-47ed-8f65-b1ed26d45ff0/edit')).toBe(
      '/library/[id]/edit',
    );
    expect(screenOf('/discover?query=secret#x')).toBe('/discover');
  });
});

describe('toReport', () => {
  it('carries a real error’s kind, scrubbed message and stack, and the screen', () => {
    const error = new TypeError(`bad value for yoge@example.com`);
    const report = toReport(error, 'render', '/library/2e818ae8-f416-47ed-8f65-b1ed26d45ff0');
    expect(report).toMatchObject({ source: 'render', name: 'TypeError', screen: '/library/[id]' });
    expect(report.message).toBe('bad value for [email]');
    expect(report.stack).not.toContain('yoge@example.com');
    expect(Number.isNaN(Date.parse(report.at))).toBe(false);
  });

  it('never copies a thrown string or object, which could be a title or a note', () => {
    const report = toReport('My private note about Heat', 'promise', '/');
    expect(report.message).toBe('A non-error value was thrown.');
    expect(JSON.stringify(report)).not.toContain('private note');
    expect(toReport({ title: 'Heat' }, 'promise', '/').name).toBe('NonError');
  });

  it('bounds the size of a report', () => {
    const error = new Error('x'.repeat(5000));
    error.stack = `Error\n${'at f (a.js:1:1)\n'.repeat(1000)}`;
    const report = toReport(error, 'window', '/');
    expect(report.message.length).toBeLessThanOrEqual(300);
    expect(report.stack.length).toBeLessThanOrEqual(2000);
  });
});

describe('reportError', () => {
  it('sends nothing anywhere without a sink, and does not throw', () => {
    expect(() => {
      reportError(new Error('boom'), 'render');
    }).not.toThrow();
  });

  it('hands one scrubbed report to the sink', () => {
    const seen: ErrorReport[] = [];
    setErrorSink((r) => seen.push(r));
    reportError(new Error('boom for yoge@example.com'), 'route');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: 'route', message: 'boom for [email]' });
  });

  it('reports the same error once, not on every re-render, but a different one again', () => {
    const seen: ErrorReport[] = [];
    setErrorSink((r) => seen.push(r));
    for (let i = 0; i < 5; i += 1) reportError(new Error('same'), 'render');
    reportError(new Error('different'), 'render');
    expect(seen.map((r) => r.message)).toEqual(['same', 'different']);
  });

  it('stops after a fixed number of reports (a render loop cannot flood)', () => {
    const seen: ErrorReport[] = [];
    setErrorSink((r) => seen.push(r));
    for (let i = 0; i < MAX_REPORTS + 30; i += 1) {
      reportError(new Error(`unique ${String(i)}`), 'render');
    }
    expect(seen).toHaveLength(MAX_REPORTS);
  });

  it('survives a sink that throws', () => {
    setErrorSink(() => {
      throw new Error('sink is down');
    });
    expect(() => {
      reportError(new Error('boom'), 'render');
    }).not.toThrow();
  });
});

describe('installGlobalErrorHandlers', () => {
  it('reports uncaught errors and unhandled rejections, ignores resource errors, and can be removed', () => {
    const seen: ErrorReport[] = [];
    setErrorSink((r) => seen.push(r));
    // A private target, so jsdom does not also report the events as uncaught errors of the test run.
    const target = new EventTarget();
    const remove = installGlobalErrorHandlers(target);

    target.dispatchEvent(new ErrorEvent('error', { error: new Error('uncaught one') }));
    target.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' })); // no error object
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: new Error('rejected one') });
    target.dispatchEvent(rejection);
    expect(seen.map((r) => `${r.source}:${r.message}`)).toEqual([
      'window:uncaught one',
      'promise:rejected one',
    ]);

    remove();
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('after removal') }));
    expect(seen).toHaveLength(2);
  });

  it('listens on the real window by default', () => {
    const seen: ErrorReport[] = [];
    setErrorSink((r) => seen.push(r));
    const remove = installGlobalErrorHandlers();
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('from the window') });
    window.dispatchEvent(rejection);
    remove();
    expect(seen.map((r) => r.message)).toEqual(['from the window']);
  });
});
