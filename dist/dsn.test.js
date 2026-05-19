import { describe, expect, it } from 'vitest';
import { parseDsn } from './dsn.js';
describe('parseDsn', () => {
    it('parses a valid DSN', () => {
        const result = parseDsn('https://mykey123@errors.example.com');
        expect(result.publicKey).toBe('mykey123');
        expect(result.baseUrl).toBe('https://errors.example.com');
    });
    it('parses DSN with explicit port', () => {
        const result = parseDsn('https://abc@errors.example.com:3300');
        expect(result.publicKey).toBe('abc');
        expect(result.baseUrl).toBe('https://errors.example.com:3300');
    });
    it('parses DSN with path (path is ignored for baseUrl)', () => {
        const result = parseDsn('https://abc@errors.example.com/some/path');
        expect(result.publicKey).toBe('abc');
        expect(result.baseUrl).toBe('https://errors.example.com');
    });
    it('throws on missing scheme (not a URL)', () => {
        expect(() => parseDsn('errors.example.com')).toThrow('invalid DSN');
    });
    it('throws on missing publicKey', () => {
        expect(() => parseDsn('https://errors.example.com')).toThrow('missing publicKey');
    });
    it('throws on unsupported scheme (ftp)', () => {
        expect(() => parseDsn('ftp://abc@errors.example.com')).toThrow('scheme must be http or https');
    });
    it('throws on empty string', () => {
        expect(() => parseDsn('')).toThrow('invalid DSN');
    });
});
//# sourceMappingURL=dsn.test.js.map