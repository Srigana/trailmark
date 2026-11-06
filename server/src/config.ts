import 'dotenv/config';

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function list(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  port: number;
  databaseUrl: string;
  writeKeys: string[];
  corsOrigins: string[];
  dashboardToken: string;
  siteHosts: string[];
  trustProxy: number;
  ingestRateLimitPerMinute: number;
  gaPropertyId: string;
  maxEventAgeHours: number;
  maxFutureSkewSeconds: number;
  bigquery: {
    enabled: boolean;
    projectId: string;
    dataset: string;
    table: string;
    location: string;
    batchSize: number;
  };
}

export function loadConfig(): Config {
  const projectId = (process.env.BIGQUERY_PROJECT_ID ?? '').trim();
  return {
    port: int('PORT', 4000, 1, 65535),
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://analytics:analytics@localhost:5432/analytics',
    writeKeys: list('WRITE_KEYS', 'dev_write_key'),
    corsOrigins: list('CORS_ORIGINS', 'http://localhost:5173'),
    dashboardToken: (process.env.DASHBOARD_TOKEN ?? '').trim(),
    trustProxy: int('TRUST_PROXY', 1, 0, 10),
    ingestRateLimitPerMinute: int('INGEST_RATE_LIMIT_PER_MINUTE', 1200, 1, 1_000_000),
    siteHosts: list('SITE_HOSTS', 'shoebox-taupe.vercel.app,localhost'),
    gaPropertyId: (process.env.GA_PROPERTY_ID ?? '').trim(),
    maxEventAgeHours: int('MAX_EVENT_AGE_HOURS', 72, 1, 24 * 365),
    maxFutureSkewSeconds: int('MAX_FUTURE_SKEW_SECONDS', 300, 0, 24 * 3600),
    bigquery: {
      enabled: projectId !== '',
      projectId,
      dataset: (process.env.BIGQUERY_DATASET ?? 'trailmark').trim(),
      table: (process.env.BIGQUERY_TABLE ?? 'events').trim(),
      location: (process.env.BIGQUERY_LOCATION ?? 'US').trim(),
      batchSize: int('BIGQUERY_BATCH_SIZE', 1000, 1, 10000),
    },
  };
}
