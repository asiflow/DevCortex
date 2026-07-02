import { describe, expect, it } from 'vitest';
import { normalizeHookPayload } from '../src/runtime';

describe('normalizeHookPayload', () => {
  it('extracts transcript_path and session_id when present', () => {
    const payload = normalizeHookPayload({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      transcript_path: '/tmp/session/transcript.jsonl',
      session_id: 'sess-123',
    });
    expect(payload.transcriptPath).toBe('/tmp/session/transcript.jsonl');
    expect(payload.sessionId).toBe('sess-123');
    expect(payload.command).toBe('npm test');
  });

  it('omits the fields for empty or non-string values', () => {
    const payload = normalizeHookPayload({ transcript_path: '', session_id: 42 });
    expect(payload.transcriptPath).toBeUndefined();
    expect(payload.sessionId).toBeUndefined();
  });
});
