import { describe, expect, it, vi, afterEach } from 'vitest';

describe('platform', () => {
  afterEach(() => {
    vi.doUnmock('react-native');
    vi.resetModules();
  });

  it('returns android when Platform.OS is android', async () => {
    vi.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    vi.resetModules();
    const { platform } = await import('./platform.js');
    expect(platform()).toBe('android');
  });

  it('returns ios when Platform.OS is ios', async () => {
    vi.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
    vi.resetModules();
    const { platform } = await import('./platform.js');
    expect(platform()).toBe('ios');
  });

  it('returns unknown when Platform.OS is an unexpected value', async () => {
    vi.doMock('react-native', () => ({ Platform: { OS: 'windows' } }));
    vi.resetModules();
    const { platform } = await import('./platform.js');
    expect(platform()).toBe('unknown');
  });
});
