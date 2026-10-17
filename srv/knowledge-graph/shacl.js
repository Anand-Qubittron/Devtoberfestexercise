const fs = require('fs')
const path = require('path')
const oxigraph = require('oxigraph')
const { build, query } = require('./store')

/**
 * A small SHACL validator: the shapes in shapes.ttl (W3C SHACL Core subset —
 * targetClass, path / inversePath, minCount, maxCount, datatype, class, minInclusive, in)
 * are each turned into a SPARQL query against the user's graph.
 */
const SHAPES = fs.readFileSync(path.join(__dirname, 'shapes.ttl'), 'utf8')
const P = 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n'
const SH = 'http://www.w3.org/ns/shacl#'

function readShapes() {
  const s = new oxigraph.Store()
  s.load(SHAPES, { format: 'text/turtle' })
  const rows = query(s, `PREFIX sh: <${SH}> PREFIX pc: <https://devtoberfest.local/ontology#>
    SELECT ?shape ?target ?prop ?path ?inverse ?min ?max ?datatype ?class ?minIncl ?severity ?message ?graph WHERE {
      ?shape a sh:NodeShape ; sh:targetClass ?target ; sh:property ?prop .
      { ?prop sh:path ?path FILTER(isIRI(?path)) } UNION { ?prop sh:path [ sh:inversePath ?path ] BIND(true AS ?inverse) }
      OPTIONAL { ?prop sh:minCount ?min }      OPTIONAL { ?prop sh:maxCount ?max }
      OPTIONAL { ?prop sh:datatype ?datatype } OPTIONAL { ?prop sh:class ?class }
      OPTIONAL { ?prop sh:minInclusive ?minIncl }
      OPTIONAL { ?prop sh:severity ?severity } OPTIONAL { ?prop sh:message ?message }
      OPTIONAL { ?prop pc:requiresGraph ?graph }
    }`).results.bindings
  const lists = query(s, `PREFIX sh: <${SH}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?prop ?v WHERE { ?prop sh:in/rdf:rest*/rdf:first ?v }`).results.bindings
  const v = (b, k) => b[k]?.value
  return rows.map(b => ({
    shape: v(b, 'shape'), target: v(b, 'target'), path: v(b, 'path'), inverse: !!b.inverse,
    min: b.min && Number(v(b, 'min')), max: b.max && Number(v(b, 'max')),
    datatype: v(b, 'datatype'), class: v(b, 'class'), minIncl: b.minIncl && Number(v(b, 'minIncl')),
    in: lists.filter(l => l.prop.value === b.prop.value && b.prop.type === l.prop.type).map(l => l.v.value),
    severity: (v(b, 'severity') ?? SH + 'Violation').replace(SH, ''),
    message: v(b, 'message') ?? 'Constraint violated', graph: v(b, 'graph')
  }))
}

/** One SPARQL query per constraint; each returns the offending focus nodes (and values). */
function checks(c) {
  const step = c.inverse ? `?v <${c.path}> ?focus` : `?focus <${c.path}> ?v`
  const head = `${P}SELECT DISTINCT ?focus ?focusLabel ?v WHERE { ?focus a <${c.target}> . OPTIONAL { ?focus rdfs:label ?focusLabel }`
  const count = (op, n) => `${P}SELECT ?focus ?focusLabel (COUNT(DISTINCT ?x) AS ?v) WHERE {
    ?focus a <${c.target}> . OPTIONAL { ?focus rdfs:label ?focusLabel }
    OPTIONAL { ${step.replace('?v', '?x')} }
  } GROUP BY ?focus ?focusLabel HAVING (COUNT(DISTINCT ?x) ${op} ${n})`
  const q = []
  if (c.min) q.push(['minCount', count('<', c.min)])
  if (c.max) q.push(['maxCount', count('>', c.max)])
  if (c.datatype) q.push(['datatype', `${head} ${step} FILTER(!isLiteral(?v) || datatype(?v) != <${c.datatype}>) }`])
  if (c.class) q.push(['class', `${head} ${step} FILTER NOT EXISTS { ?v a <${c.class}> } }`])
  if (c.minIncl != null) q.push(['minInclusive', `${head} ${step} FILTER(?v < ${c.minIncl}) }`])
  if (c.in.length) q.push(['in', `${head} ${step} FILTER(STR(?v) NOT IN (${c.in.map(x => JSON.stringify(x)).join(', ')})) }`])
  return q
}

const short = iri => iri?.split(/[#/]/).pop()

async function validate(user) {
  const { store, visible } = await build(user)
  const constraints = readShapes()
  const results = [], skipped = []
  for (const c of constraints) {
    if (c.graph && !visible.includes(short(c.graph))) { skipped.push({ shape: short(c.shape), path: short(c.path), graph: short(c.graph) }); continue }
    for (const [kind, sparql] of checks(c)) {
      for (const b of query(store, sparql).results.bindings) results.push({
        severity: c.severity, shape: short(c.shape), focus: b.focus.value,
        focusLabel: b.focusLabel?.value ?? short(b.focus.value),
        path: (c.inverse ? '^' : '') + short(c.path), constraint: kind, message: c.message, value: b.v?.value ?? null
      })
    }
  }
  const order = { Violation: 0, Warning: 1, Info: 2 }
  results.sort((a, b) => order[a.severity] - order[b.severity] || a.focusLabel.localeCompare(b.focusLabel))
  const count = s => results.filter(r => r.severity === s).length
  return {
    conforms: !count('Violation'),
    violations: count('Violation'), warnings: count('Warning'), infos: count('Info'),
    shapes: new Set(constraints.map(c => c.shape)).size, constraints: constraints.length,
    skipped, results
  }
}

module.exports = { validate, readShapes, SHAPES }
