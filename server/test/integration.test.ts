import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Pool } from '../src/db.js';
import { createPostgresEngine } from '../src/services/analysis.js';
import { syncEvents, type WarehouseRow, type WarehouseSink } from '../src/services/bigquery.js';
import { compareWithGa, type GaReportClient } from '../src/services/ga.js';
import { ev, freshDatabase, testConfig } from './helpers.js';

let pool: Pool;
const config = testConfig();

beforeEach(async () => {
  if (pool) await pool.end();
  pool = await freshDatabase();
});

afterAll(async () => {
  await pool?.end();
});

function app(overrides = {}) {
  return createApp({ pool, config: { ...config, ...overrides }, engine: createPostgresEngine(pool) });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe('POST /v1/batch', () => {
  it('requires a write key', async () => {
    const res = await request(app()).post('/v1/batch').send({ events: [ev('visit', 'a', minutesAgo(1))] });
    expect(res.status).toBe(401);
  });

  it('accepts the key from the body for sendBeacon (text/plain)', async () => {
    const res = await request(app())
      .post('/v1/batch')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ write_key: 'test_key', events: [ev('visit', 'a', minutesAgo(1))] }));
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
  });

  it('stores valid events, rejects invalid ones and de-duplicates', async () => {
    const visit = ev('visit', 'a', minutesAgo(5), { context: { page_path: '/', referrer_host: 'www.reddit.com' } });
    const res = await request(app())
      .post('/v1/batch')
      .set('X-Write-Key', 'test_key')
      .send({ events: [visit, visit, ev('exprot', 'a', minutesAgo(1)), ev('upload', 'a', minutesAgo(4))] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 2, duplicates: 1 });
    expect(res.body.rejected).toEqual([expect.objectContaining({ index: 2, reason: 'unknown_event' })]);

    const again = await request(app()).post('/v1/batch').set('X-Write-Key', 'test_key').send({ events: [visit] });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 1 });

    const { rows } = await pool.query("SELECT source, referrer_host FROM events WHERE name = 'visit'");
    expect(rows).toEqual([{ source: 'Reddit', referrer_host: 'www.reddit.com' }]);
    const q = await pool.query('SELECT SUM(accepted)::int a, SUM(duplicates)::int d, SUM(rejected)::int r FROM ingest_batches');
    expect(q.rows[0]).toEqual({ a: 2, d: 2, r: 1 });
  });

  it('ignores attribution on non-visit events', async () => {
    await request(app())
      .post('/v1/batch')
      .set('X-Write-Key', 'test_key')
      .send({ events: [ev('upload', 'a', minutesAgo(1), { context: { utm_source: 'google' } })] });
    const { rows } = await pool.query('SELECT source, utm_source FROM events');
    expect(rows).toEqual([{ source: null, utm_source: null }]);
  });

  it('validates the envelope', async () => {
    const a = app();
    expect((await request(a).post('/v1/batch').set('X-Write-Key', 'test_key').send({})).status).toBe(400);
    expect((await request(a).post('/v1/batch').set('X-Write-Key', 'test_key').send({ events: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => ev('visit', 'a', minutesAgo(1)));
    expect((await request(a).post('/v1/batch').set('X-Write-Key', 'test_key').send({ events: tooMany })).status).toBe(413);
    const bad = await request(a).post('/v1/batch').set('X-Write-Key', 'test_key').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
  });
});

describe('POST /v1/delete', () => {
  it('deletes every event for the ID and queues a warehouse delete', async () => {
    const a = app();
    await request(a)
      .post('/v1/batch')
      .set('X-Write-Key', 'test_key')
      .send({ events: [ev('visit', 'gone', minutesAgo(2)), ev('visit', 'kept', minutesAgo(2)), ev('exprot', 'gone', minutesAgo(1))] });
    const res = await request(a).post('/v1/delete').set('X-Write-Key', 'test_key').send({ anonymous_id: 'gone' });
    expect(res.body).toEqual({ deleted: 1 });
    const ids = (await pool.query('SELECT anonymous_id FROM events')).rows.map((r) => r.anonymous_id);
    expect(ids).toEqual(['kept']);
    expect((await pool.query('SELECT COUNT(*)::int n FROM rejected_events')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int n FROM deletion_requests WHERE warehouse_deleted_at IS NULL')).rows[0].n).toBe(1);
  });
});

describe('analysis queries', () => {
  async function load(events: Record<string, unknown>[]) {
    const res = await request(app()).post('/v1/batch').set('X-Write-Key', 'test_key').send({ events });
    expect(res.body.rejected).toEqual([]);
  }

  it('attributes activation to the first touch source and ignores sample-only exports', async () => {
    const t = (m: number) => minutesAgo(600 - m);
    await load([
      // g1: Google, uploads real receipts and exports -> activated
      ev('visit', 'g1', t(0), { context: { referrer_host: 'www.google.com' } }),
      ev('upload', 'g1', t(1)),
      ev('export', 'g1', t(3)),
      // g2: Google, only samples, exports the samples -> not activated
      ev('visit', 'g2', t(0), { context: { referrer_host: 'www.google.com' } }),
      ev('upload', 'g2', t(1), { properties: { sample: true, file_type: 'image' } }),
      ev('export', 'g2', t(2), { properties: { format: 'full', rows: 3, real_rows: 0 } }),
      // r1: Reddit first, comes back via Google later and exports -> credited to Reddit
      ev('visit', 'r1', t(0), { context: { referrer_host: 'old.reddit.com' } }),
      ev('visit', 'r1', t(100), { context: { referrer_host: 'www.google.com' } }),
      ev('upload', 'r1', t(101)),
      ev('export', 'r1', t(110), { properties: { format: 'full', rows: 2, real_rows: 2 } }),
      ev('export', 'r1', t(111)),
      // d1: Direct, uploads but never exports
      ev('visit', 'd1', t(0)),
      ev('upload', 'd1', t(5)),
    ]);
    const engine = createPostgresEngine(pool);
    const rows = await engine.sources({ from: minutesAgo(24 * 60), to: new Date() });
    const by = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(by.Google).toMatchObject({ visitors: 2, tried_samples: 1, uploaders: 1, exporters: 1, exports: 1 });
    expect(by.Google!.median_seconds_to_export).toBeCloseTo(180, 0);
    expect(by.Reddit).toMatchObject({ visitors: 1, uploaders: 1, exporters: 1, exports: 2 });
    expect(by.Direct).toMatchObject({ visitors: 1, uploaders: 1, exporters: 0, median_seconds_to_export: null });

    // The cohort is defined by first visit: a range after r1's first visit excludes r1 entirely.
    const later = await engine.sources({ from: t(50), to: new Date() });
    expect(later).toEqual([]);

    const weekly = await engine.weekly({ from: minutesAgo(24 * 60), to: new Date() });
    expect(weekly.reduce((s, w) => s + w.visitors, 0)).toBe(4);
    expect(weekly.reduce((s, w) => s + w.exporters, 0)).toBe(2);
    expect(weekly[0]!.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('serves the sources report with rates and intervals', async () => {
    await load([ev('visit', 'x', minutesAgo(10)), ev('upload', 'x', minutesAgo(9)), ev('export', 'x', minutesAgo(8))]);
    const res = await request(app()).get('/api/sources');
    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('postgres');
    expect(res.body.totals).toMatchObject({ visitors: 1, exporters: 1 });
    expect(res.body.sources[0]).toMatchObject({ source: 'Direct', export_rate: 1 });
    expect(res.body.sources[0].export_rate_low).toBeGreaterThan(0);
  });

  it('protects the dashboard API with a token when configured', async () => {
    const a = app({ dashboardToken: 'secret' });
    expect((await request(a).get('/api/sources')).status).toBe(401);
    expect((await request(a).get('/api/sources').set('Authorization', 'Bearer secret')).status).toBe(200);
  });

  it('rejects bad ranges', async () => {
    expect((await request(app()).get('/api/sources?from=nope')).status).toBe(400);
    expect((await request(app()).get('/api/sources?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z')).status).toBe(400);
  });

  it('reports data quality and sync state', async () => {
    await load([ev('upload', 'orphan', minutesAgo(3))]);
    const res = await request(app()).get('/api/quality');
    expect(res.status).toBe(200);
    expect(res.body.idsWithoutVisit).toBe(1);
    expect(res.body.totals.accepted).toBe(1);
    expect(res.body.sync.bigqueryConfigured).toBe(false);
  });
});

describe('BigQuery sync', () => {
  function fakeSink(failDeletes = false) {
    const rows: WarehouseRow[] = [];
    const deleted: string[][] = [];
    const sink: WarehouseSink = {
      ensureTable: async () => {},
      insert: async (r) => {
        rows.push(...r);
      },
      deleteActors: async (ids) => {
        if (failDeletes) throw new Error('streaming buffer');
        deleted.push(ids);
      },
    };
    return { sink, rows, deleted };
  }

  it('exports past the watermark in batches and replays deletions', async () => {
    await pool.query(
      `INSERT INTO events (event_id, name, anonymous_id, occurred_at, received_at, properties)
       SELECT gen_random_uuid(), 'visit', 'u' || i, now() - interval '1 hour', now() - interval '10 minutes', '{}'
       FROM generate_series(1, 5) i`,
    );
    const { sink, rows, deleted } = fakeSink();
    const opts = { destination: 'test', batchSize: 2 };
    const first = await syncEvents(pool, sink, opts);
    expect(first).toMatchObject({ rows: 5, batches: 3, lastEventPk: 5 });
    expect(rows.map((r) => r.anonymous_id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(rows[0]!.properties).toBe('{}');
    expect((await syncEvents(pool, sink, opts)).rows).toBe(0);

    await request(app()).post('/v1/delete').set('X-Write-Key', 'test_key').send({ anonymous_id: 'u1' });
    const res = await syncEvents(pool, sink, opts);
    expect(res).toMatchObject({ deletionsApplied: 1, deletionsPending: 0 });
    expect(deleted).toEqual([['u1']]);
  });

  it('never skips a lower id that commits after a higher one', async () => {
    // A: an ingest transaction that has taken its id but not committed yet.
    const slow = await pool.connect();
    await slow.query('BEGIN');
    await slow.query('SELECT pg_advisory_xact_lock_shared(727002)');
    await slow.query(
      `INSERT INTO events (event_id, name, anonymous_id, occurred_at) VALUES (gen_random_uuid(), 'visit', 'slow', now())`,
    );
    // B: a later request with a higher id commits first.
    const res = await request(app()).post('/v1/batch').set('X-Write-Key', 'test_key').send({ events: [ev('visit', 'fast', minutesAgo(1))] });
    expect(res.body.accepted).toBe(1);

    const { sink, rows } = fakeSink();
    const syncing = syncEvents(pool, sink, { destination: 'test', batchSize: 10 });
    await new Promise((r) => setTimeout(r, 300));
    expect(rows).toEqual([]); // still waiting for A
    await slow.query('COMMIT');
    slow.release();
    const out = await syncing;
    expect(out.rows).toBe(2);
    expect(rows.map((r) => r.anonymous_id)).toEqual(['slow', 'fast']);
  });

  it('gives up without moving the watermark when an insert stays open too long', async () => {
    await pool.query(`INSERT INTO events (event_id, name, anonymous_id, occurred_at) VALUES (gen_random_uuid(), 'visit', 'a', now())`);
    const stuck = await pool.connect();
    await stuck.query('BEGIN');
    await stuck.query('SELECT pg_advisory_xact_lock_shared(727002)');
    const { sink, rows } = fakeSink();
    await expect(syncEvents(pool, sink, { destination: 'test', batchSize: 10, lockTimeoutMs: 200 })).rejects.toThrow(/lock timeout/);
    await stuck.query('ROLLBACK');
    stuck.release();
    expect(rows).toEqual([]);
    expect((await pool.query('SELECT last_event_pk FROM sync_state')).rows[0]).toEqual({ last_event_pk: '0' });
  });

  it('keeps deletions pending when the warehouse refuses them', async () => {
    await request(app()).post('/v1/delete').set('X-Write-Key', 'test_key').send({ anonymous_id: 'x' });
    const { sink } = fakeSink(true);
    const res = await syncEvents(pool, sink, { destination: 'test', batchSize: 10 });
    expect(res).toMatchObject({ deletionsApplied: 0, deletionsPending: 1 });
  });

  it('records insert failures on the sync state', async () => {
    await pool.query(
      `INSERT INTO events (event_id, name, anonymous_id, occurred_at, received_at)
       VALUES (gen_random_uuid(), 'visit', 'a', now(), now() - interval '5 minutes')`,
    );
    const sink: WarehouseSink = {
      ensureTable: async () => {},
      insert: async () => {
        throw new Error('quota exceeded');
      },
      deleteActors: async () => {},
    };
    await expect(syncEvents(pool, sink, { destination: 'test', batchSize: 10 })).rejects.toThrow('quota');
    const { rows } = await pool.query('SELECT last_event_pk, last_error FROM sync_state');
    expect(rows[0]).toMatchObject({ last_event_pk: '0', last_error: 'quota exceeded' });
  });
});

describe('Google Analytics comparison', () => {
  it('groups GA sources with our labels and lines both sides up', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const at = new Date(`${day}T00:00:00Z`);
    at.setUTCMinutes(1);
    const safeAt = at > new Date() ? new Date() : at;
    await request(app())
      .post('/v1/batch')
      .set('X-Write-Key', 'test_key')
      .send({
        events: [
          ev('visit', 'a', safeAt, { context: { referrer_host: 'www.google.com' } }),
          ev('visit', 'b', safeAt, { context: { referrer_host: 'lnkd.in' } }),
          ev('upload', 'a', safeAt),
          ev('export', 'a', safeAt),
        ],
      });
    const calls: Record<string, unknown>[] = [];
    const fake: GaReportClient = {
      runReport: async (req) => {
        calls.push(req);
        if (req.dimensionFilter) {
          return [{ rows: [{ dimensionValues: [{ value: 'google' }], metricValues: [{ value: '1' }] }] }];
        }
        return [
          {
            rows: [
              { dimensionValues: [{ value: 'google' }], metricValues: [{ value: '3' }] },
              { dimensionValues: [{ value: 'linkedin.com' }], metricValues: [{ value: '1' }] },
              { dimensionValues: [{ value: 'lnkd.in' }], metricValues: [{ value: '1' }] },
              { dimensionValues: [{ value: '(direct)' }], metricValues: [{ value: '4' }] },
            ],
          },
        ];
      },
    };
    const out = await compareWithGa(createPostgresEngine(pool), fake, '123', day, day);
    expect(calls[0]).toMatchObject({ property: 'properties/123', dateRanges: [{ startDate: day, endDate: day }] });
    const by = Object.fromEntries(out.rows.map((r) => [r.source, r]));
    expect(by.Google).toEqual({ source: 'Google', ours_new_users: 1, ga_new_users: 3, ours_exporting_users: 1, ga_exporting_users: 1 });
    expect(by.LinkedIn).toMatchObject({ ours_new_users: 1, ga_new_users: 2 });
    expect(by.Direct).toMatchObject({ ours_new_users: 0, ga_new_users: 4 });
    expect(out.totals).toMatchObject({ ours_new_users: 2, ga_new_users: 9 });
  });

  it('returns 409 from the API when GA is not configured', async () => {
    const res = await request(app()).get('/api/ga/compare?from=2026-11-01&to=2026-11-02');
    expect(res.status).toBe(409);
  });
});
