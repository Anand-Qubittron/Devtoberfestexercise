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

const ask = async question => JSON.parse((await call('POST', '/knowledge-graph/ask', { body: { question } })).data.value)

test('the knowledge graph explains why rows need attention', async () => {
  const r = await ask('Which rows need attention and why?')
  assert.equal(r.questionId, 'needs-attention')
  assert.equal(r.rows.length, 10) // 5 parked rows in each of the two uploads
  const waits = r.rows.map(row => row.waitsLabel).sort()
  assert.ok(waits.includes('M-9999 (does not exist yet)'))
  assert.ok(waits.includes('S-300 Pacific Plastics Ltd'))
  assert.match(r.reasons[0].join(' | '), /processed by .* has status → Parked/)
  assert.ok(r.graph.nodes.length > 0 && r.graph.lines.length > 0)
})

test('multi-hop: from a blocked supplier to the users it affects', async () => {
  const r = await ask('who is impacted if S-300 has a problem?')
  assert.equal(r.interpretedAs, 'Which users are affected by supplier S-300?')
  assert.deepEqual([...new Set(r.rows.map(row => row.userLabel))], ['alice'])
  assert.equal(r.reasons[0].length, 4, 'four hops: upload→user, upload→row, row→material, material→supplier')
})

test('the learning journey is part of the graph', async () => {
  const r = await ask('What did I build from each Devtoberfest session?')
  assert.equal(r.rows.length, 13)
  const origin = await ask('Which sessions are behind the Object Locks app?')
  assert.deepEqual(origin.rows.map(row => row.sessionLabel), ["What's new with draft handling in RAP"])
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
