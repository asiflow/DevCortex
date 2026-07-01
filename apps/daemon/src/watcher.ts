/**
 * Repo watcher: debounced, single-flight re-scan of the project graph.
 *
 * On any relevant filesystem change we (re)schedule a scan ~`debounceMs` later,
 * coalescing bursts (editor saves, `git checkout`, installs) into one scan.
 * A scan runs `scanProject` and persists the result via `saveGraph`, so
 * `/api/graph` and every graph-derived surface stay fresh without the client
 * polling a scan endpoint.
 *
 * Loop-safety: the ENTIRE `.cortex/` directory is ignored — not just
 * `.cortex/cache`. `saveGraph` writes `.cortex/graph.json`, so watching any part
 * of `.cortex/` would make each scan trigger the next one indefinitely. Ignoring
 * `.cortex/` wholesale is a superset of the spec's `.cortex/cache` and is the
 * only correct choice for a watcher that writes into the tree it watches.
 */
import path from 'node:path';

import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';

import { saveGraph, scanProject } from '@devcortex/core';
import type { ProjectGraph } from '@devcortex/core';

/** Directory names ignored anywhere in the tree (heavy or generated). */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.next']);

/** Default debounce window for coalescing change bursts (milliseconds). */
export const DEFAULT_DEBOUNCE_MS = 300;

export interface WatcherOptions {
  /** debounce window in ms (default {@link DEFAULT_DEBOUNCE_MS}) */
  debounceMs?: number;
  /** invoked after each successful re-scan with the fresh, persisted graph */
  onRescan?: (graph: ProjectGraph) => void;
  /** invoked when a scan or the watcher itself errors (non-fatal; logged upstream) */
  onError?: (err: unknown) => void;
}

/** A running watcher handle. */
export interface RepoWatcher {
  /** stop watching and cancel any pending scan */
  close(): Promise<void>;
}

/**
 * Build the chokidar ignore predicate for `root`. Returns `true` for paths that
 * must NOT be watched. Uses the function form (chokidar v4 dropped glob strings).
 */
export function makeIgnoreMatcher(root: string): (candidate: string) => boolean {
  const cortexDir = path.join(root, '.cortex');
  return (candidate: string): boolean => {
    const abs = path.resolve(candidate);
    if (abs === cortexDir || abs.startsWith(cortexDir + path.sep)) return true;
    for (const segment of abs.split(path.sep)) {
      if (IGNORED_DIRS.has(segment)) return true;
    }
    return false;
  };
}

/**
 * Start watching `root`. The initial scan is NOT performed here (the caller owns
 * ensuring a graph exists at startup); we only react to subsequent changes.
 */
export function startWatcher(root: string, options: WatcherOptions = {}): RepoWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let timer: NodeJS.Timeout | undefined;
  let scanning = false;
  let pending = false;
  let closed = false;

  const runScan = async (): Promise<void> => {
    if (closed) return;
    if (scanning) {
      // A scan is already in flight; remember that more changes arrived so we
      // run exactly one more scan afterwards (single-flight + coalescing).
      pending = true;
      return;
    }
    scanning = true;
    try {
      const graph = await scanProject(root);
      if (closed) return;
      await saveGraph(root, graph);
      options.onRescan?.(graph);
    } catch (err) {
      options.onError?.(err);
    } finally {
      scanning = false;
      if (pending && !closed) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runScan();
    }, debounceMs);
    // Never keep the process alive solely for a pending scan.
    timer.unref();
  };

  const watcher: FSWatcher = watch(root, {
    ignored: makeIgnoreMatcher(root),
    ignoreInitial: true,
    persistent: true,
    // Coalesce editor "atomic save" (write temp + rename) into a single event.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('addDir', schedule);
  watcher.on('unlinkDir', schedule);
  watcher.on('error', (err) => options.onError?.(err));

  return {
    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await watcher.close();
    },
  };
}
