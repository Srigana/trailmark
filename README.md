# Trailmark

Shows where Shoebox users come from and which of them actually use the app. The question it is built to answer:

> Which source brings users who actually export a CSV?

```
Shoebox (Next.js on Vercel)          Trailmark server (Node.js)            BigQuery
  web/lib/track.ts   --/collect-->     validate, dedupe, classify    -->    events table (partitioned)
  visit, upload,      (Vercel          source, store in PostgreSQL          sources.sql, weekly.sql,
  upload_failed,       proxy)          sync job exports every minute         ga_compare.sql
  export                               dashboard API  <-------------------  results
                                            |
                                     React dashboard  <-- GA4 Data API (optional comparison)
```

| Part | Where |
|---|---|
| 1. Tracker | `web/lib/track.ts` in Shoebox, delivered as `shoebox-analytics-tracker.patch` |
| 2. Server | `server/`: Express + PostgreSQL collector and dashboard API |
| 3. Analysis | `bigquery/*.sql` (BigQuery) with matching `server/sql/*.sql` (PostgreSQL fallback) |
| 4. Dashboard | `client/`: React, served by the server in production |
| 5. GA comparison | `server/src/services/ga.ts` and the Google Analytics page in the dashboard |

## Definitions

- **Source**: taken from the first visit of each browser. `utm_source` wins when present, otherwise the referring domain (google.com, lnkd.in, old.reddit.com and so on map to Google, LinkedIn, Reddit). No referrer is Direct. Rules live in `server/src/services/sources.ts` and are stored on each visit, with the raw referrer and UTM values kept so they can be reclassified.
- **Uploaded**: at least one of the visitor's own receipts was read. The three sample receipts do not count.
- **Exported a CSV**: downloaded either CSV with at least one of their own receipts in it. Sample-only exports do not count.
- **Visitor**: one browser (`shoebox.cid` in local storage). Shoebox has no accounts.

Rates on the dashboard come with 95% Wilson intervals, and sources with fewer than 30 visitors are greyed out, because a 2 of 5 is not a 40% conversion rate.

## Run it locally

Requires Node 20+ and PostgreSQL 14+.

```bash
npm install
createdb analytics                      # or use any PostgreSQL database
cp server/.env.example server/.env      # set DATABASE_URL
npm run seed                            # optional: 60 days of simulated demo traffic
npm run dev                             # API on :4000, dashboard on http://localhost:5173
```

`npm run seed` writes simulated data through the real ingest path. It refuses to run with `NODE_ENV=production` or on a database that already has events (use `-- --reset` to replace them). Never seed the production database.

To send real events from a local Shoebox, apply the patch and start Shoebox with:

```bash
COLLECTOR_URL=http://localhost:4000 NEXT_PUBLIC_COLLECTOR_WRITE_KEY=dev_write_key npm run dev
```

## Deploy

`render.yaml` defines one web service. It builds the server and the dashboard, applies migrations on start, and serves the dashboard at `/`.

1. Create a PostgreSQL database (a new Neon database works) and set `DATABASE_URL`.
2. Set `WRITE_KEYS` to a long random value, and `DASHBOARD_TOKEN` to a different one. The dashboard asks for the token on first load.
3. In Shoebox's Vercel project set `COLLECTOR_URL` to this service's URL and `NEXT_PUBLIC_COLLECTOR_WRITE_KEY` to the write key, then redeploy.
4. After the first real events arrive, check `TRUST_PROXY`: requests arrive through Vercel and the host's proxy, and the rate limiter should see visitor IPs, not proxy IPs.

## BigQuery

1. Create a service account with BigQuery Data Editor and BigQuery Job User on the project, and point `GOOGLE_APPLICATION_CREDENTIALS` at its key.
2. Set `BIGQUERY_PROJECT_ID` (and optionally `BIGQUERY_DATASET`, `BIGQUERY_TABLE`, `BIGQUERY_LOCATION`).
3. Run the export worker: `npm run sync:bigquery -- --watch`. It creates the dataset and a table partitioned by day and clustered by event name and browser ID, then streams new rows every minute. In production, run `node server/dist/scripts/sync-bigquery.js --watch` as a background worker with the same environment variables (on Render, upload the key as a secret file).

Once BigQuery is configured, the dashboard runs `bigquery/*.sql` there. Without it, the same questions run in PostgreSQL. Set `ANALYSIS_ENGINE=postgres` to force PostgreSQL.

How the export stays correct:

- **No skipped rows.** It advances a watermark on the PostgreSQL id. Ids are assigned before commit, so a slow insert can commit a lower id after a higher one is visible. Every insert holds an advisory lock in shared mode; the worker takes it exclusively for an instant and only exports up to the last id handed out at that moment, so nothing in flight can be passed over. Anything that writes to `events` must go through `ingestBatch` to keep this guarantee.
- **No double counting.** Streaming retries can duplicate rows, so every query de-duplicates on `event_id` first.
- **Deletes reach BigQuery.** "Delete my data" removes rows from PostgreSQL immediately and queues the ID. The worker then deletes it in BigQuery, retrying while rows are still in the streaming buffer (up to about 90 minutes).

The queries are plain SQL with `@from_ts` and `@to_ts` parameters, so you can paste them into the BigQuery console after replacing `{{events_table}}` with your table.

## Google Analytics comparison

1. In Shoebox set `NEXT_PUBLIC_GA_MEASUREMENT_ID`. The tracker then also sends `upload`, `upload_failed` and `export` to GA4, and the privacy policy shows a Google Analytics section. GA sets cookies; check whether your visitors' countries require a consent banner before turning it on.
2. Enable the Google Analytics Data API, give the service account Viewer access on the GA4 property, and set `GA_PROPERTY_ID` on the server.

The comparison page puts GA4 `newUsers` and export users (both by `firstUserSource`) next to the same counts from our data, with GA source names grouped by our rules. It also lists why the two never match exactly: blockers, consent, how a user is identified, attribution rules, time zones, thresholds and bot filtering.

## Data quality

Every event is validated against the tracking plan in `server/src/services/validation.ts`: known event names only, strict per-event properties, ISO timestamps no more than 5 minutes in the future or 72 hours in the past, and 8 KB maximum. Invalid events are stored in `rejected_events` with the reason, and duplicates (same `event_id`) are dropped and counted. The Data quality page shows rejection rate, reasons with payloads, delivery delay, browsers that uploaded without a recorded visit, and the BigQuery export state.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/batch` | write key | Ingest up to 100 events. Also accepts `text/plain` for `sendBeacon`. |
| POST | `/v1/delete` | write key | Delete all events for one `anonymous_id`. |
| GET | `/api/sources` | dashboard token | Sources report, totals and weekly cohorts. |
| GET | `/api/events/counts`, `/api/events/recent` | dashboard token | Event counts and the latest events. |
| GET | `/api/quality` | dashboard token | Ingest health and export state. |
| GET | `/api/ga/compare?from=YYYY-MM-DD&to=YYYY-MM-DD` | dashboard token | GA4 comparison. |
| GET | `/health` | none | Liveness. |

## Tests

```bash
createdb analytics_test   # used and wiped by the integration tests; override with TEST_DATABASE_URL
npm test
npm run typecheck
```

The tests cover source classification, validation, ingest and dedupe, first-touch attribution and sample exclusion in the SQL, deletion, the BigQuery export watermark and deletion replay (with a fake sink), and the GA comparison (with a fake GA client).

## Known limits

- One browser is one visitor. The same person on two devices counts twice.
- Visitors from before the tracker shipped get the source of their first visit after it shipped, usually Direct.
- Recent weekly cohorts look worse than older ones until their visitors have had time to export.
- Sessions that hit Shoebox while the collector is down are queued in the browser and retried on the next visit, for up to 72 hours.
