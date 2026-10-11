import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function acquireLock(dataDir) {
  const path = join(dataDir, 'agent.lock');
  const owner = { pid: process.pid, nonce: randomUUID() };
  {
    try { writeFileSync(path, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let prior;
      try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Agent lock is unreadable; inspect it before removing it'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error('Agent lock is invalid; inspect it before removing it');
      try { process.kill(prior.pid, 0); throw new Error('Another agent or login process is already using this data directory'); }
      catch (aliveError) { if (aliveError.code !== 'ESRCH') throw aliveError; }
      // Never unlink/recreate a stale lock automatically: two restarting processes
      // could remove each other's fresh lock. Explicit recovery is fail-closed.
      throw new Error(`A stopped process left ${path}. Confirm no agent/login is running, remove this lock file, then restart.`);
    }
  }
  return () => {
    try { if (JSON.parse(readFileSync(path, 'utf8')).nonce === owner.nonce) unlinkSync(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
