/**
 * Shared file-backed JSON store behind all four ledgers.
 *
 * Each entry is a single `<id>.json` file under a `.cortex/` subdirectory.
 * Three invariants make the ledgers safe as a long-lived "project brain":
 *
 *  - Every value read back from disk is re-validated with the owning zod schema,
 *    so a corrupt or hand-edited file surfaces as a {@link LedgerError} instead
 *    of silently poisoning downstream context compilation.
 *  - Every write validates first, so a malformed in-memory record can never
 *    reach disk; bad input is rejected with {@link SchemaValidationError}.
 *  - Every write is atomic (temp file + `rename` in the same directory), so a
 *    concurrent reader or a crash mid-write never sees a truncated, half-written
 *    entry — only the previous file or the complete new one.
 *
 * The store is self-initializing: `persist` creates its backing directory on
 * demand, so a ledger works on a fresh repo even before `devcortex init` has
 * materialized the `.cortex/` subdirs.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ZodType } from 'zod';

import { LedgerError, SchemaValidationError } from '../domain/index';

export abstract class JsonLedger<T extends { id: string }> {
  protected constructor(
    protected readonly root: string,
    /** absolute path of the `.cortex/<kind>` directory this ledger owns */
    protected readonly dir: string,
    /** zod schema used for both write-time and read-time validation */
    protected readonly schema: ZodType<T>,
    /** human-readable noun used in error messages, e.g. "memory" */
    protected readonly label: string,
  ) {}

  /** Read + validate a single entry; `undefined` when it does not exist. */
  async get(id: string): Promise<T | undefined> {
    const file = this.fileFor(id);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return undefined;
      }
      throw new LedgerError(`Unable to read ${this.label} record at ${file}.`, { cause: err });
    }
    return this.parseEntry(raw, file);
  }

  /** All entries, optionally narrowed by a predicate. */
  async list(filter?: (item: T) => boolean): Promise<T[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // No directory yet => no entries. Not an error condition.
        return [];
      }
      throw new LedgerError(`Unable to list ${this.label} records in ${this.dir}.`, { cause: err });
    }

    const items: T[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = path.join(this.dir, name);
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') {
          // Concurrently removed between readdir and readFile; skip it.
          continue;
        }
        throw new LedgerError(`Unable to read ${this.label} record at ${file}.`, { cause: err });
      }
      const item = this.parseEntry(raw, file);
      if (filter === undefined || filter(item)) {
        items.push(item);
      }
    }
    return items;
  }

  /** Every entry, unfiltered. */
  async all(): Promise<T[]> {
    return this.list();
  }

  /**
   * Validate a fully-formed record and persist it atomically, returning the
   * stored (schema-parsed) value. The JSON is written to a temp file in the
   * same directory and then `rename`d onto the final path — `rename` is atomic
   * within a filesystem, so a concurrent reader (or a crash mid-write) never
   * observes a truncated, half-written entry; it sees either the previous file
   * or the complete new one. Used by the concrete ledgers' `add`/`update`.
   */
  protected async persist(candidate: T): Promise<T> {
    const result = this.schema.safeParse(candidate);
    if (!result.success) {
      throw new SchemaValidationError(`Refusing to write an invalid ${this.label} record.`, {
        details: result.error.issues,
        cause: result.error,
      });
    }
    const validated = result.data;
    const file = this.fileFor(validated.id);
    // Temp file lives in the SAME directory so the rename stays on one
    // filesystem (cross-device renames are not atomic). The unique suffix keeps
    // concurrent writers of the same id from clobbering each other's temp file,
    // and the non-".json" name keeps `list()` from ever picking it up.
    const tmpFile = path.join(this.dir, `.${validated.id}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmpFile, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
      await rename(tmpFile, file);
    } catch (err) {
      // Best-effort cleanup so a failed write never leaves a stray temp file.
      await rm(tmpFile, { force: true }).catch(() => undefined);
      throw new LedgerError(`Unable to write ${this.label} record to ${file}.`, { cause: err });
    }
    return validated;
  }

  /** Load an entry that must exist (used by `update`); throws when absent. */
  protected async loadRequired(id: string): Promise<T> {
    const existing = await this.get(id);
    if (existing === undefined) {
      throw new LedgerError(`No ${this.label} record exists with id "${id}".`);
    }
    return existing;
  }

  /** Resolve the absolute path of an entry file, rejecting unsafe ids. */
  protected fileFor(id: string): string {
    if (typeof id !== 'string' || id.length === 0) {
      throw new SchemaValidationError(`A ${this.label} id must be a non-empty string.`);
    }
    // Ids become file names: reject anything that could escape the ledger dir.
    if (id !== path.basename(id) || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new SchemaValidationError(`The ${this.label} id "${id}" is not a safe entry id.`);
    }
    return path.join(this.dir, `${id}.json`);
  }

  /** Parse + schema-validate raw JSON, mapping any failure to a LedgerError. */
  private parseEntry(raw: string, file: string): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new LedgerError(`The ${this.label} record at ${file} is not valid JSON.`, {
        cause: err,
      });
    }
    const result = this.schema.safeParse(parsed);
    if (!result.success) {
      throw new LedgerError(`The ${this.label} record at ${file} failed schema validation.`, {
        details: result.error.issues,
        cause: result.error,
      });
    }
    return result.data;
  }
}

/** Narrow an unknown thrown value to a Node `errno` exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
