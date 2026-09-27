const cds = require('@sap/cds')
const LOG = cds.log('process-center')
const locks = require('./locks')
const { BusinessError, TechnicalError, LockedError } = require('./errors')

const Instances = 'pc.ProcessInstances'
const Steps = 'pc.StepExecutions'
const now = () => new Date().toISOString()
const definitions = new Map()

/**
 * Registers a process.
 *
 *   define('MyProcess', {
 *     objectType: 'SalesOrder',
 *     maxAttempts: 5,                            // per step, for technical errors
 *     retryDelayMs: (attempt) => attempt * 60000, // backoff
 *     steps: [ { name: 'Check', run: async ctx => {...}, skippable: false }, ... ]
 *   })
 *
 * Steps are skippable by support unless they say `skippable: false` — set it when later
 * steps depend on what the step produces.
 *
 * A step's `run(ctx)` gets:
 *   ctx.tx       its own transaction — everything written here commits together with
 *                the step's success record, or not at all (exactly-once per step)
 *   ctx.data     JSON object handed from step to step (persisted)
 *   ctx.instance the process instance row
 *   ctx.attempt  1, 2, ... for retries
 *   ctx.log(msg) adds a line to the step's log entry
 *   ctx.lock(targets, mode='S') locks further objects for the rest of the process
 */
function define(name, def) {
  definitions.set(name, { maxAttempts: 5, retryDelayMs: a => a * 60000, ...def, name })
}

/** Creates an instance. Runs in the caller's transaction, so it only exists if the caller commits. */
async function start(name, { objectKey, objectText, data = {} }, tx = cds) {
  const def = definitions.get(name)
  if (!def) throw new Error(`Unknown process '${name}'`)
  const ID = cds.utils.uuid()
  await tx.run(INSERT.into(Instances).entries({
    ID, process: name, objectType: def.objectType, objectKey: String(objectKey), objectText,
    status: 'Ready', stepNo: 0, totalSteps: def.steps.length, currentStep: def.steps[0].name,
    attempts: 0, nextRunAt: now(), context: JSON.stringify(data)
  }))
  return ID
}

const RESUMABLE = ['Parked', 'Failed', 'Retrying', 'Ready']
const clearError = { errorKind: null, lastError: null, waitingForType: null, waitingForKey: null }

/** Continues at the step that failed — earlier steps are not repeated. */
async function resume(IDs, tx = cds) {
  return tx.run(UPDATE(Instances)
    .set({ status: 'Ready', attempts: 0, nextRunAt: now(), ...clearError })
    .where({ ID: { in: [].concat(IDs) }, status: { in: RESUMABLE } }))
}

/** Self-healing: resumes every Parked instance that waits for the given object. */
async function resumeWaitingFor(type, key, tx = cds) {
  const n = await tx.run(UPDATE(Instances)
    .set({ status: 'Ready', attempts: 0, nextRunAt: now(), ...clearError })
    .where({ status: 'Parked', waitingForType: type, waitingForKey: String(key) }))
  if (n) LOG.info(`${type} ${key} saved → resumed ${n} parked instance(s)`)
  return n
}

/** Resumes Parked instances for the given business objects (e.g. after their data was corrected). */
async function resumeParkedFor(objectType, objectKeys, tx = cds) {
  if (!objectKeys.length) return 0
  return tx.run(UPDATE(Instances)
    .set({ status: 'Ready', attempts: 0, nextRunAt: now(), ...clearError })
    .where({ status: 'Parked', objectType, objectKey: { in: objectKeys.map(String) } }))
}

async function cancel(ID, tx = cds) {
  const n = await tx.run(UPDATE(Instances)
    .set({ status: 'Cancelled', finishedAt: now(), nextRunAt: null })
    .where({ ID, status: { in: RESUMABLE } }))
  if (n) await locks.release(tx, owner(ID))
  return n
}

/** Marks the current step as done without running it (support decided it is not needed). */
async function skipStep(ID, user, tx = cds) {
  const inst = await tx.run(SELECT.one.from(Instances).where({ ID, status: { in: RESUMABLE } }))
  if (!inst) return 0
  const def = definitions.get(inst.process)
  if (def.steps[inst.stepNo]?.skippable === false)
    cds.error(409, `Step ${inst.currentStep} cannot be skipped — the following steps need its result`)
  await tx.run(INSERT.into(Steps).entries({
    instance_ID: ID, stepNo: inst.stepNo, step: inst.currentStep, attempt: inst.attempts,
    status: 'Skipped', message: `Skipped by ${user}`, startedAt: now(), finishedAt: now(), durationMs: 0
  }))
  await tx.run(UPDATE(Instances, ID).set(advance(def, inst)))
  if (inst.stepNo + 1 >= def.steps.length) await locks.release(tx, owner(ID))
  return 1
}

const owner = ID => `process:${ID}`

function advance(def, inst) {
  const next = inst.stepNo + 1, done = next >= def.steps.length
  return {
    stepNo: next, currentStep: done ? null : def.steps[next].name,
    status: done ? 'Completed' : 'Ready', attempts: 0, nextRunAt: done ? null : now(),
    finishedAt: done ? now() : null, ...clearError
  }
}

/**
 * Runs exactly one step of one instance, isolated in its own transaction —
 * the Node.js counterpart of the ABAP Processing Center's separate session per step.
 */
async function runStep(ID) {
  const db = cds.db
  const claimed = await db.tx(tx => tx.run(
    UPDATE(Instances).set({ status: 'Running' }).where({ ID, status: { in: ['Ready', 'Retrying'] } })
  ))
  if (!claimed) return // cancelled or picked up in the meantime

  const inst = await db.run(SELECT.one.from(Instances).where({ ID }))
  const def = definitions.get(inst.process)
  const step = def?.steps[inst.stepNo]
  const attempt = inst.attempts + 1
  const startedAt = new Date()
  const lines = []
  const data = JSON.parse(inst.context || '{}')
  const ownerText = `${inst.process} for ${inst.objectText}`

  try {
    if (!step) throw new BusinessError(`Process definition '${inst.process}' or step ${inst.stepNo} not found`)
    await db.tx(async tx => {
      await locks.acquire(tx, { type: inst.objectType, key: inst.objectKey, text: inst.objectText },
        { owner: owner(ID), ownerText, mode: 'X' })
      const ctx = {
        tx, data, attempt, instance: inst, step: step.name,
        log: msg => lines.push(msg),
        lock: (targets, mode = 'S') => locks.acquire(tx, targets, { owner: owner(ID), ownerText, mode })
      }
      await step.run(ctx)

      const done = inst.stepNo + 1 >= def.steps.length
      await tx.run(INSERT.into(Steps).entries({
        instance_ID: ID, stepNo: inst.stepNo, step: step.name, attempt, status: 'Succeeded',
        message: lines.join('\n') || 'OK', startedAt: startedAt.toISOString(), finishedAt: now(),
        durationMs: Date.now() - startedAt
      }))
      await tx.run(UPDATE(Instances, ID).set({ ...advance(def, inst), context: JSON.stringify(data) }))
      if (done) await locks.release(tx, owner(ID))
    })
  } catch (e) {
    await db.tx(tx => recordFailure(tx, inst, def, step, attempt, e, startedAt, lines))
  }
}

async function recordFailure(tx, inst, def, step, attempt, e, startedAt, lines) {
  const kind = e instanceof BusinessError ? 'Business' : 'Technical'
  const message = e instanceof LockedError ? `Waiting for lock — ${e.message}` : e.message
  await tx.run(INSERT.into(Steps).entries({
    instance_ID: inst.ID, stepNo: inst.stepNo, step: step?.name ?? inst.currentStep, attempt,
    status: 'Failed', errorKind: kind, message: [...lines, message].join('\n'),
    startedAt: startedAt.toISOString(), finishedAt: now(), durationMs: Date.now() - startedAt
  }))

  // waiting for someone else's lock is not a failure — it doesn't use up the retry budget
  const waiting = e instanceof LockedError
  const set = { attempts: waiting ? inst.attempts : attempt, errorKind: kind, lastError: message }
  if (kind === 'Business') {
    Object.assign(set, {
      status: 'Parked', nextRunAt: null,
      waitingForType: e.waitFor?.type ?? null, waitingForKey: e.waitFor?.key != null ? String(e.waitFor.key) : null
    })
  } else if (!waiting && attempt >= def.maxAttempts) {
    Object.assign(set, { status: 'Failed', nextRunAt: null })
  } else {
    const delay = await def.retryDelayMs(waiting ? 1 : attempt, tx)
    Object.assign(set, { status: 'Retrying', nextRunAt: new Date(Date.now() + delay).toISOString() })
  }
  await tx.run(UPDATE(Instances, inst.ID).set(set))
  // Parked/Failed instances wait for people — don't block them from fixing the data
  if (set.status !== 'Retrying') await locks.release(tx, owner(inst.ID))

  const log = kind === 'Business' ? LOG.info : LOG.warn
  log(`${inst.objectText} · ${step?.name}: ${set.status} (attempt ${attempt}) — ${message}`)
}

let timer, busy = false

async function tick(batchSize) {
  if (busy) return
  busy = true
  try {
    const due = await cds.db.run(SELECT.from(Instances).columns('ID')
      .where({ status: { in: ['Ready', 'Retrying'] }, nextRunAt: { '<=': now() } })
      .orderBy('nextRunAt').limit(batchSize))
    for (const { ID } of due) await runStep(ID)
  } catch (e) {
    LOG.error('Scheduler tick failed:', e)
  } finally {
    busy = false
  }
}

/**
 * Polls for due instances. One Node.js process is enough for a local demo; with several
 * app instances on HANA/Postgres the claim would use SELECT ... FOR UPDATE SKIP LOCKED.
 */
async function startScheduler({ pollIntervalMs = 1000, batchSize = 5 } = {}) {
  // crash recovery: a step that was running when the server stopped is simply run again
  const n = await cds.db.run(UPDATE(Instances).set({ status: 'Ready', nextRunAt: now() }).where({ status: 'Running' }))
  if (n) LOG.info(`Recovered ${n} instance(s) interrupted by a restart`)
  timer = setInterval(() => tick(batchSize), pollIntervalMs)
  timer.unref?.()
  LOG.info(`Scheduler started (every ${pollIntervalMs} ms, ${batchSize} per tick); processes: ${[...definitions.keys()].join(', ')}`)
}

function stopScheduler() { clearInterval(timer) }

module.exports = {
  define, start, resume, resumeWaitingFor, resumeParkedFor, cancel, skipStep,
  startScheduler, stopScheduler, runStep, locks, BusinessError, TechnicalError, LockedError
}
