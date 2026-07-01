/**
 * Daemon-specific error type. Extends the shared {@link DevCortexError}
 * hierarchy so every surface (CLI, hooks, HTTP clients) can switch on the stable
 * `code` field and fail-safe uniformly. Daemon runtime failures that do not map
 * to a more specific engine code (port bind failures, HTTP plumbing, dashboard
 * resolution) are reported as `INTERNAL`.
 */
import { DevCortexError } from '@devcortex/core';
import type { DevCortexErrorOptions } from '@devcortex/core';

export class DaemonError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('INTERNAL', message, options);
    this.name = 'DaemonError';
  }
}
