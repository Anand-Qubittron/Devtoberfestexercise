const { build, query } = require('./store')
const { PC, D, GRAPHS } = require('./rdf')
const nlq = require('./nlq')

/**
 * Asking the graph:
 *  - featured questions: hand-tuned SPARQL with a tailored summary
 *  - free questions: understood through the ontology (nlq.js), SPARQL generated
 *  - "tell me about S-300": everything directly connected to one thing
 *
 * Every answer comes with its chain of reasoning, the named graphs (sources) it used,
 * and a notice when data needed for it is hidden for the user's role.
 */
const PREFIXES = nlq.PREFIXES
const ref = (type, key) => `<${D}${type}/${encodeURIComponent(key)}>`

const featured = [
  {
    id: 'users-affected-by-supplier',
    text: 'Which users are affected by supplier S-300?',
    keywords: ['user', 'who', 'affect', 'impact'],
    params: { supplier: 'S-300' },
    sparql: p => `SELECT DISTINCT ${sel('user', 'upload', 'row', 'material', 'supplier')} WHERE {
  BIND(${ref('supplier', p.supplier)} AS ?supplier)
  ?material pc:suppliedBy ?supplier .
  ?row pc:orders ?material .
  ?upload pc:hasRow ?row ; pc:uploadedBy ?user .
  ${labels('user', 'upload', 'row', 'material', 'supplier')}
} ORDER BY ?userLabel ?rowLabel`,
    chain: [['upload', 'uploadedBy', 'user'], ['upload', 'hasRow', 'row'], ['row', 'orders', 'material'], ['material', 'suppliedBy', 'supplier']],
    summary: n => `${n} path(s) from supplier to user — 4 hops: supplier ← material ← row ← upload → user`
  },
  {
    id: 'needs-attention',
    text: 'Which rows need attention and why?',
    keywords: ['attention', 'why', 'problem', 'wrong'],
    sparql: () => `SELECT ${sel('row', 'process', 'status')} ?message ${sel('waits')} WHERE {
  ?row pc:processedBy ?process . ?process pc:hasStatus ?status .
  VALUES ?status { pc:Parked pc:Failed }
  OPTIONAL { ?process pc:message ?message }
  OPTIONAL { ?process pc:waitsFor ?waits }
  ${labels('row', 'process', 'status', 'waits')}
} ORDER BY ?rowLabel`,
    chain: [['row', 'processedBy', 'process'], ['process', 'hasStatus', 'status'], ['process', 'waitsFor', 'waits']],
    summary: n => n ? `${n} row(s) need attention — each resumes by itself once the object it waits for is saved` : 'Nothing needs attention'
  },
  {
    id: 'risk-exposure',
    text: 'Which purchase requests depend on suppliers with high risk events?',
    keywords: ['risk', 'exposure', 'depend', 'purchase'],
    sparql: () => `SELECT DISTINCT ${sel('pr', 'supplier', 'company', 'event')} ?category ?amount WHERE {
  ?pr pc:fromSupplier ?supplier .
  ?supplier pc:sameEntityAs ?company .
  ?company pc:hasRiskEvent ?event .
  ?event pc:riskLevel "High" ; pc:riskCategory ?category .
  OPTIONAL { ?pr pc:amount ?amount }
  ${labels('pr', 'supplier', 'company', 'event')}
} ORDER BY ?supplierLabel ?prLabel`,
    chain: [['pr', 'fromSupplier', 'supplier'], ['supplier', 'sameEntityAs', 'company'], ['company', 'hasRiskEvent', 'event'], ['event', 'riskLevel', '=High']],
    summary: n => n ? `${n} purchase request(s) depend on suppliers with a high risk event — SAP data joined with an external feed via DUNS` : 'No purchase request depends on a supplier with a high risk event'
  },
  {
    id: 'volume-per-supplier',
    text: 'What is the purchase volume per supplier?',
    keywords: ['volume', 'spend', 'per supplier'],
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
    keywords: ['locking', 'locked'],
    sparql: () => `SELECT ${sel('holder', 'object')} ?mode WHERE {
  ?lock a pc:Lock ; pc:locks ?object ; pc:heldBy ?holder ; pc:lockMode ?mode .
  ${labels('holder', 'object')}
} ORDER BY ?holderLabel ?objectLabel`,
    chain: [['lock', 'locks', 'object'], ['lock', 'heldBy', 'holder']],
    summary: n => n ? `${n} lock(s) held right now` : 'Nothing is locked right now'
  },
  {
    id: 'sessions-built',
    text: 'What did I build from each Devtoberfest session?',
    keywords: ['learn', 'learned', 'build', 'built', 'devtoberfest'],
    sparql: () => `SELECT ${sel('session', 'concept', 'app', 'file')} WHERE {
  ?session a pc:Session ; pc:teaches ?concept .
  ?concept pc:demonstratedIn ?app ; pc:implementedIn ?file .
  ${labels('session', 'concept', 'app', 'file')}
} ORDER BY ?sessionLabel ?conceptLabel`,
    chain: [['session', 'teaches', 'concept'], ['concept', 'demonstratedIn', 'app'], ['concept', 'implementedIn', 'file']],
    summary: n => `${n} concept(s) turned into working features`
  }
]

/** Free questions shown as examples — none of them is hard-coded. */
const examples = [
  'Which suppliers are blocked?',
  'Which materials does Nordic Steel supply?',
  'Which purchase requests are for M-2001?',
  'How many parked rows per upload?',
  'Total amount of purchase requests per supplier',
  'Which risk events does Pacific Plastics have?',
  'Which users uploaded rows ordering M-3001?',
  'Which rows are waiting for a missing object?',
  'Which concepts are demonstrated in the Knowledge Graph app?',
  'Tell me about S-300'
]

const sel = (...vars) => vars.map(v => `?${v} ?${v}Label`).join(' ')
function labels(...vars) { return vars.map(v => `OPTIONAL { ?${v} rdfs:label ?${v}Label }`).join('\n  ') }

const APPS = ['process monitor', 'excel uploads', 'manage suppliers', 'manage materials', 'object locks', 'knowledge graph', 'purchase requests']
function extractParams(text) {
  const p = {}
  const s = /\bS-?\s?(\d{3})\b/i.exec(text); if (s) p.supplier = `S-${s[1]}`
  const a = APPS.find(name => text.toLowerCase().includes(name)); if (a) p.app = a
  return p
}

/** Featured question matching: whole keywords, plus a bonus when its parameters were given. */
function matchFeatured(text) {
  if (featured.some(q => q.text.toLowerCase() === text.trim().toLowerCase()))
    return { question: featured.find(q => q.text.toLowerCase() === text.trim().toLowerCase()), params: { ...extractParams(text) }, score: 99 }
  const lower = ' ' + text.toLowerCase().replace(/[^a-z0-9-]+/g, ' ') + ' '
  const words = lower.trim().split(' ')
  const hit = k => k.includes(' ') ? lower.includes(` ${k} `) : words.some(w => w.startsWith(k))
  const params = extractParams(text)
  let best = null
  for (const q of featured) {
    let score = q.keywords.filter(hit).length
    const needs = Object.keys(q.params ?? {})
    if (needs.length && needs.every(n => params[n])) score += 1.5
    if (needs.length && !needs.some(n => params[n])) score -= 0.5
    if (!best || score > best.score) best = { question: q, params: { ...q.params, ...params }, score }
  }
  return best
}

const label = (row, v) => row[v + 'Label']?.value ?? row[v]?.value
const short = iri => decodeURIComponent(iri.slice(iri.lastIndexOf(iri.includes('#') ? '#' : '/') + 1))
const nodeGroup = iri => iri?.startsWith(D) ? iri.slice(D.length).split('/')[0] : iri?.startsWith(PC) ? 'status' : 'value'
const graphLabel = g => GRAPHS[g?.split('/').pop()]?.label ?? 'Ontology'

/**
 * SPARQL JSON results → table rows, chain of reasoning, graph drawing and sources.
 * `chain` entries are [subject var, property (local name or IRI), object var or '=literal'].
 */
function explain(store, json, chain, lex) {
  const vars = json.head.vars ?? []
  const bindings = json.results.bindings
  const columns = vars.filter(v => !v.endsWith('Label'))
  const rows = bindings.map(b => Object.fromEntries(columns.map(v => [v, label(b, v) ?? null])))
  const propIri = p => p.startsWith('http') ? p : PC + p
  const propName = p => lex?.propLabel.get(propIri(p)) ?? short(propIri(p)).replace(/([A-Z])/g, ' $1').toLowerCase()

  // which named graph does each step come from?
  const steps = []
  bindings.slice(0, 100).forEach(b => chain.forEach(([s, p, o]) => {
    if (b[s] && (o.startsWith('=') || b[o])) steps.push({ s: b[s].value, p: propIri(p), o: o.startsWith('=') ? null : b[o].value })
  }))
  const source = new Map()
  if (steps.length) {
    const values = [...new Set(steps.map(x => `(<${x.s}> <${x.p}> ${x.o && x.o.startsWith('http') ? `<${x.o}>` : 'UNDEF'})`))].join(' ')
    for (const b of query(store, `SELECT DISTINCT ?s ?p ?o ?g WHERE { VALUES (?s ?p ?o) { ${values} } GRAPH ?g { ?s ?p ?o } }`).results.bindings)
      source.set(`${b.s.value}|${b.p.value}`, b.g.value)
  }
  const sources = new Map()

  const nodes = new Map(), lines = new Map()
  const addNode = (b, v) => {
    if (v.startsWith('=')) { const key = 'value:' + v; nodes.set(key, { key, title: v.slice(1), group: 'value' }); return key }
    const term = b[v]
    if (!term) return null
    if (!nodes.has(term.value)) nodes.set(term.value, { key: term.value, title: label(b, v), group: term.type === 'uri' ? nodeGroup(term.value) : 'value', iri: term.type === 'uri' ? term.value : null })
    return term.value
  }
  const reasons = bindings.map(b => chain.map(([s, p, o]) => {
    const from = addNode(b, s), to = addNode(b, o)
    if (!from || !to) return null
    const g = source.get(`${b[s].value}|${propIri(p)}`)
    if (g) sources.set(g, graphLabel(g))
    const id = `${from}|${p}|${to}`
    if (!lines.has(id)) lines.set(id, { from, to, title: `${propName(p)}${g ? ' · ' + graphLabel(g) : ''}` })
    return `${label(b, s)} → ${propName(p)} → ${o.startsWith('=') ? o.slice(1) : label(b, o)}${g ? `  [${graphLabel(g)}]` : ''}`
  }).filter(Boolean))

  const MAX_NODES = 60 // keep the drawing readable
  const shown = new Set([...nodes.keys()].slice(0, MAX_NODES))
  return {
    columns, rows, reasons,
    sources: [...sources].map(([iri, label]) => ({ iri, label, kind: GRAPHS[iri.split('/').pop()]?.kind })),
    graph: {
      nodes: [...nodes.values()].filter(n => shown.has(n.key)),
      lines: [...lines.values()].filter(l => shown.has(l.from) && shown.has(l.to)),
      truncated: nodes.size > MAX_NODES
    }
  }
}

/** Notice when the query needs properties that only exist in graphs hidden for this user. */
function restricted(sparql, ctx) {
  const visibleProps = new Set(), hiddenProps = new Map()
  const props = lines => lines.map(l => l.split(' ')[1])
  for (const g of ctx.visible) props(ctx.quads[g]).forEach(p => visibleProps.add(p))
  for (const g of ctx.hidden) for (const p of props(ctx.quads[g])) if (!visibleProps.has(p)) hiddenProps.set(p, GRAPHS[g].label)
  const used = new Set([...sparql.matchAll(/pc:(\w+)|<(https:\/\/devtoberfest\.local\/ontology#\w+)>/g)].map(m => `<${m[2] ?? PC + m[1]}>`))
  const hits = new Set([...used].filter(p => hiddenProps.has(p)).map(p => hiddenProps.get(p)))
  return hits.size ? [...hits] : null
}

async function describe(iri, labelText, ctx, lex) {
  const sparql = `SELECT ?direction ?relation ?other ?otherLabel ?graph WHERE {
  { GRAPH ?graph { <${iri}> ?relation ?other } BIND("→" AS ?direction) }
  UNION { GRAPH ?graph { ?other ?relation <${iri}> } BIND("←" AS ?direction) }
  OPTIONAL { ?other rdfs:label ?otherLabel }
} ORDER BY ?direction ?relation LIMIT 120`
  const json = query(ctx.store, PREFIXES + sparql)
  const center = { key: iri, title: labelText, group: nodeGroup(iri), iri }
  const nodes = new Map([[iri, center]]), lines = [], rows = [], sources = new Map(), reasons = []
  for (const b of json.results.bindings) {
    const rel = b.relation.value
    if (rel.endsWith('#label') || rel.endsWith('#type')) continue
    const name = lex.propLabel.get(rel) ?? short(rel)
    const other = b.other.value, otherTitle = b.otherLabel?.value ?? (b.other.type === 'uri' ? short(other) : other)
    const g = b.graph.value
    sources.set(g, graphLabel(g))
    rows.push({ direction: b.direction.value, relation: name, value: otherTitle, source: graphLabel(g) })
    const key = b.other.type === 'uri' ? other : `value:${name}:${other}`
    if (!nodes.has(key)) nodes.set(key, { key, title: otherTitle, group: b.other.type === 'uri' ? nodeGroup(other) : 'value', iri: b.other.type === 'uri' ? other : null })
    const [from, to] = b.direction.value === '→' ? [iri, key] : [key, iri]
    lines.push({ from, to, title: `${name} · ${graphLabel(g)}` })
    reasons.push([`${b.direction.value === '→' ? labelText : otherTitle} → ${name} → ${b.direction.value === '→' ? otherTitle : labelText}  [${graphLabel(g)}]`])
  }
  return {
    understood: true, mode: 'describe', interpretedAs: `Everything directly connected to ${labelText}`,
    sparql: PREFIXES + sparql, summary: `${rows.length} fact(s) about ${labelText}`,
    columns: ['direction', 'relation', 'value', 'source'], rows, reasons,
    sources: [...sources].map(([iri, label]) => ({ iri, label, kind: GRAPHS[iri.split('/').pop()]?.kind })),
    graph: { nodes: [...nodes.values()].slice(0, 60), lines: lines.filter(l => nodes.has(l.from) && nodes.has(l.to)), truncated: nodes.size > 60 }
  }
}

function finish(result, sparql, ctx) {
  if (!result.sources.length) {
    const used = new Set([...sparql.matchAll(/pc:(\w+)|<(https:\/\/devtoberfest\.local\/ontology#\w+)>/g)].map(m => `<${m[2] ?? PC + m[1]}>`))
    result.sources = ctx.visible.filter(g => ctx.quads[g].some(l => used.has(l.split(' ')[1])))
      .map(g => ({ iri: g, label: GRAPHS[g].label, kind: GRAPHS[g].kind }))
  }
  const hidden = restricted(sparql, ctx)
  if (hidden) result.restricted = `Part of the data this question needs is not visible for your role: ${hidden.join(', ')}. ` +
    (result.rows.length ? 'The answer may be incomplete.' : 'That is why the answer is empty.')
  return result
}

async function ask(text, user) {
  text = (text ?? '').trim()
  const ctx = await build(user)
  const lex = nlq.lexicon(ctx.store)

  // 1. a featured question, clearly recognised
  const f = matchFeatured(text)
  if (f && f.score >= 2) return runFeatured(f, ctx, lex)

  // 2. a free question, understood through the ontology
  const u = nlq.understand(text, ctx.store)
  if (u?.describe) return describe(u.describe, u.label, ctx, lex)
  if (u?.error) {
    // the ontology knows the connection — is it in a graph this user cannot see?
    const hidden = u.needs?.length && restricted(u.needs.map(p => `<${p}>`).join(' '), ctx)
    const message = u.error + (hidden ? ` The connection exists in data that is not visible for your role: ${hidden.join(', ')}.` : '')
    return { understood: false, message, restricted: hidden ? message : undefined, suggestions: examples }
  }
  if (u?.target) {
    const plan = nlq.toSparql(u)
    const sparql = PREFIXES + plan.sparql
    const result = explain(ctx.store, query(ctx.store, sparql), plan.chain, lex)
    const n = result.rows.length
    const summary = plan.aggregate
      ? (plan.groupVar ? `${n} group(s)` : `Result: ${Object.entries(result.rows[0] ?? {}).map(([k, v]) => `${k} ${v ?? 0}`).join(', ')}`)
      : `${n} result(s)`
    return finish({ understood: true, mode: 'free', interpretedAs: nlq.describePlan(u), sparql, summary, ...result }, sparql, ctx)
  }

  // 3. a weaker featured match
  if (f && f.score >= 1) return runFeatured(f, ctx, lex)
  return {
    understood: false,
    message: 'I could not connect this question to the ontology. Mention something the graph knows — suppliers, materials, rows, uploads, users, purchase requests, risk events, sessions — or a name or code such as S-300, M-1001, Nordic Steel or row 8.',
    suggestions: examples
  }
}

function runFeatured({ question, params }, ctx, lex) {
  const sparql = PREFIXES + question.sparql(params)
  const result = explain(ctx.store, query(ctx.store, sparql), question.chain, lex)
  const interpretedAs = question.params ? Object.entries(params).reduce((t, [k, v]) => question.params[k] ? t.replace(question.params[k], v) : t, question.text) : question.text
  return finish({ understood: true, mode: 'featured', questionId: question.id, interpretedAs, sparql, summary: question.summary(result.rows.length), ...result }, sparql, ctx)
}

async function sparql(text, user) {
  const ctx = await build(user)
  const full = /\bPREFIX\s+pc:/i.test(text) ? text : PREFIXES + text
  const json = query(ctx.store, full)
  const result = explain(ctx.store, json, [], null)
  // results with ?s ?p ?o are drawn as a graph
  if (['s', 'p', 'o'].every(v => json.head.vars?.includes(v))) {
    const nodes = new Map(), lines = []
    for (const b of json.results.bindings.slice(0, 80)) {
      if (!b.s || !b.p || !b.o) continue
      for (const t of [b.s, b.o]) nodes.set(t.value, { key: t.value, title: short(t.value), group: t.type === 'uri' ? nodeGroup(t.value) : 'value', iri: t.type === 'uri' ? t.value : null })
      lines.push({ from: b.s.value, to: b.o.value, title: short(b.p.value) })
    }
    result.graph = { nodes: [...nodes.values()], lines, truncated: json.results.bindings.length > 80 }
  }
  return finish({ understood: true, mode: 'sparql', sparql: full, summary: `${result.rows.length} result(s)`, ...result }, full, ctx)
}

/** One hop around a node — used when the user expands a node in the graph view. */
async function explore(iri, user) {
  const ctx = await build(user)
  const [b] = query(ctx.store, `SELECT ?l WHERE { <${iri}> <http://www.w3.org/2000/01/rdf-schema#label> ?l } LIMIT 1`).results.bindings
  return describe(iri, b?.l.value ?? short(iri), ctx, nlq.lexicon(ctx.store))
}

const questions = featured
module.exports = { questions, featured, examples, ask, sparql, explore, matchFeatured, PREFIXES }
