import { useMemo, useState } from 'react';
import { useApi, type EventRow } from '../api';
import { rangeQuery, useDays } from '../App';
import { fmtAgo, fmtDateTime, fmtInt } from '../format';
import { ErrorNote, Loading } from './common';

const EVENT_HELP: Record<string, string> = {
  visit: 'Page load, with source',
  upload: 'Receipt read successfully',
  upload_failed: 'Receipt could not be read',
  export: 'CSV downloaded',
};

function describe(e: EventRow): string {
  const p = e.properties as Record<string, unknown>;
  switch (e.name) {
    case 'visit': {
      const parts = [e.source ?? 'Direct'];
      if (e.utm_campaign) parts.push(`campaign ${e.utm_campaign}`);
      if (e.referrer_host) parts.push(`from ${e.referrer_host}`);
      return parts.join(', ');
    }
    case 'upload':
      return `${String(p.file_type)}${p.sample ? ', sample receipt' : ''}`;
    case 'upload_failed':
      return `${p.sample ? 'sample, ' : ''}${String(p.error ?? '')}`;
    case 'export':
      return `${p.format === 'quickbooks' ? 'QuickBooks' : 'Full'} CSV, ${String(p.rows)} rows (${String(p.real_rows)} real)`;
    default:
      return '';
  }
}

export default function Events() {
  const [days] = useDays();
  const query = useMemo(() => rangeQuery(days), [days]);
  const [name, setName] = useState('');
  const counts = useApi<{ events: { name: string; events: number; users: number; last_seen: string }[] }>(
    `/api/events/counts?${query}`,
  );
  const recent = useApi<{ events: EventRow[] }>(
    `/api/events/recent?${query}&limit=100${name ? `&name=${encodeURIComponent(name)}` : ''}`,
    15_000,
  );

  return (
    <main className="page">
      <h1>Events</h1>
      <p className="lede">Everything the Shoebox tracker sent in the last {days} days. The latest list refreshes every 15 seconds.</p>

      {counts.error && <ErrorNote error={counts.error} />}
      {counts.loading && !counts.data && <Loading />}

      {counts.data && (
        <section className="block">
          <h2 style={{ marginBottom: 12 }}>Tracking plan</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Meaning</th>
                  <th scope="col" className="num">Events</th>
                  <th scope="col" className="num">Browsers</th>
                  <th scope="col" className="num">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(EVENT_HELP).map((n) => {
                  const row = counts.data!.events.find((e) => e.name === n);
                  return (
                    <tr key={n}>
                      <th scope="row"><code>{n}</code></th>
                      <td>{EVENT_HELP[n]}</td>
                      <td className="num">{fmtInt(row?.events ?? 0)}</td>
                      <td className="num">{fmtInt(row?.users ?? 0)}</td>
                      <td className="num">{row ? fmtAgo(row.last_seen) : 'never'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="block">
        <div className="head-row">
          <h2>Latest events</h2>
          <label className="inline-field">
            <span>Show</span>
            <select value={name} onChange={(e) => setName(e.target.value)}>
              <option value="">All events</option>
              {Object.keys(EVENT_HELP).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        {recent.error && <ErrorNote error={recent.error} />}
        {recent.data && recent.data.events.length === 0 && <p>No events in this range.</p>}
        {recent.data && recent.data.events.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Event</th>
                  <th scope="col">Details</th>
                  <th scope="col">Browser ID</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.events.map((e) => (
                  <tr key={e.event_id}>
                    <td className="nowrap">{fmtDateTime(e.occurred_at)}</td>
                    <td><code>{e.name}</code></td>
                    <td>{describe(e)}</td>
                    <td><code className="dim" title={e.anonymous_id}>{e.anonymous_id.slice(0, 8)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
