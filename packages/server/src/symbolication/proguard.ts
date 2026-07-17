/**
 * Pure-TS ProGuard mapping parser.
 *
 * Parses the output of `proguard/retrace` mapping.txt:
 *   com.example.MyClass -> a.b.c:
 *       int field1 -> a
 *       void method1() -> b
 *       42:43:void method3():100:101 -> d
 */

export type ProguardMapping = {
  /** Return original class name, or null if unknown. */
  resolveClass: (obfuscated: string) => string | null;
  /** Return original method name for an obfuscated (class, method) pair, or null. */
  resolveMethod: (obfuscatedClass: string, obfuscatedMethod: string) => string | null;
  /** Number of class mappings parsed. Zero on non-empty input signals a corrupt file. */
  classCount: number;
};

// Maps obfuscated class name → original class name
type ClassMap = Map<string, string>;
// Maps obfuscated class name → Map<obfuscated method name → original method name>
// Multiple overloads with the same obfuscated name map to the first encountered original.
type MethodMap = Map<string, Map<string, string>>;

// Class header: "com.example.Foo -> a.b:"
const CLASS_LINE = /^(\S+)\s+->\s+(\S+):$/;

// Member line (methods and fields):
//   "    void method1() -> b"
//   "    42:43:void method3():100:101 -> d"
//   "    int field1 -> a"
// Capture groups: (1) type, (2) raw name possibly with params, (3) obfuscated name
const MEMBER_LINE =
  /^\s+(?:\d+:\d+:)?[A-Za-z][\w.$[\]]*\s+([A-Za-z_$][\w.$]*)(\([^)]*\))?(?::[^-]*)?\s*->\s+([A-Za-z_$][\w.$]*)$/;

export const parseProguardMapping = (raw: string): ProguardMapping => {
  const classMap: ClassMap = new Map();
  const methodMap: MethodMap = new Map();

  let currentObfClass: string | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const classMatch = CLASS_LINE.exec(line);
    if (classMatch) {
      const [, orig, obf] = classMatch;
      if (orig && obf) {
        // CLASS_LINE ends with ":", strip it from obfuscated name if captured
        const obfClean = obf.endsWith(':') ? obf.slice(0, -1) : obf;
        classMap.set(obfClean, orig);
        currentObfClass = obfClean;
      }
      continue;
    }

    if (currentObfClass === null) continue;

    const memberMatch = MEMBER_LINE.exec(line);
    if (memberMatch) {
      // group 1: original name (method or field), group 2: params if method, group 3: obf name
      const [, origName, params, obfName] = memberMatch;
      if (origName && obfName && params !== undefined) {
        // Has parentheses — it's a method
        let classMethodMap = methodMap.get(currentObfClass);
        if (!classMethodMap) {
          classMethodMap = new Map();
          methodMap.set(currentObfClass, classMethodMap);
        }
        if (!classMethodMap.has(obfName)) {
          classMethodMap.set(obfName, origName);
        }
      }
    }
  }

  return {
    resolveClass: (obfuscated) => classMap.get(obfuscated) ?? null,
    resolveMethod: (obfuscatedClass, obfuscatedMethod) =>
      methodMap.get(obfuscatedClass)?.get(obfuscatedMethod) ?? null,
    classCount: classMap.size,
  };
};
