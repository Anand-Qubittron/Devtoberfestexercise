const cds = require('@sap/cds')
const kg = require('./knowledge-graph/questions')
const { stats, profile, nquads } = require('./knowledge-graph/store')
const { validate } = require('./knowledge-graph/shacl')
const { D } = require('./knowledge-graph/rdf')

module.exports = class KnowledgeGraphService extends cds.ApplicationService {
  init() {
    // answers are JSON; an unexpected error becomes an error response instead of stopping the server
    const json = fn => async req => {
      try {
        return JSON.stringify(await fn(req))
      } catch (e) {
        cds.log('knowledge-graph').error(e)
        return req.reject(500, `The knowledge graph could not answer: ${e.message}`)
      }
    }

    this.on('questions', () => kg.featured.map(({ id, text }) => ({ id, text })))
    this.on('examples', () => kg.examples)
    this.on('stats', req => stats(req.user))
    this.on('profile', json(req => profile(req.user)))
    this.on('quality', json(req => validate(req.user)))
    this.on('rdf', req => nquads(req.user))
    this.on('ask', json(req => kg.ask(req.data.question, req.user)))
    this.on('sparql', async req => {
      try {
        return JSON.stringify(await kg.sparql(req.data.query ?? '', req.user))
      } catch (e) {
        return req.reject(400, `SPARQL error: ${e.message}`)
      }
    })
    this.on('explore', async req => {
      const { iri } = req.data
      // only our own resource IRIs — they are inserted into a query
      if (!iri?.startsWith(D) || /[\s<>"{}|\\^`]/.test(iri)) return req.reject(400, 'Not an entity of this graph')
      return json(() => kg.explore(iri, req.user))(req)
    })
    return super.init()
  }
}
