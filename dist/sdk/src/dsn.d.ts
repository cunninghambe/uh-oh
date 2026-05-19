export type Dsn = {
    publicKey: string;
    baseUrl: string;
};
/**
 * Parses a DSN of the form `https://<publicKey>@<host>[:port][/path]`.
 * Throws if the DSN is invalid.
 */
export declare function parseDsn(dsn: string): Dsn;
//# sourceMappingURL=dsn.d.ts.map