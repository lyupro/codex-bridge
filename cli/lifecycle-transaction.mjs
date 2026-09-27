/**
 * Runs one install, update or uninstall of a shared package home as a single transaction under
 * the home's lifecycle lock (Plan_65 D8).
 *
 * Two installs into one home used to interleave their image copies and their record writes, and
 * uninstall removed permission rules from settings.json before it had read anything — so a
 * refused uninstall would already have changed the host. The lock is therefore taken before the
 * first read, outside the settings backup scope (backup bookkeeping is not exclusion). `update`
 * nests `install`, and a second acquire inside one process is refused by design (the lock's own
 * self-check), so the outer transaction hands the nested call a ticket instead: live only while
 * the transaction runs, and bound to its home.
 *
 * Only install may bring a home into existence: the lock needs the directory, and an update or an
 * uninstall that created an empty home folder just to lock it would leave debris behind a removal.
 * A home that does not exist has nothing shared to protect, so those run without the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { acquireLifecycleLock } from './lifecycle-lock.mjs';

const liveTickets = new WeakMap();

export async function withLifecycle(host, command, action, { ticket, waitMs, createHome = false } = {}) {
  if (typeof action !== 'function') throw new TypeError('lifecycle action must be a function');

  if (ticket !== undefined) {
    if (!ticket || typeof ticket !== 'object' || !liveTickets.has(ticket)) {
      throw new Error('lifecycle ticket is no longer active');
    }
    if (typeof host?.brandRoot !== 'string' || path.resolve(host.brandRoot) !== liveTickets.get(ticket)) {
      throw new Error('lifecycle ticket belongs to a different home');
    }
    return action(ticket);
  }

  if (!createHome && !fs.existsSync(host.brandRoot)) return action(undefined);

  const lockOptions = { command, hostRoot: host.root };
  if (waitMs !== undefined) lockOptions.waitMs = waitMs;
  const lock = await acquireLifecycleLock(host.brandRoot, lockOptions);
  const transactionTicket = Object.freeze({});
  liveTickets.set(transactionTicket, path.resolve(host.brandRoot));
  try {
    return await action(transactionTicket);
  } finally {
    liveTickets.delete(transactionTicket);
    await lock.release();
  }
}
