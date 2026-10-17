const fs = require('fs')
const path = require('path')
// Oxigraph needs Web Crypto for random numbers; it is global only from Node 19 on
globalThis.crypto ??= require('crypto').webcrypto
const oxigraph = require('oxigraph')
const { generate, GRAPHS, graphIri } = require('./rdf')

/**
 * Embedded SPARQL engine (Oxigraph). Plays the role SAP HANA Cloud's knowledge graph
 * engine has in the session: ontology + RDF in, SPARQL out.
 *
 * Access control is "secure by construction": each request gets a graph that only
 * contains the named graphs the user may see, so no query — generated or hand-written —
 * can reach anything else.
 */
const ontology = fs.readFileSync(path.join(__dirname, 'ontology.ttl'), 'utf8')
const JSON_RESULTS = { results_format: 'application/sparql-results+json', use_default_graph_as_union: true }

/** Named graphs this user may see — graphs without roles are open to every signed-in user. */
function access(user) {
  const visible = [], hidden = []
  for (const [id, g] of Object.entries(GRAPHS)) {
    const allowed = !g.roles || g.roles.some(r => user?.is?.(r))
    ;(allowed ? visible : hidden).push(id)
  }
  return { visible, hidden }
}

/** Builds a fresh store from the live data — a few thousand triples, milliseconds. */
async function build(user) {
  const quads = await generate()
  const { visible, hidden } = access(user)
  const store = new oxigraph.Store()
  store.load(ontology, { format: 'text/turtle' }) // the ontology lives in the default graph, open to all
  const data = visible.map(id => quads[id].join('\n')).join('\n')
  if (data.trim()) store.load(data, { format: 'application/n-quads' })
  return { store, visible, hidden, quads }
}

const query = (store, sparql) => {
  const result = store.query(sparql, JSON_RESULTS)
  if (typeof result !== 'string') throw new Error('Only SELECT and ASK queries are supported here')
  const json = JSON.parse(result)
  if ('boolean' in json) return { head: { vars: ['result'] }, results: { bindings: [{ result: { type: 'literal', value: String(json.boolean) } }] } }
  return json
}

/** Runs a read-only SPARQL query as the given user and returns SPARQL JSON results. */
async function select(sparql, user) {
  const { store } = await build(user)
  return query(store, sparql)
}

/** Per named graph: label, source, triples, and whether the user can see it. */
async function profile(user) {
  const { visible, quads } = await build(user)
  return {
    user: user?.id,
    graphs: Object.entries(GRAPHS).map(([id, g]) => ({
      id, iri: graphIri(id), label: g.label, kind: g.kind, source: g.source,
      roles: (g.roles ?? []).join(', '), visible: visible.includes(id),
      triples: visible.includes(id) ? quads[id].length : null
    }))
  }
}

/** The user's visible data as N-Quads — the format a triple store such as SAP HANA Cloud loads. */
async function nquads(user) {
  const { visible, quads } = await build(user)
  return visible.map(id => quads[id].join('\n')).join('\n') + '\n'
}

async function stats(user) {
  const { store } = await build(user)
  const [row] = query(store, `SELECT (COUNT(*) AS ?triples) (COUNT(DISTINCT ?s) AS ?subjects) WHERE { ?s ?p ?o }`).results.bindings
  return { triples: Number(row.triples.value), subjects: Number(row.subjects.value) }
}

module.exports = { build, query, select, profile, nquads, stats, access, ontology }
