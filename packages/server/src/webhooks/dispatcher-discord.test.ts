// Discord delivery — target detection, the one-line message per event type, and
// the guarantee that every NON-Discord receiver still gets the uh-oh payload
// byte-for-byte (that shape is the receiver contract).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { createMonitor, recordCheckIn } from '../db/repos/monitors.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import {
  isDiscordWebhookUrl,
  toDiscordContent,
  startDispatcher as startDispatcherRaw,
  type DnsLookupAll,
  type WebhookPayload,
} from './dispatcher.js';

const NOW = 1_800_000_000_000;
const CHECK_IN_AT = Date.parse('2026-08-21T11:53:20.000Z');
const PLAIN_URL = 'https://hooks.example/uh-oh';
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/AbC-token_x';
const DASHBOARD = 'https://err.example';

describe('isDiscordWebhookUrl', () => {
  it.each([
    'https://discord.com/api/webhooks/123/abc',
    'https://discordapp.com/api/webhooks/123/abc',
    'https://DISCORD.com/api/webhooks/123/abc',
    'https://discord.com/api/webhooks/123/abc?wait=true',
    'http://discord.com/api/webhooks/123/abc',
  ])('detects %s', (url) => {
    expect(isDiscordWebhookUrl(url)).toBe(true);
  });

  it.each([
    // Lookalike hosts: matched exactly, never by suffix/prefix.
    'https://evil-discord.com/api/webhooks/123/abc',
    'https://discord.com.evil.net/api/webhooks/123/abc',
    'https://notdiscord.com/api/webhooks/123/abc',
    'https://discord.com.au/api/webhooks/123/abc',
    'https://mydiscordapp.com/api/webhooks/123/abc',
    // Right host, wrong path.
    'https://discord.com/api/webhook/123/abc',
    'https://discord.com/',
    'https://discord.com/apiXapi/webhooks/123',
    // Not a webhook target at all.
    'https://hooks.example/uh-oh',
    'ftp://discord.com/api/webhooks/123/abc',
    'not-a-url',
    '',
  ])('does NOT treat %s as Discord', (url) => {
    expect(isDiscordWebhookUrl(url)).toBe(false);
  });

  it('does not match Discord subdomains (only the two documented hosts)', () => {
    expect(isDiscordWebhookUrl('https://canary.discord.com/api/webhooks/1/x')).toBe(false);
  });
});

describe('toDiscordContent', () => {
  const project = { id: 'p_1', name: 'Whitespace', slug: 'whitespace' };
  const issue = { id: 'i_1', fingerprint: 'fp', title: 'TypeError: boom', eventCount: 4 };

  const monitorPayload = (type: 'monitor.missed' | 'monitor.recovered'): WebhookPayload => ({
    type,
    dispatchId: 'd_1',
    project,
    monitor: {
      id: 'm_1',
      slug: 'cluster-rebuild',
      name: null,
      intervalMinutes: 1440,
      graceMinutes: 60,
      lastCheckInAt: CHECK_IN_AT,
    },
    url: `${DASHBOARD}/monitors/m_1`,
  });

  it('renders monitor.missed as the red one-liner with the last check-in', () => {
    expect(toDiscordContent(monitorPayload('monitor.missed'))).toBe(
      '🔴 Monitor missed: **cluster-rebuild** (Whitespace) — ' +
        `last check-in 2026-08-21 11:53 UTC (07:53 EDT) — ${DASHBOARD}/monitors/m_1`,
    );
  });

  it('renders monitor.recovered in green', () => {
    expect(toDiscordContent(monitorPayload('monitor.recovered'))).toBe(
      '🟢 Monitor recovered: **cluster-rebuild** (Whitespace) — ' +
        `last check-in 2026-08-21 11:53 UTC (07:53 EDT) — ${DASHBOARD}/monitors/m_1`,
    );
  });

  it('prefers the monitor name over its slug, and says so when it never checked in', () => {
    const payload = monitorPayload('monitor.missed');
    const content = toDiscordContent({
      ...payload,
      monitor: { ...payload.monitor!, name: 'Cluster rebuild', lastCheckInAt: null },
    });
    expect(content).toContain('**Cluster rebuild**');
    expect(content).toContain('last check-in never');
  });

  it('renders the check-in in the given local zone', () => {
    expect(toDiscordContent(monitorPayload('monitor.missed'), 'Asia/Kolkata')).toContain(
      'last check-in 2026-08-21 11:53 UTC (17:23 GMT+5:30) — ',
    );
    expect(toDiscordContent(monitorPayload('monitor.missed'), 'UTC')).toContain(
      'last check-in 2026-08-21 11:53 UTC — ',
    );
  });

  it('renders issue.new with the title, project and event count', () => {
    expect(
      toDiscordContent({
        type: 'issue.new',
        dispatchId: 'd_2',
        project,
        issue,
        event: { id: 'e_1', level: 'error', platform: 'android', receivedAt: NOW },
        url: `${DASHBOARD}/issues/i_1`,
      }),
    ).toBe(`💥 New issue: **TypeError: boom** (Whitespace) — 4 events — ${DASHBOARD}/issues/i_1`);
  });

  it('singularises a one-event issue', () => {
    expect(
      toDiscordContent({
        type: 'issue.new',
        dispatchId: 'd_2',
        project,
        issue: { ...issue, eventCount: 1 },
      }),
    ).toBe('💥 New issue: **TypeError: boom** (Whitespace) — 1 event');
  });

  it('renders issue.regressed', () => {
    expect(
      toDiscordContent({
        type: 'issue.regressed',
        dispatchId: 'd_3',
        project,
        issue,
        fixAttempt: null,
        url: `${DASHBOARD}/issues/i_1`,
      }),
    ).toBe(
      `🔁 Issue regressed: **TypeError: boom** (Whitespace) — 4 events — ${DASHBOARD}/issues/i_1`,
    );
  });

  it('renders issue.spike with last-hour volume against the baseline', () => {
    expect(
      toDiscordContent({
        type: 'issue.spike',
        dispatchId: 'd_4',
        project,
        issue,
        stats: { lastHour: 42, baselineHourly: 2.25 },
        url: `${DASHBOARD}/issues/i_1`,
      }),
    ).toBe(
      '📈 Issue spike: **TypeError: boom** (Whitespace) — ' +
        `42 in the last hour vs 2.3/h baseline — ${DASHBOARD}/issues/i_1`,
    );
  });

  it('renders fix.verified with the PR that held', () => {
    expect(
      toDiscordContent({
        type: 'fix.verified',
        dispatchId: 'd_5',
        project,
        issue,
        fixAttempt: {
          id: 'f_1',
          issueId: 'i_1',
          prUrl: 'https://github.com/acme/app/pull/12',
          commitSha: null,
          state: 'verified',
          createdAt: NOW,
          deployedAt: NOW,
          updatedAt: NOW,
        },
        url: `${DASHBOARD}/issues/i_1`,
      }),
    ).toBe(
      '✅ Fix verified: **TypeError: boom** (Whitespace) — ' +
        `https://github.com/acme/app/pull/12 — ${DASHBOARD}/issues/i_1`,
    );
  });

  it('omits the trailing link when no dashboard URL is configured', () => {
    const content = toDiscordContent(monitorPayload('monitor.missed'));
    const noLink = toDiscordContent({
      type: 'monitor.missed',
      dispatchId: 'd_1',
      project,
      monitor: {
        id: 'm_1',
        slug: 'cluster-rebuild',
        name: null,
        intervalMinutes: 1440,
        graceMinutes: 60,
        lastCheckInAt: CHECK_IN_AT,
      },
    });
    expect(content).toContain(DASHBOARD);
    expect(noLink).not.toContain(DASHBOARD);
    expect(noLink.endsWith('UTC (07:53 EDT)')).toBe(true);
  });

  it('stays one line and well under Discord’s 2000-char cap for a monstrous title', () => {
    const content = toDiscordContent({
      type: 'issue.new',
      dispatchId: 'd_6',
      project: { ...project, name: 'P'.repeat(5000) },
      issue: { ...issue, title: `${'X'.repeat(9000)}\nsecond line\tand more` },
      url: `${DASHBOARD}/issues/i_1`,
    });
    expect(content.length).toBeLessThan(2000);
    expect(content).not.toContain('\n');
    expect(content).not.toContain('\t');
    // The dashboard link survives the clamp — it is the actionable part.
    expect(content).toContain(`${DASHBOARD}/issues/i_1`);
  });
});

describe('dispatcher delivery', () => {
  const publicLookup: DnsLookupAll = () =>
    Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
  const startDispatcher: typeof startDispatcherRaw = (deps) =>
    startDispatcherRaw({ lookupFn: publicLookup, ...deps });

  let db: Db;
  let close: () => void;
  let projectId: string;
  let monitorId: string;

  beforeEach(() => {
    ({ db, close } = makeTestDb());
    const project = createProject(db, { name: 'Whitespace', webhookUrl: PLAIN_URL });
    projectId = project.id;
    monitorId = createMonitor(db, {
      projectId,
      slug: 'cluster-rebuild',
      intervalMinutes: 1440,
      graceMinutes: 60,
      now: NOW,
    }).id;
    recordCheckIn(db, monitorId, { now: CHECK_IN_AT });
  });

  afterEach(() => close());

  /** Run the dispatcher once, returning the RAW request bodies it POSTed. */
  const runOnce = async (alertLocalTz?: string): Promise<{ url: string; body: string }[]> => {
    const calls: { url: string; body: string }[] = [];
    const fetchFn = vi.fn((url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ?? '' });
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });
    const handle = startDispatcher({
      db,
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => NOW,
      pollIntervalMs: 10,
      dashboardUrl: DASHBOARD,
      alertLocalTz,
    });
    await new Promise<void>((r) => setTimeout(r, 80));
    await handle.stop();
    return calls;
  };

  it('POSTs a Discord-shaped { content } body to a Discord webhook', async () => {
    enqueueDispatch(db, { monitorId, url: DISCORD_URL, type: 'monitor.missed' }, NOW);
    const calls = await runOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(DISCORD_URL);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      content:
        '🔴 Monitor missed: **cluster-rebuild** (Whitespace) — ' +
        `last check-in 2026-08-21 11:53 UTC (07:53 EDT) — ${DASHBOARD}/monitors/${monitorId}`,
    });
  });

  it('renders the check-in in the zone the dispatcher was started with', async () => {
    enqueueDispatch(db, { monitorId, url: DISCORD_URL, type: 'monitor.missed' }, NOW);
    const calls = await runOnce('Asia/Kolkata');

    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      content:
        '🔴 Monitor missed: **cluster-rebuild** (Whitespace) — ' +
        `last check-in 2026-08-21 11:53 UTC (17:23 GMT+5:30) — ${DASHBOARD}/monitors/${monitorId}`,
    });
  });

  it('keeps the monitor payload BYTE-IDENTICAL for a non-Discord target', async () => {
    const row = enqueueDispatch(db, { monitorId, url: PLAIN_URL, type: 'monitor.missed' }, NOW);
    const calls = await runOnce();

    expect(calls[0]?.body).toBe(
      JSON.stringify({
        type: 'monitor.missed',
        dispatchId: row.id,
        project: { id: projectId, name: 'Whitespace', slug: 'whitespace' },
        monitor: {
          id: monitorId,
          slug: 'cluster-rebuild',
          name: null,
          intervalMinutes: 1440,
          graceMinutes: 60,
          lastCheckInAt: CHECK_IN_AT,
        },
        url: `${DASHBOARD}/monitors/${monitorId}`,
      }),
    );
  });

  it('keeps the issue payload BYTE-IDENTICAL for a non-Discord target', async () => {
    const { issue } = upsertIssue(db, {
      projectId,
      fingerprint: 'fp1',
      title: 'TypeError: boom',
      ts: NOW,
      platform: 'android',
    });
    const event = insertEvent(db, {
      projectId,
      issueId: issue.id,
      releaseId: null,
      fingerprint: 'fp1',
      level: 'error',
      platform: 'android',
      payload: '{}',
      receivedAt: NOW,
      deviceInfo: '{}',
      userInfo: null,
    });
    const row = enqueueDispatch(
      db,
      { issueId: issue.id, eventId: event.id, url: PLAIN_URL, type: 'issue.new' },
      NOW,
    );
    const calls = await runOnce();

    expect(calls[0]?.body).toBe(
      JSON.stringify({
        type: 'issue.new',
        dispatchId: row.id,
        project: { id: projectId, name: 'Whitespace', slug: 'whitespace' },
        issue: {
          id: issue.id,
          fingerprint: 'fp1',
          title: 'TypeError: boom',
          eventCount: 1,
        },
        event: {
          id: event.id,
          level: 'error',
          platform: 'android',
          receivedAt: NOW,
        },
        url: `${DASHBOARD}/issues/${issue.id}`,
      }),
    );
  });
});
