export class Scope {
    user = null;
    tags = {};
    ctx = {};
    fingerprint = null;
    setUser(u) {
        this.user = u;
    }
    setTag(k, v) {
        if (v === null) {
            delete this.tags[k];
        }
        else {
            this.tags[k] = v;
        }
    }
    setContext(k, v) {
        if (v === null) {
            delete this.ctx[k];
        }
        else {
            this.ctx[k] = v;
        }
    }
    setFingerprint(parts) {
        this.fingerprint = parts;
    }
    snapshot() {
        const out = {};
        if (this.user !== null)
            out.user = this.user;
        if (Object.keys(this.tags).length > 0)
            out.tags = { ...this.tags };
        if (Object.keys(this.ctx).length > 0)
            out.context = { ...this.ctx };
        if (this.fingerprint !== null)
            out.fingerprint = [...this.fingerprint];
        return out;
    }
}
//# sourceMappingURL=scope.js.map