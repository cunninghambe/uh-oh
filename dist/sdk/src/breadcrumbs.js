const DEFAULT_CAP = 100;
export class BreadcrumbBuffer {
    cap;
    items = [];
    constructor(cap = DEFAULT_CAP) {
        this.cap = cap;
    }
    add(b) {
        const crumb = {
            category: b.category,
            message: b.message,
            level: b.level ?? 'info',
            ts: new Date().toISOString(),
            ...(b.data !== undefined ? { data: b.data } : {}),
        };
        if (this.items.length >= this.cap) {
            this.items.shift(); // FIFO: drop oldest
        }
        this.items.push(crumb);
    }
    get() {
        return [...this.items];
    }
    clear() {
        this.items = [];
    }
    get length() {
        return this.items.length;
    }
}
//# sourceMappingURL=breadcrumbs.js.map