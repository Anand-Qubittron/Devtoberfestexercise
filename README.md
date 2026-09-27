# Process Center for CAP

Reliable background processing for SAP CAP (Node.js), inspired by the **ABAP Processing Center**
and the new **RAP draft** features, brought to JavaScript.

Custom code usually processes mass data, events and Excel uploads "fire and forget": when row 37 of
500 fails, nobody knows, support digs through logs, and re-running creates duplicates. The Process
Center turns every business object into a tracked **process instance** that moves through
**steps**. It is:

| | |
|---|---|
| **Transactionally isolated** | Each step runs in its own transaction. A step's work and its "done" record commit together, so no step runs twice. |
| **Visible** | A living log per object shows which step failed, why, and when the next retry is due. |
| **Resumable** | After a business error is fixed, the process continues **at the failed step**. Nothing is re-created. |
| **Self-healing** | Technical errors (locks, timeouts) are retried automatically with backoff. When a user saves the master data a parked process waits for, that process resumes by itself. |
| **Draft-aware** | Cross-object locking: editing a supplier locks its materials, running processes lock what they use, and users and processes never overwrite each other. |
| **Standardised** | A developer writes only the steps and throws `BusinessError` or `TechnicalError`. The engine handles everything else. |

Runs fully locally: SQLite, mocked users, no BTP services.

## Run it

Requires Node.js 18+.

```bash
npm install
npm run setup     # creates db.sqlite with demo master data + sample/material-orders.xlsx
npm run watch     # opens the launchpad at http://localhost:4004/fiori.html
npm test          # end-to-end test (own in-memory database)
```

Log in as **alice / alice** or **bob / bob**. Use a second browser (or a private window) for the
second user. `npm run deploy` resets the database.

## Demo script (about 5 minutes)

1. **Excel Uploads → Create**: enter a name, upload `sample/material-orders.xlsx`, then **Create**.
   Activating the draft hands the 50 rows to background processing.
2. **Process Monitor** (refreshes itself): rows move through *Validate → CreatePurchaseRequest →
   NotifyBuyer*. About 20 % of steps hit a simulated transient error, show *Retrying*, and heal on
   the next attempt. Open one: the **Step Log** shows the failed and the successful attempt.
3. **Needs Attention** tab: five rows are *Parked* with a business reason:
   - `M-9999` doesn't exist → **Manage Materials → Create** `M-9999` → those rows resume on their own.
   - Supplier `S-300` is blocked → **Manage Suppliers → S-300 → Edit**, untick *Blocked*, **Save** → they resume.
   - A row has quantity 0 → **Excel Uploads → the batch → Edit**, fix the row, **Save** → it resumes.

   **Purchase Requests** shows exactly one request per row, even after the retries and resumes.
4. **Cross-object locks**: while bob edits supplier `S-100`, upload the file again. The S-100 rows
   wait with *"Waiting for lock — bob is editing supplier S-100"* (they don't fail). Once bob saves,
   they continue. The other way round: while rows are processing, alice can't edit their supplier
   (*"Supplier S-200 is locked: MaterialOrderImport …"*). **Object Locks** shows all of this live.
5. **Support actions**: Resume, Skip Step (only where allowed) and Cancel, for single rows or bulk.
   **Demo Settings** changes the error rate and speed.

## How it works

```
Draft activation / event / job / API
        │  pc.start('MaterialOrderImport', { objectKey })        ← in the caller's transaction
        ▼
 ProcessInstances ──scheduler (poll)──► runStep(): own transaction per step
        │                                   ├─ ok               → next step … Completed
        │                                   ├─ TechnicalError   → Retrying (backoff) … Failed after N
        │                                   ├─ LockedError      → Retrying, doesn't use up attempts
        │                                   └─ BusinessError    → Parked (+ waitingFor object)
        ▼
 StepExecutions (living log) · ObjectLocks (S/X, users and processes) · Fiori monitor
```

```
srv/process-center/   engine.js · locks.js · errors.js   ← reusable, no demo code
srv/processes/        material-order-import.js           ← a process = a list of steps
srv/demo-service.*    draft hooks: EDIT locks the scope, SAVE releases it + resumes waiting processes
srv/monitor-service.* Resume / Skip Step / Cancel / Demo Settings
app/                  Fiori Elements apps + launchpad sandbox (fiori.html)
```

A step:

```js
{ name: 'Validate', skippable: false, run: async ctx => {
    const material = await ctx.tx.run(SELECT.one.from(Materials).where({ materialNo }))
    if (!material) throw new BusinessError(`Material ${materialNo} does not exist`,
                                           { waitFor: { type: 'Material', key: materialNo } })
    await ctx.lock({ type: 'Material', key: material.ID })   // shared lock until the process ends
    ctx.data.materialID = material.ID                        // handed to the next steps
} }
```

## RAP draft features → CAP

| RAP (2025/2026) | Here |
|---|---|
| Table entities (the CDS entity is the persistence) | Standard in CAP |
| Cross-object draft scope (`with cross association`) | `before('EDIT')` locks the dependent objects; `SAVE` / `DISCARD` release them. Processes take part through the same lock table. |
| Hiding draft features in the UI | Fiori manifest setting, or leave `@odata.draft.enabled` off |
| Collaborative draft | **Not yet.** See the roadmap |

## Roadmap

- **Collaborative draft**: a share action, field-level locks and presence (needs a WebSocket
  channel; CAP 9 has no built-in support).
- Separate the engine into an npm `cds-plugin`, so any CAP app gets the tables, services and monitor via `npm add`.
- Multi-instance scheduling on HANA/Postgres (`SELECT … FOR UPDATE SKIP LOCKED`), plus BTP Job Scheduler triggers.
- More triggers: CAP / Event Mesh events and a REST API.
- Alerts for stuck or failed processes and SLA timers.
- AI: generate step handlers from a process description, and explain failures in business language.

## Notes

- Versions are pinned to run on **Node 18** without build tools (`better-sqlite3` 11 has prebuilt
  binaries for Node 18). On Node 22+ you can unpin and use the latest CAP.
- The scheduler polls once per second in a single Node.js process, which is right for a local demo.
