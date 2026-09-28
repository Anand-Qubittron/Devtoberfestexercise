const cds = require('@sap/cds')
const kg = require('./knowledge-graph/questions')
const { stats } = require('./knowledge-graph/store')

module.exports = class KnowledgeGraphService extends cds.ApplicationService {
  init() {
    this.on('questions', () => kg.questions.map(({ id, text }) => ({ id, text })))
    this.on('stats', () => stats())
    this.on('ask', async req => JSON.stringify(await kg.ask(req.data.question)))
    this.on('sparql', async req => {
      try {
        return JSON.stringify(await kg.sparql(req.data.query ?? ''))
      } catch (e) {
        return req.reject(400, `SPARQL error: ${e.message}`)
      }
    })
    return super.init()
  }
}
