// ============================================================================
// Privacy & Redaction Engine (§7.22) — text + object redaction (canonical).
//
// `redactText(text)` scans a buffer for the sensitive-material classes declared
// in the frozen domain contract (domain/redaction.ts: REDACTION_KINDS) and
// returns the buffer with every match masked as `[REDACTED:<kind>]`, plus a
// per-kind tally. It is deterministic and tokenless (no LLM, no network): the
// same input always yields the same output, which is what makes it safe to run
// on the hot path before anything leaves the machine.
//
// Detectors run in a fixed precedence order (most-specific first) so each byte
// of input is masked at most once and attributed to exactly one kind: a value
// already rewritten to `[REDACTED:...]` can never be re-matched by a later
// detector because the `[`/`]`/`:` characters are excluded from every value
// character class.
//
// `redactObject(obj)` deep-walks arbitrary data: string leaves are
// content-redacted via `redactText`, and any value under a key that *looks*
// secret is masked wholesale (the key implies the value is sensitive regardless
// of its shape). Cycles + shared references are preserved via a visited-map, so
// the walk always terminates.
//
// -------------------------------------------------------------------------
// INTEGRATION NOTE (sub-project #5, Tier-1 seam)
// -------------------------------------------------------------------------
// This is the canonical `redactText` — the `../redaction` dependency consumed
// by mcp-firewall. `redaction/index.ts` re-exports it, so
// `import { redactText } from '../redaction'` resolves here unchanged. The
// detector logic is the one first stood up as the firewall's Tier-1 seam; it is
// kept intact and extended with `redactObject` (this file) + `classifyOutbound`
// (./outbound) to complete the §7.22 public API.
//
// Convention: relative imports omit extensions; value + type imports split for
// `verbatimModuleSyntax`.
// ============================================================================

import { REDACTION_KINDS, SchemaValidationError } from '../domain/index';
import type { RedactionFinding, RedactionKind, RedactionResult } from '../domain/index';

// --- masks ------------------------------------------------------------------

/** The stable placeholder a detected secret/PII occurrence is replaced with. */
function mask(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

// --- detector model ---------------------------------------------------------

/**
 * A single detector. `re` MUST be global (so `String.replace` masks every
 * occurrence). `render` receives the string capture groups (`groups[0]` is the
 * whole match, `groups[1]` the first capture, …) and returns the replacement:
 *  - "full" detectors ignore the groups and return just the mask;
 *  - "value" detectors preserve a captured prefix (key/quote/`=`) and mask only
 *    the secret value, so `"token":"abc"` becomes `"token":"[REDACTED:token]"`.
 */
interface Detector {
  kind: RedactionKind;
  re: RegExp;
  render: (groups: string[]) => string;
}

/** Value character class shared by the assignment detectors. Excludes the
 * mask's own delimiters (`[` `]` `:` and the bracket/quote family) so an
 * already-masked value is never matched a second time, and stops the value at
 * the natural JSON / shell / query terminators. */
const VALUE = `[^\\s"'\`,;{}\\[\\]()<>]+`;

/** Build a detector for `NAME = VALUE` / `"name":"value"` style assignments
 * whose key contains one of `keyword`. Preserves everything up to and including
 * the opening delimiter/quote (capture 1) and masks only the value (capture 2).
 * The leading boundary is captured so it is re-emitted verbatim. */
function assignment(kind: RedactionKind, keyword: string): Detector {
  const re = new RegExp(
    `((?:^|[\\s;,{\\[(])(?:export\\s+)?["']?[\\w.\\-]*(?:${keyword})[\\w.\\-]*["']?\\s*[:=]\\s*["']?)(${VALUE})`,
    'gi',
  );
  return { kind, re, render: (g) => `${g[1] ?? ''}${mask(kind)}` };
}

/** Build a "full match" detector that masks the entire matched token. */
function standalone(kind: RedactionKind, re: RegExp): Detector {
  return { kind, re, render: () => mask(kind) };
}

// --- detector precedence (specific -> general) ------------------------------

const DETECTORS: readonly Detector[] = [
  // 1. PEM private-key blocks (multi-line, non-greedy).
  standalone(
    'private-key',
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
  ),

  // 2. Database / broker connection strings (mask the whole URL incl. creds).
  standalone(
    'db-url',
    /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s"'`<>{}[\]()]+/gi,
  ),

  // 3. High-confidence, provider-prefixed API keys/tokens (attributed api-key).
  standalone(
    'api-key',
    /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
  ),
  // 4. `api_key = ...` / `"apiKey": "..."` assignments.
  assignment('api-key', 'api[_-]?key|apikey|access[_-]?key'),

  // 5. JSON Web Tokens (three base64url segments).
  standalone('token', /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g),
  // 6. `Authorization: Bearer <token>` — keep the scheme, mask the credential.
  {
    kind: 'token',
    re: /\b(Bearer\s+)([A-Za-z0-9._-]{12,})\b/gi,
    render: (g) => `${g[1] ?? ''}${mask('token')}`,
  },
  // 7. `token = ...` / `"accessToken": "..."` assignments.
  assignment('token', 'token'),

  // 8. `secret = ...` / `"clientSecret": "..."` assignments.
  assignment('secret', 'secret'),

  // 9. `password = ...` / `"passwd": "..."` assignments.
  assignment('password', 'password|passwd|passphrase|pwd'),

  // 10. Email addresses (PII).
  standalone('pii-email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g),

  // 11. Phone numbers (PII) — require a separator/paren/leading + to curb FPs.
  standalone(
    'pii-phone',
    /(?:\+\d{1,3}[\s.-])?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}\b/g,
  ),

  // 12. Residual env-file secrets: ALL-CAPS NAME=<20+ tokenish chars> (runs
  //     last so it only catches values the named detectors above did not).
  {
    kind: 'env',
    re: /((?:^|[\s;,{])(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*["']?)([A-Za-z0-9_\-+/=.]{20,})/g,
    render: (g) => `${g[1] ?? ''}${mask('env')}`,
  },
];

// --- engine -----------------------------------------------------------------

/**
 * Run a single detector across `text`, masking every match and counting how
 * many were replaced.
 *
 * The `String.replace` callback receives `(match, ...captures, offset, whole)`.
 * We drop the numeric `offset` (and any trailing whole-string / named-groups
 * arg) by keeping only string arguments; `groups[0]` is the whole match and
 * `groups[1..]` are the positional captures, which is all `render` consumes.
 */
function applyDetector(text: string, detector: Detector): { out: string; count: number } {
  let count = 0;
  const out = text.replace(detector.re, (match: string, ...rest: unknown[]): string => {
    count += 1;
    const groups: string[] = [
      match,
      ...rest.filter((value): value is string => typeof value === 'string'),
    ];
    return detector.render(groups);
  });
  return { out, count };
}

/** Order a per-kind count map into stable `REDACTION_KINDS`-sequenced findings. */
function orderFindings(counts: ReadonlyMap<RedactionKind, number>): RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  for (const kind of REDACTION_KINDS) {
    const count = counts.get(kind);
    if (count !== undefined && count > 0) {
      findings.push({ kind, count });
    }
  }
  return findings;
}

/**
 * Mask every secret / PII occurrence in `text` and report a per-kind tally.
 *
 * Deterministic and side-effect free. `findings` lists only the kinds that
 * actually matched (`count >= 1`), ordered by the canonical `REDACTION_KINDS`
 * sequence so the output is stable across runs.
 *
 * @throws SchemaValidationError when `text` is not a string.
 */
export function redactText(text: string): RedactionResult {
  if (typeof text !== 'string') {
    throw new SchemaValidationError('redactText expects a string input.');
  }

  const counts = new Map<RedactionKind, number>();
  let working = text;
  for (const detector of DETECTORS) {
    const { out, count } = applyDetector(working, detector);
    if (count > 0) {
      working = out;
      counts.set(detector.kind, (counts.get(detector.kind) ?? 0) + count);
    }
  }

  return { redacted: working, findings: orderFindings(counts) };
}

// --- object redaction -------------------------------------------------------

/**
 * Classify an object *key* as sensitive, mapping it to the redaction kind that
 * best describes the secret it holds. Deterministic; separator-insensitive
 * (`apiKey`, `api_key`, `API-KEY` all collapse to the same decision). Returns
 * `null` when the key does not look secret (its value is then content-redacted
 * normally rather than masked wholesale).
 */
function classifyObjectKey(key: string): RedactionKind | null {
  const compact = key.toLowerCase().replace(/[_\-.]/g, '');
  if (/pass(word|phrase|wd)?|pwd/.test(compact)) return 'password';
  if (compact.includes('apikey') || compact.includes('accesskey')) return 'api-key';
  if (compact.includes('token')) return 'token';
  if (
    compact.includes('secret') ||
    compact.includes('credential') ||
    compact.includes('privatekey') ||
    compact.includes('clientsecret') ||
    compact.includes('dsn')
  ) {
    return 'secret';
  }
  // separator-delimited `key` suffix (SIGNING_KEY, api-key) — but never "monkey"
  if (/(^|[_.-])key([_.-]|$)/.test(key.toLowerCase())) return 'secret';
  return null;
}

/** A primitive a sensitive key should mask entirely (rather than recurse into). */
function isMaskableLeaf(value: unknown): boolean {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean';
}

/** True for a plain, walkable object (not null, array, Date, Map, class, …). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-walk `obj`, returning a redacted clone plus merged findings.
 *
 * - String leaves are content-redacted via {@link redactText}.
 * - Any value under a key that {@link classifyObjectKey} deems secret is masked
 *   wholesale — the key implies the value is sensitive regardless of its shape.
 * - Arrays and plain objects are cloned; every other value (numbers, booleans,
 *   Dates, functions, …) passes through unchanged. Cycles + shared references
 *   are preserved via a visited-map, so the walk always terminates.
 *
 * The input is never mutated.
 */
export function redactObject(obj: unknown): { redacted: unknown; findings: RedactionFinding[] } {
  const counts = new Map<RedactionKind, number>();
  const seen = new Map<object, unknown>();

  const bump = (kind: RedactionKind, by = 1): void => {
    counts.set(kind, (counts.get(kind) ?? 0) + by);
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = redactText(value);
      for (const finding of result.findings) bump(finding.kind, finding.count);
      return result.redacted;
    }

    if (Array.isArray(value)) {
      const cached = seen.get(value);
      if (cached !== undefined) return cached;
      const clone: unknown[] = [];
      seen.set(value, clone);
      for (const item of value) clone.push(walk(item));
      return clone;
    }

    if (isPlainObject(value)) {
      const cached = seen.get(value);
      if (cached !== undefined) return cached;
      const clone: Record<string, unknown> = {};
      seen.set(value, clone);
      for (const [key, child] of Object.entries(value)) {
        const keyKind = classifyObjectKey(key);
        if (keyKind !== null && isMaskableLeaf(child)) {
          bump(keyKind);
          clone[key] = mask(keyKind);
        } else {
          clone[key] = walk(child);
        }
      }
      return clone;
    }

    return value;
  };

  const redacted = walk(obj);
  return { redacted, findings: orderFindings(counts) };
}
