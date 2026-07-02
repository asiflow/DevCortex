/**
 * Agent Flight Recorder (§7.16) — record, seal, and compare agent sessions on
 * disk under `.cortex/runs/`. Deterministic and tokenless (the OSS layer).
 *
 * Public API:
 *   startRun(root, task): Promise<RunRecord>
 *   recordArtifact(root, runId, key, content): Promise<void>
 *   attachEvidence(root, runId, evidenceId): Promise<void>
 *   finishRun(root, runId, shipReportPath?): Promise<RunRecord>
 *   listRuns(root): Promise<RunRecord[]>
 *   loadRun(root, runId): Promise<RunRecord>
 *   compareRuns(root, a, b): Promise<RunComparison>
 */
export {
  startRun,
  recordArtifact,
  attachEvidence,
  finishRun,
  listRuns,
  loadRun,
  compareRuns,
} from './runs';
export type { ArtifactKey, RunComparison } from './runs';

export { parseTranscript, distillTranscript } from './distill';
export type { TranscriptDigest, DistillOutcome } from './distill';
