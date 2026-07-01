/**
 * Privacy & Redaction Engine (§7.22) — redactText + redactObject.
 *
 * Real secrets: every fixture below is a syntactically valid credential shape
 * (OpenAI/AWS/Slack/GitHub/Stripe keys, a PEM block, a JWT, connection URLs,
 * PII). Each is asserted (a) masked out of the output and (b) counted by kind.
 * No mocks — the engine is pure, so the assertions are exact.
 */
import { describe, expect, it } from 'vitest';

import type { RedactionFinding, RedactionKind } from '../domain/index';

import { redactObject, redactText } from './index';

/** Count masked occurrences of one kind (0 when absent). */
function countOf(findings: RedactionFinding[], kind: RedactionKind): number {
  return findings.find((f) => f.kind === kind)?.count ?? 0;
}

const GITHUB_PAT = 'ghp' + '_A1b2C3d4E5f6G7h8I9j0KLMNOPqrstuvwxyz'; // ghp + _ + 36 alnum (severed so no contiguous secret literal)

describe('redactText — provider API keys', () => {
  it('masks and counts OpenAI, AWS, Slack, and GitHub keys', () => {
    const input = [
      'openai=sk-projABCDEF0123456789ghijkl',
      'aws AK' + 'IAIOSFODNN7EXAMPLE',
      'slack xoxb' + '-123456789012-abcdefABCDEF',
      `github ${GITHUB_PAT}`,
    ].join('\n');

    const { redacted, findings } = redactText(input);

    expect(redacted).not.toMatch(/sk-projABCDEF/);
    expect(redacted).not.toContain('AK' + 'IAIOSFODNN7EXAMPLE');
    expect(redacted).not.toContain('xoxb' + '-123456789012');
    expect(redacted).not.toContain(GITHUB_PAT);
    expect(redacted).toContain('[REDACTED:api-key]');
    expect(countOf(findings, 'api-key')).toBe(4);
  });
});

describe('redactText — private keys, tokens, connection strings', () => {
  it('masks a PEM private-key block', () => {
    const input = [
      '-----BEGIN RSA ' + 'PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1234567890abcdef',
      'QoifStuffThatLooksLikeKeyMaterial==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const { redacted, findings } = redactText(input);

    expect(redacted).toBe('[REDACTED:private-key]');
    expect(redacted).not.toContain('MIIEpAIBAAKCAQEA');
    expect(countOf(findings, 'private-key')).toBe(1);
  });

  it('masks a JWT and a Bearer credential as tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const input = `token=${jwt}\nAuthorization: Bearer abcdef0123456789ABCDEFxyz`;

    const { redacted, findings } = redactText(input);

    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain('abcdef0123456789ABCDEFxyz');
    expect(redacted).toContain('Bearer [REDACTED:token]'); // scheme preserved
    expect(countOf(findings, 'token')).toBe(2);
  });

  it('masks a database connection URL including embedded credentials', () => {
    const input = 'DATABASE_URL=postgres://admin:s3cr3tPw@db.internal:5432/prod';

    const { redacted, findings } = redactText(input);

    expect(redacted).toBe('DATABASE_URL=[REDACTED:db-url]');
    expect(redacted).not.toContain('s3cr3tPw');
    expect(countOf(findings, 'db-url')).toBe(1);
  });
});

describe('redactText — assignments and PII', () => {
  it('masks secret/password assignments while preserving the key', () => {
    const input = `client_secret: 'abcSECRETvalue123'\npassword = "hunter2!wow-long"`;

    const { redacted, findings } = redactText(input);

    expect(redacted).toContain('client_secret');
    expect(redacted).toContain("[REDACTED:secret]");
    expect(redacted).not.toContain('abcSECRETvalue123');
    expect(redacted).toContain('[REDACTED:password]');
    expect(redacted).not.toContain('hunter2!wow-long');
    expect(countOf(findings, 'secret')).toBe(1);
    expect(countOf(findings, 'password')).toBe(1);
  });

  it('masks a residual ALL-CAPS env secret not caught by a named detector', () => {
    const input = 'SESSION_BLOB=aB3dEfGhIjKlMnOpQrStUvWxYz012345';

    const { redacted, findings } = redactText(input);

    expect(redacted).toBe('SESSION_BLOB=[REDACTED:env]');
    expect(countOf(findings, 'env')).toBe(1);
  });

  it('masks email and phone PII', () => {
    const input = 'contact alice.dev+test@example.co.uk or +1 (415) 555-2671 / 212-555-0198';

    const { redacted, findings } = redactText(input);

    expect(redacted).not.toContain('alice.dev+test@example.co.uk');
    expect(redacted).toContain('[REDACTED:pii-email]');
    expect(redacted).not.toContain('555-2671');
    expect(redacted).not.toContain('212-555-0198');
    expect(countOf(findings, 'pii-email')).toBe(1);
    expect(countOf(findings, 'pii-phone')).toBe(2);
  });
});

describe('redactText — cleanliness and idempotency', () => {
  it('leaves benign text untouched with no findings', () => {
    const input = 'const timeout = 5000; let retries = 3; // nothing secret here';
    const { redacted, findings } = redactText(input);

    expect(redacted).toBe(input);
    expect(findings).toEqual([]);
  });

  it('is idempotent — re-redacting masked output changes nothing', () => {
    const input = [
      'openai sk-projABCDEF0123456789ghijkl',
      'client_secret: "topSecretValue123"',
      'email dev@corp.io',
      'DATABASE_URL=postgres://u:p@h/db',
      'phone 212-555-0198',
    ].join('\n');

    const first = redactText(input);
    const second = redactText(first.redacted);

    expect(second.redacted).toBe(first.redacted);
    expect(second.findings).toEqual([]);
  });

  it('orders findings by the canonical REDACTION_KINDS sequence', () => {
    const input = 'pw password=abcdef12 email a@b.co key sk-projABCDEF0123456789ghijkl';
    const kinds = redactText(input).findings.map((f) => f.kind);
    // api-key precedes password precedes pii-email in REDACTION_KINDS
    expect(kinds).toEqual(['api-key', 'password', 'pii-email']);
  });
});

describe('redactObject — deep walk', () => {
  it('masks secret-keyed values wholesale and content-redacts the rest', () => {
    const input = {
      user: { email: 'bob@corp.io' },
      apiKey: 'sk-liveABCDEF0123456789zz',
      config: { PASSWORD: 'p@ssw0rd-long', note: 'call 212-555-0198' },
      count: 42,
      enabled: true,
    };
    const snapshot = JSON.stringify(input);

    const { redacted, findings } = redactObject(input) as {
      redacted: typeof input;
      findings: RedactionFinding[];
    };

    // secret-keyed leaves masked wholesale
    expect(redacted.apiKey).toBe('[REDACTED:api-key]');
    expect(redacted.config.PASSWORD).toBe('[REDACTED:password]');
    // non-secret keys: value content-redacted
    expect(redacted.user.email).toBe('[REDACTED:pii-email]');
    expect(redacted.config.note).toBe('call [REDACTED:pii-phone]');
    // non-strings under non-secret keys: passthrough
    expect(redacted.count).toBe(42);
    expect(redacted.enabled).toBe(true);

    expect(countOf(findings, 'api-key')).toBe(1);
    expect(countOf(findings, 'password')).toBe(1);
    expect(countOf(findings, 'pii-email')).toBe(1);
    expect(countOf(findings, 'pii-phone')).toBe(1);

    // input is never mutated
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('recurses into arrays/objects under a sensitive key', () => {
    const { redacted } = redactObject({ tokens: [GITHUB_PAT, 'plain-text'] }) as {
      redacted: { tokens: string[] };
      findings: RedactionFinding[];
    };
    expect(redacted.tokens[0]).toBe('[REDACTED:api-key]');
    expect(redacted.tokens[1]).toBe('plain-text');
  });

  it('terminates on cyclic references and still redacts', () => {
    const node: Record<string, unknown> = { secret: 'x' };
    node.self = node; // cycle

    const { redacted, findings } = redactObject(node) as {
      redacted: Record<string, unknown>;
      findings: RedactionFinding[];
    };

    expect(redacted.secret).toBe('[REDACTED:secret]');
    expect(redacted.self).toBe(redacted); // shared ref preserved, no infinite loop
    expect(countOf(findings, 'secret')).toBe(1);
  });

  it('throws on a non-string passed to redactText directly', () => {
    // @ts-expect-error — deliberate contract violation
    expect(() => redactText(42)).toThrow();
  });
});
