import { describe, expect, it } from 'vitest';
import { Scope } from './scope.js';

describe('Scope', () => {
  it('snapshot is empty by default', () => {
    const s = new Scope();
    expect(s.snapshot()).toEqual({});
  });

  it('setUser adds user to snapshot', () => {
    const s = new Scope();
    s.setUser({ id: 'u1', email: 'a@b.com' });
    expect(s.snapshot().user).toEqual({ id: 'u1', email: 'a@b.com' });
  });

  it('setUser(null) clears user', () => {
    const s = new Scope();
    s.setUser({ id: 'u1' });
    s.setUser(null);
    expect(s.snapshot().user).toBeUndefined();
  });

  it('setTag adds tag to snapshot', () => {
    const s = new Scope();
    s.setTag('env', 'prod');
    expect(s.snapshot().tags).toEqual({ env: 'prod' });
  });

  it('setTag(k, null) removes tag', () => {
    const s = new Scope();
    s.setTag('env', 'prod');
    s.setTag('env', null);
    expect(s.snapshot().tags).toBeUndefined();
  });

  it('setContext adds context to snapshot', () => {
    const s = new Scope();
    s.setContext('app', { version: '1.0' });
    expect(s.snapshot().context).toEqual({ app: { version: '1.0' } });
  });

  it('setContext(k, null) removes context key', () => {
    const s = new Scope();
    s.setContext('app', { version: '1.0' });
    s.setContext('app', null);
    expect(s.snapshot().context).toBeUndefined();
  });

  it('setFingerprint sets fingerprint in snapshot', () => {
    const s = new Scope();
    s.setFingerprint(['module', 'error']);
    expect(s.snapshot().fingerprint).toEqual(['module', 'error']);
  });

  it('setFingerprint(null) clears fingerprint', () => {
    const s = new Scope();
    s.setFingerprint(['a']);
    s.setFingerprint(null);
    expect(s.snapshot().fingerprint).toBeUndefined();
  });

  it('snapshot returns copies (mutation does not affect scope)', () => {
    const s = new Scope();
    s.setTag('env', 'prod');
    const snap = s.snapshot();
    if (snap.tags) snap.tags['env'] = 'changed';
    expect(s.snapshot().tags).toEqual({ env: 'prod' });
  });
});
