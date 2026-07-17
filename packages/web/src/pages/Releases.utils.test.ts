import { describe, expect, it } from 'vitest';

import { MAX_SYMBOL_UPLOAD_BYTES } from '../api.js';
import { oversizeError } from './Releases.utils.js';

describe('oversizeError (M9 client-side size pre-check)', () => {
  it('allows a file right at the cap', () => {
    expect(oversizeError(MAX_SYMBOL_UPLOAD_BYTES)).toBeNull();
  });

  it('allows a small file', () => {
    expect(oversizeError(1024)).toBeNull();
  });

  it('rejects a file one byte over the cap, with a message mentioning both sizes', () => {
    const msg = oversizeError(MAX_SYMBOL_UPLOAD_BYTES + 1);
    expect(msg).not.toBeNull();
    expect(msg).toContain('50.0MB');
  });
});
