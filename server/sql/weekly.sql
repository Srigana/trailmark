-- PostgreSQL version of bigquery/weekly.sql. Keep the two in step.
-- $1 from, $2 to. The connection runs in UTC, so weeks start Monday 00:00 UTC.

WITH first_visit AS (
  SELECT DISTINCT ON (anonymous_id) anonymous_id, COALESCE(source, 'Direct') AS source, occurred_at AS first_seen
  FROM events
  WHERE name = 'visit'
  ORDER BY anonymous_id, occurred_at, id
),
cohort AS (
  SELECT * FROM first_visit WHERE first_seen >= $1 AND first_seen < $2
),
activated AS (
  SELECT DISTINCT c.anonymous_id
  FROM cohort AS c
  JOIN events AS e
    ON e.anonymous_id = c.anonymous_id
   AND e.occurred_at >= c.first_seen
   AND e.name = 'export'
   AND (e.properties->>'real_rows')::int > 0
)
SELECT
  to_char(date_trunc('week', c.first_seen), 'YYYY-MM-DD') AS week,
  c.source,
  COUNT(*)::int AS visitors,
  COUNT(a.anonymous_id)::int AS exporters
FROM cohort AS c
LEFT JOIN activated AS a USING (anonymous_id)
GROUP BY 1, 2
ORDER BY 1, 2
