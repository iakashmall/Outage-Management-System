// One process per background job (runbook v2, WP4).
//
// Each background job (timers, and the bus reactions that send SMS or call
// the DMS) runs only in the process that holds its session advisory lock
// (pg_try_advisory_lock). All locks of a process live on ONE dedicated
// connection, so they are released the moment the process dies; a process
// that did not get a job retries every JOB_LOCK_RETRY_MS and takes it over.
// If the lock connection drops, the process reconnects and re-takes its
// locks; if another process got one of them meanwhile, this process exits
// (the container restarts it) rather than run a job twice.
// The intake queue consumer is NOT exclusive: any number of workers share
// the queue through SKIP LOCKED.
import { db } from './db.js';

const NS_JOB = 41010;
const jobs = new Map(); // name -> { start, running }
let conn = null, connecting = null, retryTimer = null;

export const runningJobs = () => [...jobs].filter(([, j]) => j.running).map(([name]) => name);
export const waitingJobs = () => [...jobs].filter(([, j]) => !j.running).map(([name]) => name);

async function connection() {
  if (conn) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = await db.connect({ direct: true });
    c.client.on('error', (err) => lost(err));
    c.client.on('end', () => lost(new Error('connection ended')));
    conn = c;
    return c;
  })().finally(() => { connecting = null; });
  return connecting;
}

const tryLock = async (name) =>
  (await (await connection()).one('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [NS_JOB, name])).ok;

async function lost(err) {
  if (!conn) return;
  conn = null;
  const mine = runningJobs();
  console.error(`[jobs] lock connection lost (${err.message}); re-taking ${mine.length} job lock(s)`);
  for (let i = 0; ; i++) {
    try {
      for (const name of mine) {
        if (!(await tryLock(name))) {
          console.error(`[jobs] FATAL: job "${name}" was taken by another process while the lock connection was down; exiting so it never runs twice`);
          process.exit(1);
        }
      }
      console.log('[jobs] job locks re-taken');
      return;
    } catch (e) {
      conn = null;
      if (i % 10 === 0) console.error('[jobs] still cannot reach the database to re-take job locks:', e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function attempt(name) {
  const job = jobs.get(name);
  // Session advisory locks are re-entrant: never let two tries overlap, or
  // the same process could "win" twice and start the job twice.
  if (!job || job.running || job.trying) return;
  job.trying = true;
  try {
    if (!(await tryLock(name))) return;
  } catch (err) {
    console.error(`[jobs] could not try the lock for "${name}":`, err.message);
    return;
  } finally {
    job.trying = false;
  }
  job.running = true;
  console.log(`[jobs] ${name}: running in this process (pid ${process.pid})`);
  try { await job.start(); } catch (err) { console.error(`[jobs] ${name} failed to start:`, err.message); }
}

// Registers a job and starts it here if no other process runs it.
export async function runExclusive(name, start) {
  jobs.set(name, { start, running: false });
  await attempt(name);
  if (!retryTimer) {
    const every = Number(process.env.JOB_LOCK_RETRY_MS) || 15000;
    retryTimer = setInterval(() => { for (const n of waitingJobs()) attempt(n); }, every);
    retryTimer.unref?.();
  }
}
