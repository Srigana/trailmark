import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createEngine } from './services/analysis.js';
import { createGaClient } from './services/ga.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);

if (!config.dashboardToken) {
  console.warn('[api] DASHBOARD_TOKEN is empty: the dashboard API is open. Set it before deploying.');
}

await migrate(pool, (m) => console.log(`[db] ${m}`));

// Serve the built dashboard when it exists (works from both src/ via tsx and dist/src/ after tsc).
const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = [path.resolve(here, '../../client/dist'), path.resolve(here, '../../../client/dist')].find((d) =>
  existsSync(path.join(d, 'index.html')),
);
if (staticDir) console.log(`[api] serving dashboard from ${staticDir}`);

const engine = createEngine(pool, config);
let gaClientPromise: ReturnType<typeof createGaClient> | undefined;
const gaClient = () => (gaClientPromise ??= createGaClient());
console.log(`[api] analysis engine: ${engine.name}`);

const server = createApp({ pool, config, engine, gaClient, staticDir }).listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}`);
});

function shutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
