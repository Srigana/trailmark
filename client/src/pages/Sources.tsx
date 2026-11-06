import { useMemo } from 'react';
import { useApi, type SourceRow, type SourcesResponse } from '../api';
import { rangeQuery, useDays } from '../App';
import { BarChart, RangeDotChart, SERIES } from '../charts';
import { fmtDay, fmtDuration, fmtInt, fmtPct } from '../format';
import { ErrorNote, Loading } from './common';

/** Below this many visitors a source's rate is shown faded. */
const MIN_VISITORS = 30;

/** The answer to "which source brings users who export?", as a sentence. */
function headline(sources: SourceRow[], days: number): string {
  const withExports = sources.filter((s) => s.exporters > 0);
  if (withExports.length === 0) return `Nobody has exported their own receipts in the last ${days} days yet.`;
  const mostExporters = [...withExports].sort((a, b) => b.exporters - a.exporters || b.visitors - a.visitors)[0]!;
  const likeliest = withExports
    .filter((s) => s.visitors >= MIN_VISITORS)
    .sort((a, b) => b.export_rate_low - a.export_rate_low)[0];
  if (!likeliest) return `${mostExporters.source} brings the most exporters so far. No source has ${MIN_VISITORS} visitors yet.`;
  if (likeliest.source === mostExporters.source) {
    return `${likeliest.source} brings the most people who export, and they export most often.`;
  }
  return `${likeliest.source} visitors are the likeliest to export. ${mostExporters.source} brings the most exporters.`;
}

export default function Sources() {
  const [days] = useDays();
  const query = useMemo(() => rangeQuery(days), [days]);
  const { data, error, loading } = useApi<SourcesResponse>(`/api/sources?${query}`);

  const ranked = useMemo(() => {
    if (!data) return [];
    // Rank by the low end of the interval, so a big source with a solid rate beats a tiny lucky one.
    return [...data.sources].sort((a, b) => b.export_rate_low - a.export_rate_low || b.visitors - a.visitors);
  }, [data]);

  const weekly = useMemo(() => {
    const map = new Map<string, { visitors: number; exporters: number }>();
    for (const w of data?.weekly ?? []) {
      const cur = map.get(w.week) ?? { visitors: 0, exporters: 0 };
      cur.visitors += w.visitors;
      cur.exporters += w.exporters;
      map.set(w.week, cur);
    }
    const weeks = [...map.keys()].sort();
    return {
      weeks,
      visitors: weeks.map((w) => map.get(w)!.visitors),
      exporters: weeks.map((w) => map.get(w)!.exporters),
    };
  }, [data]);

  if (error) {
    return (
      <main className="page">
        <ErrorNote error={error} />
      </main>
    );
  }
  if (loading && !data) {
    return (
      <main className="page">
        <Loading />
      </main>
    );
  }
  if (!data) return null;

  const t = data.totals;

  if (t.visitors === 0) {
    return (
      <main className="page">
        <h1>No first visits in the last {days} days.</h1>
        <p className="lede">
          Either the range is too short or the tracker isn't sending. The Events page shows whether anything has arrived.
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>{headline(data.sources, days)}</h1>
      <p className="lede">
        {fmtInt(t.exporters)} of {fmtInt(t.visitors)} new visitors in the last {days} days exported their own receipts (
        {fmtPct(t.exporters / t.visitors)}).
      </p>

      <ol className="trail" aria-label="From first visit to export">
        <li>
          <span className="blaze" aria-hidden="true" />
          <span className="trail-count">{fmtInt(t.visitors)}</span>
          <span className="trail-label">Arrived</span>
          <span className="trail-share">first visit in this range</span>
        </li>
        <li>
          <span className="blaze" aria-hidden="true" />
          <span className="trail-count">{fmtInt(t.uploaders)}</span>
          <span className="trail-label">Uploaded their own receipt</span>
          <span className="trail-share">{fmtPct(t.uploaders / t.visitors)} of arrivals</span>
        </li>
        <li>
          <span className="blaze" aria-hidden="true" />
          <span className="trail-count">{fmtInt(t.exporters)}</span>
          <span className="trail-label">Exported a CSV</span>
          <span className="trail-share">
            {fmtPct(t.exporters / t.visitors)} of arrivals, {t.uploaders ? fmtPct(t.exporters / t.uploaders, 0) : '0%'} of uploaders
          </span>
        </li>
      </ol>
      <p className="aside">
        {fmtInt(t.tried_samples)} people tried the sample receipts. Samples are left out of uploads and exports.
      </p>

      <section className="block">
        <h2>Export rate by source</h2>
        <p className="note">
          The blaze marks each source's rate; the line shows where the true rate likely sits given how many visitors it
          had. Faded sources have fewer than {MIN_VISITORS} visitors.
        </p>
        <div className="figure">
          <RangeDotChart
            label="Export rate by source with 95% intervals"
            formatTick={(v) => fmtPct(v, 0)}
            rows={ranked.map((r) => ({
              label: r.source,
              value: r.export_rate,
              low: r.export_rate_low,
              high: r.export_rate_high,
              muted: r.visitors < MIN_VISITORS,
              tooltip: (
                <>
                  <strong>{r.source}</strong>
                  <span>
                    {fmtInt(r.exporters)} of {fmtInt(r.visitors)} exported ({fmtPct(r.export_rate)})
                  </span>
                  <span>
                    Likely {fmtPct(r.export_rate_low)} to {fmtPct(r.export_rate_high)}
                  </span>
                </>
              ),
            }))}
          />
        </div>
      </section>

      <section className="block">
        <h2>How far each source gets</h2>
        <p className="note">People, not events, counted once at each step.</p>
        <ul className="path-key" aria-label="Path bar key">
          <li><i style={{ background: '#e1e4e8' }} />Arrived</li>
          <li><i style={{ background: '#9db5dc' }} />Uploaded</li>
          <li><i style={{ background: SERIES[0] }} />Exported</li>
        </ul>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col" className="num">Arrived</th>
                <th scope="col"><span className="sr-only">Path</span></th>
                <th scope="col" className="num">Uploaded</th>
                <th scope="col" className="num">Exported</th>
                <th scope="col" className="num">Export rate</th>
                <th scope="col" className="num">Likely range</th>
                <th scope="col" className="num">Of uploaders</th>
                <th scope="col" className="num">Typical time to export</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => (
                <tr key={r.source} className={r.visitors < MIN_VISITORS ? 'thin' : undefined}>
                  <th scope="row">{r.source}</th>
                  <td className="num">{fmtInt(r.visitors)}</td>
                  <td className="path">
                    <div className="path-bar" aria-hidden="true">
                      <span className="up" style={{ width: `${r.upload_rate * 100}%` }} />
                      <span className="ex" style={{ width: `${r.export_rate * 100}%` }} />
                    </div>
                  </td>
                  <td className="num">
                    {fmtInt(r.uploaders)} <span className="dim">{fmtPct(r.upload_rate, 0)}</span>
                  </td>
                  <td className="num">{fmtInt(r.exporters)}</td>
                  <td className="num strong">{fmtPct(r.export_rate)}</td>
                  <td className="num dim">
                    {fmtPct(r.export_rate_low)} to {fmtPct(r.export_rate_high)}
                  </td>
                  <td className="num">{r.uploaders ? fmtPct(r.upload_to_export_rate, 0) : 'n/a'}</td>
                  <td className="num">{fmtDuration(r.median_seconds_to_export)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="block">
        <h2>Arrivals and exporters by week</h2>
        <p className="note">
          Weeks start Monday, UTC. The latest weeks look weaker because their visitors have had less time to export.
        </p>
        <div className="figure">
          <BarChart
            label="New visitors and exporters per week"
            categories={weekly.weeks}
            formatCategory={fmtDay}
            series={[
              { name: 'Arrived', color: SERIES[0], values: weekly.visitors },
              { name: 'Exported a CSV', color: SERIES[1], values: weekly.exporters },
            ]}
            tooltip={(i) => (
              <>
                <strong>Week of {fmtDay(weekly.weeks[i] ?? '')}</strong>
                <span>{fmtInt(weekly.visitors[i] ?? 0)} arrived</span>
                <span>
                  {fmtInt(weekly.exporters[i] ?? 0)} exported ({fmtPct((weekly.exporters[i] ?? 0) / Math.max(1, weekly.visitors[i] ?? 0))})
                </span>
              </>
            )}
          />
        </div>
      </section>

      <section className="block">
        <h2>How these are counted</h2>
        <dl className="terms" style={{ marginTop: 14 }}>
          <dt>Source</dt>
          <dd>
            The source of each person's first visit. Campaign tags in the link (utm_source) win; otherwise the site that
            linked to Shoebox. No referrer counts as Direct, and so do links between Shoebox's own pages.
          </dd>
          <dt>Uploaded</dt>
          <dd>At least one of their own receipts was read. The three sample receipts don't count.</dd>
          <dt>Exported a CSV</dt>
          <dd>Downloaded the QuickBooks or full CSV with at least one of their own receipts in it.</dd>
          <dt>Person</dt>
          <dd>
            One browser. Shoebox has no accounts, so a phone and a laptop count as two people, and clearing site data
            starts over.
          </dd>
        </dl>
        <p className="source-note">
          Computed in {data.engine === 'bigquery' ? 'BigQuery' : 'PostgreSQL, because BigQuery isn’t configured'}.
        </p>
      </section>
    </main>
  );
}
