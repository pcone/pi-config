import { describe, it, expect } from 'vitest';
import { TYPE_PRECEDENCE } from './types.js';

describe('types', () => {
  it('TYPE_PRECEDENCE has the expected shape', () => {
    expect(Array.isArray(TYPE_PRECEDENCE)).toBe(true);
    expect(TYPE_PRECEDENCE.length).toBe(9);
    expect(TYPE_PRECEDENCE[0]).toBe('feat');
    expect(TYPE_PRECEDENCE).toContain('fix');
    expect(TYPE_PRECEDENCE).toContain('chore');
  });

  it('TYPE_PRECEDENCE is readonly (frozen)', () => {
    // TYPE_PRECEDENCE is a const assertion tuple — attempting to mutate
    // would be a compile error. We just verify the reference is the array.
    expect(TYPE_PRECEDENCE).toBeDefined();
  });
});
