import { describe, it, expect } from 'vitest';
import { clampScore, formatCount, formatDateTime, formatRelative, humanize } from './format';

describe('clampScore', () => {
  it('bounds values to 0..100 and rounds', () => {
    expect(clampScore(-10)).toBe(0);
    expect(clampScore(140)).toBe(100);
    expect(clampScore(81.6)).toBe(82);
  });
  it('treats NaN as 0', () => {
    expect(clampScore(Number.NaN)).toBe(0);
  });
});

describe('humanize', () => {
  it('title-cases screaming snake case', () => {
    expect(humanize('READY_WITH_WARNINGS')).toBe('Ready with warnings');
    expect(humanize('shipped')).toBe('Shipped');
  });
});

describe('formatDateTime', () => {
  it('returns a dash for missing input', () => {
    expect(formatDateTime(undefined)).toBe('—');
  });
  it('passes through unparseable input rather than throwing', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});

describe('formatRelative', () => {
  it('reports recent times as "just now"', () => {
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    expect(formatRelative('2026-06-30T11:59:40.000Z', now)).toBe('just now');
  });
  it('reports older times with a unit', () => {
    const now = Date.parse('2026-06-30T12:00:00.000Z');
    expect(formatRelative('2026-06-30T09:00:00.000Z', now)).toMatch(/hour/);
  });
});

describe('formatCount', () => {
  it('formats integers with grouping', () => {
    expect(formatCount(1234)).toBe(new Intl.NumberFormat().format(1234));
  });
});
