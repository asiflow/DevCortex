// ============================================================================
// Unit tests for command implementations in commands.ts.
//
// These tests call command functions directly (bypassing CLI parsing) and pass
// GlobalOptions objects directly — `readGlobals` is never invoked here, so
// we never touch the filesystem for option resolution.
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as commands from '../src/commands';

describe('cmdBrief', () => {
  it('cmdBrief returns the brief text and ok:true even when uninitialized', async () => {
    const result = await commands.cmdBrief({ root: '/tmp/not-a-workspace-xyz', json: false });
    expect(result.data).toMatchObject({ ok: true });
    expect(result.human).toContain('devcortex init');
  });
});
