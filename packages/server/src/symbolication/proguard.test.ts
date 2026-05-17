import { describe, it, expect } from 'vitest';
import { parseProguardMapping } from './proguard.js';

const SAMPLE_MAPPING = `
# ProGuard generated mapping
com.example.MyActivity -> a.b:
    int counter -> c
    void onCreate(android.os.Bundle) -> d
    void onDestroy() -> e

com.example.utils.StringHelper -> f.g:
    java.lang.String format(java.lang.String) -> h
    java.lang.String format(java.lang.String,java.lang.Object) -> h
    void doNothing() -> i

com.example.DataModel -> j:
    42:43:void process():100:101 -> k
`;

describe('parseProguardMapping', () => {
  it('resolves a top-level class name', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    expect(mapping.resolveClass('a.b')).toBe('com.example.MyActivity');
  });

  it('resolves a nested class name', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    expect(mapping.resolveClass('f.g')).toBe('com.example.utils.StringHelper');
  });

  it('returns null for unknown class', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    expect(mapping.resolveClass('x.y.z')).toBeNull();
  });

  it('resolves a method name', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    expect(mapping.resolveMethod('a.b', 'd')).toBe('onCreate');
  });

  it('resolves overloaded methods — same obfuscated name maps to first original', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    // both format overloads map to 'h'; we return 'format' (first encounter)
    expect(mapping.resolveMethod('f.g', 'h')).toBe('format');
  });

  it('returns null for unknown method on known class', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    expect(mapping.resolveMethod('a.b', 'zzz')).toBeNull();
  });

  it('returns null for method on unknown class', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    expect(mapping.resolveMethod('x.y', 'h')).toBeNull();
  });

  it('skips comment lines', () => {
    const mapping = parseProguardMapping('# comment\ncom.Foo -> a:\n    void bar() -> b\n');
    expect(mapping.resolveClass('a')).toBe('com.Foo');
  });

  it('skips blank lines without error', () => {
    const mapping = parseProguardMapping('\n\ncom.Foo -> a:\n\n    void bar() -> b\n\n');
    expect(mapping.resolveClass('a')).toBe('com.Foo');
    expect(mapping.resolveMethod('a', 'b')).toBe('bar');
  });

  it('handles line-range annotated methods', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    // "42:43:void process():100:101 -> k" should resolve method k → process
    expect(mapping.resolveMethod('j', 'k')).toBe('process');
  });

  it('does not treat field entries as methods', () => {
    const mapping = parseProguardMapping(SAMPLE_MAPPING);
    // "int counter -> c" is a field — resolveMethod should return null
    expect(mapping.resolveMethod('a.b', 'c')).toBeNull();
  });
});
