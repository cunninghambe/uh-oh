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
    it('get returns a copy (mutation does not affect buffer)', () => {
        const buf = new BreadcrumbBuffer();
        buf.add({ category: 'nav', message: 'x' });
        const items = buf.get();
        items.splice(0, 1);
        expect(buf.get()).toHaveLength(1);
    });
});
//# sourceMappingURL=breadcrumbs.test.js.map