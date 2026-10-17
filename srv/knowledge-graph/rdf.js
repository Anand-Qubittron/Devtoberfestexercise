const cds = require('@sap/cds')
const path = require('path')
const fs = require('fs')

/**
 * Turns the CAP database and an external feed into RDF that follows ontology.ttl.
 *
 * Every fact is stored in a named graph that says where it comes from (provenance).
 * Named graphs are also the unit of access control: a user's graph only contains
 * the named graphs their roles allow (see store.js).
 */
const PC = 'https://devtoberfest.local/ontology#'
const D = 'https://devtoberfest.local/data/'
const G = 'https://devtoberfest.local/graph/'

const GRAPHS = {
  purchasing: { label: 'SAP Purchasing', kind: 'SAP', source: 'Suppliers, materials, purchase requests (CAP database, standing in for S/4HANA)' },
  finance:    { label: 'SAP Finance', kind: 'SAP', source: 'Prices and purchase amounts', roles: ['Buyer'] },
  processing: { label: 'Process Center', kind: 'SAP', source: 'Excel uploads, rows, processes, locks' },
  learning:   { label: 'Learning Hub', kind: 'SAP', source: 'Devtoberfest sessions and concepts' },
  risk:       { label: 'RiskWatch (external)', kind: 'non-SAP', source: 'Third-party supplier risk feed (licensed data)', roles: ['Buyer'] },
  mapping:    { label: 'Entity resolution', kind: 'derived', source: 'SAP supplier ↔ RiskWatch company, matched by DUNS number', roles: ['Buyer'] }
}
const graphIri = id => G + id

const iri = (type, key) => `<${D}${type}/${encodeURIComponent(String(key))}>`
const pc = name => `<${PC}${name}>`
const RDF_TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>'
const LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>'
const XSD = t => `<http://www.w3.org/2001/XMLSchema#${t}>`

const text = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '"'
const typed = (v, t) => `"${v}"^^${XSD(t)}`

const FEED = path.join(__dirname, 'sources', 'riskwatch-feed.json')

/** @returns {Promise<Record<string, string[]>>} N-Quads lines per named graph id */
async function generate(tx = cds.db) {
  const q = query => tx.run(query)
  const [suppliers, materials, uploads, rows, prs, processes, locks, sessions, concepts] = await Promise.all([
    q(SELECT.from('demo.Suppliers')),
    q(SELECT.from('demo.Materials')),
    q(SELECT.from('demo.UploadBatches').columns('ID', 'name', 'createdBy', 'createdAt')),
    q(SELECT.from('demo.UploadItems')),
    q(SELECT.from('demo.PurchaseRequests')),
    q(SELECT.from('pc.ProcessInstances').columns('ID', 'process', 'objectText', 'status', 'currentStep', 'errorKind', 'lastError', 'waitingForType', 'waitingForKey')),
    q(SELECT.from('pc.ObjectLocks')),
    q(SELECT.from('learning.Sessions')),
    q(SELECT.from('learning.Concepts'))
  ])
  const feed = JSON.parse(fs.readFileSync(FEED, 'utf8'))

  const out = Object.fromEntries(Object.keys(GRAPHS).map(g => [g, []]))
  const into = g => {
    const t = (s, p, o) => out[g].push(`${s} ${p} ${o} <${graphIri(g)}> .`)
    t.node = (subject, cls, label) => { t(subject, RDF_TYPE, pc(cls)); t(subject, LABEL, text(label)) }
    return t
  }
  const purchasing = into('purchasing'), finance = into('finance'), processing = into('processing')
  const learning = into('learning'), risk = into('risk'), mapping = into('mapping')

  const supplierById = new Map(suppliers.map(s => [s.ID, s]))
  const materialById = new Map(materials.map(m => [m.ID, m]))
  const materialByNo = new Map(materials.map(m => [m.materialNo, m]))
  const uploadById = new Map(uploads.map(u => [u.ID, u]))
  const rowLabel = r => `${uploadById.get(r.batch_ID)?.name ?? 'Upload'} · row ${r.rowNo}`
  const users = new Set()
  const user = id => { users.add(id); return iri('user', id) }

  // ── SAP purchasing + finance ──
  for (const s of suppliers) {
    const S = iri('supplier', s.supplierNo)
    purchasing.node(S, 'Supplier', `${s.supplierNo} ${s.name}`)
    purchasing(S, pc('blocked'), typed(!!s.blocked, 'boolean'))
    if (s.dunsNumber) purchasing(S, pc('dunsNumber'), text(s.dunsNumber))
    if (s.country) {
      purchasing(S, pc('locatedIn'), iri('country', s.country))
      purchasing.node(iri('country', s.country), 'Country', s.country)
    }
  }
  for (const m of materials) {
    const M = iri('material', m.materialNo)
    purchasing.node(M, 'Material', `${m.materialNo} ${m.description ?? ''}`.trim())
    if (m.price != null) finance(M, pc('price'), typed(Number(m.price), 'decimal'))
    const s = supplierById.get(m.supplier_ID)
    if (s) purchasing(M, pc('suppliedBy'), iri('supplier', s.supplierNo))
  }
  const rowById = new Map(rows.map(r => [r.ID, r]))
  for (const p of prs) {
    const P = iri('purchase-request', p.prNo)
    const m = materialById.get(p.material_ID), s = supplierById.get(p.supplier_ID)
    purchasing.node(P, 'PurchaseRequest', p.prNo)
    purchasing(P, pc('quantity'), typed(p.quantity ?? 0, 'integer'))
    finance(P, pc('amount'), typed(Number(p.amount ?? 0), 'decimal'))
    if (m) purchasing(P, pc('forMaterial'), iri('material', m.materialNo))
    if (s) purchasing(P, pc('fromSupplier'), iri('supplier', s.supplierNo))
    if (rowById.has(p.sourceItem)) processing(iri('row', p.sourceItem), pc('resultedIn'), P)
  }

  // ── Process Center ──
  for (const u of uploads) {
    const U = iri('upload', u.ID)
    processing.node(U, 'Upload', u.name)
    if (u.createdBy) processing(U, pc('uploadedBy'), user(u.createdBy))
  }
  for (const r of rows) {
    const R = iri('row', r.ID)
    processing.node(R, 'UploadRow', rowLabel(r))
    processing(iri('upload', r.batch_ID), pc('hasRow'), R)
    processing(R, pc('rowNumber'), typed(r.rowNo, 'integer'))
    processing(R, pc('quantity'), typed(r.quantity ?? 0, 'integer'))
    processing(R, pc('orderedMaterialNo'), text(r.materialNo))
    if (materialByNo.has(r.materialNo)) processing(R, pc('orders'), iri('material', r.materialNo))
    if (r.process_ID) processing(R, pc('processedBy'), iri('process', r.process_ID))
  }

  // references to business objects by (type, key) as used by the process engine and locks
  const objectIri = (type, key) => {
    if (type === 'Supplier') { const s = supplierById.get(key); return s ? iri('supplier', s.supplierNo) : null }
    if (type === 'Material') {
      const m = materialById.get(key) ?? materialByNo.get(key)
      if (m) return iri('material', m.materialNo)
      const M = iri('material', key) // awaited but not existing yet — not a Material (yet)
      processing.node(M, 'MissingObject', `${key} (does not exist yet)`)
      return M
    }
    if (type === 'UploadItem') return rowById.has(key) ? iri('row', key) : null
    if (type === 'UploadBatch') return uploadById.has(key) ? iri('upload', key) : null
    return null
  }
  for (const p of processes) {
    const P = iri('process', p.ID)
    processing.node(P, 'Process', `${p.process} for ${p.objectText}`)
    processing(P, pc('hasStatus'), pc(p.status))
    if (p.currentStep) processing(P, pc('currentStep'), text(p.currentStep))
    if (p.errorKind) processing(P, pc('errorKind'), text(p.errorKind))
    if (p.lastError) processing(P, pc('message'), text(p.lastError))
    const waits = p.waitingForType && objectIri(p.waitingForType, p.waitingForKey)
    if (waits) processing(P, pc('waitsFor'), waits)
  }
  for (const l of locks) {
    const L = iri('lock', l.ID)
    const target = objectIri(l.objectType, l.objectKey)
    if (!target) continue
    processing.node(L, 'Lock', `${l.mode} lock on ${l.objectText}`)
    processing(L, pc('locks'), target)
    processing(L, pc('lockMode'), text(l.mode))
    const editor = /^(\S+) is editing/.exec(l.ownerText ?? '')
    if (l.owner.startsWith('process:')) processing(L, pc('heldBy'), iri('process', l.owner.slice(8)))
    else if (editor) processing(L, pc('heldBy'), user(editor[1]))
  }
  for (const u of users) processing.node(iri('user', u), 'User', u)

  // ── External risk feed (non-SAP) + entity resolution ──
  const supplierByDuns = new Map(suppliers.filter(s => s.dunsNumber).map(s => [s.dunsNumber, s]))
  for (const c of feed.companies) {
    const C = iri('external-company', c.duns)
    risk.node(C, 'ExternalCompany', `${c.legalName} (${feed.provider})`)
    risk(C, pc('dunsNumber'), text(c.duns))
    risk(C, pc('locatedIn'), iri('country', c.countryIso))
    risk.node(iri('country', c.countryIso), 'Country', c.countryIso)
    for (const e of c.events) {
      const E = iri('risk-event', e.id)
      risk.node(E, 'RiskEvent', `${e.severity} ${e.category} risk: ${e.title}`)
      risk(C, pc('hasRiskEvent'), E)
      risk(E, pc('riskLevel'), text(e.severity))
      risk(E, pc('riskCategory'), text(e.category))
      risk(E, pc('headline'), text(e.title))
      risk(E, pc('reportedOn'), typed(e.date, 'date'))
    }
    const s = supplierByDuns.get(c.duns)
    if (s) mapping(iri('supplier', s.supplierNo), pc('sameEntityAs'), C)
  }

  // ── Learning journey ──
  const apps = new Map(), files = new Set()
  for (const s of sessions) {
    const S = iri('session', s.ID)
    learning.node(S, 'Session', s.title)
    if (s.track) learning(S, pc('track'), text(s.track))
    if (s.date) learning(S, pc('date'), typed(s.date, 'date'))
  }
  for (const c of concepts) {
    const C = iri('concept', c.ID)
    learning.node(C, 'Concept', c.name)
    learning(iri('session', c.session_ID), pc('teaches'), C)
    if (c.implementation) learning(C, pc('implementation'), text(c.implementation))
    if (c.appUrl) { apps.set(c.appUrl, c.appTitle); learning(C, pc('demonstratedIn'), iri('app', c.appUrl.replace('#', ''))) }
    if (c.sourceFile) { files.add(c.sourceFile); learning(C, pc('implementedIn'), iri('file', c.sourceFile)) }
  }
  for (const [url, title] of apps) learning.node(iri('app', url.replace('#', '')), 'App', title)
  for (const f of files) learning.node(iri('file', f), 'SourceFile', f)

  return out
}

module.exports = { generate, GRAPHS, graphIri, PC, D, G }
