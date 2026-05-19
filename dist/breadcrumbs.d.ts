import type { Breadcrumb, BreadcrumbLevel } from './_uh_oh_types';
type BreadcrumbInput = {
    category: string;
    message: string;
    level?: BreadcrumbLevel;
    data?: Record<string, unknown>;
};
export declare class BreadcrumbBuffer {
    private readonly cap;
    private items;
    constructor(cap?: number);
    add(b: BreadcrumbInput): void;
    get(): Breadcrumb[];
    clear(): void;
    get length(): number;
}
export {};
//# sourceMappingURL=breadcrumbs.d.ts.map