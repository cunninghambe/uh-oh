import { describe, expect, it } from 'vitest';
import { BreadcrumbBuffer } from './breadcrumbs.js';

describe('BreadcrumbBuffer', () => {
  it('starts empty', () => {
    const buf = new BreadcrumbBuffer();
    expect(buf.get()).toEqual([]);
  });

  it('adds breadcrumbs and returns them in order', () => {
    const buf = new BreadcrumbBuffer();
    buf.add({ category: 'nav', message: 'Home' });
    buf.add({ category: 'nav', message: 'Profile' });
    const items = buf.get();
    expect(items).toHaveLength(2);
    expect(items[0]?.message).toBe('Home');
    expect(items[1]?.message).toBe('Profile');
  });

  it('defaults level to info', () => {
    const buf = new BreadcrumbBuffer();
    buf.add({ category: 'nav', message: 'x' });
    expect(buf.get()[0]?.level).toBe('info');
  });

  it('clears all breadcrumbs', () => {
    const buf = new BreadcrumbBuffer();
    buf.add({ category: 'nav', message: 'x' });
    buf.clear();
    expect(buf.get()).toEqual([]);
  });

  it('drops oldest on FIFO overflow (cap 3)', () => {
    const buf = new BreadcrumbBuffer(3);
    buf.add({ category: 'a', message: '1' });
    buf.add({ category: 'a', message: '2' });
    buf.add({ category: 'a', message: '3' });
    buf.add({ category: 'a', message: '4' });
    const items = buf.get();
    expect(items).toHaveLength(3);
    expect(items[0]?.message).toBe('2');
    expect(items[2]?.message).toBe('4');
  });

  it('accepts exactly cap items without dropping (boundary)', () => {
    const buf = new BreadcrumbBuffer(3);
    buf.add({ category: 'a', message: '1' });
    buf.add({ category: 'a', message: '2' });
    buf.add({ category: 'a', message: '3' });
    expect(buf.get()).toHaveLength(3);
    expect(buf.get()[0]?.message).toBe('1');
  });

  // EventEnvelopeSchema allows at most 100 breadcrumbs. A larger maxBreadcrumbs
  // used to make every event built after the 101st crumb a 400, which the
  // spool drops as permanent.
  it('never holds more than the wire cap of 100, whatever cap is asked for', () => {
    const buf = new BreadcrumbBuffer(250);
    for (let i = 0; i < 300; i++) buf.add({ category: 'a', message: String(i) });
    expect(buf.get()).toHaveLength(100);
    expect(buf.get()[0]?.message).toBe('200');
  });

  it('a cap of 0 keeps no breadcrumbs; an invalid cap falls back to 100', () => {
    const none = new BreadcrumbBuffer(0);
    none.add({ category: 'a', message: 'x' });
    expect(none.get()).toHaveLength(0);

    const bad = new BreadcrumbBuffer(Number.NaN);
    for (let i = 0; i < 150; i++) bad.add({ category: 'a', message: String(i) });
    expect(bad.get()).toHaveLength(100);
  });

  it('get returns a copy (mutation does not affect buffer)', () => {
    const buf = new BreadcrumbBuffer();
    buf.add({ category: 'nav', message: 'x' });
    const items = buf.get();
    items.splice(0, 1);
    expect(buf.get()).toHaveLength(1);
  });
});
