import type { EventEnvelope, Level, BreadcrumbLevel } from '../../_uh_oh_types';
import { Scope } from './scope.js';
import { type AsyncStorageLike } from './spool.js';
export type InitOptions = {
    dsn: string;
    release: string;
    environment?: string;
    beforeSend?: (e: EventEnvelope) => EventEnvelope | null;
    maxBreadcrumbs?: number;
    debug?: boolean;
    enableNative?: boolean;
};
type BreadcrumbInput = {
    category: string;
    message: string;
    level?: BreadcrumbLevel;
    data?: Record<string, unknown>;
};
export declare class Client {
    readonly scope: Scope;
    private readonly breadcrumbs;
    private readonly spool;
    private readonly opts;
    private dsn;
    private readonly noop;
    private uninstallHandlers;
    constructor(opts: InitOptions, storage?: AsyncStorageLike);
    start(): void;
    private _installNativeAndDrainPending;
    stop(): void;
    captureException(err: unknown, ctx?: {
        tags?: Record<string, string>;
        extra?: Record<string, unknown>;
    }): string;
    captureMessage(msg: string, level?: Level): string;
    addBreadcrumb(b: BreadcrumbInput): void;
    private _capture;
    private _buildEnvelope;
    /**
     * Builds a full EventEnvelope from a partial report written by the native
     * crash handler. The native side provides exception, timestamp, and device;
     * this method fills in sdk, release, platform, level, breadcrumbs, and scope.
     */
    private _buildEnvelopeFromPartial;
    private _drain;
}
export {};
//# sourceMappingURL=client.d.ts.map