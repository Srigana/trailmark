import type { AnalysisEngine } from './analysis.js';
import { classifyGaSource } from './sources.js';

/** The subset of the GA4 Data API client this module uses, so tests can pass a fake. */
export interface GaReportClient {
  runReport(request: Record<string, unknown>): Promise<
    [
      {
        rows?:
          | { dimensionValues?: { value?: string | null }[] | null; metricValues?: { value?: string | null }[] | null }[]
          | null;
      },
      ...unknown[],
    ]
  >;
}

export async function createGaClient(): Promise<GaReportClient> {
  const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
  return new BetaAnalyticsDataClient() as unknown as GaReportClient;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be a date in YYYY-MM-DD format`);
  }
  return value;
}

async function gaUsersBySource(
  client: GaReportClient,
  propertyId: string,
  startDate: string,
  endDate: string,
  metric: 'newUsers' | 'totalUsers',
  eventName?: string,
): Promise<Map<string, number>> {
  const request: Record<string, unknown> = {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'firstUserSource' }],
    metrics: [{ name: metric }],
    limit: 1000,
  };
  if (eventName) {
    request.dimensionFilter = {
      filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: eventName } },
    };
  }
  const [report] = await client.runReport(request);
  const totals = new Map<string, number>();
  for (const row of report.rows ?? []) {
    const raw = row.dimensionValues?.[0]?.value ?? '';
    const value = Number(row.metricValues?.[0]?.value ?? 0);
    const label = classifyGaSource(raw);
    // A user has exactly one firstUserSource, so summing rows that map to the same label never double counts.
    totals.set(label, (totals.get(label) ?? 0) + (Number.isFinite(value) ? value : 0));
  }
  return totals;
}

export interface ComparisonRow {
  source: string;
  ours_new_users: number;
  ga_new_users: number;
  ours_exporting_users: number;
  ga_exporting_users: number;
}

/**
 * Compares our numbers with GA4 for whole UTC days [fromDay, toDay].
 * GA4 reports days in the property's time zone, which is one of the listed reasons numbers differ.
 */
export async function compareWithGa(
  engine: AnalysisEngine,
  client: GaReportClient,
  propertyId: string,
  fromDay: string,
  toDay: string,
) {
  const from = new Date(`${fromDay}T00:00:00Z`);
  const to = new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 24 * 3600 * 1000);
  if (from >= to) throw new Error('from must be on or before to');

  const [ours, gaNew, gaExport] = await Promise.all([
    engine.compare({ from, to }),
    gaUsersBySource(client, propertyId, fromDay, toDay, 'newUsers'),
    gaUsersBySource(client, propertyId, fromDay, toDay, 'totalUsers', 'export'),
  ]);

  const rows = new Map<string, ComparisonRow>();
  const get = (source: string) => {
    let row = rows.get(source);
    if (!row) {
      row = { source, ours_new_users: 0, ga_new_users: 0, ours_exporting_users: 0, ga_exporting_users: 0 };
      rows.set(source, row);
    }
    return row;
  };
  for (const r of ours) {
    const row = get(r.source);
    row.ours_new_users += r.new_users;
    row.ours_exporting_users += r.exporting_users;
  }
  for (const [source, n] of gaNew) get(source).ga_new_users += n;
  for (const [source, n] of gaExport) get(source).ga_exporting_users += n;

  const list = [...rows.values()].sort(
    (a, b) => b.ours_new_users + b.ga_new_users - (a.ours_new_users + a.ga_new_users) || a.source.localeCompare(b.source),
  );
  const sum = (k: keyof Omit<ComparisonRow, 'source'>) => list.reduce((s, r) => s + r[k], 0);
  return {
    from: fromDay,
    to: toDay,
    engine: engine.name,
    rows: list,
    totals: {
      ours_new_users: sum('ours_new_users'),
      ga_new_users: sum('ga_new_users'),
      ours_exporting_users: sum('ours_exporting_users'),
      ga_exporting_users: sum('ga_exporting_users'),
    },
  };
}
