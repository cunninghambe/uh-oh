import type { JsonValue, User } from '../../_uh_oh_types';
type ScopeSnapshot = {
    user?: User;
    tags?: Record<string, string>;
    context?: Record<string, JsonValue>;
    fingerprint?: string[];
};
export declare class Scope {
    private user;
    private tags;
    private ctx;
    private fingerprint;
    setUser(u: User | null): void;
    setTag(k: string, v: string | null): void;
    setContext(k: string, v: Record<string, unknown> | null): void;
    setFingerprint(parts: string[] | null): void;
    snapshot(): ScopeSnapshot;
}
export {};
//# sourceMappingURL=scope.d.ts.map