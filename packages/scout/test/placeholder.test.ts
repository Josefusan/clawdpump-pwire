import { describe, expect, it } from 'vitest';
import { name } from '../src/index.js';

describe('scout', () => {
  it('placeholder', () => {
    expect(name).toBe('scout');
  });
});
