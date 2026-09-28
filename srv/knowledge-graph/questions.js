const { select } = require('./store')
const { PC, D } = require('./rdf')

/**
 * Natural language → SPARQL, offline: a catalogue of business questions the graph can answer.
 * A typed question is matched by keywords; codes like S-300, M-1001 or "row 13" become parameters.
 *
 * `chain` describes the path each answer follows ([subject var, predicate, object var]) —
 * that is the chain of reasoning shown with every answer.
 */
const PREFIXES = `PREFIX pc: <${PC}>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`
const ref = (type, key) => `<${D}${type}/${encodeURIComponent(key)}>`

const questions = [
  {
    id: 'users-affected-by-supplier',
    text: 'Which users are affected by supplier S-300?',
    keywords: ['user', 'who', 'affect', 'impact', 'supplier'],
    params: { supplier: 'S-300' },
    sparql: p => `SELECT DISTINCT ?user ?userLabel ?upload ?uploadLabel ?row ?rowLabel ?material ?materialLabel ?supplier ?supplierLabel WHERE {
  BIND(${ref('supplier', p.supplier)} AS ?supplier)
  ?supplier rdfs:label ?supplierLabel .
  ?material pc:suppliedBy ?supplier ; rdfs:label ?materialLabel .
  ?row pc:orders ?material ; rdfs:label ?rowLabel .
  ?upload pc:hasRow ?row ; rdfs:label ?uploadLabel ; pc:uploadedBy ?user .
  ?user rdfs:label ?userLabel .
} ORDER BY ?userLabel ?rowLabel`,
    chain: [['upload', 'uploaded by', 'user'], ['upload', 'has row', 'row'], ['row', 'orders', 'material'], ['material', 'supplied by', 'supplier']],
    summary: n => `${n} path(s) from supplier to user — 4 hops: supplier ← material ← row ← upload → user`
  },
  {
    id: 'rows-blocked-supplier',
    text: 'Which rows are stuck because their supplier is blocked?',
    keywords: ['stuck', 'blocked', 'block', 'row', 'because', 'supplier'],
    sparql: () => `SELECT ?row ?rowLabel ?material ?materialLabel ?supplier ?supplierLabel ?process ?processLabel ?status ?statusLabel WHERE {
  ?row a pc:UploadRow ; rdfs:label ?rowLabel ; pc:orders ?material ; pc:processedBy ?process .
  ?material rdfs:label ?materialLabel ; pc:suppliedBy ?supplier .
  ?supplier rdfs:label ?supplierLabel ; pc:blocked true .
  ?process rdfs:label ?processLabel ; pc:hasStatus ?status . ?status rdfs:label ?statusLabel .
  FILTER(?status NOT IN (pc:Completed, pc:Cancelled))
} ORDER BY ?rowLabel`,
    chain: [['row', 'orders', 'material'], ['material', 'supplied by', 'supplier'], ['supplier', 'is', '=blocked'], ['row', 'processed by', 'process'], ['process', 'has status', 'status']],
    summary: n => n ? `${n} row(s) cannot continue until their supplier is unblocked` : 'No open rows depend on a blocked supplier'
  },
  {
    id: 'needs-attention',
    text: 'Which rows need attention and why?',
    keywords: ['attention', 'why', 'parked', 'failed', 'problem', 'error', 'wrong'],
    sparql: () => `SELECT ?row ?rowLabel ?process ?processLabel ?status ?statusLabel ?message ?waits ?waitsLabel WHERE {
  ?row pc:processedBy ?process ; rdfs:label ?rowLabel .
  ?process rdfs:label ?processLabel ; pc:hasStatus ?status .
  VALUES ?status { pc:Parked pc:Failed }
  ?status rdfs:label ?statusLabel .
  OPTIONAL { ?process pc:message ?message }
  OPTIONAL { ?process pc:waitsFor ?waits . ?waits rdfs:label ?waitsLabel }
} ORDER BY ?rowLabel`,
    chain: [['row', 'processed by', 'process'], ['process', 'has status', 'status'], ['process', 'waits for', 'waits']],
    summary: n => n ? `${n} row(s) need attention — each resumes by itself once the object it waits for is saved` : 'Nothing needs attention'
  },
  {
    id: 'why-row',
    text: 'Why is row 13 not completed?',
    keywords: ['why', 'row', 'not', 'completed', 'status'],
    params: { row: '13' },
    sparql: p => `SELECT ?row ?rowLabel ?material ?materialLabel ?supplier ?supplierLabel ?process ?processLabel ?status ?statusLabel ?message ?waits ?waitsLabel WHERE {
  ?row pc:rowNumber ${Number(p.row)} ; rdfs:label ?rowLabel ; pc:processedBy ?process .
  ?process rdfs:label ?processLabel ; pc:hasStatus ?status . ?status rdfs:label ?statusLabel .
  OPTIONAL { ?row pc:orders ?material . ?material rdfs:label ?materialLabel .
             OPTIONAL { ?material pc:suppliedBy ?supplier . ?supplier rdfs:label ?supplierLabel } }
  OPTIONAL { ?process pc:message ?message }
  OPTIONAL { ?process pc:waitsFor ?waits . ?waits rdfs:label ?waitsLabel }
} ORDER BY ?rowLabel`,
    chain: [['row', 'processed by', 'process'], ['process', 'has status', 'status'], ['process', 'waits for', 'waits'], ['row', 'orders', 'material'], ['material', 'supplied by', 'supplier']],
    summary: n => `${n} row(s) with this number (one per upload)`
  },
  {
    id: 'materials-of-supplier',
    text: 'Which materials does supplier S-100 supply?',
    keywords: ['material', 'supply', 'supplies', 'deliver', 'supplier'],
    params: { supplier: 'S-100' },
    sparql: p => `SELECT ?material ?materialLabel ?price ?supplier ?supplierLabel WHERE {
  BIND(${ref('supplier', p.supplier)} AS ?supplier)
  ?supplier rdfs:label ?supplierLabel .
  ?material pc:suppliedBy ?supplier ; rdfs:label ?materialLabel .
  OPTIONAL { ?material pc:price ?price }
} ORDER BY ?materialLabel`,
    chain: [['material', 'supplied by', 'supplier']],
    summary: n => `${n} material(s)`
  },
  {
    id: 'where-used-material',
    text: 'Where is material M-1001 used?',
    keywords: ['where', 'used', 'use', 'material'],
    params: { material: 'M-1001' },
    sparql: p => `SELECT ?material ?materialLabel ?upload ?uploadLabel ?row ?rowLabel ?pr ?prLabel WHERE {
  BIND(${ref('material', p.material)} AS ?material)
  ?material rdfs:label ?materialLabel .
  ?row pc:orders ?material ; rdfs:label ?rowLabel .
  ?upload pc:hasRow ?row ; rdfs:label ?uploadLabel .
  OPTIONAL { ?row pc:resultedIn ?pr . ?pr rdfs:label ?prLabel }
} ORDER BY ?rowLabel`,
    chain: [['upload', 'has row', 'row'], ['row', 'orders', 'material'], ['row', 'resulted in', 'pr']],
    summary: n => `${n} row(s) order this material`
  },
  {
    id: 'volume-per-supplier',
    text: 'What is the purchase volume per supplier?',
    keywords: ['volume', 'spend', 'amount', 'total', 'sum', 'how much', 'per supplier'],
    sparql: () => `SELECT ?supplier ?supplierLabel (COUNT(?pr) AS ?requests) (SUM(?amount) AS ?volume) WHERE {
  ?pr a pc:PurchaseRequest ; pc:fromSupplier ?supplier ; pc:amount ?amount .
  ?supplier rdfs:label ?supplierLabel .
} GROUP BY ?supplier ?supplierLabel ORDER BY DESC(?volume)`,
    chain: [],
    summary: n => `${n} supplier(s) with purchase requests (aggregated over purchase request → supplier)`
  },
  {
    id: 'locks-now',
    text: 'Who is locking what right now?',
    keywords: ['lock', 'locking', 'locked', 'editing', 'who'],
    sparql: () => `SELECT ?holder ?holderLabel ?object ?objectLabel ?mode WHERE {
  ?lock a pc:Lock ; pc:locks ?object ; pc:heldBy ?holder ; pc:lockMode ?mode .
  ?object rdfs:label ?objectLabel . ?holder rdfs:label ?holderLabel .
} ORDER BY ?holderLabel ?objectLabel`,
    chain: [['holder', 'locks', 'object']],
    summary: n => n ? `${n} lock(s) held right now` : 'Nothing is locked right now'
  },
  {
    id: 'sessions-built',
    text: 'What did I build from each Devtoberfest session?',
    keywords: ['session', 'learn', 'learned', 'build', 'built', 'devtoberfest', 'concept'],
    sparql: () => `SELECT ?session ?sessionLabel ?concept ?conceptLabel ?app ?appLabel ?file ?fileLabel WHERE {
  ?session a pc:Session ; rdfs:label ?sessionLabel ; pc:teaches ?concept .
  ?concept rdfs:label ?conceptLabel ; pc:demonstratedIn ?app ; pc:implementedIn ?file .
  ?app rdfs:label ?appLabel . ?file rdfs:label ?fileLabel .
} ORDER BY ?sessionLabel ?conceptLabel`,
    chain: [['session', 'teaches', 'concept'], ['concept', 'demonstrated in', 'app'], ['concept', 'implemented in', 'file']],
    summary: n => `${n} concept(s) turned into working features`
  },
  {
    id: 'app-origin',
    text: 'Which sessions are behind the Object Locks app?',
    keywords: ['which session', 'behind', 'origin', 'come from', 'app'],
    params: { app: 'Object Locks' },
    sparql: p => `SELECT ?app ?appLabel ?concept ?conceptLabel ?session ?sessionLabel WHERE {
  ?app a pc:App ; rdfs:label ?appLabel . FILTER(LCASE(STR(?appLabel)) = ${JSON.stringify(p.app.toLowerCase())})
  ?concept pc:demonstratedIn ?app ; rdfs:label ?conceptLabel .
  ?session pc:teaches ?concept ; rdfs:label ?sessionLabel .
}`,
    chain: [['session', 'teaches', 'concept'], ['concept', 'demonstrated in', 'app']],
    summary: n => `${n} concept(s) behind this app`
  }
]

const APPS = ['process monitor', 'excel uploads', 'manage suppliers', 'manage materials', 'object locks', 'knowledge graph', 'purchase requests']

function extractParams(text) {
  const p = {}
  const s = /\bS-?\s?(\d{3})\b/i.exec(text); if (s) p.supplier = `S-${s[1]}`
  const m = /\bM-?\s?(\d{4})\b/i.exec(text); if (m) p.material = `M-${m[1]}`
  const r = /\brow\s*(\d+)\b/i.exec(text); if (r) p.row = r[1]
  const a = APPS.find(name => text.toLowerCase().includes(name)); if (a) p.app = a
  return p
}

/** Picks the best matching question: keyword hits, plus a bonus when its parameters were given. */
function match(text) {
  const lower = ' ' + text.toLowerCase().replace(/[^a-z0-9-]+/g, ' ') + ' '
  const words = lower.trim().split(' ')
  // whole words, allowing endings: "row" matches "rows" but not "tomorrow"; phrases match as a whole
  const hit = k => k.includes(' ') ? lower.includes(` ${k} `) : words.some(w => w.startsWith(k))
  const params = extractParams(text)
  let best = null
  for (const q of questions) {
    let score = q.keywords.filter(hit).length
    const needs = Object.keys(q.params ?? {})
    if (needs.length && needs.every(n => params[n])) score += 1.5
    if (needs.length && !needs.some(n => params[n])) score -= 0.5
    if (!best || score > best.score) best = { q, score }
  }
  if (!best || best.score < 1) return null
  return { question: best.q, params: { ...best.q.params, ...params } }
}

const label = (row, v) => row[v + 'Label']?.value ?? row[v]?.value
const nodeGroup = iri => iri?.startsWith(D) ? iri.slice(D.length).split('/')[0] : iri?.startsWith(PC) ? 'status' : 'value'

/** Turns SPARQL JSON results into rows + the chain of reasoning (triples) + a graph. */
function explain(json, chain = []) {
  const vars = json.head.vars ?? []
  const bindings = json.results.bindings
  const columns = vars.filter(v => !vars.includes(v + 'Label'))
  const rows = bindings.map(b => Object.fromEntries(columns.map(v => [v, label(b, v) ?? null])))

  const nodes = new Map(), lines = new Map()
  const addNode = (b, v) => {
    if (v.startsWith('=')) { const key = 'value:' + v; nodes.set(key, { key, title: v.slice(1), group: 'value' }); return key }
    const term = b[v]
    if (!term) return null
    const key = term.value
    if (!nodes.has(key)) nodes.set(key, { key, title: label(b, v), group: term.type === 'uri' ? nodeGroup(term.value) : 'value' })
    return key
  }
  const reasons = bindings.map(b => chain.map(([s, p, o]) => {
    const from = addNode(b, s), to = addNode(b, o)
    if (!from || !to) return null
    const id = `${from}|${p}|${to}`
    if (!lines.has(id)) lines.set(id, { from, to, title: p })
    return `${label(b, s)} → ${p} → ${o.startsWith('=') ? o.slice(1) : label(b, o)}`
  }).filter(Boolean))

  const MAX_NODES = 60 // keep the drawing readable
  const shown = new Set([...nodes.keys()].slice(0, MAX_NODES))
  return {
    columns, rows, reasons,
    graph: {
      nodes: [...nodes.values()].filter(n => shown.has(n.key)),
      lines: [...lines.values()].filter(l => shown.has(l.from) && shown.has(l.to)),
      truncated: nodes.size > MAX_NODES
    }
  }
}

async function ask(text) {
  const found = match(text ?? '')
  if (!found) return {
    understood: false,
    message: 'I could not map this question to the graph. Try one of the suggested questions, or write SPARQL yourself.',
    suggestions: questions.map(q => q.text)
  }
  const { question, params } = found
  const sparql = PREFIXES + question.sparql(params)
  const result = explain(await select(sparql), question.chain)
  return { understood: true, questionId: question.id, interpretedAs: interpret(question, params), params, sparql, summary: question.summary(result.rows.length), ...result }
}

function interpret(q, params) {
  let t = q.text
  for (const [k, v] of Object.entries(params)) if (q.params?.[k]) t = t.replace(q.params[k], v)
  return t
}

async function sparql(query) {
  const text = /\bPREFIX\s+pc:/i.test(query) ? query : PREFIXES + query
  const json = await select(text)
  const result = explain(json, [])
  // results with ?s ?p ?o are drawn as a graph
  if (['s', 'p', 'o'].every(v => json.head.vars?.includes(v))) {
    const short = term => term.value.split(/[#/]/).pop()
    const nodes = new Map(), lines = []
    for (const b of json.results.bindings.slice(0, 80)) {
      if (!b.s || !b.p || !b.o) continue
      for (const t of [b.s, b.o]) nodes.set(t.value, { key: t.value, title: decodeURIComponent(short(t)), group: t.type === 'uri' ? nodeGroup(t.value) : 'value' })
      lines.push({ from: b.s.value, to: b.o.value, title: short(b.p) })
    }
    result.graph = { nodes: [...nodes.values()], lines, truncated: json.results.bindings.length > 80 }
  }
  return { understood: true, sparql: text, summary: `${result.rows.length} result(s)`, ...result }
}

module.exports = { questions, ask, sparql, match, PREFIXES }
