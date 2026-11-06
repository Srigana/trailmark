import { useState, type FormEvent } from 'react';
import { useApi, type CompareResponse } from '../api';
import { fmtInt } from '../format';
import { ErrorNote, Loading } from './common';

function utcDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

function Diff({ ours, ga }: { ours: number; ga: number }) {
  if (ours === 0 && ga === 0) return <span className="dim">same</span>;
  if (ours === 0) return <span>GA only</span>;
  const pct = ((ga - ours) / ours) * 100;
  const text = `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
  return <span className={Math.abs(pct) >= 20 ? 'strong' : undefined}>{text}</span>;
}

const REASONS: { title: string; body: string; direction: string }[] = [
  {
    title: 'Ad and tracker blockers',
    direction: 'GA lower',
    body:
      'Brave, uBlock Origin and many privacy extensions block Google Analytics. Our tracker sends to the Shoebox domain itself, which blocklists catch far less often, though some lists also block common first-party paths. Expect GA to miss a larger share of technical audiences (Hacker News, Reddit, GitHub) than of Google searchers.',
  },
  {
    title: 'Consent',
    direction: 'GA lower',
    body:
      'If GA is only loaded after cookie consent, every visitor who declines or ignores the banner is missing from GA. Our first-party tracker is not tied to that banner.',
  },
  {
    title: 'What counts as a user',
    direction: 'either',
    body:
      'GA identifies a browser with its _ga cookie. We use the shoebox.cid value in local storage. Cookie cleaners, private windows and browser privacy features do not always reset both together, so the same person can be new in one system and returning in the other.',
  },
  {
    title: 'Source rules',
    direction: 'shifts between rows',
    body:
      'Both sides use first touch, but GA can only see a visitor once GA loads. If the first visit was blocked or declined, firstUserSource comes from a later visit. GA source names are run through our rules on this page, and anything GA could not attribute shows as (not set).',
  },
  {
    title: 'Days and time zones',
    direction: 'edges of the range',
    body:
      'GA reports days in the time zone set on the property. Our side uses UTC days. Visits near midnight can land on different days in the two systems.',
  },
  {
    title: 'Thresholds and processing delay',
    direction: 'GA lower',
    body:
      'GA can withhold small rows (data thresholds) and takes up to 24 to 48 hours to finish processing a day. Compare complete days that ended at least two days ago.',
  },
  {
    title: 'Bots and internal traffic',
    direction: 'either',
    body:
      'GA filters known bots and any internal traffic you configured. Our collector validates events but does not run a bot list, and visits from the team count unless their browsers are excluded.',
  },
];

export default function Compare({ configured }: { configured: boolean }) {
  const [from, setFrom] = useState(utcDay(-30));
  const [to, setTo] = useState(utcDay(-2));
  const [applied, setApplied] = useState({ from, to });
  const path = configured ? `/api/ga/compare?from=${applied.from}&to=${applied.to}` : null;
  const { data, error, loading } = useApi<CompareResponse>(path);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ from, to });
  };

  return (
    <main className="page">
      <h1>Google Analytics comparison</h1>
      <p className="lede">The same two questions answered by GA4 and by Trailmark, side by side.</p>

      {!configured && (
        <section className="block">
          <h2 style={{ marginBottom: 12 }}>Connect Google Analytics</h2>
          <ol className="steps">
            <li>
              In Shoebox, set <code>NEXT_PUBLIC_GA_MEASUREMENT_ID</code> (the G-XXXXXXX ID) in Vercel and redeploy. The tracker
              then sends the same upload and export events to GA, and Shoebox's privacy policy adds a Google Analytics
              section. Check whether your visitors' countries require a cookie consent banner before you do this.
            </li>
            <li>
              In Google Cloud, create a service account, enable the Google Analytics Data API, and add the service account
              email as a Viewer on the GA4 property.
            </li>
            <li>
              On this server, set <code>GA_PROPERTY_ID</code> (the numeric property ID) and
              <code> GOOGLE_APPLICATION_CREDENTIALS</code> (path to the key file), then restart.
            </li>
          </ol>
        </section>
      )}

      {configured && (
        <section className="block">
          <form className="field-row" onSubmit={submit}>
            <label>
              <span>From</span>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={to} min={from} max={utcDay(0)} onChange={(e) => setTo(e.target.value)} required />
            </label>
            <button className="btn" type="submit">
              Compare
            </button>
          </form>

          {error && <ErrorNote error={error} />}
          {loading && <Loading />}
          {data && !loading && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col" rowSpan={2}>Source</th>
                    <th scope="colgroup" colSpan={3} className="num group">New users</th>
                    <th scope="colgroup" colSpan={3} className="num group">Users who exported</th>
                  </tr>
                  <tr>
                    <th scope="col" className="num">Trailmark</th>
                    <th scope="col" className="num">GA4</th>
                    <th scope="col" className="num">Difference</th>
                    <th scope="col" className="num">Trailmark</th>
                    <th scope="col" className="num">GA4</th>
                    <th scope="col" className="num">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.source}>
                      <th scope="row">{r.source}</th>
                      <td className="num">{fmtInt(r.ours_new_users)}</td>
                      <td className="num">{fmtInt(r.ga_new_users)}</td>
                      <td className="num"><Diff ours={r.ours_new_users} ga={r.ga_new_users} /></td>
                      <td className="num">{fmtInt(r.ours_exporting_users)}</td>
                      <td className="num">{fmtInt(r.ga_exporting_users)}</td>
                      <td className="num"><Diff ours={r.ours_exporting_users} ga={r.ga_exporting_users} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td className="num">{fmtInt(data.totals.ours_new_users)}</td>
                    <td className="num">{fmtInt(data.totals.ga_new_users)}</td>
                    <td className="num"><Diff ours={data.totals.ours_new_users} ga={data.totals.ga_new_users} /></td>
                    <td className="num">{fmtInt(data.totals.ours_exporting_users)}</td>
                    <td className="num">{fmtInt(data.totals.ga_exporting_users)}</td>
                    <td className="num"><Diff ours={data.totals.ours_exporting_users} ga={data.totals.ga_exporting_users} /></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="note" style={{ marginTop: 12 }}>
            Trailmark side: browsers whose first visit was on these UTC days, and browsers with any export on these days. GA4 side:
            newUsers and totalUsers with eventName export, both by firstUserSource. Exports are counted whether or not they
            held real receipts, because GA cannot tell them apart.
          </p>
        </section>
      )}

      <section className="block">
        <h2>Why the numbers differ</h2>
        <p className="note">Two honest systems won't agree. These are the usual reasons, and which way each one pushes GA.</p>
        <dl className="reasons" style={{ marginTop: 16 }}>
          {REASONS.map((r) => (
            <div key={r.title}>
              <dt>
                {r.title} <span className="effect">({r.direction})</span>
              </dt>
              <dd>{r.body}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
