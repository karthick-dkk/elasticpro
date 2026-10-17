/**
 * Find playwright for the two real-engine checks (scroll-check.mjs, fit-check.mjs) — one
 * definition of where to look, so the two cannot disagree about whether it is installed.
 *
 * Looked for in the repo, the working directory and $PLAYWRIGHT_MODULES, in that order.
 * Returns null when it is absent; the caller says so and exits 0, like the jsdom checks.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright(root, who) {
  const req = createRequire(import.meta.url);
  const paths = [root, process.cwd(), process.env.PLAYWRIGHT_MODULES].filter(Boolean);
  let entry = null;
  for (const base of paths) { try { entry = req.resolve('playwright', { paths: [base] }); break; } catch { /* next */ } }
  if (!entry) {
    console.log(`${who}: playwright not found — skipping.`);
    console.log(`  install it in one of: ${paths.join(', ')}  (npm i playwright)`);
    return null;
  }
  const m = await import(pathToFileURL(entry).href);
  return m.chromium ? m : m.default;
}
