const { query } = require('./store')
const { PC, D } = require('./rdf')

/**
 * Ontology-driven question understanding — no fixed question list, no LLM.
 *
 *  1. Vocabulary from the ontology: class and property labels + skos:altLabel synonyms
 *  2. Entities from the data: codes (S-100, M-1001, PR-000012), names (Nordic Steel),
 *     users, statuses, "row 13", and literal values such as "High" or "ESG"
 *  3. Intent: list / how many / total … per …
 *  4. The shortest path through the schema from what is asked for to everything mentioned
 *  5. SPARQL generated from that path — the path is also the chain of reasoning
 *
 * The same idea (the ontology tells the system how to build the query) is what SAP uses
 * with an LLM; here it is deterministic, so every interpretation can be shown and checked.
 */
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const local = iri => iri.slice(iri.lastIndexOf(iri.includes('#') ? '#' : '/') + 1)
const PREFIXES = `PREFIX pc: <${PC}>\nPREFIX rdfs: <${RDFS}>\n`
const rows = (store, sparql) => query(store, PREFIXES + sparql).results.bindings

// process-internal links are only used when nothing more direct exists
const EDGE_WEIGHT = { waitsFor: 2.5, locks: 3, heldBy: 3, locatedIn: 2 }
const LEGAL = /\b(ab|gmbh|ltd|limited|sa|oy|inc|llc|ag|aktiebolag|gesellschaft mbh|mbh)\b\.?/g
// entity kinds whose labels are long sentences — they are found via other words
const NO_LABEL_ALIAS = new Set(['UploadRow', 'Process', 'Lock', 'RiskEvent', 'Session', 'Concept'])

const norm = s => ' ' + s.toLowerCase().replace(/[“”"?!.,;:()]/g, ' ').replace(/\s+/g, ' ').trim() + ' '
const plural = w => w.endsWith('y') && !/[aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : /(s|x|ch|sh)$/.test(w) ? w + 'es' : w + 's'

/** Vocabulary + schema, read from the user's graph. */
function lexicon(store) {
  const classes = new Map(), classLabel = new Map(), props = new Map(), propLabel = new Map()
  for (const b of rows(store, `PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?x ?kind ?l ?pref WHERE {
      VALUES ?kind { owl:Class owl:ObjectProperty owl:DatatypeProperty } ?x a ?kind .
      { ?x rdfs:label ?l BIND(true AS ?pref) } UNION { ?x skos:altLabel ?l }
    }`)) {
    const x = b.x.value, l = b.l.value.toLowerCase(), isClass = b.kind.value.endsWith('Class')
    if (b.pref) (isClass ? classLabel : propLabel).set(x, b.l.value)
    const add = (m, term) => m.has(term) || m.set(term, x)
    if (isClass) { add(classes, l); add(classes, plural(l)) } else add(props, l)
  }
  const edges = rows(store, `SELECT DISTINCT ?sc ?p ?oc WHERE {
      ?s ?p ?o . ?s a ?sc . ?o a ?oc . FILTER(isIRI(?o) && STRSTARTS(STR(?p), "${PC}") && STRSTARTS(STR(?sc), "${PC}") && STRSTARTS(STR(?oc), "${PC}"))
    }`).map(b => ({ from: b.sc.value, prop: b.p.value, to: b.oc.value }))
  const attributes = rows(store, `SELECT DISTINCT ?c ?p ?dt WHERE {
      ?s a ?c ; ?p ?v . FILTER(isLiteral(?v) && STRSTARTS(STR(?p), "${PC}")) BIND(DATATYPE(?v) AS ?dt)
    }`).map(b => ({ cls: b.c.value, prop: b.p.value, datatype: b.dt?.value }))
  // numeric properties as declared in the ontology — known even when the data is hidden for this user
  const measures = rows(store, `PREFIX owl: <http://www.w3.org/2002/07/owl#>
    SELECT ?p ?d WHERE { ?p a owl:DatatypeProperty ; rdfs:range ?r ; rdfs:domain ?d . FILTER(?r IN (<${XSD}decimal>, <${XSD}integer>)) }`)
    .map(b => ({ prop: b.p.value, cls: b.d.value }))
  const schemaEdges = rows(store, `PREFIX owl: <http://www.w3.org/2002/07/owl#>
    SELECT ?d ?p ?r WHERE { ?p a owl:ObjectProperty ; rdfs:domain ?d ; rdfs:range ?r }`)
    .map(b => ({ from: b.d.value, prop: b.p.value, to: b.r.value }))
  // properties that can be compared with a number ("quantity 0", "amount over 5000")
  const numeric = new Set(rows(store, `PREFIX owl: <http://www.w3.org/2002/07/owl#>
    SELECT ?p WHERE { ?p a owl:DatatypeProperty ; rdfs:range ?r . FILTER(?r IN (<${XSD}decimal>, <${XSD}integer>) && ?p != pc:rowNumber) }`)
    .map(b => b.p.value))
  return { classes, classLabel, props, propLabel, edges, attributes, measures, schemaEdges, numeric }
}

/** Things mentioned by name: entities in the data, statuses, literal values. */
function entityIndex(store) {
  const aliases = [] // { alias, caseSensitive, kind: 'entity' | 'literal', ... }
  for (const b of rows(store, `SELECT ?e ?label ?c WHERE {
      ?e a ?c ; rdfs:label ?label . FILTER(STRSTARTS(STR(?c), "${PC}") && (STRSTARTS(STR(?e), "${D}") || ?c = pc:ProcessStatus))
    }`)) {
    const e = b.e.value, label = b.label.value, cls = b.c.value, kind = local(cls)
    const add = (alias, caseSensitive = alias.length <= 3) => alias.trim().length >= 2 &&
      aliases.push({ alias: alias.trim(), caseSensitive, kind: 'entity', iri: e, cls, label })
    const code = /^([A-Z]{1,3}-\d+)\b\s*(.*)$/.exec(label)
    if (code) {
      add(code[1], false)
      if (code[2]) { add(code[2]); add(code[2].toLowerCase().replace(LEGAL, '').trim()) }
    } else if (!NO_LABEL_ALIAS.has(kind)) {
      const name = label.replace(/\s*\([^)]*\)\s*$/, '')
      add(name)
      // short names ("Nordic Steel") belong to our own master data; external records need their full name
      if (kind !== 'ExternalCompany') add(name.toLowerCase().replace(LEGAL, '').replace(/\s+/g, ' ').trim())
    }
  }
  // synonyms of statuses (stuck → Parked, done → Completed)
  for (const b of rows(store, `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?e ?l ?label WHERE { ?e a pc:ProcessStatus ; skos:altLabel ?l ; rdfs:label ?label }`))
    aliases.push({ alias: b.l.value, kind: 'entity', iri: b.e.value, cls: PC + 'ProcessStatus', label: b.label.value })
  // short, repeating text values: "High" risk, "ESG", track "Data", step "Validate" …
  const values = rows(store, `SELECT ?c ?p ?v (COUNT(*) AS ?n) WHERE {
      ?s a ?c ; ?p ?v . FILTER(isLiteral(?v) && DATATYPE(?v) = <${XSD}string> && STRLEN(?v) >= 3 && STRLEN(?v) <= 24
        && STRSTARTS(STR(?p), "${PC}") && ?p NOT IN (pc:dunsNumber, pc:orderedMaterialNo))
    } GROUP BY ?c ?p ?v`)
  const distinct = new Map()
  for (const b of values) distinct.set(b.p.value, (distinct.get(b.p.value) ?? 0) + 1)
  for (const b of values) if (distinct.get(b.p.value) <= 12) aliases.push({
    alias: b.v.value, kind: 'literal', cls: b.c.value, prop: b.p.value, value: b.v.value, label: `${local(b.p.value)} = ${b.v.value}`
  })
  aliases.sort((a, b) => b.alias.length - a.alias.length)
  return aliases
}

const OPS = [['more than', '>'], ['greater than', '>'], ['higher than', '>'], ['over', '>'], ['above', '>'], ['at least', '>='],
  ['less than', '<'], ['lower than', '<'], ['below', '<'], ['under', '<'], ['at most', '<='], ['up to', '<=']]
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "quantity 0", "amount over 5000", "price below 20" — removed from the question once recognised. */
function comparisons(question, lex) {
  let base = ' ' + question.replace(/(\d),(\d{3})\b/g, '$1$2').replace(/\bzero\b/gi, '0') + ' '
  const compares = []
  for (const [term, prop] of [...lex.props].sort((a, b) => b[0].length - a[0].length)) {
    if (!lex.numeric.has(prop)) continue
    const ops = OPS.map(([words]) => escape(words)).join('|')
    const re = new RegExp(`\\s(?:an? |the )?${escape(term)}\\s+(?:is |of |= ?|equal to |equals )?(?:(${ops}) )?(-?\\d+(?:\\.\\d+)?)(?=[\\s?!.,;:)])`)
    const m = re.exec(base.toLowerCase())
    if (!m) continue
    compares.push({ prop, op: OPS.find(([words]) => words === m[1])?.[1] ?? '=', value: Number(m[2]) })
    base = base.slice(0, m.index) + ' '.repeat(m[0].length) + base.slice(m.index + m[0].length)
  }
  return { compares, rest: base }
}

// "no DUNS number", "without purchase requests", "do not have a price"
const NEGATED = / (?:no|without|without an?|without any|not have|not have an?|not have any)$/
const negatedAt = (text, at) => NEGATED.test(text.slice(0, at))

/** Finds non-overlapping mentions, longest first. */
function scan(question, lex, aliases) {
  const { compares, rest } = comparisons(question, lex)
  question = rest
  const text = norm(question), taken = []
  const free = (i, n) => !taken.some(([a, b]) => i < b && a < i + n)
  const find = (term, caseSensitive) => {
    const hay = caseSensitive ? ' ' + question.replace(/[?!.,;:]/g, ' ') + ' ' : text
    const needle = caseSensitive ? ` ${term} ` : ` ${term.toLowerCase()} `
    let i = -1
    // reserve the words only, not the spaces around them — neighbours share those
    while ((i = hay.indexOf(needle, i + 1)) >= 0) if (free(i + 1, needle.length - 2)) { taken.push([i + 1, i + needle.length - 1]); return i }
    return -1
  }
  const found = { entities: [], literals: [], classes: [], props: [], rowNumbers: [], booleans: [], compares, absent: [] }

  // "row 13", "rows 7 and 8"
  for (const m of text.matchAll(/ rows? (\d+)(?: (?:and|,) (\d+))? /g)) {
    found.rowNumbers.push(Number(m[1])); if (m[2]) found.rowNumbers.push(Number(m[2]))
    taken.push([m.index + 1, m.index + m[0].length - 1])
  }
  // boolean properties: "blocked" / "not blocked" / "unblocked"
  for (const [term, prop] of lex.props) {
    if (!lex.attributes.some(a => a.prop === prop && a.datatype === XSD + 'boolean')) continue
    const neg = find(`not ${term}`) >= 0 || find(`un${term}`) >= 0
    if (neg || find(term) >= 0) found.booleans.push({ prop, value: !neg, cls: lex.attributes.find(a => a.prop === prop).cls })
  }
  for (const a of aliases) {
    const at = find(a.alias, a.caseSensitive)
    if (at >= 0) (a.kind === 'entity' ? found.entities : found.literals).push({ ...a, at })
  }
  for (const [term, cls] of [...lex.classes].sort((a, b) => b[0].length - a[0].length)) {
    const at = find(term)
    if (at >= 0) found.classes.push({ cls, term, at, negated: negatedAt(text, at) })
  }
  for (const [term, prop] of lex.props) {
    const at = find(term)
    if (at < 0) continue
    found.props.push(prop)
    if (negatedAt(text, at)) found.absent.push(prop)
  }
  for (const c of compares) found.props.push(c.prop)
  found.classes.sort((a, b) => a.at - b.at)
  return found
}

/** Cheapest path between two classes in the schema graph (edges can be walked both ways). */
function shortestPath(edges, from, to, preferred) {
  if (from === to) return []
  const dist = new Map([[from, 0]]), prev = new Map(), open = new Set([from])
  while (open.size) {
    const cur = [...open].reduce((a, b) => dist.get(a) <= dist.get(b) ? a : b)
    open.delete(cur)
    if (cur === to) break
    for (const e of edges) {
      for (const [a, b, forward] of [[e.from, e.to, true], [e.to, e.from, false]]) {
        if (a !== cur || a === b) continue
        const w = (EDGE_WEIGHT[local(e.prop)] ?? 1) * (preferred.has(e.prop) ? 0.6 : 1)
        const d = dist.get(cur) + w
        if (d < (dist.get(b) ?? Infinity)) { dist.set(b, d); prev.set(b, { from: cur, edge: e, forward }); open.add(b) }
      }
    }
  }
  if (!prev.has(to)) return null
  const steps = []
  for (let n = to; n !== from; n = prev.get(n).from) steps.unshift(prev.get(n))
  return steps.map(s => ({ prop: s.edge.prop, forward: s.forward, fromCls: s.from, toCls: s.forward ? s.edge.to : s.edge.from }))
}

function understand(question, store) {
  const lex = lexicon(store), aliases = entityIndex(store)
  const f = scan(question, lex, aliases)
  const text = norm(question)

  const count = / how many | number of | count /.test(text)
  const sum = / total | sum | how much /.test(text) && !count
  const describe = / tell me about | what do (we|you) know about | describe | details (of|for|about) /.test(text)
  const why = / why | reason /.test(text)

  // a missing material is not a Material (yet) — "which materials are missing" asks for the missing objects
  if (f.classes.some(c => c.cls === PC + 'MissingObject')) f.classes = f.classes.filter(c => c.cls !== PC + 'Material')
  // "materials without purchase requests": the negated class is a condition, not what is asked for
  const negated = f.classes.filter(c => c.negated).map(c => c.cls)
  f.classes = f.classes.filter(c => !c.negated)

  // anchors: everything the question pins down
  const anchors = []
  const byClass = new Map()
  for (const e of f.entities) {
    if (!byClass.has(e.cls)) byClass.set(e.cls, { kind: 'iris', cls: e.cls, iris: [], labels: [] })
    const a = byClass.get(e.cls); if (!a.iris.includes(e.iri)) { a.iris.push(e.iri); a.labels.push(e.label) }
  }
  anchors.push(...byClass.values())
  for (const l of f.literals) anchors.push({ kind: 'literal', cls: l.cls, prop: l.prop, value: l.value, labels: [l.value] })
  for (const b of f.booleans) anchors.push({ kind: 'literal', cls: b.cls, prop: b.prop, value: b.value, datatype: 'boolean', labels: [b.value ? local(b.prop) : `not ${local(b.prop)}`] })
  if (f.rowNumbers.length) anchors.push({ kind: 'literal', cls: PC + 'UploadRow', prop: PC + 'rowNumber', value: f.rowNumbers, datatype: 'integer', labels: f.rowNumbers.map(n => `row ${n}`) })

  // measure for totals: a numeric property that is mentioned, otherwise "amount"
  const measure = sum ? (lex.measures.find(a => f.props.includes(a.prop)) ?? lex.measures.find(a => local(a.prop) === 'amount')) : null
  // grouping: "per supplier", "by upload", "for each session"
  const groupMatch = / (?:per|by|for each|each) ([a-z ]+?) /.exec(text)
  const groupClass = groupMatch && f.classes.find(c => text.indexOf(' ' + c.term + ' ') === groupMatch.index + groupMatch[0].indexOf(groupMatch[1]) - 1)?.cls

  // what is asked for: the first class mentioned that is not just the grouping; "who" → users
  let target = sum && measure ? measure.cls
    : f.classes.find(c => c.cls !== groupClass)?.cls ?? (/ who /.test(text) ? PC + 'User' : f.rowNumbers.length ? PC + 'UploadRow' : null)
  if (describe || (!target && anchors.length === 1 && anchors[0].kind === 'iris' && anchors[0].iris.length === 1)) {
    const a = anchors.find(x => x.kind === 'iris')
    if (a) return { describe: a.iris[0], label: a.labels[0] }
  }
  if (!target || (!anchors.length && !count && !sum && !groupClass && f.classes.length < 2)) {
    // "Which suppliers?" alone is fine as a list; nothing recognised at all is not
    if (!target) return null
  }

  // conditions on values: on the thing asked for when it has the property, otherwise on a class mentioned
  const owner = prop => {
    const has = lex.attributes.filter(a => a.prop === prop).map(a => a.cls)
    return has.includes(target) ? target : f.classes.map(c => c.cls).find(c => has.includes(c)) ?? has[0]
  }
  for (const c of [...f.compares, ...f.absent.map(prop => ({ prop, absent: true }))]) {
    const cls = owner(c.prop), name = lex.propLabel.get(c.prop) ?? local(c.prop)
    // the property exists in the ontology, but not in any data this user can see
    if (!cls) return { error: `I can't see ${name} in the data you can see.`, needs: [c.prop] }
    anchors.push(c.absent
      ? { kind: 'absent', cls, prop: c.prop, labels: [`no ${name}`] }
      : { kind: 'compare', cls, prop: c.prop, op: c.op, value: c.value, labels: [`${name} ${c.op === '=' ? '' : c.op + ' '}${c.value}`] })
  }

  // paths: target → every anchor, and target → classes mentioned along the way
  const preferred = new Set(f.props)
  const hints = f.classes.map(c => c.cls).filter(c => c !== target && c !== groupClass && !anchors.some(a => a.cls === c))
  const plans = []
  for (const a of anchors) {
    const via = hints.find(h => shortestPath(lex.edges, target, h, preferred) && shortestPath(lex.edges, h, a.cls, preferred))
    const path = via
      ? [...shortestPath(lex.edges, target, via, preferred), ...shortestPath(lex.edges, via, a.cls, preferred)]
      : shortestPath(lex.edges, target, a.cls, preferred)
    if (!path) return {
      error: `I can't connect ${lex.classLabel.get(target)} with ${lex.classLabel.get(a.cls) ?? local(a.cls)} in the data you can see.`,
      needs: shortestPath(lex.schemaEdges, target, a.cls, preferred)?.map(s => s.prop) ?? []
    }
    plans.push({ path, anchor: a })
  }
  for (const h of hints) if (!plans.some(p => p.path.some(s => s.toCls === h))) {
    const path = shortestPath(lex.edges, target, h, preferred)
    if (path) { plans.push({ path, anchor: null }); continue }
    // never drop part of a question silently
    const inOntology = shortestPath(lex.schemaEdges, target, h, preferred)
    return {
      error: `I can't connect ${lex.classLabel.get(target)} with ${lex.classLabel.get(h)} in the data you can see.`,
      needs: inOntology?.map(s => s.prop) ?? []
    }
  }
  for (const n of negated) {
    if (n === target) continue
    const path = shortestPath(lex.edges, target, n, preferred)
    if (!path) return {
      error: `I can't connect ${lex.classLabel.get(target)} with ${lex.classLabel.get(n)} in the data you can see.`,
      needs: shortestPath(lex.schemaEdges, target, n, preferred)?.map(s => s.prop) ?? []
    }
    plans.push({ path, anchor: null, negate: n })
  }
  let groupPath = null
  if (groupClass && groupClass !== target) {
    groupPath = shortestPath(lex.edges, target, groupClass, preferred)
    if (!groupPath) return { error: `I don't see a connection between ${lex.classLabel.get(target)} and ${lex.classLabel.get(groupClass)}.` }
    plans.push({ path: groupPath, anchor: null, group: true })
  }
  // asking why, or about a status: show the process's reason and what it waits for
  const reasons = why || anchors.some(a => a.cls === PC + 'ProcessStatus')
  return { target, plans, count, sum, measure, groupClass, reasons, lex }
}

/** Turns an interpretation into SPARQL + the chain of reasoning. */
function toSparql(u) {
  const { lex } = u
  const names = new Map(), used = new Set(), classOf = new Map()
  const varFor = (signature, cls) => {
    if (names.has(signature)) return names.get(signature)
    let base = local(cls).replace(/^./, c => c.toLowerCase()), name = base, i = 2
    while (used.has(name)) name = base + i++
    used.add(name); names.set(signature, name); classOf.set(name, cls); return name
  }
  const t = varFor('', u.target)
  const where = [`?${t} a <${u.target}> .`], chain = [], labelled = new Set([t]), filters = []
  let groupVar = null

  for (const plan of u.plans) {
    // "without …": the path must not exist — its variables are not part of the answer
    if (plan.negate) {
      const inner = []
      let cur = t
      plan.path.forEach((step, i) => {
        const next = i === plan.path.length - 1 ? varFor('!' + plan.negate, step.toCls) : `${t}_no${u.plans.indexOf(plan)}_${i}`
        inner.push(step.forward ? `?${cur} <${step.prop}> ?${next} .` : `?${next} <${step.prop}> ?${cur} .`)
        cur = next
      })
      filters.push(`FILTER NOT EXISTS { ${inner.join(' ')} ?${cur} a <${plan.negate}> . }`)
      continue
    }
    let sig = '', cur = t
    for (const step of plan.path) {
      sig += `|${step.forward ? '' : '^'}${step.prop}`
      const next = varFor(sig, step.toCls)
      const triple = step.forward ? `?${cur} <${step.prop}> ?${next} .` : `?${next} <${step.prop}> ?${cur} .`
      if (!where.includes(triple)) where.push(triple)
      // a link such as "waits for" can point to different kinds of things — pin the class
      const typed = `?${next} a <${step.toCls}> .`
      if (!where.includes(typed)) where.push(typed)
      const link = step.forward ? [cur, step.prop, next] : [next, step.prop, cur]
      if (!chain.some(c => c.join() === link.join())) chain.push(link)
      labelled.add(next); cur = next
    }
    if (plan.group) groupVar = cur
    const a = plan.anchor
    if (!a) continue
    if (a.kind === 'iris') {
      where.push(`VALUES ?${cur} { ${a.iris.map(i => `<${i}>`).join(' ')} }`)
    } else if (a.kind === 'compare') {
      const v = `${cur}_${local(a.prop)}`
      where.push(`?${cur} <${a.prop}> ?${v} .`); filters.push(`FILTER(?${v} ${a.op} ${a.value})`)
      chain.push([cur, a.prop, '=' + (a.op === '=' ? '' : a.op + ' ') + a.value])
    } else if (a.kind === 'absent') {
      filters.push(`FILTER NOT EXISTS { ?${cur} <${a.prop}> ?${cur}_${local(a.prop)} }`)
    } else {
      const values = [].concat(a.value)
      const lit = v => a.datatype === 'boolean' ? String(v) : a.datatype === 'integer' ? String(v) : JSON.stringify(v)
      if (values.length === 1) {
        where.push(`?${cur} <${a.prop}> ${lit(values[0])} .`)
        chain.push([cur, a.prop, '=' + values[0]])
      } else {
        const v = `${cur}_${local(a.prop)}`
        where.push(`?${cur} <${a.prop}> ?${v} .`); filters.push(`FILTER(?${v} IN (${values.map(lit).join(', ')}))`)
        chain.push([cur, a.prop, '=' + values.join(' / ')])
      }
    }
  }
  const optional = [...labelled].map(v => `OPTIONAL { ?${v} rdfs:label ?${v}Label }`)
  const body = [...where, ...filters, ...optional].map(l => '  ' + l).join('\n')

  if (u.count || u.sum) {
    const m = u.sum && u.measure
    const owner = m ? (m.cls === u.target ? t : [...names].find(([, n]) => n !== t && lex.attributes.some(a => a.cls === u.target))?.[1] ?? t) : null
    const measureLine = m ? `\n  ?${owner} <${m.prop}> ?measure .` : ''
    const g = groupVar ? `?${groupVar} ?${groupVar}Label ` : ''
    const inner = `SELECT DISTINCT ${g}?${t}${m ? ' ?measure' : ''} WHERE {\n${body}${measureLine}\n}`
    const aggregates = `(COUNT(?${t}) AS ?count)${m ? ` (SUM(?measure) AS ?total)` : ''}`
    const sparql = `SELECT ${g}${aggregates} WHERE {\n{ ${inner} }\n}${groupVar ? ` GROUP BY ?${groupVar} ?${groupVar}Label ORDER BY DESC(?${m ? 'total' : 'count'})` : ''}`
    return { sparql, chain: groupVar ? chain.filter(c => c.includes(groupVar) || c[0] === t) : [], target: t, aggregate: true, groupVar }
  }

  // a few attributes of the thing asked for make the answer self-explanatory
  const attrs = lex.attributes.filter(a => a.cls === u.target && !['orderedMaterialNo', 'dunsNumber', 'implementation', 'headline', 'message'].includes(local(a.prop))).slice(0, 4)
  const attrLines = attrs.map(a => `  OPTIONAL { ?${t} <${a.prop}> ?${local(a.prop)} }`)
  const select = [...labelled].map(v => `?${v} ?${v}Label`).concat(attrs.map(a => '?' + local(a.prop)))
  if (u.reasons) {
    // the process of the answer — on the path, or reached from an upload row
    let proc = [...labelled].find(v => classOf.get(v) === PC + 'Process')
    if (!proc && u.target === PC + 'UploadRow') { proc = `${t}_process`; attrLines.push(`  OPTIONAL { ?${t} <${PC}processedBy> ?${proc} }`) }
    if (proc) {
      attrLines.push(`  OPTIONAL { ?${proc} <${PC}message> ?reason }`,
        `  OPTIONAL { ?${proc} <${PC}waitsFor> ?waitingFor . OPTIONAL { ?waitingFor rdfs:label ?waitingForLabel } }`)
      select.push('?reason', '?waitingFor ?waitingForLabel')
    }
  }
  const sparql = `SELECT DISTINCT ${select.join(' ')} WHERE {\n${body}\n${attrLines.join('\n')}\n} ORDER BY ?${t}Label LIMIT 200`
  return { sparql, chain, target: t }
}

/** "Purchase request → from supplier → Supplier (risk level = High)" — what was understood. */
function describePlan(u) {
  const name = c => u.lex.classLabel.get(c) ?? local(c)
  const parts = u.plans.filter(p => !p.group).map(p => {
    let s = ''
    for (const step of p.path) s += ` → ${u.lex.propLabel.get(step.prop) ?? local(step.prop)}${step.forward ? '' : ' (inverse)'} → ${name(step.toCls)}`
    if (p.negate) return ` has no${s}`
    const a = p.anchor
    if (a) s += ['compare', 'absent'].includes(a.kind) ? ` with ${a.labels[0]}` : ` = ${a.labels.join(' / ')}`
    return s
  })
  const what = u.sum ? `Total ${u.lex.propLabel.get(u.measure?.prop) ?? 'amount'} of ${name(u.target)}`
    : u.count ? `Number of ${name(u.target)}` : name(u.target)
  return what + (parts.length ? ' where ' + parts.map(p => name(u.target) + p).join(' and ') : '')
    + (u.groupClass ? `, per ${name(u.groupClass)}` : '')
}

module.exports = { understand, toSparql, describePlan, lexicon, local, PREFIXES }
