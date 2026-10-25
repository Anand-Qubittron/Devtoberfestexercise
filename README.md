# Devtoberfest 2026: what I learned, built as one working app

Each Devtoberfest session I attended is turned into a working feature of one local SAP CAP
application. The **Learning Hub** tile lists every session with what I learned, what I built, and
links to the apps where you can see it.

| Session | Built | See it in |
|---|---|---|
| ABAP Processing Center: Enhancing Custom Development | Process engine: isolated steps, living log, retries, resume, self-healing | Process Monitor, Excel Uploads |
| What's new with draft handling in RAP | Draft activation as trigger, cross-object locks shared by users and processes | Object Locks, Manage Suppliers |
| Building your knowledge graph: Knowledge Graphs in Agentic AI | Ontology, named graphs per source, SAP + external data via entity resolution, SHACL quality rules, role-based access, free questions with a chain of reasoning | Knowledge Graph |

Everything runs locally: SQLite, mocked users, no BTP services, no AI keys.

---

## Process Center for CAP

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

**Both users at once, locally:** `npm run demo` starts `cds watch` and opens the launchpad twice:
alice on `http://alice.localhost:4004` and bob on `http://bob.localhost:4004`, already logged in.
Browsers keep separate logins per address, so the two windows stay separate. This uses
`/demo-login?user=…`, which only exists with the mocked users; with real authentication it is not
there. In BAS, open `<your BAS URL>/demo-login?user=bob` in a private window instead.

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

## Knowledge graph

The session showed how an ontology, RDF data and SPARQL let AI agents reason across business
objects with multi-hop relationships and explain their answers. Here that runs locally, built along
SAP's best practices:

| Layer / practice | On SAP (HANA Cloud, BDC, Joule) | Here |
|---|---|---|
| Ontology | Classes and relationships, reusing business semantics | `srv/knowledge-graph/ontology.ttl` (OWL), with synonyms as `skos:altLabel` |
| RDF data, provenance | Loaded into the HANA Cloud knowledge graph engine, per source | `rdf.js` regenerates the triples on every question, **one named graph per source**: SAP Purchasing, SAP Finance, Process Center, Learning Hub, RiskWatch (external), Entity resolution |
| SAP + non-SAP data | Harmonising data products with external data | A simulated third-party supplier risk feed (`sources/riskwatch-feed.json`) is linked to SAP suppliers by **DUNS number** in its own mapping graph |
| Data quality | Validate before reasoning | W3C **SHACL** rules (`shapes.ttl`), each checked as a SPARQL query (`shacl.js`), shown in the *Data quality* dialog |
| Authorization | The graph must not reveal more than the sources would | Each user's graph only contains the named graphs their roles allow (`store.js`), so no generated or hand-written query can reach the rest |
| SPARQL engine | HANA Cloud knowledge graph engine | [Oxigraph](https://github.com/oxigraph/oxigraph), embedded (WebAssembly, no server) |
| Natural language → SPARQL | An LLM writes SPARQL from the ontology | **Ontology-driven and offline** (`nlq.js`): words are matched to ontology labels and synonyms, names and codes to entities, and the shortest path through the schema becomes the SPARQL. Every interpretation is shown. Plus eight featured analyses and a free SPARQL editor |
| Explainability | Chain of reasoning | Every answer lists the triples it followed, **with the source of each step**, and draws them as a network graph; any node can be expanded |

**What you can ask.** The data comes from the same tables the other tiles use, so every upload, edit or
fix shows up in the next answer. Free questions are understood through the ontology; none of them is
pre-written:

| Kind of question | Example |
|---|---|
| List, multi-hop | *Which materials are blocked?* (inferred through the supplier) · *Which users uploaded rows ordering M-3001?* |
| Count, total, per group | *How many parked rows per upload?* · *Total amount of purchase requests per supplier* |
| Conditions on values | *Which rows have quantity 0?* · *Which purchase requests have an amount over 5000?* · *Which materials cost more than 50?* |
| Absence | *Which suppliers have no DUNS number?* · *Which materials have no purchase requests?* |
| Missing objects | *Which materials are missing?* (material numbers parked rows wait for) |
| Reasons | *Why are rows parked?* adds the reason and what each row waits for |
| Describe | *Tell me about S-300* |

The eight featured analyses are curated queries for more complex questions, e.g. *How is each upload
doing?* (rows per status and amount per upload) and *Which uploads order from suppliers with high risk
events?* (Excel rows joined with the external feed).

**Users and roles** (mocked): **alice** is a *Buyer* and sees everything; **bob** is *Support* and
does not see SAP Finance (prices, amounts), RiskWatch or Entity resolution. Asking as bob for
amounts or risks explains which sources are hidden, instead of giving a silently incomplete answer.

**Downloads:** the ontology and the quality rules are public (`/knowledge-graph/ontology.ttl`,
`/knowledge-graph/shapes.ttl`); *My data (.nq)* exports the user's own graph as N-Quads. All are
standard formats that SAP HANA Cloud's knowledge graph engine can load.

**Demo (after an upload has parked some rows):**
1. As alice, ask *"Which suppliers have high risk events?"*. The answer goes SAP supplier → same
   company (DUNS) → external record → risk event; *Sources used* and the *Chain of Reasoning* show
   which step came from SAP and which from the external feed.
2. Ask *"Which materials are blocked?"*. Materials have no block flag; the graph infers it through
   their supplier.
3. In the *Graph* tab, use **+** on a node to explore its neighbours.
4. Open *Data quality*: the uploaded file's row with quantity 0 is a violation, and S-400 has no
   DUNS number, so it cannot be matched with the risk feed.
5. Ask *"How is each upload doing?"* and *"Why are rows parked?"*: every parked row comes with its
   reason and what it waits for.
6. Repeat question 1 as bob (private window): the answer explains that the needed sources are
   hidden for their role.

The quality rules run on the same per-user graph as the questions, but they don't block answers: the
results are shown in the *Data quality* dialog. In production, validation would run when data is
loaded.

## Roadmap

- **Collaborative draft**: a share action, field-level locks and presence (needs a WebSocket
  channel; CAP 9 has no built-in support).
- Separate the engine into an npm `cds-plugin`, so any CAP app gets the tables, services and monitor via `npm add`.
- Multi-instance scheduling on HANA/Postgres (`SELECT … FOR UPDATE SKIP LOCKED`), plus BTP Job Scheduler triggers.
- More triggers: CAP / Event Mesh events and a REST API.
- Alerts for stuck or failed processes and SLA timers.
- AI: generate step handlers from a process description, and explain failures in business language.
- Knowledge graph: an LLM (SAP Generative AI Hub) for questions the ontology-driven parser does not cover, with the generated SPARQL validated before it runs; load the graph into SAP HANA Cloud; expose it to agents as MCP tools.

## Notes

- Versions are pinned to run on **Node 18** without build tools (`better-sqlite3` 11 has prebuilt
  binaries for Node 18). On Node 22+ you can unpin and use the latest CAP.
- The scheduler polls once per second in a single Node.js process, which is right for a local demo.
