const cds = require('@sap/cds')
const pc = require('./process-center/engine')

module.exports = class ProcessMonitorService extends cds.ApplicationService {
  init() {
    const { ProcessInstances, DemoSettings } = this.entities
    const reread = req => SELECT.one.from(ProcessInstances, req.params[0].ID ?? req.params[0])

    // every action is guarded by the status in the engine; 0 rows = not allowed in this status
    const act = fn => async req => {
      const ID = req.params[0].ID ?? req.params[0]
      if (!(await fn(ID, req))) return req.reject(409, `Not possible while the process is in this status`)
      return reread(req)
    }
    this.on('resume', ProcessInstances, act(ID => pc.resume(ID)))
    this.on('skipStep', ProcessInstances, act((ID, req) => pc.skipStep(ID, req.user.id)))
    this.on('cancel', ProcessInstances, act(ID => pc.cancel(ID)))

    this.on('configureDemo', async req => {
      const set = Object.fromEntries(Object.entries(req.data).filter(([, v]) => v != null))
      if (Object.keys(set).length) await UPDATE('pc.DemoSettings', 1).set(set)
      return SELECT.one.from(DemoSettings, 1)
    })

    return super.init()
  }
}
