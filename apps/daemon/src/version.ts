/**
 * Resolve this package's own version for the `/api/health` payload.
 *
 * The version is read from the sibling `package.json` at runtime (relative to
 * this module's URL) rather than imported/bundled, so it always reflects the
 * installed package and never drifts from a compile-time constant. Both build
 * outputs (`dist/index.js`, `dist/main.js`) sit directly in `dist/`, so
 * `../package.json` resolves to the package root in production; under vitest the
 * same relative walk from `src/` resolves the same file.
 */
import { readFileSync } from 'node:fs';

let cached: string | undefined;

export function daemonVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const url = new URL('../package.json', import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof (parsed as { version: unknown }).version === 'string'
    ) {
      cached = (parsed as { version: string }).version;
      return cached;
    }
  } catch {
    // fall through to the safe default
  }
  cached = '0.0.0';
  return cached;
}
