// ============================================================================
// Privacy & Redaction Engine (§7.22) — outbound disclosure classifier.
//
// `classifyOutbound` is the gate every cloud transmission passes through. Given
// the candidate file set and the active privacy mode, it produces the
// `OutboundManifest` the user must approve BEFORE anything leaves the machine:
// which files, why, how large, redaction status, retention, and the opt-out
// flag (§7.22). The mode is authoritative and fail-safe:
//
//   local-only     → NOTHING leaves. `files` is empty, `optOut` is true.
//   metadata-cloud → only anonymized file type + size leave; contents + paths
//                    are withheld, so each entry carries the tiny metadata
//                    payload's size, not the file's.
//   deep-cloud     → file contents leave, redaction applied first; each entry's
//                    `sizeBytes` is the size of the *redacted* payload.
//
// Files that cannot be read (missing, a directory, permission denied) or that
// resolve outside the repo root are omitted — you cannot, and must not, send
// what you cannot open or reach.
//
// Convention: relative imports omit extensions; value + type imports split for
// `verbatimModuleSyntax`.
// ============================================================================

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { PRIVACY_MODES, DevCortexError } from '../domain/index';
import type { OutboundFile, OutboundManifest, PrivacyMode } from '../domain/index';

import { redactText } from './redact';

/** Retention default per privacy mode (surfaced in the disclosure). */
const RETENTION: Record<PrivacyMode, string> = {
  'local-only': 'none',
  'metadata-cloud': '30d',
  'deep-cloud': 'ephemeral',
};

/** Normalize an OS path to repo-relative POSIX for the manifest. */
function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * Classify the candidate `files` for outbound transmission under `mode`.
 *
 * @param root  absolute (or resolvable) repo root; every file is resolved
 *   against it and anything escaping it is dropped.
 * @param files repo-relative candidate paths.
 * @param mode  the active privacy mode; determines what, if anything, may leave.
 * @throws DevCortexError `INTERNAL` when `root`/`files`/`mode` violate the
 *   static contract (empty root, non-array files, unknown mode).
 */
export async function classifyOutbound(
  root: string,
  files: string[],
  mode: PrivacyMode,
): Promise<OutboundManifest> {
  if (typeof root !== 'string' || root.length === 0) {
    throw new DevCortexError('INTERNAL', 'classifyOutbound: root must be a non-empty string');
  }
  if (!Array.isArray(files)) {
    throw new DevCortexError('INTERNAL', 'classifyOutbound: files must be an array of strings');
  }
  if (!(PRIVACY_MODES as readonly string[]).includes(mode)) {
    throw new DevCortexError('INTERNAL', `classifyOutbound: unknown privacy mode "${String(mode)}"`);
  }

  // local-only: nothing leaves — short-circuit before touching the disk.
  if (mode === 'local-only') {
    return { mode, files: [], totalBytes: 0, retention: RETENTION[mode], optOut: true };
  }

  const resolvedRoot = path.resolve(root);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  const outbound: OutboundFile[] = [];

  for (const candidate of files) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;

    const abs = path.resolve(resolvedRoot, candidate);
    // Never send anything outside the repo root.
    if (abs !== resolvedRoot && !abs.startsWith(rootPrefix)) continue;

    let contents: string;
    let bytesOnDisk: number;
    try {
      const info = await stat(abs);
      if (!info.isFile()) continue;
      bytesOnDisk = info.size;
      contents = await readFile(abs, 'utf8');
    } catch {
      // Missing / unreadable → cannot send it → omit (fail-safe for privacy).
      continue;
    }

    const relPosix = toPosix(path.relative(resolvedRoot, abs));

    if (mode === 'metadata-cloud') {
      const ext = path.extname(abs).replace(/^\./, '') || 'none';
      // Only anonymized type + size leave; the payload we measure is that metadata.
      const metadata = JSON.stringify({ ext, bytes: bytesOnDisk });
      outbound.push({
        path: relPosix,
        reason:
          'metadata-cloud: only anonymized file type and size leave; path and contents are withheld.',
        sizeBytes: Buffer.byteLength(metadata, 'utf8'),
        redacted: true,
      });
      continue;
    }

    // deep-cloud: contents leave, redaction applied first.
    const { redacted, findings } = redactText(contents);
    const masked = findings.reduce((total, finding) => total + finding.count, 0);
    outbound.push({
      path: relPosix,
      reason:
        masked > 0
          ? `deep-cloud: selected for analysis; ${masked} secret/PII occurrence(s) redacted before send.`
          : 'deep-cloud: selected for analysis; contents scanned, no secrets detected.',
      sizeBytes: Buffer.byteLength(redacted, 'utf8'),
      redacted: true,
    });
  }

  const totalBytes = outbound.reduce((total, file) => total + file.sizeBytes, 0);
  return { mode, files: outbound, totalBytes, retention: RETENTION[mode], optOut: false };
}
