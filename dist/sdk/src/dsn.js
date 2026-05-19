/**
 * Parses a DSN of the form `https://<publicKey>@<host>[:port][/path]`.
 * Throws if the DSN is invalid.
 */
export function parseDsn(dsn) {
    let url;
    try {
        url = new URL(dsn);
    }
    catch {
        throw new Error(`uh-oh: invalid DSN "${dsn}" — not a valid URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`uh-oh: invalid DSN "${dsn}" — scheme must be http or https`);
    }
    const publicKey = url.username;
    if (!publicKey) {
        throw new Error(`uh-oh: invalid DSN "${dsn}" — missing publicKey in userinfo`);
    }
    const port = url.port ? `:${url.port}` : '';
    const baseUrl = `${url.protocol}//${url.hostname}${port}`;
    return { publicKey, baseUrl };
}
//# sourceMappingURL=dsn.js.map