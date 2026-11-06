import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(connectionString: string): pg.Pool {
  // All bucketing (date_trunc) happens in UTC so charts are stable regardless of server settings.
  const pool = new pg.Pool({ connectionString, max: 10, options: '-c timezone=UTC' });
  pool.on('error', (err) => {
    console.error('[db] idle client error', err);
  });
  return pool;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Resolves the migrations folder for both `tsx src/...` and compiled `dist/src/...`. */
async function migrationsDir(): Promise<string> {
  const candidates = [path.resolve(here, '../migrations'), path.resolve(here, '../../migrations')];
  for (const dir of candidates) {
    try {
      await readdir(dir);
      return dir;
    } catch {
      // try next
    }
  }
  throw new Error(`migrations folder not found (looked in ${candidates.join(', ')})`);
}

/** Applies pending .sql migrations in filename order, each inside its own transaction. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const dir = await migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (for example several app instances starting at once).
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}
