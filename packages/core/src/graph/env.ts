/**
 * Environment-variable analysis helpers.
 *
 * - `extractEnvRefs` finds `process.env.X` / `process.env['X']` references in a
 *   source string.
 * - `parseEnvKeys` parses the key set declared in a dotenv-style file
 *   (`.env.example`) so the scanner can mark a referenced var "documented".
 *
 * Both are pure string functions — no I/O — so they are trivially testable and
 * have no failure path of their own.
 */

const DOT_REF = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const BRACKET_REF = /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;

/** Distinct env var names referenced via `process.env` in the given source. */
export function extractEnvRefs(source: string): string[] {
  const names = new Set<string>();
  for (const re of [DOT_REF, BRACKET_REF]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const name = match[1];
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }
  return [...names];
}

/** Keys declared in a dotenv-style file (e.g. `.env.example`). */
export function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const left = (eq === -1 ? line : line.slice(0, eq)).trim().replace(/^export\s+/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(left)) keys.add(left);
  }
  return keys;
}
