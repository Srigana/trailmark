-- Our side of the Google Analytics comparison, shaped like the GA4 report it is compared with:
--   new_users       IDs whose first ever visit is in [@from_ts, @to_ts)       (GA4: newUsers by firstUserSource)
--   exporting_users IDs with any export event in [@from_ts, @to_ts),
--                   grouped by the source of their first visit                 (GA4: totalUsers, eventName = export)

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
new_users AS (
  SELECT source, COUNT(*) AS new_users
  FROM first_visit
  WHERE first_seen >= @from_ts AND first_seen < @to_ts
  GROUP BY source
),
exporting AS (
  SELECT IFNULL(f.source, '(no visit recorded)') AS source, COUNT(DISTINCT e.anonymous_id) AS exporting_users
  FROM events AS e
  LEFT JOIN first_visit AS f USING (anonymous_id)
  WHERE e.name = 'export' AND e.occurred_at >= @from_ts AND e.occurred_at < @to_ts
  GROUP BY 1
)
SELECT
  source,
  IFNULL(n.new_users, 0) AS new_users,
  IFNULL(x.exporting_users, 0) AS exporting_users
FROM new_users AS n
FULL OUTER JOIN exporting AS x USING (source)
ORDER BY new_users DESC, source
