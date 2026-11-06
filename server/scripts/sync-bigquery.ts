/**
 * Exports events from PostgreSQL to BigQuery.
 *   npm run sync:bigquery            run once and exit
 *   npm run sync:bigquery -- --watch keep running, syncing every BIGQUERY_SYNC_INTERVAL_SECONDS (default 60)
 */
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { createBigQuerySink, syncEvents } from '../src/services/bigquery.js';

const config = loadConfig();
if (!config.bigquery.enabled) {
  console.error('BIGQUERY_PROJECT_ID is not set. Configure BigQuery in server/.env first.');
  process.exit(1);
}

const watch = process.argv.includes('--watch');
const intervalSeconds = Number(process.env.BIGQUERY_SYNC_INTERVAL_SECONDS ?? 60);
const pool = createPool(config.databaseUrl);
await migrate(pool);
const sink = createBigQuerySink(config.bigquery);
const destination = `bigquery:${config.bigquery.projectId}.${config.bigquery.dataset}.${config.bigquery.table}`;

async function runOnce(): Promise<void> {
  const started = Date.now();
  const result = await syncEvents(pool, sink, {
    destination,
    batchSize: config.bigquery.batchSize,
  });
  console.log(
    `[sync] ${result.rows} rows in ${result.batches} batch(es), watermark ${result.lastEventPk}, ` +
      `deletions applied ${result.deletionsApplied}, pending ${result.deletionsPending}, ${Date.now() - started}ms`,
  );
}

if (!watch) {
  try {
    await runOnce();
  } catch (err) {
    console.error('[sync] failed:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
} else {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await runOnce();
    } catch (err) {
      console.error('[sync] failed, will retry:', (err as Error).message);
    }
    for (let i = 0; i < intervalSeconds && !stopping; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await pool.end();
}
