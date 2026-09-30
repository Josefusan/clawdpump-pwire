import { describe, expect, it } from 'vitest';
import { name } from '../src/index.js';

describe('live', () => {
  it('placeholder', () => {
    expect(name).toBe('live');
  });
});
