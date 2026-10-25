// npm run demo — starts the app with cds watch for two users side by side, already logged in:
//  - locally: opens alice on http://alice.localhost:4004 and bob on http://bob.localhost:4004. Browsers
//    send every *.localhost address to this machine but keep separate logins per address.
//  - in SAP Business Application Studio: the app also listens on port 4005. Every port has its own
//    address there (port4004-…, port4005-…), so alice uses port 4004 and bob port 4005.
// See /demo-login in server.js — it only exists with the mocked users.
const { spawn, exec } = require('child_process')

const PORT = Number(process.env.PORT || 4004), SECOND = PORT + 1
const bas = !!(process.env.WS_BASE_URL || process.env.H2O_URL) || process.cwd().startsWith('/home/user/projects')

const watch = spawn(process.execPath, [require.resolve('@sap/cds-dk/bin/cds.js'), 'watch'], {
  stdio: 'inherit', env: { ...process.env, PORT, DEMO_SECOND_PORT: SECOND }
})
watch.on('exit', code => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => watch.kill(signal))

function open(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : process.env.WSL_DISTRO_NAME ? `cmd.exe /c start "" "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, err => err && console.log(`Open in your browser: ${url}`))
}

function basLinks() {
  // the preview address of a port is "port<port>-" + the workspace host
  const base = process.env.WS_BASE_URL || process.env.H2O_URL
  let host = null
  try { host = new URL(base).host.replace(/^port\d+-/, '') } catch { /* unknown — explain instead */ }
  const link = (port, user) => host ? `https://port${port}-${host}/demo-login?user=${user}` : `<preview address of port ${port}>/demo-login?user=${user}`
  console.log(`
Two users in SAP Business Application Studio — open both in normal tabs of the same browser:
  alice: ${link(PORT, 'alice')}
  bob:   ${link(SECOND, 'bob')}
${host ? '' : `Take the address BAS shows for port ${PORT} (port${PORT}-…) and use port${SECOND}-… for bob.\n`}`)
}

;(async () => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`http://localhost:${PORT}/`).then(() => true, () => false)) break
    await new Promise(r => setTimeout(r, 500))
  }
  if (bas) return basLinks()
  const urls = ['alice', 'bob'].map(user => `http://${user}.localhost:${PORT}/demo-login?user=${user}`)
  console.log(`\nalice: ${urls[0]}\nbob:   ${urls[1]}\n`)
  urls.forEach(open)
})()
