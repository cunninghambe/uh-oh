import type { JsonValue, User } from '@uh-oh/types';

type ScopeSnapshot = {
  user?: User;
  tags?: Record<string, string>;
  context?: Record<string, JsonValue>;
  fingerprint?: string[];
};

export class Scope {
  private user: User | null = null;
  private tags: Record<string, string> = {};
  private ctx: Record<string, JsonValue> = {};
  private fingerprint: string[] | null = null;

  setUser(u: User | null): void {
    this.user = u;
  }

  setTag(k: string, v: string | null): void {
    if (v === null) {
      delete this.tags[k];
    } else {
      this.tags[k] = v;
    }
  }

  setContext(k: string, v: Record<string, unknown> | null): void {
    if (v === null) {
      delete this.ctx[k];
    } else {
      this.ctx[k] = v as Record<string, JsonValue>;
    }
  }

  setFingerprint(parts: string[] | null): void {
    this.fingerprint = parts;
  }

  snapshot(): ScopeSnapshot {
    const out: ScopeSnapshot = {};
    if (this.user !== null) out.user = this.user;
    if (Object.keys(this.tags).length > 0) out.tags = { ...this.tags };
    if (Object.keys(this.ctx).length > 0) out.context = { ...this.ctx };
    if (this.fingerprint !== null) out.fingerprint = [...this.fingerprint];
    return out;
  }
}
