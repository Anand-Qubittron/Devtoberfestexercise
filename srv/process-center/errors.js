/**
 * A step signals *what kind* of problem it hit — the engine decides what happens next:
 *
 *  BusinessError  → the data is wrong. Retrying won't help, a human has to fix it.
 *                   The instance is Parked. Pass `waitFor` to resume it automatically
 *                   as soon as that object is saved.
 *  TechnicalError → transient (lock, timeout, remote system down). Retried with backoff.
 *                   Any unexpected exception is treated as technical, too.
 */
class BusinessError extends Error {
  constructor(message, { waitFor } = {}) {
    super(message)
    this.kind = 'Business'
    this.waitFor = waitFor // { type, key }
  }
}

class TechnicalError extends Error {
  constructor(message) {
    super(message)
    this.kind = 'Technical'
  }
}

class LockedError extends TechnicalError {
  constructor(message, conflicts = []) {
    super(message)
    this.conflicts = conflicts
  }
}

module.exports = { BusinessError, TechnicalError, LockedError }
