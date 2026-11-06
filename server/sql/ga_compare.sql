-- PostgreSQL version of bigquery/ga_compare.sql. Keep the two in step.
-- $1 from, $2 to.

WITH first_visit AS (
  SELECT DISTINCT ON (anonymous_id) anonymous_id, COALESCE(source, 'Direct') AS source, occurred_at AS first_seen
  FROM events
  WHERE name = 'visit'
  ORDER BY anonymous_id, occurred_at, id
),
new_users AS (
  SELECT source, COUNT(*)::int AS new_users
  FROM first_visit
  WHERE first_seen >= $1 AND first_seen < $2
  GROUP BY source
),
exporting AS (
  SELECT COALESCE(f.source, '(no visit recorded)') AS source, COUNT(DISTINCT e.anonymous_id)::int AS exporting_users
  FROM events AS e
  LEFT JOIN first_visit AS f USING (anonymous_id)
  WHERE e.name = 'export' AND e.occurred_at >= $1 AND e.occurred_at < $2
  GROUP BY 1
)
SELECT
  source,
  COALESCE(n.new_users, 0) AS new_users,
  COALESCE(x.exporting_users, 0) AS exporting_users
FROM new_users AS n
FULL OUTER JOIN exporting AS x USING (source)
ORDER BY new_users DESC, source
