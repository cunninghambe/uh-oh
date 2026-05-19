import { Client } from './client.js';
let client = null;
export const init = (opts) => {
    client = new Client(opts);
    client.start();
};
export const captureException = (err, ctx) => {
    return client?.captureException(err, ctx) ?? '';
};
export const captureMessage = (msg, level = 'info') => {
    return client?.captureMessage(msg, level) ?? '';
};
export const addBreadcrumb = (b) => {
    client?.addBreadcrumb(b);
};
export const setUser = (u) => {
    client?.scope.setUser(u);
};
export const setContext = (key, value) => {
    client?.scope.setContext(key, value);
};
export const setTag = (key, value) => {
    client?.scope.setTag(key, value);
};
export const setFingerprint = (parts) => {
    client?.scope.setFingerprint(parts);
};
//# sourceMappingURL=index.js.map