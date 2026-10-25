const cds = require('@sap/cds')
const pc = require('./srv/process-center/engine')

// process definitions register themselves with the engine
require('./srv/processes/material-order-import')

const auth = cds.env.requires.auth
const mocked = auth?.kind === 'mocked'

// ontology and data-quality rules are public files — the same Turtle could be loaded into SAP HANA Cloud.
// The data itself is only served through the knowledge graph service, which applies the user's access.
cds.on('bootstrap', app => {
  app.get('/knowledge-graph/ontology.ttl', (_, res) =>
    res.type('text/turtle').attachment('ontology.ttl').send(require('./srv/knowledge-graph/store').ontology))
  app.get('/knowledge-graph/shapes.ttl', (_, res) =>
    res.type('text/turtle').attachment('shapes.ttl').send(require('./srv/knowledge-graph/shacl').SHAPES))

  // Demo only (mocked users): /demo-login?user=bob remembers the user in a cookie for this address, so
  // two users work side by side in one browser — on alice.localhost / bob.localhost locally, or on two
  // ports in SAP Business Application Studio (see npm run demo).
  if (mocked) {
    // only the demo users configured with a password in package.json (alice, bob)
    const users = Object.fromEntries(Object.entries(auth.users ?? {}).filter(([, u]) => u?.password))
    app.get('/demo-login', (req, res) => {
      const user = String(req.query.user ?? '')
      if (!Object.hasOwn(users, user)) return res.status(400).send(`Unknown user. Use one of: ${Object.keys(users).join(', ')}`)
      res.cookie('demo-user', user, { httpOnly: true, sameSite: 'lax', path: '/' }).redirect('/fiori.html')
    })
    app.use((req, _, next) => {
      const user = !req.headers.authorization && /(?:^|;\s*)demo-user=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      if (user && Object.hasOwn(users, user)) req.headers.authorization = 'Basic ' + Buffer.from(`${user}:${users[user].password ?? ''}`).toString('base64')
      next()
    })
  }
})

// npm run demo: the same app on a second port too. In SAP Business Application Studio every port has its
// own address (port4004-…, port4005-…), so the browser keeps one login per port: alice and bob side by side.
const secondPort = Number(process.env.DEMO_SECOND_PORT)
if (mocked && secondPort) cds.on('listening', () => {
  const server = require('http').createServer(cds.app).listen(secondPort, () => console.log(`[demo] - also listening on http://localhost:${secondPort}`))
  cds.on('shutdown', () => server.close())
})

cds.on('served', () => pc.startScheduler(cds.env.processCenter))
cds.on('shutdown', () => pc.stopScheduler())

module.exports = cds.server
