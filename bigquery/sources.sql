-- Which source brings users who actually export a CSV?
--
-- Cohort:    anonymous IDs whose first ever visit falls in [@from_ts, @to_ts).
-- Source:    first touch, the source of that first visit.
-- Activated: exported a CSV (QuickBooks or full) with at least one real receipt in it.
--            Exports made only from the built-in sample receipts do not count.
--
-- {{events_table}} is replaced with the fully qualified table, for example `my-project.trailmark.events`.
-- Streaming inserts are de-duplicated on event_id in the first CTE.

WITH events AS (
  SELECT *
  FROM {{events_table}}
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY received_at, event_pk) = 1
),
first_visit AS (
  SELECT anonymous_id, IFNULL(source, 'Direct') AS source, occurred_at AS first_seen
  FROM events
  WHERE name = 'visit'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY anonymous_id ORDER BY occurred_at, event_pk) = 1
),
cohort AS (
  SELECT * FROM first_visit WHERE first_seen >= @from_ts AND first_seen < @to_ts
),
per_user AS (
  SELECT
    c.anonymous_id,
    c.source,
    c.first_seen,
    MIN(IF(e.name = 'upload' AND JSON_VALUE(e.properties, '$.sample') = 'true', e.occurred_at, NULL)) AS first_sample_upload,
    MIN(IF(e.name = 'upload' AND JSON_VALUE(e.properties, '$.sample') = 'false', e.occurred_at, NULL)) AS first_real_upload,
    MIN(IF(e.name = 'export' AND SAFE_CAST(JSON_VALUE(e.properties, '$.real_rows') AS INT64) > 0, e.occurred_at, NULL)) AS first_real_export,
    COUNTIF(e.name = 'export' AND SAFE_CAST(JSON_VALUE(e.properties, '$.real_rows') AS INT64) > 0) AS real_exports
  FROM cohort AS c
  LEFT JOIN events AS e
    ON e.anonymous_id = c.anonymous_id
   AND e.occurred_at >= c.first_seen
   AND e.name IN ('upload', 'export')
  GROUP BY c.anonymous_id, c.source, c.first_seen
),
-- PERCENTILE_CONT interpolates like PostgreSQL's percentile_cont, so both engines report the same median.
medians AS (
  SELECT DISTINCT
    source,
    PERCENTILE_CONT(TIMESTAMP_DIFF(first_real_export, first_seen, MILLISECOND) / 1000, 0.5) OVER (PARTITION BY source)
      AS median_seconds_to_export
  FROM per_user
)
SELECT
  p.source,
  COUNT(*) AS visitors,
  COUNT(p.first_sample_upload) AS tried_samples,
  COUNT(p.first_real_upload) AS uploaders,
  COUNT(p.first_real_export) AS exporters,
  SUM(p.real_exports) AS exports,
  ANY_VALUE(m.median_seconds_to_export) AS median_seconds_to_export
FROM per_user AS p
JOIN medians AS m ON m.source = p.source
GROUP BY p.source
ORDER BY visitors DESC, p.source
