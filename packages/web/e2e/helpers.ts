// Shared helpers for the e2e specs. `@uh-oh/types` isn't a dependency of @uh-oh/web (and this
// wave's lockfile rule allows exactly one devDep addition, already spent on @playwright/test),
// so the event envelope shape below is a plain object literal kept in sync with
// packages/server's EventEnvelopeSchema by hand, not an imported type.
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { E2E_ADMIN_PASSWORD } from './constants.js';

/** Distinguishes values across test runs/retries without needing a fresh DB each time. */
export const unique = (label: string): string =>
  `${label}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;

export const login = async (page: Page, password: string = E2E_ADMIN_PASSWORD): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
};

/** Logs in and waits for the redirect to the projects list (the post-login landing page). */
export const loginAndLandOnProjects = async (page: Page): Promise<void> => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
};

/**
 * Creates a project via the Home page form and returns its publicKey, scraped from the card
 * Home.tsx renders (`publicKey: <value>`) — there's no dedicated "get project" API call this
 * helper can use without adding UI, and reading it back out of the DOM also exercises that the
 * created project actually renders correctly.
 */
export const createProject = async (
  page: Page,
  name: string,
): Promise<{ name: string; publicKey: string }> => {
  await page.goto('/');
  await page.getByPlaceholder('New project name').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();

  const card = page.locator('a', { hasText: name }).filter({ hasText: 'publicKey:' });
  await expect(card).toBeVisible();
  const text = await card.innerText();
  const match = /publicKey:\s*(\S+)/.exec(text);
  if (!match?.[1]) throw new Error(`could not find publicKey in project card:\n${text}`);
  return { name, publicKey: match[1] };
};

type StackFrameInput = {
  function?: string;
  filename?: string;
  lineno?: number;
  inApp: boolean;
};

type EnvelopeOverrides = {
  type?: string;
  value?: string;
  stacktrace?: StackFrameInput[];
  version?: string;
  build?: string;
};

/** A minimal envelope satisfying packages/server's EventEnvelopeSchema (see
 * packages/types/src/index.ts). */
export const buildEnvelope = (overrides: EnvelopeOverrides = {}): Record<string, unknown> => ({
  sdk: { name: 'uh-oh-e2e', version: '1.0.0' },
  timestamp: new Date().toISOString(),
  platform: 'web',
  release: { version: overrides.version ?? '1.0.0', build: overrides.build ?? '1' },
  level: 'error',
  exception: {
    type: overrides.type ?? 'TypeError',
    value: overrides.value ?? 'Cannot read properties of undefined',
    stacktrace: overrides.stacktrace ?? [
      { function: 'renderWidget', filename: 'app/widget.js', lineno: 42, inApp: true },
      { function: 'main', filename: 'app/index.js', lineno: 10, inApp: true },
    ],
    mechanism: 'js-global',
  },
  breadcrumbs: [],
  device: { osName: 'Linux', osVersion: '1.0' },
});

/** POSTs one event to /ingest/<publicKey> (same-origin through vite preview's proxy — see
 * vite.config.ts — exactly like a real RN/web/node app would hit it in production). */
export const ingestEvent = async (
  request: APIRequestContext,
  publicKey: string,
  overrides: EnvelopeOverrides = {},
): Promise<void> => {
  const res = await request.post(`/ingest/${publicKey}`, { data: buildEnvelope(overrides) });
  if (!res.ok()) {
    throw new Error(`ingest failed: ${String(res.status())} ${await res.text()}`);
  }
};

/**
 * POSTs a dead-man's-switch check-in to /ingest/<publicKey>/check-in/<slug> (v0.5 CONTRACT M) —
 * `intervalMinutes` is only required on a monitor's first-ever check-in (auto-create); omit it
 * on later pings against an already-created slug.
 */
export const checkIn = async (
  request: APIRequestContext,
  publicKey: string,
  slug: string,
  intervalMinutes?: number,
): Promise<{ monitorId: string }> => {
  const qs = intervalMinutes !== undefined ? `?intervalMinutes=${String(intervalMinutes)}` : '';
  const res = await request.post(`/ingest/${publicKey}/check-in/${slug}${qs}`);
  if (!res.ok()) {
    throw new Error(`check-in failed: ${String(res.status())} ${await res.text()}`);
  }
  return (await res.json()) as { monitorId: string };
};

type UsageEventInput = {
  type: 'pageview' | 'event';
  ts?: number;
  path?: string;
  referrer?: string;
  name?: string;
  props?: Record<string, string | number | boolean>;
};

/**
 * POSTs a batch of usage events to /ingest/<publicKey>/usage (v0.6 CONTRACT U-IN) — the public,
 * unauthenticated analytics endpoint the @uh-oh/js browser SDK's beacon hits in production.
 */
export const ingestUsage = async (
  request: APIRequestContext,
  publicKey: string,
  events: UsageEventInput[],
): Promise<{ accepted: number; dropped: number }> => {
  const res = await request.post(`/ingest/${publicKey}/usage`, { data: { events } });
  if (!res.ok()) {
    throw new Error(`usage ingest failed: ${String(res.status())} ${await res.text()}`);
  }
  return (await res.json()) as { accepted: number; dropped: number };
};
