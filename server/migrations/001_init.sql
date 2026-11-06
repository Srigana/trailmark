-- Accepted Shoebox events. event_id is the client generated idempotency key.
CREATE TABLE events (
  id             BIGSERIAL PRIMARY KEY,
  event_id       UUID        NOT NULL UNIQUE,
  name           TEXT        NOT NULL,
  anonymous_id   TEXT        NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  page_path      TEXT,
  -- Attribution, sent with visit events only. Raw values are kept so sources can be reclassified later.
  referrer_host  TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  source         TEXT,
  properties     JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX events_occurred_at_idx ON events (occurred_at);
CREATE INDEX events_name_occurred_at_idx ON events (name, occurred_at);
CREATE INDEX events_actor_occurred_at_idx ON events (anonymous_id, occurred_at, id);
CREATE INDEX events_received_at_idx ON events (received_at);

-- Events that failed validation, kept so broken instrumentation is visible.
CREATE TABLE rejected_events (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT        NOT NULL,
  details      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  payload      JSONB       NOT NULL
);

CREATE INDEX rejected_events_received_at_idx ON rejected_events (received_at);

-- One row per ingest request, used for data quality reporting.
CREATE TABLE ingest_batches (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted     INTEGER     NOT NULL,
  duplicates   INTEGER     NOT NULL,
  rejected     INTEGER     NOT NULL
);

CREATE INDEX ingest_batches_received_at_idx ON ingest_batches (received_at);

-- Export watermarks for downstream destinations such as BigQuery.
CREATE TABLE sync_state (
  destination     TEXT PRIMARY KEY,
  last_event_pk   BIGINT      NOT NULL DEFAULT 0,
  rows_synced     BIGINT      NOT NULL DEFAULT 0,
  last_synced_at  TIMESTAMPTZ,
  last_error      TEXT,
  last_error_at   TIMESTAMPTZ
);

-- "Delete my data" requests. Rows are removed from PostgreSQL immediately; the BigQuery
-- sync replays each request against the warehouse and stamps warehouse_deleted_at.
CREATE TABLE deletion_requests (
  id                    BIGSERIAL PRIMARY KEY,
  anonymous_id          TEXT        NOT NULL,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows_deleted          INTEGER     NOT NULL,
  warehouse_deleted_at  TIMESTAMPTZ
);

CREATE INDEX deletion_requests_pending_idx ON deletion_requests (id) WHERE warehouse_deleted_at IS NULL;
