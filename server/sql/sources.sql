-- PostgreSQL version of bigquery/sources.sql. Keep the two in step.
-- $1 from, $2 to.

WITH first_visit AS (
  SELECT DISTINCT ON (anonymous_id) anonymous_id, COALESCE(source, 'Direct') AS source, occurred_at AS first_seen
  FROM events
  WHERE name = 'visit'
  ORDER BY anonymous_id, occurred_at, id
),
cohort AS (
  SELECT * FROM first_visit WHERE first_seen >= $1 AND first_seen < $2
),
per_user AS (
  SELECT
    c.anonymous_id,
    c.source,
    c.first_seen,
    MIN(e.occurred_at) FILTER (WHERE e.name = 'upload' AND e.properties->>'sample' = 'true') AS first_sample_upload,
    MIN(e.occurred_at) FILTER (WHERE e.name = 'upload' AND e.properties->>'sample' = 'false') AS first_real_upload,
    MIN(e.occurred_at) FILTER (WHERE e.name = 'export' AND (e.properties->>'real_rows')::int > 0) AS first_real_export,
    COUNT(*) FILTER (WHERE e.name = 'export' AND (e.properties->>'real_rows')::int > 0) AS real_exports
  FROM cohort AS c
  LEFT JOIN events AS e
    ON e.anonymous_id = c.anonymous_id
   AND e.occurred_at >= c.first_seen
   AND e.name IN ('upload', 'export')
  GROUP BY c.anonymous_id, c.source, c.first_seen
)
SELECT
  source,
  COUNT(*)::int AS visitors,
  COUNT(first_sample_upload)::int AS tried_samples,
  COUNT(first_real_upload)::int AS uploaders,
  COUNT(first_real_export)::int AS exporters,
  COALESCE(SUM(real_exports), 0)::int AS exports,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM first_real_export - first_seen)))::float8
    AS median_seconds_to_export
FROM per_user
GROUP BY source
ORDER BY visitors DESC, source
