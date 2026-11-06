/**
 * Fills a local database with 60 days of simulated Shoebox traffic so the dashboard has
 * something to show before real events arrive. Every event goes through the real ingest
 * path (validation, source classification, dedupe), with the server clock simulated.
 *
 *   npm run seed            refuses to run if events already exist
 *   npm run seed -- --reset deletes all events first
 *
 * This is demo data. Never run it against the production database.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { ingestBatch } from '../src/services/ingest.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data with NODE_ENV=production.');
  process.exit(1);
}

const DAYS = 60;
const DAY = 24 * 3600 * 1000;

// Deterministic RNG so every seed produces the same demo dataset.
let state = 20261105;
function rand(): number {
  state |= 0;
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const chance = (p: number) => rand() < p;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

interface Profile {
  weight: number;
  context: () => Partial<Record<string, string>>;
  trySamples: number;
  realUpload: number;
  exportGivenUpload: number;
}

// Rates differ by source on purpose so the report has something to find.
const PROFILES: Record<string, Profile> = {
  google: {
    weight: 34,
    context: () => ({ referrer_host: pick(['www.google.com', 'www.google.co.uk', 'www.google.ca']) }),
    trySamples: 0.35, realUpload: 0.24, exportGivenUpload: 0.55,
  },
  linkedin: {
    weight: 14,
    context: () =>
      chance(0.6)
        ? { utm_source: 'linkedin', utm_medium: 'social', utm_campaign: pick(['launch_post', 'tax_season_tips']) }
        : { referrer_host: 'lnkd.in' },
    trySamples: 0.45, realUpload: 0.12, exportGivenUpload: 0.4,
  },
  reddit: {
    weight: 20,
    context: () =>
      chance(0.3)
        ? { utm_source: 'reddit', utm_medium: 'social', utm_campaign: 'r_freelance' }
        : { referrer_host: pick(['www.reddit.com', 'old.reddit.com', 'out.reddit.com']) },
    trySamples: 0.6, realUpload: 0.2, exportGivenUpload: 0.38,
  },
  hackernews: {
    weight: 7,
    context: () => ({ referrer_host: 'news.ycombinator.com' }),
    trySamples: 0.7, realUpload: 0.1, exportGivenUpload: 0.3,
  },
  github: {
    weight: 5,
    context: () => ({ referrer_host: 'github.com' }),
    trySamples: 0.55, realUpload: 0.14, exportGivenUpload: 0.35,
  },
  direct: {
    weight: 14,
    context: () => ({}),
    trySamples: 0.3, realUpload: 0.3, exportGivenUpload: 0.62,
  },
  other: {
    weight: 6,
    context: () => ({ referrer_host: pick(['www.indiehackers.com', 'freelancersunion.org', 'news.google.com']) }),
    trySamples: 0.4, realUpload: 0.18, exportGivenUpload: 0.45,
  },
};
const totalWeight = Object.values(PROFILES).reduce((s, p) => s + p.weight, 0);

function pickProfile(): Profile {
  let r = rand() * totalWeight;
  for (const p of Object.values(PROFILES)) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return PROFILES.direct!;
}

type Raw = Record<string, unknown> & { timestamp: string };

function event(name: string, id: string, at: number, extra: Partial<Raw> = {}): Raw {
  return {
    event_id: randomUUID(),
    name,
    anonymous_id: id,
    timestamp: new Date(at).toISOString(),
    context: { page_path: '/' },
    ...extra,
  };
}

function simulateUser(firstSeen: number, end: number): Raw[] {
  const id = randomUUID();
  const p = pickProfile();
  const out: Raw[] = [event('visit', id, firstSeen, { context: { page_path: '/', ...p.context() } })];
  let t = firstSeen;
  const step = (minS: number, maxS: number) => (t += (minS + rand() * (maxS - minS)) * 1000);

  if (chance(p.trySamples)) {
    step(5, 60);
    for (let i = 0; i < 3; i++) {
      out.push(event('upload', id, step(1, 6), { properties: { sample: true, file_type: i === 2 ? 'pdf' : 'image' } }));
    }
    if (chance(0.15)) out.push(event('export', id, step(10, 90), { properties: { format: 'full', rows: 3, real_rows: 0 } }));
  }

  if (!chance(p.realUpload)) return out.filter((e) => Date.parse(e.timestamp) < end);

  // Some people come back another day before uploading their own receipts.
  if (chance(0.35)) {
    t += (1 + rand() * 6) * DAY;
    out.push(event('visit', id, t));
  }
  const receipts = 1 + Math.floor(rand() * 14);
  let real = 0;
  for (let i = 0; i < receipts; i++) {
    step(3, 40);
    if (chance(0.06)) {
      out.push(event('upload_failed', id, t, { properties: { sample: false, error: "This doesn't look like a receipt or invoice." } }));
    } else {
      out.push(event('upload', id, t, { properties: { sample: false, file_type: chance(0.8) ? 'image' : 'pdf' } }));
      real += 1;
    }
  }
  if (real > 0 && chance(p.exportGivenUpload)) {
    const format = chance(0.65) ? 'quickbooks' : 'full';
    out.push(event('export', id, step(30, 900), { properties: { format, rows: real, real_rows: real } }));
    if (chance(0.3)) {
      out.push(event('export', id, step(5, 60), { properties: { format: format === 'full' ? 'quickbooks' : 'full', rows: real, real_rows: real } }));
    }
  }
  return out.filter((e) => Date.parse(e.timestamp) < end);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
await migrate(pool);

const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM events');
if ((rows[0]?.n ?? 0) > 0) {
  if (!process.argv.includes('--reset')) {
    console.error(`The database already has ${rows[0]!.n} events. Run with --reset to replace them.`);
    await pool.end();
    process.exit(1);
  }
}
if (process.argv.includes('--reset')) {
  await pool.query(
    'TRUNCATE events, rejected_events, ingest_batches, sync_state, deletion_requests RESTART IDENTITY',
  );
}

const end = Date.now();
const start = end - DAYS * DAY;
const all: Raw[] = [];
for (let d = 0; d < DAYS; d++) {
  // Traffic grows over the period, with a Reddit spike around day 40.
  const visitors = Math.round(18 + d * 0.6 + rand() * 10);
  for (let v = 0; v < visitors; v++) {
    all.push(...simulateUser(start + d * DAY + rand() * DAY, end));
  }
}

// Realistic instrumentation problems: retries that resend an event, and malformed events.
const faulty: Raw[] = [];
for (const e of all) {
  if (chance(0.01)) faulty.push({ ...e });
  if (chance(0.004)) faulty.push({ ...e, event_id: randomUUID(), name: 'exprot' });
  if (chance(0.003) && e.name === 'export') faulty.push({ ...e, event_id: randomUUID(), properties: { format: 'csv', rows: 2 } });
  if (chance(0.002)) faulty.push({ ...e, event_id: randomUUID(), timestamp: new Date(Date.parse(e.timestamp) + 2 * DAY).toISOString() });
}
const stream = [...all, ...faulty].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

// Each event is sent on its own, like the tracker does, and arrives 0.2 to 2.5 seconds later.
let accepted = 0;
let duplicates = 0;
let rejected = 0;
for (const e of stream) {
  const occurred = Date.parse(e.timestamp);
  const received = Math.min(end, Math.max(occurred, start) + 200 + rand() * 2300);
  const res = await ingestBatch(pool, [e], {
    now: new Date(received),
    maxAgeMs: config.maxEventAgeHours * 3600 * 1000,
    maxFutureSkewMs: config.maxFutureSkewSeconds * 1000,
    siteHosts: config.siteHosts,
  });
  accepted += res.accepted;
  duplicates += res.duplicates;
  rejected += res.rejected.length;
}

console.log(`Seeded ${DAYS} days of demo data: ${accepted} accepted, ${duplicates} duplicates, ${rejected} rejected.`);
await pool.end();
