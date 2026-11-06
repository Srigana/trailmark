import { BigQuery, type TableField } from '@google-cloud/bigquery';
import type { Config } from '../config.js';
import type { Pool } from '../db.js';
import { EVENT_WRITE_LOCK } from './ingest.js';

/** Row shape written to BigQuery. Mirrors bigquery/schema.json. */
export interface WarehouseRow {
  event_pk: number;
  event_id: string;
  name: string;
  anonymous_id: string;
  occurred_at: string;
  received_at: string;
  page_path: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  source: string | null;
  properties: string;
}

export interface WarehouseSink {
  ensureTable(): Promise<void>;
  insert(rows: WarehouseRow[]): Promise<void>;
  /** Deletes every row for these IDs. Must be safe to call repeatedly. */
  deleteActors(anonymousIds: string[]): Promise<void>;
}

export const BIGQUERY_SCHEMA: TableField[] = [
  { name: 'event_pk', type: 'INT64', mode: 'REQUIRED', description: 'Primary key in PostgreSQL' },
  { name: 'event_id', type: 'STRING', mode: 'REQUIRED', description: 'Client generated idempotency key' },
  { name: 'name', type: 'STRING', mode: 'REQUIRED', description: 'visit, upload, upload_failed or export' },
  { name: 'anonymous_id', type: 'STRING', mode: 'REQUIRED', description: 'Random per-browser ID (shoebox.cid)' },
  { name: 'occurred_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'received_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'page_path', type: 'STRING', mode: 'NULLABLE' },
  { name: 'referrer_host', type: 'STRING', mode: 'NULLABLE', description: 'Visit events only' },
  { name: 'utm_source', type: 'STRING', mode: 'NULLABLE', description: 'Visit events only' },
  { name: 'utm_medium', type: 'STRING', mode: 'NULLABLE', description: 'Visit events only' },
  { name: 'utm_campaign', type: 'STRING', mode: 'NULLABLE', description: 'Visit events only' },
  { name: 'source', type: 'STRING', mode: 'NULLABLE', description: 'Classified source label, visit events only' },
  { name: 'properties', type: 'JSON', mode: 'NULLABLE' },
];

export function createBigQuerySink(cfg: Config['bigquery']): WarehouseSink {
  const client = new BigQuery({ projectId: cfg.projectId, location: cfg.location });
  const dataset = client.dataset(cfg.dataset);
  const table = dataset.table(cfg.table);
  const fqn = `\`${cfg.projectId}.${cfg.dataset}.${cfg.table}\``;
  return {
    async ensureTable() {
      const [datasetExists] = await dataset.exists();
      if (!datasetExists) await dataset.create({ location: cfg.location });
      const [tableExists] = await table.exists();
      if (!tableExists) {
        await dataset.createTable(cfg.table, {
          schema: { fields: BIGQUERY_SCHEMA },
          timePartitioning: { type: 'DAY', field: 'occurred_at' },
          clustering: { fields: ['name', 'anonymous_id'] },
          description: 'Shoebox events exported from the Trailmark collector',
        });
      }
    },
    async insert(rows) {
      // insertId gives best effort de-duplication if a batch is retried after a partial failure.
      // The analysis queries also de-duplicate on event_id, so a retry can never double count.
      await table.insert(
        rows.map((row) => ({ insertId: row.event_id, json: row })),
        { raw: true },
      );
    },
    async deleteActors(ids) {
      if (ids.length === 0) return;
      await client.query({
        query: `DELETE FROM ${fqn} WHERE anonymous_id IN UNNEST(@ids)`,
        params: { ids },
        types: { ids: ['STRING'] },
        location: cfg.location,
      });
    },
  };
}

interface SyncOptions {
  destination: string;
  batchSize: number;
  maxBatches?: number;
  /** How long to wait for in-flight inserts when computing the export horizon. */
  lockTimeoutMs?: number;
}

/**
 * Highest event id that can never be followed by a lower id committing later.
 *
 * BIGSERIAL ids are handed out before commit, so a slow transaction can commit id 5 after id 6
 * is already visible. A plain "id > watermark" export would then skip 5 forever. Inserts hold
 * EVENT_WRITE_LOCK in shared mode; taking it exclusively waits for every in-flight insert to
 * finish, so every id assigned up to that moment is settled and later ids will be larger.
 */
export async function exportHorizon(pool: Pool, lockTimeoutMs = 10_000): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
    await client.query('SELECT pg_advisory_xact_lock($1)', [EVENT_WRITE_LOCK]);
    const { rows } = await client.query<{ horizon: string }>(
      "SELECT COALESCE(pg_sequence_last_value('events_id_seq'::regclass), 0) AS horizon",
    );
    await client.query('COMMIT');
    return Number(rows[0]?.horizon ?? 0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface SyncResult {
  rows: number;
  batches: number;
  lastEventPk: number;
  deletionsApplied: number;
  deletionsPending: number;
}

interface EventRow {
  id: string;
  event_id: string;
  name: string;
  anonymous_id: string;
  occurred_at: Date;
  received_at: Date;
  page_path: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  source: string | null;
  properties: Record<string, unknown>;
}

/**
 * Applies pending "delete my data" requests to the warehouse. BigQuery refuses DML on rows
 * still in the streaming buffer (up to about 90 minutes after insert), so a failed request
 * stays pending and is retried on the next run. Returns [applied, stillPending].
 */
async function applyDeletions(pool: Pool, sink: WarehouseSink): Promise<[number, number]> {
  const { rows } = await pool.query<{ id: string; anonymous_id: string }>(
    'SELECT id, anonymous_id FROM deletion_requests WHERE warehouse_deleted_at IS NULL ORDER BY id LIMIT 500',
  );
  if (rows.length === 0) return [0, 0];
  try {
    await sink.deleteActors([...new Set(rows.map((r) => r.anonymous_id))]);
  } catch (err) {
    console.warn(`[sync] warehouse delete deferred: ${(err as Error).message}`);
    return [0, rows.length];
  }
  await pool.query('UPDATE deletion_requests SET warehouse_deleted_at = now() WHERE id = ANY($1::bigint[])', [
    rows.map((r) => r.id),
  ]);
  return [rows.length, 0];
}

/** Copies events past the watermark into the sink, batch by batch, then replays deletions. */
export async function syncEvents(pool: Pool, sink: WarehouseSink, opts: SyncOptions): Promise<SyncResult> {
  await pool.query('INSERT INTO sync_state (destination) VALUES ($1) ON CONFLICT (destination) DO NOTHING', [
    opts.destination,
  ]);

  const result: SyncResult = { rows: 0, batches: 0, lastEventPk: 0, deletionsApplied: 0, deletionsPending: 0 };
  try {
    await sink.ensureTable();
    const horizon = await exportHorizon(pool, opts.lockTimeoutMs);
    for (;;) {
      const state = await pool.query<{ last_event_pk: string }>(
        'SELECT last_event_pk FROM sync_state WHERE destination = $1',
        [opts.destination],
      );
      const watermark = Number(state.rows[0]?.last_event_pk ?? 0);
      result.lastEventPk = watermark;

      const { rows } = await pool.query<EventRow>(
        `SELECT id, event_id, name, anonymous_id, occurred_at, received_at, page_path, referrer_host,
                utm_source, utm_medium, utm_campaign, source, properties
         FROM events
         WHERE id > $1 AND id <= $3
         ORDER BY id
         LIMIT $2`,
        [watermark, opts.batchSize, horizon],
      );
      if (rows.length === 0) break;

      await sink.insert(
        rows.map((r) => ({
          event_pk: Number(r.id),
          event_id: r.event_id,
          name: r.name,
          anonymous_id: r.anonymous_id,
          occurred_at: r.occurred_at.toISOString(),
          received_at: r.received_at.toISOString(),
          page_path: r.page_path,
          referrer_host: r.referrer_host,
          utm_source: r.utm_source,
          utm_medium: r.utm_medium,
          utm_campaign: r.utm_campaign,
          source: r.source,
          properties: JSON.stringify(r.properties ?? {}),
        })),
      );

      const lastPk = Number(rows[rows.length - 1]!.id);
      await pool.query(
        `UPDATE sync_state
         SET last_event_pk = $2, rows_synced = rows_synced + $3, last_synced_at = now(), last_error = NULL
         WHERE destination = $1`,
        [opts.destination, lastPk, rows.length],
      );
      result.rows += rows.length;
      result.batches += 1;
      result.lastEventPk = lastPk;

      if (rows.length < opts.batchSize) break;
      if (opts.maxBatches !== undefined && result.batches >= opts.maxBatches) break;
    }

    [result.deletionsApplied, result.deletionsPending] = await applyDeletions(pool, sink);

    if (result.rows === 0) {
      await pool.query('UPDATE sync_state SET last_synced_at = now(), last_error = NULL WHERE destination = $1', [
        opts.destination,
      ]);
    }
    return result;
  } catch (err) {
    const message = describeError(err);
    await pool.query('UPDATE sync_state SET last_error = $2, last_error_at = now() WHERE destination = $1', [
      opts.destination,
      message.slice(0, 2000),
    ]);
    throw new Error(message);
  }
}

function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string; errors?: { errors?: { message?: string }[] }[] };
  if (e?.name === 'PartialFailureError' && Array.isArray(e.errors)) {
    const first = e.errors[0]?.errors?.[0]?.message ?? 'unknown row error';
    return `BigQuery rejected ${e.errors.length} row(s), first error: ${first}`;
  }
  return e?.message ?? String(err);
}
