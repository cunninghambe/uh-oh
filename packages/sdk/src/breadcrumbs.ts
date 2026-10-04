import type { Breadcrumb, BreadcrumbLevel, JsonValue } from '@uh-oh/types';

const DEFAULT_CAP = 100;
/** EventEnvelopeSchema allows at most 100 breadcrumbs per event. */
const WIRE_MAX = 100;
const CATEGORY_MAX = 64;
const MESSAGE_MAX = 1024;

type BreadcrumbInput = {
  category: string;
  message: string;
  level?: BreadcrumbLevel;
  data?: Record<string, unknown>;
};

export class BreadcrumbBuffer {
  private items: Breadcrumb[] = [];
  private readonly cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    // A cap over the wire limit would make every event built after the 101st
    // crumb a 400, which the spool drops as permanent.
    this.cap = Number.isFinite(cap) && cap >= 0 ? Math.min(Math.floor(cap), WIRE_MAX) : DEFAULT_CAP;
  }

  add(b: BreadcrumbInput): void {
    if (this.cap === 0) return;
    // Clamped to the wire schema (category 1-64, message <=1024): one
    // over-long crumb would otherwise make every event carrying it a 400.
    const category = typeof b.category === 'string' && b.category ? b.category : 'default';
    const message = typeof b.message === 'string' ? b.message : String(b.message);
    const crumb: Breadcrumb = {
      category: category.length > CATEGORY_MAX ? category.slice(0, CATEGORY_MAX) : category,
      message: message.length > MESSAGE_MAX ? message.slice(0, MESSAGE_MAX) : message,
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
