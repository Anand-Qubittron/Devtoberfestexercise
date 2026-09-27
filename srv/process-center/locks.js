const cds = require('@sap/cds')
const { LockedError } = require('./errors')

/**
 * Cross-object locks. A target is { type, key, text }.
 *
 *  S (shared)    — conflicts only with another owner's X lock
 *  X (exclusive) — conflicts with any lock of another owner
 *
 * Every function takes the transaction to run in, so a lock commits or rolls back
 * together with the work it protects.
 */
const Locks = 'pc.ObjectLocks'
const now = () => new Date().toISOString()

async function conflictsOf(tx, targets, owner, mode) {
  const found = []
  for (const t of targets) {
    const where = { objectType: t.type, objectKey: String(t.key), owner: { '!=': owner } }
    if (mode === 'S') where.mode = 'X'
    const rows = await tx.run(
      SELECT.from(Locks).where(where).and(`(expiresAt is null or expiresAt > '${now()}')`)
    )
    found.push(...rows)
  }
  return found
}

function describe(conflicts) {
  const [first] = conflicts
  const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : ''
  return `${first.objectText || first.objectType + ' ' + first.objectKey} is locked: ${first.ownerText || first.owner}${more}`
}

/** Acquires all targets or none; throws LockedError on conflict. */
async function acquire(tx, targets, { owner, ownerText, mode = 'X', ttlMinutes }) {
  targets = [].concat(targets).filter(t => t && t.key != null)
  await tx.run(DELETE.from(Locks).where(`expiresAt is not null and expiresAt <= '${now()}'`))

  const conflicts = await conflictsOf(tx, targets, owner, mode)
  if (conflicts.length) throw new LockedError(describe(conflicts), conflicts)

  const expiresAt = ttlMinutes ? new Date(Date.now() + ttlMinutes * 60000).toISOString() : null
  for (const t of targets) {
    const key = { objectType: t.type, objectKey: String(t.key), owner }
    const mine = await tx.run(SELECT.one.from(Locks).where(key))
    if (mine) {
      if (mode === 'X' && mine.mode !== 'X') await tx.run(UPDATE(Locks, mine.ID).set({ mode }))
      continue
    }
    await tx.run(INSERT.into(Locks).entries({
      ...key, objectText: t.text, mode, ownerText, createdAt: now(), expiresAt
    }))
  }
}

async function release(tx, owner) {
  await tx.run(DELETE.from(Locks).where({ owner }))
}

/** Throws LockedError if another owner holds a lock the given mode would conflict with. */
async function check(tx, targets, { owner = '', mode = 'X' } = {}) {
  const conflicts = await conflictsOf(tx, [].concat(targets), owner, mode)
  if (conflicts.length) throw new LockedError(describe(conflicts), conflicts)
}

module.exports = { acquire, release, check }
