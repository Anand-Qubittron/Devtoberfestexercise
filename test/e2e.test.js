// End-to-end: Excel upload → background processing → self-healing → locks.
// Starts its own server with an in-memory database, so the demo data is never touched.
const { test, before, after } = require('node:test')
const assert = require('node:assert')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PORT = 4499
const BASE = `http://localhost:${PORT}/odata/v4`
const SAMPLE = path.join(__dirname, '..', 'sample', 'material-orders.xlsx')
const S100 = '6f1d2c3a-0001-4000-8000-000000000001'
const S300 = '6f1d2c3a-0001-4000-8000-000000000003'
// concepts in db/data/learning-Concepts.csv (one line each, after the header)
const CONCEPTS = fs.readFileSync(path.join(__dirname, '..', 'db', 'data', 'learning-Concepts.csv'), 'utf8').trim().split('\n').length - 1
let server

const call = async (method, url, { user = 'alice', body, type = 'application/json' } = {}) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(`${user}:${user}`).toString('base64'), 'content-type': type },
    body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body
  })
  const text = await res.text()
  return { status: res.status, data: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
    messages: JSON.parse(res.headers.get('sap-messages') || '[]').map(m => m.message) }
}
const get = async url => (await call('GET', url)).data
const sleep = ms => new Promise(r => setTimeout(r, ms))
const byStatus = async () => Object.fromEntries((await get(
  `/process-monitor/ProcessInstances?$apply=groupby((status),aggregate($count as n))`)).value.map(r => [r.status, r.n]))
async function until(check, timeoutMs = 60000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(300)) if (await check()) return
  assert.fail('timed out waiting — ' + JSON.stringify(await byStatus()))
}
const settled = async () => { const s = await byStatus(); return !s.Ready && !s.Running && !s.Retrying }

async function editSupplier(ID, user, patch) {
  const edit = await call('POST', `/demo/Suppliers(ID=${ID},IsActiveEntity=true)/DemoService.draftEdit`, { user, body: { PreserveChanges: true } })
  if (patch) await call('PATCH', `/demo/Suppliers(ID=${ID},IsActiveEntity=false)`, { user, body: patch })
  return edit
}
const saveSupplier = (ID, user) => call('POST', `/demo/Suppliers(ID=${ID},IsActiveEntity=false)/DemoService.draftActivate`, { user, body: {} })

async function upload(name) {
  const { data } = await call('POST', '/demo/UploadBatches', { body: { name } })
  await call('PUT', `/demo/UploadBatches(ID=${data.ID},IsActiveEntity=false)/file`,
    { body: fs.readFileSync(SAMPLE), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const res = await call('POST', `/demo/UploadBatches(ID=${data.ID},IsActiveEntity=false)/DemoService.draftActivate`, { body: {} })
  return { ID: data.ID, ...res }
}

before(async () => {
  if (!fs.existsSync(SAMPLE)) require('../scripts/make-sample-excel')
  server = spawn(process.execPath, [require.resolve('@sap/cds-dk/bin/cds.js'), 'serve', 'all', '--in-memory'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, cds_processCenter_pollIntervalMs: '100', cds_processCenter_batchSize: '20' },
    stdio: process.env.DEBUG ? 'inherit' : 'ignore'
  })
  await until(async () => fetch(`http://localhost:${PORT}`).then(() => true, () => false), 30000)
  // fast, but still with transient errors on 20 % of the steps
  await call('POST', '/process-monitor/configureDemo', { body: { technicalErrorRate: 20, stepDelayMs: 0, retryDelaySeconds: 1 } })
})
after(() => server?.kill())

test('a user editing a supplier makes processes wait instead of fail', async () => {
  assert.equal((await editSupplier(S100, 'bob')).status, 201)
  const { status, messages } = await upload('Week 39')
  assert.equal(status, 201)
  assert.deepEqual(messages, ['50 row(s) handed over to background processing'])

  await until(async () => (await get(`/process-monitor/ProcessInstances/$count?$filter=startswith(lastError,'Waiting for lock')`)) > 0)
  const waiting = await get(`/process-monitor/ProcessInstances?$filter=startswith(lastError,'Waiting for lock')&$top=1`)
  assert.match(waiting.value[0].lastError, /bob is editing supplier S-100/)
  assert.equal(waiting.value[0].status, 'Retrying')

  assert.equal((await saveSupplier(S100, 'bob')).status, 200)
})

test('transient errors heal themselves, bad data is parked with the reason', async () => {
  await until(settled)
  assert.deepEqual(await byStatus(), { Completed: 45, Parked: 5 })

  const healed = await get(`/process-monitor/StepExecutions?$filter=errorKind eq 'Technical' and status eq 'Failed'&$expand=instance($select=status)`)
  assert.ok(healed.value.length > 0, 'the demo produced transient errors')
  assert.ok(healed.value.every(s => s.instance.status === 'Completed' || s.instance.status === 'Parked'))

  const parked = (await get(`/process-monitor/ProcessInstances?$filter=status eq 'Parked'`)).value
  assert.deepEqual(parked.map(p => p.waitingForType).sort(), ['Material', 'Material', 'Supplier', 'Supplier', 'UploadItem'])
})

test('users cannot edit master data while processes use it', async () => {
  // a small second upload keeps S-100/S-200 busy for a moment
  await call('POST', '/process-monitor/configureDemo', { body: { stepDelayMs: 150 } })
  await upload('Week 40')
  await until(async () => (await get(`/process-monitor/ObjectLocks/$count?$filter=objectText eq 'Supplier S-200'`)) > 0, 20000)
  const res = await editSupplier('6f1d2c3a-0001-4000-8000-000000000002', 'alice')
  assert.equal(res.status, 423)
  assert.match(res.data.error.message, /Supplier S-200 is locked: MaterialOrderImport/)
  await call('POST', '/process-monitor/configureDemo', { body: { stepDelayMs: 0 } })
  await until(settled)
})

test('support cannot skip a step whose result later steps need', async () => {
  const [p] = (await get(`/process-monitor/ProcessInstances?$filter=status eq 'Parked' and currentStep eq 'Validate'&$top=1`)).value
  const res = await call('POST', `/process-monitor/ProcessInstances(${p.ID})/ProcessMonitorService.skipStep`, { body: {} })
  assert.equal(res.status, 409)
})

const ask = async (question, user = 'alice') => JSON.parse((await call('POST', '/knowledge-graph/ask', { user, body: { question } })).data.value)
const kg = async (fn, user = 'alice') => { const r = (await call('GET', `/knowledge-graph/${fn}`, { user })).data; return typeof r.value === 'string' && /^[{[]/.test(r.value) ? JSON.parse(r.value) : r }

test('the knowledge graph explains why rows need attention', async () => {
  const r = await ask('Which rows need attention and why?')
  assert.equal(r.questionId, 'needs-attention')
  assert.equal(r.rows.length, 10) // 5 parked rows in each of the two uploads
  const waits = r.rows.map(row => row.waits)
  assert.ok(waits.includes('M-9999 (does not exist yet)'))
  assert.ok(waits.includes('S-300 Pacific Plastics Ltd'))
  assert.match(r.reasons[0].join(' | '), /processed by .* has status → Parked/)
  assert.ok(r.graph.nodes.length > 0 && r.graph.lines.length > 0)
})

test('multi-hop: from a blocked supplier to the users it affects', async () => {
  const r = await ask('who is impacted if S-300 has a problem?')
  assert.equal(r.interpretedAs, 'Which users are affected by supplier S-300?')
  assert.deepEqual([...new Set(r.rows.map(row => row.user))], ['alice'])
  assert.equal(r.reasons[0].length, 4, 'four hops: upload→user, upload→row, row→material, material→supplier')
})

test('free questions are understood through the ontology — nothing is pre-written', async () => {
  const blocked = await ask('Which materials are blocked?') // materials have no block flag: inferred via the supplier
  assert.equal(blocked.mode, 'free')
  assert.deepEqual(blocked.rows.map(r => r.material).sort(), ['M-3001 PET granulate 25kg', 'M-3002 PVC tube 3m'])
  assert.match(blocked.interpretedAs, /Material → supplied by → Supplier = blocked/)

  const perUpload = await ask('How many parked rows per upload?')
  assert.deepEqual(perUpload.rows.map(r => Number(r.count)), [5, 5])

  const rows = await ask('Show rows 8 and 13')
  assert.equal(rows.rows.length, 4) // two uploads

  const named = await ask('Which materials does Nordic Steel supply?') // a name, not a code
  assert.deepEqual(named.rows.map(r => r.material.split(' ')[0]), ['M-1001', 'M-1002', 'M-1003'])

  const origin = await ask('Which sessions are behind the Object Locks app?')
  assert.deepEqual([...new Set(origin.rows.map(r => r.session))], ["What's new with draft handling in RAP"])
})

test('SAP and external data are joined through entity resolution, with provenance', async () => {
  const r = await ask('Which suppliers have high risk events?')
  assert.deepEqual(r.rows.map(row => row.supplier), ['S-200 Rhein Chemicals GmbH', 'S-300 Pacific Plastics Ltd'])
  assert.deepEqual(r.sources.map(s => s.label).sort(), ['Entity resolution', 'RiskWatch (external)'])
  assert.match(r.reasons[0].join(' | '), /same company as .*\[Entity resolution\].*has risk event.*\[RiskWatch \(external\)\]/)
})

test('each role sees only its named graphs — secure by construction', async () => {
  const bob = await kg('profile()', 'bob')
  assert.deepEqual(bob.graphs.filter(g => !g.visible).map(g => g.id), ['finance', 'risk', 'mapping'])
  assert.ok((await kg('profile()')).graphs.every(g => g.visible), 'alice (Buyer) sees everything')

  const total = await ask('Total amount of purchase requests per supplier', 'bob')
  assert.equal(total.rows.length, 0)
  assert.match(total.restricted, /SAP Finance/)
  const risk = await ask('Which suppliers have high risk events?', 'bob')
  assert.equal(risk.understood, false)
  assert.match(risk.message, /not visible for your role: .*RiskWatch/)

  // not even hand-written SPARQL or the data export reach hidden graphs
  const direct = await call('POST', '/knowledge-graph/sparql', { user: 'bob', body: { query: 'SELECT ?a WHERE { GRAPH <https://devtoberfest.local/graph/finance> { ?pr pc:amount ?a } }' } })
  assert.equal(JSON.parse(direct.data.value).rows.length, 0)
  const exported = (await call('GET', '/knowledge-graph/rdf()', { user: 'bob' })).data.value
  assert.ok(!exported.includes('#amount>') && !exported.includes('/graph/risk>'))
  assert.ok((await call('GET', '/knowledge-graph/rdf()')).data.value.includes('#amount>'))
})

test('SHACL validation reports data quality before the data is used for reasoning', async () => {
  const q = await kg('quality()')
  assert.equal(q.conforms, false)
  assert.equal(q.results.filter(r => r.severity === 'Violation' && r.message === 'Quantity must be at least 1').length, 2)
  assert.ok(q.results.some(r => r.focusLabel === 'S-400 Andes Packaging SA' && r.severity === 'Warning'))
  assert.ok(q.results.some(r => r.focusLabel.startsWith('BALTIC METALS OY') && r.severity === 'Info'))
  const bob = await kg('quality()', 'bob')
  assert.ok(bob.skipped.length > 0 && bob.infos === 0, 'rules on hidden data are skipped, not reported')
})

test('the graph can be explored node by node — only own entities', async () => {
  const r = JSON.parse((await call('POST', '/knowledge-graph/explore', { body: { iri: 'https://devtoberfest.local/data/supplier/S-300' } })).data.value)
  assert.ok(r.rows.some(row => row.relation === 'supplied by' && row.value.startsWith('M-3001')))
  assert.ok(r.rows.some(row => row.relation === 'same company as' && row.source === 'Entity resolution'))
  const bad = await call('POST', '/knowledge-graph/explore', { body: { iri: 'https://devtoberfest.local/data/x> } UNION { ?s ?p ?o' } })
  assert.equal(bad.status, 400)
})

test('the learning journey is part of the graph', async () => {
  const r = await ask('What did I build from each Devtoberfest session?')
  assert.equal(r.rows.length, CONCEPTS)
})

test('unknown questions and SPARQL updates are refused', async () => {
  assert.equal((await ask('what is the weather tomorrow')).understood, false)
  const update = await call('POST', '/knowledge-graph/sparql', { body: { query: 'DELETE WHERE { ?s ?p ?o }' } })
  assert.equal(update.status, 400)
  const stats = await get('/knowledge-graph/stats()')
  assert.ok(stats.triples > 1000)
})

test('fixing the data resumes parked processes at the failed step — without duplicates', async () => {
  // 1. create the missing material
  const { data: m } = await call('POST', '/demo/Materials', { body: { materialNo: 'M-9999', description: 'Special alloy', price: 99, supplier_ID: S100 } })
  const created = await call('POST', `/demo/Materials(ID=${m.ID},IsActiveEntity=false)/DemoService.draftActivate`, { body: {} })
  assert.deepEqual(created.messages, ['4 parked process(es) resumed'])

  // 2. unblock the supplier
  await editSupplier(S300, 'alice', { blocked: false })
  assert.deepEqual((await saveSupplier(S300, 'alice')).messages, ['4 parked process(es) resumed'])

  // 3. correct the row with quantity 0 in each upload — once the resumed rows are through,
  //    because rows in process are locked against editing
  await until(settled)
  for (const b of (await get(`/demo/UploadBatches?$filter=IsActiveEntity eq true`)).value) {
    const edit = await call('POST', `/demo/UploadBatches(ID=${b.ID},IsActiveEntity=true)/DemoService.draftEdit`, { body: { PreserveChanges: true } })
    assert.equal(edit.status, 201, JSON.stringify(edit.data))
    const [row] = (await get(`/demo/UploadItems?$filter=batch_ID eq ${b.ID} and quantity eq 0 and IsActiveEntity eq false`)).value
    await call('PATCH', `/demo/UploadItems(ID=${row.ID},IsActiveEntity=false)`, { body: { quantity: 15 } })
    const saved = await call('POST', `/demo/UploadBatches(ID=${b.ID},IsActiveEntity=false)/DemoService.draftActivate`, { body: {} })
    assert.deepEqual(saved.messages, ['1 parked row(s) resumed'])
  }

  await until(settled)
  assert.deepEqual(await byStatus(), { Completed: 100 })
  assert.equal(await get('/demo/PurchaseRequests/$count'), 100)
  assert.equal((await get('/demo/PurchaseRequests?$apply=groupby((sourceItem))')).value.length, 100, 'no duplicates')
  assert.equal(await get('/process-monitor/ObjectLocks/$count'), 0, 'all locks released')

  const [b] = (await get(`/demo/UploadBatches?$filter=IsActiveEntity eq true and name eq 'Week 39'`)).value
  assert.deepEqual([b.total, b.completed, b.parked, b.failed], [50, 50, 0, 0])
})
