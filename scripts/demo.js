// npm run demo — starts the app with cds watch and opens the launchpad twice:
// alice on http://alice.localhost:4004 and bob on http://bob.localhost:4004. Browsers send every
// *.localhost address to this machine but keep separate logins per address, so both users work side
// by side (see /demo-login in server.js). Works with WSL too, where 127.0.0.1 is not forwarded.
const { spawn, exec } = require('child_process')

const PORT = process.env.PORT || 4004
const urls = ['alice', 'bob'].map(user => `http://${user}.localhost:${PORT}/demo-login?user=${user}`)

const watch = spawn(process.execPath, [require.resolve('@sap/cds-dk/bin/cds.js'), 'watch'], {
  stdio: 'inherit', env: { ...process.env, PORT }
})
watch.on('exit', code => process.exit(code ?? 0))
process.on('SIGINT', () => watch.kill('SIGINT'))

function open(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : process.env.WSL_DISTRO_NAME ? `cmd.exe /c start "" "${url}"`
    : `xdg-open "${url}"`
  exec(cmd, err => err && console.log(`Open in your browser: ${url}`))
}

;(async () => {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`http://localhost:${PORT}/`).then(() => true, () => false)) break
    await new Promise(r => setTimeout(r, 500))
  }
  console.log(`\nalice: ${urls[0]}\nbob:   ${urls[1]}\n`)
  urls.forEach(open)
})()
