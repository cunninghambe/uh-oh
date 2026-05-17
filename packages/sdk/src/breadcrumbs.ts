import type { Breadcrumb, BreadcrumbLevel, JsonValue } from '@uh-oh/types';

const DEFAULT_CAP = 100;

type BreadcrumbInput = {
  category: string;
  message: string;
  level?: BreadcrumbLevel;
  data?: Record<string, unknown>;
};

export class BreadcrumbBuffer {
  private items: Breadcrumb[] = [];

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  add(b: BreadcrumbInput): void {
    const crumb: Breadcrumb = {
      category: b.category,
      message: b.message,
      level: b.level ?? 'info',
      ts: new Date().toISOString(),
      ...(b.data !== undefined ? { data: b.data as Record<string, JsonValue> } : {}),
    };
    if (this.items.length >= this.cap) {
      this.items.shift(); // FIFO: drop oldest
    }
    this.items.push(crumb);
  }

  get(): Breadcrumb[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }

  get length(): number {
    return this.items.length;
  }
}
