import { useCallback, useEffect, useState } from 'react';

const TOKEN_KEY = 'trailmark.dashboardToken';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: the token only lasts for this page
  }
  window.dispatchEvent(new Event('trailmark:token'));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface Loadable<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Fetches `path` and refetches when it changes. Pass null to skip. */
export function useApi<T>(path: string | null, refreshMs?: number): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const onToken = () => reload();
    window.addEventListener('trailmark:token', onToken);
    return () => window.removeEventListener('trailmark:token', onToken);
  }, [reload]);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiGet<T>(path)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'Could not reach the API.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  useEffect(() => {
    if (!refreshMs || !path) return;
    const id = window.setInterval(reload, refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs, path, reload]);

  return { data, error, loading, reload };
}

// ---------- Response types ----------

export interface SourceRow {
  source: string;
  visitors: number;
  tried_samples: number;
  uploaders: number;
  exporters: number;
  exports: number;
  median_seconds_to_export: number | null;
  upload_rate: number;
  export_rate: number;
  export_rate_low: number;
  export_rate_high: number;
  upload_to_export_rate: number;
}

export interface SourcesResponse {
  engine: 'bigquery' | 'postgres';
  sources: SourceRow[];
  totals: { visitors: number; tried_samples: number; uploaders: number; exporters: number; exports: number };
  weekly: { week: string; source: string; visitors: number; exporters: number }[];
}

export interface EventRow {
  event_id: string;
  name: string;
  anonymous_id: string;
  occurred_at: string;
  received_at: string;
  page_path: string | null;
  source: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  properties: Record<string, unknown>;
}

export interface QualityResponse {
  unit: 'hour' | 'day';
  totals: { accepted: number; duplicates: number; rejected: number; batches: number };
  series: { bucket: string; accepted: number; duplicates: number; rejected: number }[];
  reasons: { reason: string; events: number; last_seen: string }[];
  samples: { id: string; received_at: string; reason: string; details: { path: string; message: string }[]; payload: unknown }[];
  freshness: { last_received_at: string | null; median_lag_seconds: number | null; p95_lag_seconds: number | null };
  idsWithoutVisit: number;
  sync: {
    bigqueryConfigured: boolean;
    totalEvents: number;
    pendingDeletions: number;
    destinations: {
      destination: string;
      last_event_pk: string;
      rows_synced: string;
      last_synced_at: string | null;
      last_error: string | null;
      last_error_at: string | null;
      pending: number;
    }[];
  };
}

export interface CompareResponse {
  from: string;
  to: string;
  engine: string;
  rows: {
    source: string;
    ours_new_users: number;
    ga_new_users: number;
    ours_exporting_users: number;
    ga_exporting_users: number;
  }[];
  totals: { ours_new_users: number; ga_new_users: number; ours_exporting_users: number; ga_exporting_users: number };
}
