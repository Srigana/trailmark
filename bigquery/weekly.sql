-- New visitors per week (by first visit) and how many of them went on to export real receipts.
-- Recent weeks are still maturing: their users have had less time to export.
-- Weeks start on Monday, in UTC.

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
activated AS (
  SELECT DISTINCT c.anonymous_id
  FROM cohort AS c
  JOIN events AS e
    ON e.anonymous_id = c.anonymous_id
   AND e.occurred_at >= c.first_seen
   AND e.name = 'export'
   AND SAFE_CAST(JSON_VALUE(e.properties, '$.real_rows') AS INT64) > 0
)
SELECT
  FORMAT_DATE('%F', DATE_TRUNC(DATE(c.first_seen), WEEK(MONDAY))) AS week,
  c.source,
  COUNT(*) AS visitors,
  COUNT(a.anonymous_id) AS exporters
FROM cohort AS c
LEFT JOIN activated AS a USING (anonymous_id)
GROUP BY week, c.source
ORDER BY week, c.source
