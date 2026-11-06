import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import {
  enrichSources,
  getEventCounts,
  getQuality,
  getRecentEvents,
  getSyncStatus,
  type AnalysisEngine,
  type Range,
} from './services/analysis.js';
import { compareWithGa, parseDay, type GaReportClient } from './services/ga.js';
import { MAX_BATCH_SIZE, deleteActor, ingestBatch } from './services/ingest.js';

const DAY_MS = 24 * 3600 * 1000;
const MAX_RANGE_MS = 366 * DAY_MS;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const rangeQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/** Parses ?from=&to= (ISO 8601). Defaults to the last 30 days. */
export function parseRange(query: unknown, now = new Date()): Range {
  const parsed = rangeQuery.safeParse(query);
  if (!parsed.success) throw new HttpError(400, 'from and to must be ISO 8601 date-times');
  const to = parsed.data.to ? new Date(parsed.data.to) : now;
  const from = parsed.data.from ? new Date(parsed.data.from) : new Date(to.getTime() - 30 * DAY_MS);
  if (from >= to) throw new HttpError(400, 'from must be before to');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new HttpError(400, 'range cannot exceed 366 days');
  return { from, to };
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `expected an integer between ${min} and ${max}`);
  }
  return n;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

export interface AppDeps {
  pool: Pool;
  config: Config;
  engine: AnalysisEngine;
  /** Lazily creates the GA4 client; only called when GA_PROPERTY_ID is set. */
  gaClient?: () => Promise<GaReportClient>;
  staticDir?: string;
}

export function createApp({ pool, config, engine, gaClient, staticDir }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Number of proxies in front of the server, so rate limits see the visitor's IP and not the proxy's.
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());

  const corsOrigin = config.corsOrigins.includes('*') ? true : config.corsOrigins;

  function requireWriteKey(req: Request, bodyKey: unknown) {
    const header = req.get('authorization');
    const key =
      (header?.startsWith('Bearer ') ? header.slice(7) : undefined) ??
      req.get('x-write-key') ??
      (typeof bodyKey === 'string' ? bodyKey : undefined);
    if (!key || !config.writeKeys.some((k) => safeEqual(k, key))) {
      throw new HttpError(401, 'missing or invalid write key');
    }
  }

  // ---------- Collector (called by the Shoebox tracker) ----------
  const collector = express.Router();
  collector.use(cors({ origin: corsOrigin, methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Write-Key'], maxAge: 86400 }));
  collector.use(rateLimit({ windowMs: 60_000, limit: config.ingestRateLimitPerMinute, standardHeaders: 'draft-7', legacyHeaders: false }));
  // navigator.sendBeacon sends text/plain, so accept it and parse as JSON.
  collector.use(express.json({ limit: '256kb', type: ['application/json', 'text/plain'] }));

  collector.post(
    '/batch',
    wrap(async (req, res) => {
      const body = req.body as { events?: unknown; write_key?: unknown } | undefined;
      requireWriteKey(req, body?.write_key);
      if (!body || !Array.isArray(body.events)) throw new HttpError(400, 'body must be { "events": [...] }');
      if (body.events.length === 0) throw new HttpError(400, 'events must not be empty');
      if (body.events.length > MAX_BATCH_SIZE) {
        throw new HttpError(413, `a batch can contain at most ${MAX_BATCH_SIZE} events`);
      }
      const result = await ingestBatch(pool, body.events, {
        maxAgeMs: config.maxEventAgeHours * 3600 * 1000,
        maxFutureSkewMs: config.maxFutureSkewSeconds * 1000,
        siteHosts: config.siteHosts,
      });
      res.json(result);
    }),
  );

  // Backs the "Delete my data" button on Shoebox's privacy page.
  collector.post(
    '/delete',
    wrap(async (req, res) => {
      const body = req.body as { anonymous_id?: unknown; write_key?: unknown } | undefined;
      requireWriteKey(req, body?.write_key);
      const id = z.string().min(1).max(128).safeParse(body?.anonymous_id);
      if (!id.success) throw new HttpError(400, 'anonymous_id is required');
      res.json({ deleted: await deleteActor(pool, id.data) });
    }),
  );

  app.use('/v1', collector);

  app.get(
    '/health',
    wrap(async (_req, res) => {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    }),
  );

  // ---------- Dashboard API ----------
  const api = express.Router();
  api.use(cors({ origin: corsOrigin, allowedHeaders: ['Content-Type', 'Authorization'] }));
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
  api.use((req, _res, next) => {
    if (req.method === 'OPTIONS' || !config.dashboardToken) return next();
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, config.dashboardToken)) return next(new HttpError(401, 'dashboard token required'));
    next();
  });

  api.get(
    '/config',
    wrap(async (_req, res) => {
      res.json({ engine: engine.name, gaConfigured: config.gaPropertyId !== '' });
    }),
  );

  api.get(
    '/sources',
    wrap(async (req, res) => {
      const range = parseRange(req.query);
      const [sources, weekly] = await Promise.all([engine.sources(range), engine.weekly(range)]);
      const totals = sources.reduce(
        (t, r) => ({
          visitors: t.visitors + r.visitors,
          tried_samples: t.tried_samples + r.tried_samples,
          uploaders: t.uploaders + r.uploaders,
          exporters: t.exporters + r.exporters,
          exports: t.exports + r.exports,
        }),
        { visitors: 0, tried_samples: 0, uploaders: 0, exporters: 0, exports: 0 },
      );
      res.json({ engine: engine.name, sources: enrichSources(sources), totals, weekly });
    }),
  );

  api.get(
    '/events/counts',
    wrap(async (req, res) => {
      res.json({ events: await getEventCounts(pool, parseRange(req.query)) });
    }),
  );

  api.get(
    '/events/recent',
    wrap(async (req, res) => {
      const name = typeof req.query.name === 'string' && req.query.name !== '' ? req.query.name : null;
      const limit = intParam(req.query.limit, 100, 1, 500);
      res.json({ events: await getRecentEvents(pool, parseRange(req.query), name, limit) });
    }),
  );

  api.get(
    '/quality',
    wrap(async (req, res) => {
      const range = parseRange(req.query);
      const [quality, sync] = await Promise.all([getQuality(pool, range), getSyncStatus(pool)]);
      res.json({ ...quality, sync: { bigqueryConfigured: config.bigquery.enabled, ...sync } });
    }),
  );

  api.get(
    '/ga/compare',
    wrap(async (req, res) => {
      if (!config.gaPropertyId || !gaClient) {
        throw new HttpError(409, 'Google Analytics is not configured. Set GA_PROPERTY_ID on the server.');
      }
      let fromDay: string;
      let toDay: string;
      try {
        fromDay = parseDay(req.query.from, 'from');
        toDay = parseDay(req.query.to, 'to');
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      if (fromDay > toDay) throw new HttpError(400, 'from must be on or before to');
      try {
        res.json(await compareWithGa(engine, await gaClient(), config.gaPropertyId, fromDay, toDay));
      } catch (err) {
        throw new HttpError(502, `Google Analytics request failed: ${(err as Error).message}`);
      }
    }),
  );

  app.use('/api', api);

  // In production the server also serves the built dashboard (client/dist) with an SPA fallback.
  if (staticDir) {
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders(res, file) {
          // Vite fingerprints everything under assets/, so it can be cached forever.
          res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.get(/^\/(?!api\/|v1\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use((_req, _res, next) => next(new HttpError(404, 'not found')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    const e = err as { type?: string };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'request body is not valid JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request body too large' });
      return;
    }
    console.error('[api] unhandled error', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
