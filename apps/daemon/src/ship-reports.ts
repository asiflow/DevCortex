/**
 * Ship-report reads for the daemon API.
 *
 * `/api/ship-reports` returns the most recent persisted markdown reports, and
 * `/api/ready-score` derives a compact readiness summary from the newest one.
 *
 * Design note — why we DERIVE rather than RE-RUN: `generateShipReport` executes
 * the project's real typecheck/lint/build/test commands and writes a new report
 * + evidence on every call. That is correct for an explicit `devcortex ship`,
 * but far too heavy and side-effecting for a GET a dashboard may poll. The
 * daemon therefore reflects the LAST report the user actually produced — a fast,
 * read-only operation. The parser is anchored on the stable machine-oriented
 * header the core renderer emits (`- **Status:** …` plus the `## Passed` /
 * `## Blocked` / `## Warnings` sections) and degrades to `UNKNOWN`/zero counts
 * rather than throwing if that layout ever drifts.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { workspacePaths } from '@devcortex/core';

import { DaemonError } from './errors';

/** One recent ship report: its filename and full markdown body. */
export interface ShipReportFile {
  name: string;
  markdown: string;
}

/** Compact readiness summary served at `/api/ready-score`. */
export interface ReadyScore {
  score: number;
  status: string;
  passed: number;
  blocked: number;
  warnings: number;
  /** ISO timestamp the reflected ship report was generated (null if none). */
  generatedAt: string | null;
  /** Filename of the reflected report (null if none). */
  reportName: string | null;
  /** True when a tracked file changed after the report — the score may be out of date. */
  stale: boolean;
}

/** Status reported when the repo has never generated a ship report. */
export const NO_REPORT_STATUS = 'NO_REPORT';

/** Default number of recent reports `/api/ship-reports` returns. */
export const DEFAULT_SHIP_REPORT_LIMIT = 10;

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/**
 * List the most recent ship reports, newest first. Filenames are ISO-timestamp
 * prefixed, so a lexicographic sort is chronological. Tolerates a not-yet-created
 * reports directory (returns `[]`).
 */
export async function listShipReports(
  root: string,
  limit = DEFAULT_SHIP_REPORT_LIMIT,
): Promise<ShipReportFile[]> {
  const dir = workspacePaths(root).shipReportsDir;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return [];
    throw new DaemonError(`Unable to list ship reports in ${dir}.`, { cause: err });
  }

  const newestFirst = entries
    .filter((name) => name.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, Math.max(0, limit));

  const reports: ShipReportFile[] = [];
  for (const name of newestFirst) {
    try {
      const markdown = await readFile(path.join(dir, name), 'utf8');
      reports.push({ name, markdown });
    } catch (err) {
      // A report that vanished between readdir and readFile is not fatal; skip it.
      if (isErrno(err) && err.code === 'ENOENT') continue;
      throw new DaemonError(`Unable to read ship report ${name}.`, { cause: err });
    }
  }
  return reports;
}

interface ParsedReport {
  status: string;
  passed: number;
  blocked: number;
  warnings: number;
  generatedAt: string | null;
}

const STATUS_LINE = /^- \*\*Status:\*\* (.+)$/;
const GENERATED_LINE = /^- \*\*Generated:\*\* (.+)$/;

/**
 * Parse the compact counts + status from a ship-report markdown body. Robust to
 * missing sections: an absent status line yields `UNKNOWN`; absent sections yield
 * zero counts. Never throws.
 */
export function parseShipReport(markdown: string): ParsedReport {
  let status = 'UNKNOWN';
  let passed = 0;
  let blocked = 0;
  let warnings = 0;
  let generatedAt: string | null = null;

  type Section = 'passed' | 'blocked' | 'warnings' | 'other';
  let section: Section = 'other';

  for (const line of markdown.split(/\r?\n/)) {
    const statusMatch = STATUS_LINE.exec(line);
    if (statusMatch && statusMatch[1] !== undefined) {
      status = statusMatch[1].trim();
      continue;
    }

    const generatedMatch = GENERATED_LINE.exec(line);
    if (generatedMatch && generatedMatch[1] !== undefined) {
      generatedAt = generatedMatch[1].trim();
      continue;
    }

    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      section =
        heading === 'Passed'
          ? 'passed'
          : heading.startsWith('Blocked')
            ? 'blocked'
            : heading === 'Warnings'
              ? 'warnings'
              : 'other';
      continue;
    }

    if (section === 'passed' || section === 'blocked') {
      // Count only data rows of the checks table — skip its header + separator.
      if (line.startsWith('| ') && !line.startsWith('| Check ') && !line.startsWith('| --- ')) {
        if (section === 'passed') passed += 1;
        else blocked += 1;
      }
    } else if (section === 'warnings') {
      if (line.startsWith('- ')) warnings += 1;
    }
  }

  return { status, passed, blocked, warnings, generatedAt };
}

/**
 * True when any tracked file was modified after `generatedAt` — i.e. the repo
 * changed since the reflected ship, so its verdict may be out of date. Reads the
 * cached graph's file list and stats each, short-circuiting on the first newer
 * file. Degrades to `false` (no false alarm) if it can't determine an answer.
 */
async function isStaleSince(root: string, generatedAt: string | null): Promise<boolean> {
  if (generatedAt === null) return false;
  const shippedAt = Date.parse(generatedAt);
  if (Number.isNaN(shippedAt)) return false;

  let files: { path: string }[];
  try {
    const graph = JSON.parse(await readFile(workspacePaths(root).graph, 'utf8')) as {
      files?: { path: string }[];
    };
    files = Array.isArray(graph.files) ? graph.files.slice(0, 5000) : [];
  } catch {
    return false;
  }

  for (const f of files) {
    try {
      const s = await stat(path.join(root, f.path));
      if (s.mtimeMs > shippedAt) return true;
    } catch {
      // file removed/unreadable between graph capture and now — ignore.
    }
  }
  return false;
}

/**
 * Compute the readiness score from the newest persisted ship report. Blocked
 * (required) failures weigh full; warnings weigh half. Also reports the ship's
 * timestamp and whether the repo has changed since (so the dashboard can show
 * "READY as of <time>" and flag a stale verdict). Returns a well-defined
 * `NO_REPORT` summary when the repo has never shipped.
 */
export async function readyScore(root: string): Promise<ReadyScore> {
  const [latest] = await listShipReports(root, 1);
  if (latest === undefined) {
    return {
      score: 0,
      status: NO_REPORT_STATUS,
      passed: 0,
      blocked: 0,
      warnings: 0,
      generatedAt: null,
      reportName: null,
      stale: false,
    };
  }

  const { status, passed, blocked, warnings, generatedAt } = parseShipReport(latest.markdown);
  const total = passed + blocked + warnings;
  const numerator = passed + 0.5 * warnings;
  const score = total === 0 ? 0 : Math.round((100 * numerator) / total);
  const stale = await isStaleSince(root, generatedAt);

  return { score, status, passed, blocked, warnings, generatedAt, reportName: latest.name, stale };
}
