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

  // Local demo only (mocked users): /demo-login?user=bob remembers the user in a cookie for this host,
  // so alice on alice.localhost and bob on bob.localhost work side by side without the browser's login prompt.
  const auth = cds.env.requires.auth
  if (auth?.kind === 'mocked') {
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

cds.on('served', () => pc.startScheduler(cds.env.processCenter))
cds.on('shutdown', () => pc.stopScheduler())

module.exports = cds.server
