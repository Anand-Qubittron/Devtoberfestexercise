const cds = require('@sap/cds')
const pc = require('./srv/process-center/engine')

// process definitions register themselves with the engine
require('./srv/processes/material-order-import')

// ontology and data-quality rules are public files — the same Turtle could be loaded into SAP HANA Cloud.
// The data itself is only served through the knowledge graph service, which applies the user's access.
cds.on('bootstrap', app => {
  app.get('/knowledge-graph/ontology.ttl', (_, res) =>
    res.type('text/turtle').attachment('ontology.ttl').send(require('./srv/knowledge-graph/store').ontology))
  app.get('/knowledge-graph/shapes.ttl', (_, res) =>
    res.type('text/turtle').attachment('shapes.ttl').send(require('./srv/knowledge-graph/shacl').SHAPES))
})

cds.on('served', () => pc.startScheduler(cds.env.processCenter))
cds.on('shutdown', () => pc.stopScheduler())

module.exports = cds.server
