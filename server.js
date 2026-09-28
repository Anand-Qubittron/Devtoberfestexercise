const cds = require('@sap/cds')
const pc = require('./srv/process-center/engine')

// process definitions register themselves with the engine
require('./srv/processes/material-order-import')

// ontology and live RDF data as files — the same Turtle could be loaded into SAP HANA Cloud
cds.on('bootstrap', app => {
  app.get('/knowledge-graph/ontology.ttl', (_, res) =>
    res.type('text/turtle').attachment('ontology.ttl').send(require('./srv/knowledge-graph/store').ontology))
  app.get('/knowledge-graph/data.nt', async (_, res, next) => {
    try {
      res.type('application/n-triples').attachment('data.nt').send(await require('./srv/knowledge-graph/rdf').generate())
    } catch (e) { next(e) }
  })
})

cds.on('served', () => pc.startScheduler(cds.env.processCenter))
cds.on('shutdown', () => pc.stopScheduler())

module.exports = cds.server
