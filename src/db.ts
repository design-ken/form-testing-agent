import pg from 'pg';
import type { TestResult } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set.');
    }
    pool = new Pool({ connectionString, ssl: { rejectUnauthorized: true } });
  }
  return pool;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inserts all result rows for a run. Retries once after a 3-second delay to
 * cover Neon's free-tier cold-start suspend/wake behavior. Never throws —
 * caller (run.ts) treats a DB failure as non-fatal so email/Notion can still
 * proceed, per the plan's "don't block alerting on DB success" mitigation.
 */
export async function insertResults(results: TestResult[]): Promise<{ ok: boolean; error?: string }> {
  const attempt = async (): Promise<void> => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const r of results) {
        await client.query(
          `INSERT INTO test_runs
            (run_id, run_timestamp, form_url, form_name, device, category, status, severity, description, screenshot_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            r.runId,
            r.runTimestamp,
            r.formUrl,
            r.formName,
            r.device,
            r.category,
            r.status,
            r.severity,
            r.description,
            r.screenshotPath,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  const describeError = (err: unknown): string => {
    if (err instanceof Error && err.message) return err.message;
    const code = (err as { code?: string })?.code;
    return code ? `Error with code ${code} (no message)` : String(err);
  };

  try {
    await attempt();
    return { ok: true };
  } catch (firstErr) {
    console.error('[db] First insert attempt failed, retrying in 3s:', describeError(firstErr));
    await sleep(3000);
    try {
      await attempt();
      return { ok: true };
    } catch (secondErr) {
      const message = describeError(secondErr);
      console.error('[db] Retry also failed:', message);
      return { ok: false, error: message };
    }
  }
}

/**
 * Returns the most recent run_timestamp across all rows, or null if the
 * table is empty. Used by the watchdog to detect a silently-skipped cron run.
 */
export async function getLatestRunTimestamp(): Promise<Date | null> {
  const client = await getPool().connect();
  try {
    const res = await client.query('SELECT MAX(run_timestamp) AS latest FROM test_runs');
    const latest = res.rows[0]?.latest;
    return latest ? new Date(latest) : null;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
