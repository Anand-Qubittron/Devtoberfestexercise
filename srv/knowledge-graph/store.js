const fs = require('fs')
const path = require('path')
// Oxigraph needs Web Crypto for random numbers; it is global only from Node 19 on
globalThis.crypto ??= require('crypto').webcrypto
const oxigraph = require('oxigraph')
const { generate } = require('./rdf')

/**
 * Embedded SPARQL engine (Oxigraph). Plays the role SAP HANA Cloud's knowledge graph
 * engine has in the session: ontology + RDF in, SPARQL out.
 */
const ontology = fs.readFileSync(path.join(__dirname, 'ontology.ttl'), 'utf8')

/** Builds a fresh store from the live database (a few thousand triples — milliseconds). */
async function build() {
  const data = await generate()
  const store = new oxigraph.Store()
  store.load(ontology, { format: 'text/turtle' })
  store.load(data, { format: 'application/n-triples' })
  return { store, data }
}

/** Runs a read-only SPARQL query and returns standard SPARQL JSON results. */
async function select(sparql) {
  const { store } = await build()
  const result = store.query(sparql, { results_format: 'application/sparql-results+json' })
  if (typeof result !== 'string') throw new Error('Only SELECT and ASK queries are supported here')
  const json = JSON.parse(result)
  if ('boolean' in json) return { head: { vars: ['result'] }, results: { bindings: [{ result: { type: 'literal', value: String(json.boolean) } }] } }
  return json
}

async function stats() {
  const { store } = await build()
  const [row] = JSON.parse(store.query(`
    SELECT (COUNT(*) AS ?triples) (COUNT(DISTINCT ?s) AS ?subjects) WHERE { ?s ?p ?o }`,
  { results_format: 'application/sparql-results+json' })).results.bindings
  return { triples: Number(row.triples.value), subjects: Number(row.subjects.value) }
}

module.exports = { build, select, stats, ontology }
