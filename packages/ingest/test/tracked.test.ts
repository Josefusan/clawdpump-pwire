import { describe, expect, it } from 'vitest';
import { TrackedSet, parseMaxTracked } from '../src/tracked.js';

describe('TrackedSet cap', () => {
  it('never exceeds cap; evicts least-recently-active, keeps newest', () => {
    const t = new TrackedSet(3);
    const evictions: string[] = [];
    for (let i = 0; i < 10; i++) {
      evictions.push(...t.add(`m${i}`, 1000 + i));
      expect(t.size).toBeLessThanOrEqual(3);
      if (i === 1) t.touch('m0'); // m0 stays active
    }
    expect(t.size).toBe(3);
    expect(t.has('m9')).toBe(true);
    expect(t.has('m1')).toBe(false); // oldest inactive is gone
    expect(evictions).toHaveLength(7);
  });

  it('touch protects a mint from eviction', () => {
    const t = new TrackedSet(2);
    t.add('a', 1);
    t.add('b', 1);
    t.touch('a');
    expect(t.add('c', 1)).toEqual(['b']);
    expect(t.keys()).toEqual(['a', 'c']);
  });

  it('expire removes only past-window mints', () => {
    const t = new TrackedSet(5);
    t.add('a', 10);
    t.add('b', 100);
    expect(t.expire(50)).toEqual(['a']);
    expect(t.keys()).toEqual(['b']);
  });

  it('parseMaxTracked: default 500, min 1', () => {
    expect(parseMaxTracked(undefined)).toBe(500);
    expect(parseMaxTracked('0')).toBe(500);
    expect(parseMaxTracked('abc')).toBe(500);
    expect(parseMaxTracked('1')).toBe(1);
    expect(parseMaxTracked('42')).toBe(42);
  });
});
