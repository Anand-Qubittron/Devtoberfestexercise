const cds = require('@sap/cds')

/**
 * Turns the CAP database into RDF (Turtle) that follows ontology.ttl.
 * The graph is regenerated from the live data, so it always reflects the current state.
 */
const PC = 'https://devtoberfest.local/ontology#'
const D = 'https://devtoberfest.local/data/'

const iri = (type, key) => `<${D}${type}/${encodeURIComponent(String(key))}>`
const pc = name => `<${PC}${name}>`
const RDF_TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>'
const LABEL = '<http://www.w3.org/2000/01/rdf-schema#label>'
const XSD = t => `<http://www.w3.org/2001/XMLSchema#${t}>`

const text = v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '"'
const typed = (v, t) => `"${v}"^^${XSD(t)}`

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

  const out = []
  const t = (s, p, o) => out.push(`${s} ${p} ${o} .`)
  const node = (subject, cls, label) => { t(subject, RDF_TYPE, pc(cls)); t(subject, LABEL, text(label)) }

  const supplierById = new Map(suppliers.map(s => [s.ID, s]))
  const materialById = new Map(materials.map(m => [m.ID, m]))
  const materialByNo = new Map(materials.map(m => [m.materialNo, m]))
  const uploadById = new Map(uploads.map(u => [u.ID, u]))
  const rowLabel = r => `${uploadById.get(r.batch_ID)?.name ?? 'Upload'} · row ${r.rowNo}`
  const users = new Set()
  const user = id => { users.add(id); return iri('user', id) }

  for (const s of suppliers) {
    const S = iri('supplier', s.supplierNo)
    node(S, 'Supplier', `${s.supplierNo} ${s.name}`)
    t(S, pc('blocked'), typed(!!s.blocked, 'boolean'))
    if (s.country) {
      t(S, pc('locatedIn'), iri('country', s.country))
      node(iri('country', s.country), 'Country', s.country)
    }
  }
  for (const m of materials) {
    const M = iri('material', m.materialNo)
    node(M, 'Material', `${m.materialNo} ${m.description ?? ''}`.trim())
    if (m.price != null) t(M, pc('price'), typed(Number(m.price), 'decimal'))
    const s = supplierById.get(m.supplier_ID)
    if (s) t(M, pc('suppliedBy'), iri('supplier', s.supplierNo))
  }
  for (const u of uploads) {
    const U = iri('upload', u.ID)
    node(U, 'Upload', u.name)
    if (u.createdBy) t(U, pc('uploadedBy'), user(u.createdBy))
  }
  for (const r of rows) {
    const R = iri('row', r.ID)
    node(R, 'UploadRow', rowLabel(r))
    t(iri('upload', r.batch_ID), pc('hasRow'), R)
    t(R, pc('rowNumber'), typed(r.rowNo, 'integer'))
    t(R, pc('quantity'), typed(r.quantity ?? 0, 'integer'))
    t(R, pc('orderedMaterialNo'), text(r.materialNo))
    if (materialByNo.has(r.materialNo)) t(R, pc('orders'), iri('material', r.materialNo))
    if (r.process_ID) t(R, pc('processedBy'), iri('process', r.process_ID))
  }
  const rowById = new Map(rows.map(r => [r.ID, r]))
  for (const p of prs) {
    const P = iri('purchase-request', p.prNo)
    const m = materialById.get(p.material_ID), s = supplierById.get(p.supplier_ID)
    node(P, 'PurchaseRequest', p.prNo)
    t(P, pc('amount'), typed(Number(p.amount ?? 0), 'decimal'))
    t(P, pc('quantity'), typed(p.quantity ?? 0, 'integer'))
    if (m) t(P, pc('forMaterial'), iri('material', m.materialNo))
    if (s) t(P, pc('fromSupplier'), iri('supplier', s.supplierNo))
    if (rowById.has(p.sourceItem)) t(iri('row', p.sourceItem), pc('resultedIn'), P)
  }

  // references to business objects by (type, key) as used by the process engine and locks
  const objectIri = (type, key) => {
    if (type === 'Supplier') { const s = supplierById.get(key); return s ? iri('supplier', s.supplierNo) : null }
    if (type === 'Material') {
      const m = materialById.get(key) ?? materialByNo.get(key)
      if (m) return iri('material', m.materialNo)
      const M = iri('material', key) // awaited but not existing yet
      node(M, 'Material', `${key} (does not exist yet)`)
      return M
    }
    if (type === 'UploadItem') return rowById.has(key) ? iri('row', key) : null
    if (type === 'UploadBatch') return uploadById.has(key) ? iri('upload', key) : null
    return null
  }

  for (const p of processes) {
    const P = iri('process', p.ID)
    node(P, 'Process', `${p.process} for ${p.objectText}`)
    t(P, pc('hasStatus'), pc(p.status))
    if (p.currentStep) t(P, pc('currentStep'), text(p.currentStep))
    if (p.errorKind) t(P, pc('errorKind'), text(p.errorKind))
    if (p.lastError) t(P, pc('message'), text(p.lastError))
    const waits = p.waitingForType && objectIri(p.waitingForType, p.waitingForKey)
    if (waits) t(P, pc('waitsFor'), waits)
  }
  for (const l of locks) {
    const L = iri('lock', l.ID)
    const target = objectIri(l.objectType, l.objectKey)
    if (!target) continue
    node(L, 'Lock', `${l.mode} lock on ${l.objectText}`)
    t(L, pc('locks'), target)
    t(L, pc('lockMode'), text(l.mode))
    const editor = /^(\S+) is editing/.exec(l.ownerText ?? '')
    if (l.owner.startsWith('process:')) t(L, pc('heldBy'), iri('process', l.owner.slice(8)))
    else if (editor) t(L, pc('heldBy'), user(editor[1]))
  }

  const apps = new Map(), files = new Set()
  for (const s of sessions) {
    const S = iri('session', s.ID)
    node(S, 'Session', s.title)
    if (s.track) t(S, pc('track'), text(s.track))
    if (s.date) t(S, pc('date'), typed(s.date, 'date'))
  }
  for (const c of concepts) {
    const C = iri('concept', c.ID)
    node(C, 'Concept', c.name)
    t(iri('session', c.session_ID), pc('teaches'), C)
    if (c.implementation) t(C, pc('implementation'), text(c.implementation))
    if (c.appUrl) { apps.set(c.appUrl, c.appTitle); t(C, pc('demonstratedIn'), iri('app', c.appUrl.replace('#', ''))) }
    if (c.sourceFile) { files.add(c.sourceFile); t(C, pc('implementedIn'), iri('file', c.sourceFile)) }
  }
  for (const [url, title] of apps) node(iri('app', url.replace('#', '')), 'App', title)
  for (const f of files) node(iri('file', f), 'SourceFile', f)
  for (const u of users) node(iri('user', u), 'User', u)

  return out.join('\n') + '\n'
}

module.exports = { generate, PC, D }
