import { randomUUID } from 'node:crypto';
import type { Config } from '../src/config.js';
import { createPool, migrate, type Pool } from '../src/db.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://analytics:analytics@localhost:5432/analytics_test';

export async function freshDatabase(): Promise<Pool> {
  const pool = createPool(TEST_DATABASE_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  return pool;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    writeKeys: ['test_key'],
    corsOrigins: ['http://localhost:5173'],
    dashboardToken: '',
    siteHosts: ['shoebox.test'],
    trustProxy: 1,
    ingestRateLimitPerMinute: 10_000,
    gaPropertyId: '',
    maxEventAgeHours: 72,
    maxFutureSkewSeconds: 300,
    bigquery: { enabled: false, projectId: '', dataset: 'trailmark', table: 'events', location: 'US', batchSize: 1000 },
    ...overrides,
  };
}

export function ev(name: string, anonymousId: string, at: Date, extra: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    event_id: randomUUID(),
    name,
    anonymous_id: anonymousId,
    timestamp: at.toISOString(),
  };
  if (name === 'upload') base.properties = { sample: false, file_type: 'image' };
  if (name === 'export') base.properties = { format: 'quickbooks', rows: 1, real_rows: 1 };
  return { ...base, ...extra };
}
