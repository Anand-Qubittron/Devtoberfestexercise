const cds = require('@sap/cds')
const pc = require('./srv/process-center/engine')

// process definitions register themselves with the engine
require('./srv/processes/material-order-import')

cds.on('served', () => pc.startScheduler(cds.env.processCenter))
cds.on('shutdown', () => pc.stopScheduler())

module.exports = cds.server
