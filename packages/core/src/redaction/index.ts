// ============================================================================
// Privacy & Redaction Engine (§7.22) — public API barrel.
//
// Deterministic, tokenless (no LLM, no network) secret / credential / PII
// redaction plus the outbound-disclosure classifier that gates every cloud
// transmission by privacy mode:
//
//   redactText(text)                    — mask + tally secrets/PII in a buffer
//   redactObject(obj)                   — deep-walk + redact arbitrary data
//   classifyOutbound(root, files, mode) — build the pre-send OutboundManifest
//
// `redactText` is the canonical `../redaction` seam consumed by mcp-firewall;
// re-exporting it here keeps `import { redactText } from '../redaction'` stable.
// ============================================================================

export { redactText, redactObject } from './redact';
export { classifyOutbound } from './outbound';
