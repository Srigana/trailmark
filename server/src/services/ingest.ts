import type { Pool } from '../db.js';
import { classifySource } from './sources.js';
import { validateEvent, type IncomingEvent, type RejectionReason, type ValidationIssue } from './validation.js';

export const MAX_BATCH_SIZE = 100;

/**
 * Every transaction that inserts events holds this advisory lock in shared mode. The BigQuery
 * export takes it exclusively for an instant to find the highest id that is safe to export:
 * once it holds the lock, every id handed out so far belongs to a committed or rolled back
 * transaction. See exportHorizon in bigquery.ts.
 */
export const EVENT_WRITE_LOCK = 727002;

export interface IngestOptions {
  /** Server time used for timestamp checks and stored as received_at. */
  now?: Date;
  maxAgeMs: number;
  maxFutureSkewMs: number;
  /** Shoebox's own hostnames, so internal navigation is not counted as a referral. */
  siteHosts: string[];
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: RejectionReason; issues: ValidationIssue[] }[];
}

/**
 * Validates and stores a batch. Valid events are inserted idempotently on event_id,
 * invalid ones go to rejected_events, and a summary row goes to ingest_batches.
 * One transaction, so the counts always match the stored rows.
 */
export async function ingestBatch(pool: Pool, rawEvents: unknown[], opts: IngestOptions): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const rules = { now, maxAgeMs: opts.maxAgeMs, maxFutureSkewMs: opts.maxFutureSkewMs };

  const valid: { event: IncomingEvent; occurredAt: Date }[] = [];
  const rejected: IngestResult['rejected'] = [];
  const rejectedPayloads: unknown[] = [];
  const seen = new Set<string>();
  let inBatchDuplicates = 0;

  rawEvents.forEach((raw, index) => {
    const result = validateEvent(raw, rules);
    if (!result.ok) {
      rejected.push({ index, reason: result.reason, issues: result.issues });
      rejectedPayloads.push(raw);
      return;
    }
    if (seen.has(result.event.event_id)) {
      inBatchDuplicates += 1;
      return;
    }
    seen.add(result.event.event_id);
    valid.push({ event: result.event, occurredAt: result.occurredAt });
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [EVENT_WRITE_LOCK]);

    let inserted = 0;
    if (valid.length > 0) {
      const c = {
        eventId: [] as string[],
        name: [] as string[],
        anonymousId: [] as string[],
        occurredAt: [] as Date[],
        pagePath: [] as (string | null)[],
        referrerHost: [] as (string | null)[],
        utmSource: [] as (string | null)[],
        utmMedium: [] as (string | null)[],
        utmCampaign: [] as (string | null)[],
        source: [] as (string | null)[],
        properties: [] as string[],
      };
      for (const { event, occurredAt } of valid) {
        const ctx = event.context ?? {};
        // Attribution only means something on the landing visit.
        const isVisit = event.name === 'visit';
        const referrerHost = isVisit ? (ctx.referrer_host?.toLowerCase() ?? null) : null;
        const utmSource = isVisit ? (ctx.utm_source ?? null) : null;
        const utmMedium = isVisit ? (ctx.utm_medium ?? null) : null;
        c.eventId.push(event.event_id);
        c.name.push(event.name);
        c.anonymousId.push(event.anonymous_id);
        c.occurredAt.push(occurredAt);
        c.pagePath.push(ctx.page_path ?? null);
        c.referrerHost.push(referrerHost);
        c.utmSource.push(utmSource);
        c.utmMedium.push(utmMedium);
        c.utmCampaign.push(isVisit ? (ctx.utm_campaign ?? null) : null);
        c.source.push(isVisit ? classifySource({ utmSource, utmMedium, referrerHost }, opts.siteHosts) : null);
        c.properties.push(JSON.stringify(event.properties ?? {}));
      }
      const res = await client.query(
        `INSERT INTO events (event_id, name, anonymous_id, occurred_at, page_path, referrer_host,
                             utm_source, utm_medium, utm_campaign, source, properties, received_at)
         SELECT u.*, $12::timestamptz
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[], $10::text[], $11::jsonb[]) AS u
         ON CONFLICT (event_id) DO NOTHING`,
        [
          c.eventId,
          c.name,
          c.anonymousId,
          c.occurredAt,
          c.pagePath,
          c.referrerHost,
          c.utmSource,
          c.utmMedium,
          c.utmCampaign,
          c.source,
          c.properties,
          now,
        ],
      );
      inserted = res.rowCount ?? 0;
    }

    if (rejected.length > 0) {
      await client.query(
        `INSERT INTO rejected_events (reason, details, payload, received_at)
         SELECT r, d, p, $4::timestamptz FROM unnest($1::text[], $2::jsonb[], $3::jsonb[]) AS t(r, d, p)`,
        [
          rejected.map((r) => r.reason),
          rejected.map((r) => JSON.stringify(r.issues)),
          rejectedPayloads.map((p) => JSON.stringify(p === undefined ? null : p)),
          now,
        ],
      );
    }

    const duplicates = inBatchDuplicates + (valid.length - inserted);
    await client.query(
      'INSERT INTO ingest_batches (received_at, accepted, duplicates, rejected) VALUES ($1, $2, $3, $4)',
      [now, inserted, duplicates, rejected.length],
    );

    await client.query('COMMIT');
    return { accepted: inserted, duplicates, rejected };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deletes every event for one anonymous ID and records the request so the BigQuery sync
 * can delete the exported copies too. Rejected payloads carrying the ID are removed as well.
 */
export async function deleteActor(pool: Pool, anonymousId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query('DELETE FROM events WHERE anonymous_id = $1', [anonymousId]);
    await client.query("DELETE FROM rejected_events WHERE payload->>'anonymous_id' = $1", [anonymousId]);
    const deleted = res.rowCount ?? 0;
    await client.query('INSERT INTO deletion_requests (anonymous_id, rows_deleted) VALUES ($1, $2)', [
      anonymousId,
      deleted,
    ]);
    await client.query('COMMIT');
    return deleted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
