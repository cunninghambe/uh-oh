import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { usageEvents, usageSalts, type UsageEventRow } from '../db/schema.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { TEST_SECRET } from '../auth/test-utils.js';
import { metrics } from '../metrics/registry.js';

let db: Db;
let close: () => void;
let project: ProjectRow;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
});
afterEach(() => close());

const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });

// A recognizable IP + UA so the privacy proofs can search the DB for them.
const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (SecretDeviceModel) SuperUniqueAgentString/9.9';

type PostOpts = {
  publicKey?: string;
  ip?: string;
  ua?: string;
  origin?: string;
  contentType?: string;
  payload: unknown;
};

const postUsage = (server: ReturnType<typeof buildServer>, opts: PostOpts) => {
  const contentType = opts.contentType ?? 'application/json';
  const body =
    contentType === 'application/json' && typeof opts.payload !== 'string'
      ? opts.payload
      : typeof opts.payload === 'string'
        ? opts.payload
        : JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-forwarded-for': opts.ip ?? IP,
    'user-agent': opts.ua ?? UA,
  };
  if (opts.origin) headers['origin'] = opts.origin;
  return server.inject({
    method: 'POST',
    url: `/ingest/${opts.publicKey ?? project.publicKey}/usage`,
    headers,
    payload: body as string | object,
  });
};

const allUsage = (): UsageEventRow[] => db.select().from(usageEvents).all();

describe('POST /ingest/:publicKey/usage — auth + batching', () => {
  it('rejects an unknown public key with 401 and no echo', async () => {
    const res = await postUsage(app(), {
      publicKey: 'pk_nope',
      payload: { events: [{ type: 'pageview', path: '/x' }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('pk_nope');
    expect(allUsage()).toHaveLength(0);
  });

  it('accepts a valid batch with 202 { accepted, dropped }', async () => {
    const res = await postUsage(app(), {
      payload: {
        events: [
          { type: 'pageview', path: '/home' },
          { type: 'event', name: 'signup' },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(allUsage()).toHaveLength(2);
  });

  it('rejects a batch over 50 events with 413 and stores nothing', async () => {
    const events = Array.from({ length: 51 }, () => ({ type: 'pageview', path: '/x' }));
    const res = await postUsage(app(), { payload: { events } });
    expect(res.statusCode).toBe(413);
    expect(allUsage()).toHaveLength(0);
  });

  it('rejects a non-batch body with 400', async () => {
    const res = await postUsage(app(), { payload: { nope: true } });
    expect(res.statusCode).toBe(400);
  });

  it('drops individual invalid events but keeps the batch', async () => {
    const res = await postUsage(app(), {
      payload: {
        events: [
          { type: 'pageview', path: '/ok' }, // valid
          { type: 'pageview' }, // invalid: pageview needs a path
          { type: 'event' }, // invalid: event needs a name
          { type: 'event', name: 'bad name!' }, // invalid: name regex
          { type: 'event', name: 'ok_event' }, // valid
          { type: 'pageview', path: '/big', props: { a: 'x'.repeat(300) } }, // invalid: value > 256
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2, dropped: 4 });
    expect(allUsage()).toHaveLength(2);
  });

  it('drops an event with more than 10 prop keys', async () => {
    const props: Record<string, number> = {};
    for (let i = 0; i < 11; i++) props[`k${String(i)}`] = i;
    const res = await postUsage(app(), {
      payload: { events: [{ type: 'event', name: 'e', props }] },
    });
    expect(res.json()).toEqual({ accepted: 0, dropped: 1 });
  });

  it('parses a text/plain body (sendBeacon) the same as JSON', async () => {
    const res = await postUsage(app(), {
      contentType: 'text/plain',
      payload: { events: [{ type: 'pageview', path: '/beacon' }] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(allUsage()[0]?.path).toBe('/beacon');
  });

  it('rate-limits excessive posts with 429', async () => {
    const server = app();
    let saw429 = false;
    for (let i = 0; i < 260; i++) {
      const res = await postUsage(server, { payload: { events: [] } });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it('sets open CORS on POST and answers the OPTIONS preflight', async () => {
    const server = app();
    const post = await postUsage(server, { payload: { events: [] } });
    expect(post.headers['access-control-allow-origin']).toBe('*');
    const preflight = await server.inject({
      method: 'OPTIONS',
      url: `/ingest/${project.publicKey}/usage`,
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
  });

  it('increments uh_oh_usage_events_total by the accepted count', async () => {
    const total = async (): Promise<number> => {
      const raw = (await Promise.resolve(metrics.usageEvents.get())) as unknown as {
        values: Array<{ value: number }>;
      };
      return raw.values.reduce((sum, v) => sum + v.value, 0);
    };
    const before = await total();
    await postUsage(app(), {
      payload: {
        events: [
          { type: 'pageview', path: '/a' },
          { type: 'event', name: 'e' },
        ],
      },
    });
    expect((await total()) - before).toBe(2);
  });
});

describe('normalization + referrer privacy', () => {
  it('strips query + fragment from the stored path', async () => {
    await postUsage(app(), {
      payload: { events: [{ type: 'pageview', path: '/products?id=42&q=secret#reviews' }] },
    });
    const row = allUsage()[0];
    expect(row?.path).toBe('/products');
    // The query (which could carry PII) must not survive anywhere on the row.
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('stores only the referrer DOMAIN, never its path or query', async () => {
    await postUsage(app(), {
      payload: {
        events: [
          { type: 'pageview', path: '/', referrer: 'https://news.example.com/article?utm=abc123' },
        ],
      },
    });
    const row = allUsage()[0];
    expect(row?.referrerDomain).toBe('news.example.com');
    expect(JSON.stringify(row)).not.toContain('utm');
    expect(JSON.stringify(row)).not.toContain('abc123');
  });

  it('nulls a same-origin referrer (matches the request Origin host)', async () => {
    await postUsage(app(), {
      origin: 'https://myapp.example.com',
      payload: {
        events: [{ type: 'pageview', path: '/', referrer: 'https://myapp.example.com/prev' }],
      },
    });
    expect(allUsage()[0]?.referrerDomain).toBeNull();
  });

  it('nulls an unparseable referrer', async () => {
    await postUsage(app(), {
      payload: { events: [{ type: 'pageview', path: '/', referrer: 'not a url' }] },
    });
    expect(allUsage()[0]?.referrerDomain).toBeNull();
  });

  it('stores props as JSON', async () => {
    await postUsage(app(), {
      payload: { events: [{ type: 'event', name: 'purchase', props: { sku: 'A1', qty: 2 } }] },
    });
    expect(JSON.parse(allUsage()[0]?.props ?? 'null')).toEqual({ sku: 'A1', qty: 2 });
  });
});

// ── Proof of privacy: raw IP / User-Agent are NEVER persisted ──────────────────
describe('privacy: no raw IP or User-Agent is ever stored', () => {
  it('stores no IP or UA on the usage row (only the 16-char visitor hash)', async () => {
    await postUsage(app(), {
      payload: {
        events: [{ type: 'pageview', path: '/', referrer: 'https://ref.example.com/x' }],
      },
    });
    const row = allUsage()[0];
    expect(row).toBeDefined();
    const serialized = JSON.stringify(row);
    // The identifying inputs must not appear anywhere on the persisted row.
    expect(serialized).not.toContain(IP);
    expect(serialized).not.toContain(UA);
    expect(serialized).not.toContain('SecretDeviceModel');
    expect(serialized).not.toContain('SuperUniqueAgentString');
    // The only identity artifact is a 16-char hex visitor hash.
    expect(row?.visitor).toMatch(/^[0-9a-f]{16}$/);
    expect(row?.visitor).not.toBe(IP);
  });

  it('leaks neither IP/UA nor the salt anywhere in the whole usage store', async () => {
    await postUsage(app(), {
      payload: {
        events: [
          { type: 'pageview', path: '/a', props: { note: 'nothing-sensitive' } },
          { type: 'event', name: 'click' },
        ],
      },
    });
    const dump = JSON.stringify({
      events: db.select().from(usageEvents).all(),
      // Even dumping the salt table alongside the rows, no IP/UA is present.
      salts: db.select().from(usageSalts).all(),
    });
    expect(dump).not.toContain(IP);
    expect(dump).not.toContain('SecretDeviceModel');
    expect(dump).not.toContain('SuperUniqueAgentString');
    // The salt is stored (it must, to keep hashes stable within a day) but is
    // never returned in an API response — proven by the ingest response body.
    const salts = db.select().from(usageSalts).all();
    expect(salts).toHaveLength(1);
  });

  it('never returns the salt (or the visitor) in the ingest response body', async () => {
    const res = await postUsage(app(), {
      payload: { events: [{ type: 'pageview', path: '/' }] },
    });
    const salt = db.select().from(usageSalts).all()[0]?.salt;
    expect(salt).toBeDefined();
    expect(res.body).not.toContain(salt ?? '__no_salt__');
    expect(Object.keys(res.json<Record<string, unknown>>())).toEqual(['accepted', 'dropped']);
  });

  it('gives the SAME visitor hash for the same IP+UA within a day, and DIFFERENT hashes for different IP or UA', async () => {
    const server = app();
    await postUsage(server, { payload: { events: [{ type: 'pageview', path: '/1' }] } });
    await postUsage(server, { payload: { events: [{ type: 'pageview', path: '/2' }] } });
    await postUsage(server, {
      ip: '198.51.100.9',
      payload: { events: [{ type: 'pageview', path: '/3' }] },
    });
    await postUsage(server, {
      ua: 'DifferentAgent/1.0',
      payload: { events: [{ type: 'pageview', path: '/4' }] },
    });
    const byPath = new Map(allUsage().map((r) => [r.path, r.visitor]));
    // Same IP + UA → same visitor.
    expect(byPath.get('/1')).toBe(byPath.get('/2'));
    // Different IP → different visitor.
    expect(byPath.get('/3')).not.toBe(byPath.get('/1'));
    // Different UA → different visitor.
    expect(byPath.get('/4')).not.toBe(byPath.get('/1'));
  });
});

// ── Release attribution (§24) ─────────────────────────────────────────────────
describe('usage release attribution', () => {
  it('stores a valid per-event release on the row', async () => {
    const res = await postUsage(app(), {
      payload: { events: [{ type: 'pageview', path: '/', release: '2.1.0' }] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(allUsage()[0]?.release).toBe('2.1.0');
  });

  it('leaves release null when the event omits it', async () => {
    await postUsage(app(), { payload: { events: [{ type: 'event', name: 'signup' }] } });
    expect(allUsage()[0]?.release).toBeNull();
  });

  it('drops an event whose release exceeds 128 chars WITHOUT failing the batch', async () => {
    const res = await postUsage(app(), {
      payload: {
        events: [
          { type: 'pageview', path: '/ok', release: '1.0.0' }, // valid
          { type: 'pageview', path: '/bad', release: 'x'.repeat(129) }, // invalid: release too long
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, dropped: 1 });
    const rows = allUsage();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe('/ok');
    expect(rows[0]?.release).toBe('1.0.0');
  });
});
