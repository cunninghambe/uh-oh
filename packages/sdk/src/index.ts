import { Client } from './client.js';
import type { EventEnvelope, Level, BreadcrumbLevel } from '@uh-oh/types';

export type { Level, BreadcrumbLevel, EventEnvelope };

export type InitOptions = {
  dsn: string;
  release: string;
  environment?: string;
  beforeSend?: (e: EventEnvelope) => EventEnvelope | null;
  maxBreadcrumbs?: number;
  debug?: boolean;
  enableNative?: boolean;
};

let client: Client | null = null;

export const init = (opts: InitOptions): void => {
  // Tear down any existing client first so a second init() (e.g. after a
  // fast-refresh) doesn't leak the previous client's handlers (M6, SPEC §12 #14).
  if (client) client.stop();
  client = new Client(opts);
  client.start();
};

export const captureException = (
  err: unknown,
  ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): string => {
  return client?.captureException(err, ctx) ?? '';
};

export const captureMessage = (msg: string, level: Level = 'info'): string => {
  return client?.captureMessage(msg, level) ?? '';
};

export const addBreadcrumb = (b: {
  category: string;
  message: string;
  level?: BreadcrumbLevel;
  data?: Record<string, unknown>;
}): void => {
  client?.addBreadcrumb(b);
};

export const setUser = (u: { id: string; email?: string; username?: string } | null): void => {
  client?.scope.setUser(u);
};

export const setContext = (key: string, value: Record<string, unknown> | null): void => {
  client?.scope.setContext(key, value);
};

export const setTag = (key: string, value: string | null): void => {
  client?.scope.setTag(key, value);
};

export const setFingerprint = (parts: string[] | null): void => {
  client?.scope.setFingerprint(parts);
};
