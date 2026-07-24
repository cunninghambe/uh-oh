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

/** Drives the real login FORM — fill password, click submit. Used directly by auth.spec.ts,
 * which is the one spec whose job is to exercise this flow itself (wrong password, correct
 * login redirect). Every other spec just needs an authenticated session; see
 * `loginAndLandOnProjects` below for why those don't call this. */
export const login = async (page: Page, password: string = E2E_ADMIN_PASSWORD): Promise<void> => {
  await page.goto('/login');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
};

// v0.9 CONTRACT (SPEC §24 E2E catch-up): the login endpoint is rate-limited per-IP at 10
// attempts/60s with an escalating lockout (SPEC §5) — real security behavior this suite must
// not weaken. A full serial run drives ~13 non-auth tests, none of which care about exercising
// the login FORM itself (only auth.spec.ts does, via `login` above, untouched by this) — so a
// real UI login per test was observed to exhaust that budget partway through a full run (login
// starting to fail — "Projects heading not found" after a 429 from /api/auth/login — around the
// 11th test). Instead, mint ONE real token via a direct API call the first time any spec needs
// to be logged in, cache it at module scope, and seed localStorage with it on every later call —
// playwright.config.ts pins `workers: 1` (one shared process for the whole run, tests execute
// strictly sequentially — see global-setup.ts's DB-sharing comment for the same assumption), so
// this module is loaded once and the cache is safely shared/ordered across every spec file.
let cachedAdminToken: string | null = null;

/** Logs in (a real token, from a real login call — just not the UI form on every call) and
 * lands on the projects list (the post-login landing page). */
export const loginAndLandOnProjects = async (page: Page): Promise<void> => {
  if (cachedAdminToken === null) {
    const res = await page.request.post('/api/auth/login', {
      data: { password: E2E_ADMIN_PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(`cached login failed: ${String(res.status())} ${await res.text()}`);
    }
    cachedAdminToken = ((await res.json()) as { token: string }).token;
  }
  const token = cachedAdminToken;
  // Registered before the navigation below so it runs ahead of the app's own bundle, avoiding
  // any flash of the logged-out state (see auth.ts's KEY for the localStorage key name).
  await page.addInitScript((t: string) => {
    localStorage.setItem('uh-oh.token', t);
  }, token);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
};

/**
 * Reads the dashboard JWT the login flow already stashed in localStorage (see auth.ts's KEY) so a
 * spec can make an authenticated REST call through the `request` fixture (e.g. seeding a fixture
 * the UI itself doesn't create — v0.8 CONTRACT §23 fix attempts) without a second, separate
 * `/api/auth/login` call. That matters here specifically because the login endpoint is rate
 * limited per-IP (SPEC §5: 10 attempts/60s before an escalating lockout) and this whole suite
 * already spends one login per test — reusing the token already in the page avoids adding to that
 * budget.
 */
export const getAdminToken = async (page: Page): Promise<string> => {
  const token = await page.evaluate(() => localStorage.getItem('uh-oh.token'));
  if (!token) throw new Error('no auth token in localStorage — was the page logged in?');
  return token;
};

/** Extracts the issue id from the current URL (`/issues/<id>`) — there's no dedicated "get
 * issue" API call a helper could use instead without adding UI; reading it back out of the router
 * state after a real navigation also exercises that the navigation actually landed on that issue. */
export const currentIssueId = (page: Page): string => {
  const match = /\/issues\/([^/?#]+)/.exec(page.url());
  if (!match?.[1]) throw new Error(`could not find an issue id in the current URL: ${page.url()}`);
  return match[1];
};

/** Same idea as {@link currentIssueId}, for a project id (`/projects/<id>`). */
export const currentProjectId = (page: Page): string => {
  const match = /\/projects\/([^/?#]+)/.exec(page.url());
  if (!match?.[1]) {
    throw new Error(`could not find a project id in the current URL: ${page.url()}`);
  }
  return match[1];
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
  // v0.9 CONTRACT (SPEC §24 usage release attribution): the canonical `version+build` release
  // identity a real client stamps automatically on every usage event — release-health.spec.ts is
  // the one caller that sets this explicitly, matching it against an ingested event's release so
  // the pageviews attribute to the same release row.
  release?: string;
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
