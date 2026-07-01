/**
 * Sub-project #4 domain-contract smoke test — Deep quality gates (§7.12-7.13).
 *
 * The gate-family taxonomy is a frozen const tuple and `UiQualityScore` is a
 * computed (non-persisted) artifact, so — like CouncilReport — coverage is at
 * the type/const level: the tuple's membership and order are load-bearing (they
 * key gate dispatch and report ordering), and a representative score fixture
 * must satisfy the interface at compile time.
 */
import { describe, expect, it } from 'vitest';

import { GATE_FAMILIES } from './index';
import type { GateFamily, UiQualityScore } from './index';

describe('gate families', () => {
  it('exposes the six deep-gate families in deterministic order', () => {
    expect(GATE_FAMILIES).toEqual(['code', 'ui', 'security', 'devops', 'product', 'premium-ui']);
  });

  it('has no duplicate families', () => {
    expect(new Set(GATE_FAMILIES).size).toBe(GATE_FAMILIES.length);
  });

  it('narrows every member to GateFamily', () => {
    for (const family of GATE_FAMILIES) {
      const narrowed: GateFamily = family;
      expect(typeof narrowed).toBe('string');
    }
  });
});

describe('UiQualityScore', () => {
  const score: UiQualityScore = {
    visualHierarchy: 82,
    mobileResponsiveness: 74,
    spacingConsistency: 68,
    accessibility: 55,
    premiumFeel: 61,
    overall: 68,
    topFixes: ['Add responsive breakpoints to the dashboard grid', 'Label form inputs for a11y'],
  };

  it('is a well-formed computed artifact with 0-100 dimensions', () => {
    const dimensions = [
      score.visualHierarchy,
      score.mobileResponsiveness,
      score.spacingConsistency,
      score.accessibility,
      score.premiumFeel,
      score.overall,
    ];
    for (const value of dimensions) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(Array.isArray(score.topFixes)).toBe(true);
  });
});
