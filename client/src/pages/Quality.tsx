import { useMemo, type ReactNode } from 'react';
import { useApi, type QualityResponse } from '../api';
import { rangeQuery, useDays } from '../App';
import { BarChart, SERIES } from '../charts';
import { fmtAgo, fmtDateTime, fmtDay, fmtDuration, fmtInt, fmtPct } from '../format';
import { ErrorNote, Loading } from './common';

const REASONS: Record<string, string> = {
  unknown_event: 'Event name is not in the tracking plan',
  invalid_schema: 'Missing or malformed fields',
  payload_too_large: 'Event larger than 8 KB',
  timestamp_in_future: 'Timestamp ahead of server time (client clock wrong)',
  timestamp_too_old: 'Timestamp older than the allowed age (stale retry)',
};

export default function Quality() {
  const [days] = useDays();
  const query = useMemo(() => rangeQuery(days), [days]);
  const { data, error, loading } = useApi<QualityResponse>(`/api/quality?${query}`);

  const received = data ? data.totals.accepted + data.totals.duplicates + data.totals.rejected : 0;
  const fmtBucket = (b: string) =>
    data?.unit === 'hour'
      ? new Date(b).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: 'UTC' })
      : fmtDay(b);

  return (
    <main className="page">
      <h1>Data quality</h1>
      <p className="lede">Whether the Sources numbers can be trusted, from everything received in the last {days} days.</p>

      {error && <ErrorNote error={error} />}
      {loading && !data && <Loading />}

      {data && (
        <>
          <div className="figures">
            <div>
              <strong>{fmtInt(data.totals.accepted)}</strong>
              <span>accepted{received ? `, ${fmtPct(data.totals.accepted / received)} of received` : ''}</span>
            </div>
            <div>
              <strong>{fmtInt(data.totals.duplicates)}</strong>
              <span>retries dropped as duplicates</span>
            </div>
            <div>
              <strong>{fmtInt(data.totals.rejected)}</strong>
              <span>rejected{received ? `, ${fmtPct(data.totals.rejected / received, 2)} of received` : ''}</span>
            </div>
            <div>
              <strong>{fmtDuration(data.freshness.median_lag_seconds)}</strong>
              <span>typical delivery delay, slowest 5% over {fmtDuration(data.freshness.p95_lag_seconds)}</span>
            </div>
          </div>

          <section className="block">
            <h2>Rejected events per {data.unit}</h2>
            <p className="note">A rise here usually means a tracker change shipped with a bug.</p>
            <div className="figure">
            <BarChart
              label={`Rejected events per ${data.unit}`}
              categories={data.series.map((s) => s.bucket)}
              formatCategory={fmtBucket}
              series={[{ name: 'Rejected', color: SERIES[0], values: data.series.map((s) => s.rejected) }]}
              tooltip={(i) => {
                const s = data.series[i]!;
                return (
                  <>
                    <strong>{data.unit === 'hour' ? fmtDateTime(s.bucket) : fmtDay(s.bucket)}</strong>
                    <span>{fmtInt(s.rejected)} rejected</span>
                    <span>{fmtInt(s.duplicates)} duplicates</span>
                    <span>{fmtInt(s.accepted)} accepted</span>
                  </>
                );
              }}
            />
            </div>
          </section>

          <div className="two-col block">
            <section>
              <h2 style={{ marginBottom: 12 }}>Checks</h2>
              <ul className="checks">
                <Check ok={data.totals.rejected === 0 || data.totals.rejected / Math.max(1, received) < 0.01}>
                  Rejection rate under 1%
                </Check>
                <Check ok={data.idsWithoutVisit === 0}>
                  {data.idsWithoutVisit === 0
                    ? 'Every browser that uploaded or exported has a recorded visit'
                    : `${fmtInt(data.idsWithoutVisit)} browsers uploaded or exported with no recorded visit, so they have no source`}
                </Check>
                <Check ok={data.freshness.last_received_at !== null && Date.now() - Date.parse(data.freshness.last_received_at) < 24 * 3600 * 1000}>
                  Last event received {fmtAgo(data.freshness.last_received_at)}
                </Check>
                {data.sync.bigqueryConfigured && (
                  <Check ok={data.sync.pendingDeletions === 0}>
                    {data.sync.pendingDeletions === 0
                      ? 'No delete requests waiting for BigQuery'
                      : `${fmtInt(data.sync.pendingDeletions)} delete requests waiting to be applied in BigQuery`}
                  </Check>
                )}
              </ul>
            </section>

            <section>
              <h2 style={{ marginBottom: 12 }}>BigQuery export</h2>
              {!data.sync.bigqueryConfigured && (
                <p>
                  Not configured. Set BIGQUERY_PROJECT_ID on the server and run <code>npm run sync:bigquery -- --watch</code>.
                  Until then the Sources page is computed in PostgreSQL.
                </p>
              )}
              {data.sync.destinations.map((d) => (
                <dl key={d.destination} className="kv">
                  <dt>Destination</dt>
                  <dd><code>{d.destination}</code></dd>
                  <dt>Rows exported</dt>
                  <dd>{fmtInt(Number(d.rows_synced))}</dd>
                  <dt>Waiting to export</dt>
                  <dd>{fmtInt(d.pending)}</dd>
                  <dt>Last run</dt>
                  <dd>{fmtAgo(d.last_synced_at)}</dd>
                  {d.last_error && (
                    <>
                      <dt>Last error</dt>
                      <dd className="error-text">{d.last_error} ({fmtAgo(d.last_error_at)})</dd>
                    </>
                  )}
                </dl>
              ))}
              {data.sync.bigqueryConfigured && data.sync.destinations.length === 0 && <p>The sync has not run yet.</p>}
            </section>
          </div>

          <section className="block">
            <h2 style={{ marginBottom: 12 }}>Rejections by reason</h2>
            {data.reasons.length === 0 ? (
              <p>Nothing rejected in this range.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Reason</th>
                      <th scope="col">What it means</th>
                      <th scope="col" className="num">Events</th>
                      <th scope="col" className="num">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reasons.map((r) => (
                      <tr key={r.reason}>
                        <th scope="row"><code>{r.reason}</code></th>
                        <td>{REASONS[r.reason] ?? ''}</td>
                        <td className="num">{fmtInt(r.events)}</td>
                        <td className="num">{fmtAgo(r.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.samples.length > 0 && (
            <section className="block">
              <h2 style={{ marginBottom: 12 }}>Latest rejected events</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Received</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Problem</th>
                      <th scope="col">Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.samples.map((s) => (
                      <tr key={s.id}>
                        <td className="nowrap">{fmtDateTime(s.received_at)}</td>
                        <td><code>{s.reason}</code></td>
                        <td>{s.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ')}</td>
                        <td>
                          <details>
                            <summary>View</summary>
                            <pre>{JSON.stringify(s.payload, null, 2)}</pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={ok ? 'ok' : 'warn'}>
      <span className="check-mark" aria-hidden="true">
        {ok ? (
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 3v6M8 12v1.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        )}
      </span>
      <span className="sr-only">{ok ? 'Passed: ' : 'Needs attention: '}</span>
      {children}
    </li>
  );
}
