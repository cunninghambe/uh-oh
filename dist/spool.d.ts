import type { EventEnvelope } from './_uh_oh_types';
import type { SendResult } from './transport.js';
export type AsyncStorageLike = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};
export declare class Spool {
    private readonly storage;
    constructor(storage: AsyncStorageLike);
    enqueue(env: EventEnvelope): Promise<void>;
    drain(send: (env: EventEnvelope) => Promise<SendResult>): Promise<void>;
    size(): Promise<number>;
    private _read;
}
//# sourceMappingURL=spool.d.ts.map