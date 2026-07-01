// ============================================================================
// DevCortex error hierarchy.
//
// Every failure path in the engine throws a DevCortexError (or subclass) with a
// stable, machine-readable `code`. Surfaces (CLI, MCP, hooks) switch on `code`
// to decide presentation and, crucially, fail-safe behaviour: a hook that
// catches a DevCortexError degrades to passive mode rather than blocking the
// user's work.
// ============================================================================

export const DEVCORTEX_ERROR_CODES = [
  'CONFIG_INVALID',
  'CONFIG_NOT_FOUND',
  'WORKSPACE_NOT_INITIALIZED',
  'WORKSPACE_EXISTS',
  'SCAN_FAILED',
  'GATE_FAILED',
  'EVIDENCE_INVALID',
  'POLICY_VIOLATION',
  'LEDGER_CORRUPT',
  'SCHEMA_VALIDATION',
  'STACK_PACK_INVALID',
  'INTERNAL',
] as const;

export type DevCortexErrorCode = (typeof DEVCORTEX_ERROR_CODES)[number];

export interface DevCortexErrorOptions {
  details?: unknown;
  cause?: unknown;
}

export class DevCortexError extends Error {
  readonly code: DevCortexErrorCode;
  readonly details?: unknown;

  constructor(code: DevCortexErrorCode, message: string, options: DevCortexErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DevCortexError';
    this.code = code;
    this.details = options.details;
  }
}

export class ConfigError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('CONFIG_INVALID', message, options);
    this.name = 'ConfigError';
  }
}

export class WorkspaceError extends DevCortexError {
  constructor(
    code: Extract<DevCortexErrorCode, 'WORKSPACE_NOT_INITIALIZED' | 'WORKSPACE_EXISTS'>,
    message: string,
    options?: DevCortexErrorOptions,
  ) {
    super(code, message, options);
    this.name = 'WorkspaceError';
  }
}

export class ScanError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('SCAN_FAILED', message, options);
    this.name = 'ScanError';
  }
}

export class GateError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('GATE_FAILED', message, options);
    this.name = 'GateError';
  }
}

export class EvidenceError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('EVIDENCE_INVALID', message, options);
    this.name = 'EvidenceError';
  }
}

export class PolicyViolationError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('POLICY_VIOLATION', message, options);
    this.name = 'PolicyViolationError';
  }
}

export class LedgerError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('LEDGER_CORRUPT', message, options);
    this.name = 'LedgerError';
  }
}

export class SchemaValidationError extends DevCortexError {
  constructor(message: string, options?: DevCortexErrorOptions) {
    super('SCHEMA_VALIDATION', message, options);
    this.name = 'SchemaValidationError';
  }
}

/** Type guard usable across surfaces and tests. */
export function isDevCortexError(err: unknown): err is DevCortexError {
  return err instanceof DevCortexError;
}
