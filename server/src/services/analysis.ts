import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import type { Config } from '../config.js';
import type { Pool } from '../db.js';

export interface Range {
  from: Date;
  to: Date;
}

export interface SourceRow {
  source: string;
  visitors: number;
  tried_samples: number;
  uploaders: number;
  exporters: number;
  exports: number;
  median_seconds_to_export: number | null;
}

export interface WeeklyRow {
  week: string;
  source: string;
  visitors: number;
  exporters: number;
}

export interface CompareRow {
  source: string;
  new_users: number;
  exporting_users: number;
}

export interface AnalysisEngine {
  name: 'bigquery' | 'postgres';
  sources(range: Range): Promise<SourceRow[]>;
  weekly(range: Range): Promise<WeeklyRow[]>;
  compare(range: Range): Promise<CompareRow[]>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Finds a folder by walking up from this file, so it works from src/ (tsx) and dist/src/ (tsc). */
function findDir(...segments: string[]): string {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ...segments);
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`folder ${segments.join('/')} not found above ${here}`);
}

function readSql(dir: string, file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

function normalizeSources(rows: Record<string, unknown>[]): SourceRow[] {
  return rows.map((r) => ({
    source: String(r.source),
    visitors: num(r.visitors),
    tried_samples: num(r.tried_samples),
    uploaders: num(r.uploaders),
    exporters: num(r.exporters),
    exports: num(r.exports),
    median_seconds_to_export: numOrNull(r.median_seconds_to_export),
  }));
}

function normalizeWeekly(rows: Record<string, unknown>[]): WeeklyRow[] {
  return rows.map((r) => ({
    week: String(r.week),
    source: String(r.source),
    visitors: num(r.visitors),
    exporters: num(r.exporters),
  }));
}

function normalizeCompare(rows: Record<string, unknown>[]): CompareRow[] {
  return rows.map((r) => ({
    source: String(r.source),
    new_users: num(r.new_users),
    exporting_users: num(r.exporting_users),
  }));
}

export function createPostgresEngine(pool: Pool): AnalysisEngine {
  const dir = findDir('sql');
  const sql = {
    sources: readSql(dir, 'sources.sql'),
    weekly: readSql(dir, 'weekly.sql'),
    compare: readSql(dir, 'ga_compare.sql'),
  };
  const run = async (text: string, range: Range) => (await pool.query(text, [range.from, range.to])).rows;
  return {
    name: 'postgres',
    sources: async (range) => normalizeSources(await run(sql.sources, range)),
    weekly: async (range) => normalizeWeekly(await run(sql.weekly, range)),
    compare: async (range) => normalizeCompare(await run(sql.compare, range)),
  };
}

const IDENTIFIER = /^[A-Za-z0-9_-]+$/;

/** Inserts the fully qualified, backticked table name. Identifiers are validated because they cannot be query parameters. */
export function renderBigQuerySql(template: string, projectId: string, dataset: string, table: string): string {
  for (const [label, value] of [
    ['project', projectId],
    ['dataset', dataset],
    ['table', table],
  ] as const) {
    if (!IDENTIFIER.test(value)) throw new Error(`invalid BigQuery ${label} name: ${value}`);
  }
  return template.split('{{events_table}}').join(`\`${projectId}.${dataset}.${table}\``);
}

export function createBigQueryEngine(cfg: Config['bigquery']): AnalysisEngine {
  const dir = findDir('bigquery');
  const render = (file: string) => renderBigQuerySql(readSql(dir, file), cfg.projectId, cfg.dataset, cfg.table);
  const sql = { sources: render('sources.sql'), weekly: render('weekly.sql'), compare: render('ga_compare.sql') };
  const client = new BigQuery({ projectId: cfg.projectId, location: cfg.location });
  const run = async (query: string, range: Range) => {
    const [rows] = await client.query({
      query,
      location: cfg.location,
      params: { from_ts: range.from, to_ts: range.to },
      types: { from_ts: 'TIMESTAMP', to_ts: 'TIMESTAMP' },
      useLegacySql: false,
    });
    return rows as Record<string, unknown>[];
  };
  return {
    name: 'bigquery',
    sources: async (range) => normalizeSources(await run(sql.sources, range)),
    weekly: async (range) => normalizeWeekly(await run(sql.weekly, range)),
    compare: async (range) => normalizeCompare(await run(sql.compare, range)),
  };
}

export function createEngine(pool: Pool, config: Config): AnalysisEngine {
  const wanted = (process.env.ANALYSIS_ENGINE ?? '').trim().toLowerCase();
  if (wanted === 'postgres' || !config.bigquery.enabled) return createPostgresEngine(pool);
  return createBigQueryEngine(config.bigquery);
}

/** 95% Wilson score interval for a proportion. Honest error bars for small source counts. */
export function wilson(successes: number, total: number, z = 1.96): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** Adds rates and intervals to the raw source rows. */
export function enrichSources(rows: SourceRow[]) {
  return rows.map((r) => {
    const ci = wilson(r.exporters, r.visitors);
    return {
      ...r,
      upload_rate: r.visitors ? r.uploaders / r.visitors : 0,
      export_rate: r.visitors ? r.exporters / r.visitors : 0,
      export_rate_low: ci.low,
      export_rate_high: ci.high,
      upload_to_export_rate: r.uploaders ? r.exporters / r.uploaders : 0,
    };
  });
}

// ---------- Operational queries, always served from PostgreSQL ----------

export async function getEventCounts(pool: Pool, range: Range) {
  const { rows } = await pool.query(
    `SELECT name, COUNT(*)::int AS events, COUNT(DISTINCT anonymous_id)::int AS users, MAX(occurred_at) AS last_seen
     FROM events WHERE occurred_at >= $1 AND occurred_at < $2
     GROUP BY name ORDER BY events DESC, name`,
    [range.from, range.to],
  );
  return rows;
}

export async function getRecentEvents(pool: Pool, range: Range, name: string | null, limit: number) {
  const { rows } = await pool.query(
    `SELECT event_id, name, anonymous_id, occurred_at, received_at, page_path, source, referrer_host,
            utm_source, utm_medium, utm_campaign, properties
     FROM events
     WHERE occurred_at >= $1 AND occurred_at < $2 AND ($3::text IS NULL OR name = $3)
     ORDER BY occurred_at DESC, id DESC LIMIT $4`,
    [range.from, range.to, name, limit],
  );
  return rows;
}

function bucketUnit(range: Range): 'hour' | 'day' {
  return range.to.getTime() - range.from.getTime() <= 2 * 24 * 3600 * 1000 ? 'hour' : 'day';
}

export async function getQuality(pool: Pool, range: Range) {
  const unit = bucketUnit(range);
  const [totals, series, reasons, samples, freshness, orphans] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(accepted), 0)::int AS accepted,
              COALESCE(SUM(duplicates), 0)::int AS duplicates,
              COALESCE(SUM(rejected), 0)::int AS rejected,
              COUNT(*)::int AS batches
       FROM ingest_batches WHERE received_at >= $1 AND received_at < $2`,
      [range.from, range.to],
    ),
    pool.query(
      `WITH buckets AS (
         SELECT generate_series(date_trunc('${unit}', $1::timestamptz), $2::timestamptz - interval '1 microsecond',
                                interval '1 ${unit}') AS bucket
       ),
       agg AS (
         SELECT date_trunc('${unit}', received_at) AS bucket,
                SUM(accepted)::int AS accepted, SUM(duplicates)::int AS duplicates, SUM(rejected)::int AS rejected
         FROM ingest_batches WHERE received_at >= $1 AND received_at < $2 GROUP BY 1
       )
       SELECT b.bucket, COALESCE(a.accepted, 0) AS accepted, COALESCE(a.duplicates, 0) AS duplicates,
              COALESCE(a.rejected, 0) AS rejected
       FROM buckets b LEFT JOIN agg a USING (bucket) ORDER BY b.bucket`,
      [range.from, range.to],
    ),
    pool.query(
      `SELECT reason, COUNT(*)::int AS events, MAX(received_at) AS last_seen
       FROM rejected_events WHERE received_at >= $1 AND received_at < $2
       GROUP BY reason ORDER BY events DESC, reason`,
      [range.from, range.to],
    ),
    pool.query(
      `SELECT id, received_at, reason, details, payload
       FROM rejected_events WHERE received_at >= $1 AND received_at < $2
       ORDER BY received_at DESC, id DESC LIMIT 20`,
      [range.from, range.to],
    ),
    pool.query(
      `SELECT MAX(received_at) AS last_received_at,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM received_at - occurred_at))::float8 AS median_lag_seconds,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM received_at - occurred_at))::float8 AS p95_lag_seconds
       FROM events WHERE received_at >= $1 AND received_at < $2`,
      [range.from, range.to],
    ),
    // IDs that uploaded or exported without any recorded visit point at a tracking gap.
    pool.query(
      `SELECT COUNT(DISTINCT e.anonymous_id)::int AS ids_without_visit
       FROM events e
       WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND e.name <> 'visit'
         AND NOT EXISTS (SELECT 1 FROM events v WHERE v.anonymous_id = e.anonymous_id AND v.name = 'visit')`,
      [range.from, range.to],
    ),
  ]);
  return {
    unit,
    totals: totals.rows[0],
    series: series.rows,
    reasons: reasons.rows,
    samples: samples.rows,
    freshness: freshness.rows[0],
    idsWithoutVisit: orphans.rows[0]?.ids_without_visit ?? 0,
  };
}

export async function getSyncStatus(pool: Pool) {
  const [state, total, deletions] = await Promise.all([
    pool.query(
      `SELECT s.destination, s.last_event_pk, s.rows_synced, s.last_synced_at, s.last_error, s.last_error_at,
              (SELECT COUNT(*)::int FROM events e WHERE e.id > s.last_event_pk) AS pending
       FROM sync_state s ORDER BY s.destination`,
    ),
    pool.query('SELECT COUNT(*)::int AS events FROM events'),
    pool.query('SELECT COUNT(*)::int AS pending FROM deletion_requests WHERE warehouse_deleted_at IS NULL'),
  ]);
  return {
    destinations: state.rows,
    totalEvents: total.rows[0]?.events ?? 0,
    pendingDeletions: deletions.rows[0]?.pending ?? 0,
  };
}
