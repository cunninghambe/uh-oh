import type { EventEnvelope, Level, BreadcrumbLevel } from '../../_uh_oh_types';
export type { Level, BreadcrumbLevel, EventEnvelope };
export type InitOptions = {
    dsn: string;
    release: string;
    environment?: string;
    beforeSend?: (e: EventEnvelope) => EventEnvelope | null;
    maxBreadcrumbs?: number;
    debug?: boolean;
    enableNative?: boolean;
};
export declare const init: (opts: InitOptions) => void;
export declare const captureException: (err: unknown, ctx?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
}) => string;
export declare const captureMessage: (msg: string, level?: Level) => string;
export declare const addBreadcrumb: (b: {
    category: string;
    message: string;
    level?: BreadcrumbLevel;
    data?: Record<string, unknown>;
}) => void;
export declare const setUser: (u: {
    id: string;
    email?: string;
    username?: string;
} | null) => void;
export declare const setContext: (key: string, value: Record<string, unknown> | null) => void;
export declare const setTag: (key: string, value: string | null) => void;
export declare const setFingerprint: (parts: string[] | null) => void;
//# sourceMappingURL=index.d.ts.map