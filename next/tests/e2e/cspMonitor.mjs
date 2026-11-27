// Records every Content-Security-Policy violation the page reports, so an end-to-end run can fail
// on one. The app is served with the same headers as production (see security/policy.mjs).
import { securityHeaderMap } from '../../security/policy.mjs';

/** Headers for the static server: the production policy, plus the test's own fake Supabase. */
export const e2eHeaders = (supabaseUrl) =>
  securityHeaderMap({
    connect: [supabaseUrl],
    // The tests run over plain http on 127.0.0.1, which "upgrade-insecure-requests" would rewrite.
    upgradeInsecure: false,
  });

/** Starts listening in `context`; returns the (live) list of violations. */
export async function watchCsp(context) {
  const violations = [];
  await context.exposeFunction('__cvCspViolation', (v) => {
    violations.push(v);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void window.__cvCspViolation({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
        source: e.sourceFile,
        line: e.lineNumber,
        sample: e.sample,
      });
    });
  });
  return violations;
}

/** Proves the monitor works: an inline script MUST be blocked and reported. */
export async function provePolicyIsEnforced(page, violations) {
  const before = violations.length;
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__cvInlineRan = true;';
    document.head.appendChild(script);
  });
  await page.waitForTimeout(200);
  const ran = await page.evaluate(() => window.__cvInlineRan === true);
  const reported = violations.slice(before).some((v) => v.directive.startsWith('script-src'));
  // Remove the deliberate probe from the record so the real assertion stays about the app.
  violations.length = before;
  return { blocked: !ran, reported };
}
