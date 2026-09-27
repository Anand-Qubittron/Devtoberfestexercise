const cds = require('@sap/cds')
const ExcelJS = require('exceljs')
const pc = require('./process-center/engine')
const { locks, LockedError } = pc

const DRAFT_LOCK_MINUTES = 15 // same as CAP's default draft lock timeout

module.exports = class DemoService extends cds.ApplicationService {
  init() {
    const { Suppliers, Materials, UploadBatches } = this.entities

    /*
     * Cross-object draft scope: editing one object locks the objects that depend on it.
     *   Supplier     → the supplier and all its materials
     *   Material     → the material
     *   UploadBatch  → the batch and all its rows
     * Running processes hold locks too, so users and processes never overwrite each other.
     */
    const scopes = {
      async Suppliers(ID) {
        const s = await SELECT.one.from('demo.Suppliers', ID)
        const materials = await SELECT.from('demo.Materials').where({ supplier_ID: ID })
        return {
          text: `supplier ${s.supplierNo}`,
          targets: [
            { type: 'Supplier', key: ID, text: `Supplier ${s.supplierNo}` },
            ...materials.map(m => ({ type: 'Material', key: m.ID, text: `Material ${m.materialNo}` }))
          ]
        }
      },
      async Materials(ID) {
        const m = await SELECT.one.from('demo.Materials', ID)
        return { text: `material ${m.materialNo}`, targets: [{ type: 'Material', key: ID, text: `Material ${m.materialNo}` }] }
      },
      async UploadBatches(ID) {
        const b = await SELECT.one.from('demo.UploadBatches', ID).columns('name')
        const items = await SELECT.from('demo.UploadItems').columns('ID', 'rowNo').where({ batch_ID: ID })
        return {
          text: `upload "${b.name}"`,
          targets: [
            { type: 'UploadBatch', key: ID, text: `Upload ${b.name}` },
            ...items.map(i => ({ type: 'UploadItem', key: i.ID, text: `${b.name} · row ${i.rowNo}` }))
          ]
        }
      }
    }
    const owner = (entity, ID) => `draft:${entity}:${ID}`
    // draft actions carry the key in req.params, the activated record in req.data
    const keyOf = req => req.params?.[0]?.ID ?? req.params?.[0] ?? req.data.ID

    for (const entity of [Suppliers, Materials, UploadBatches]) {
      const name = entity.name.split('.').pop()

      this.before('EDIT', entity, async req => {
        const ID = keyOf(req)
        const { text, targets } = await scopes[name](ID)
        try {
          await locks.acquire(cds, targets, {
            owner: owner(name, ID), ownerText: `${req.user.id} is editing ${text}`, mode: 'X', ttlMinutes: DRAFT_LOCK_MINUTES
          })
        } catch (e) {
          if (e instanceof LockedError) return req.reject(423, `You can't edit ${text} right now. ${e.message}`)
          throw e
        }
      })
      this.after('DISCARD', entity.drafts, (_, req) => locks.release(cds, owner(name, keyOf(req))))
      this.after('SAVE', entity.drafts, (_, req) => locks.release(cds, owner(name, keyOf(req))))
    }

    // Self-healing: fixing master data resumes the processes that were parked because of it
    this.after('SAVE', Suppliers.drafts, async (_, req) => {
      const n = await pc.resumeWaitingFor('Supplier', keyOf(req))
      if (n) req.info(`${n} parked process(es) resumed`)
    })
    this.after('SAVE', Materials.drafts, async (_, req) => {
      const { materialNo } = await SELECT.one.from('demo.Materials', keyOf(req)).columns('materialNo')
      const n = await pc.resumeWaitingFor('Material', materialNo)
      if (n) req.info(`${n} parked process(es) resumed`)
    })

    // Draft activation of an upload is the trigger: every row becomes a process instance
    this.after('SAVE', UploadBatches.drafts, async (_, req) => {
      const ID = keyOf(req)
      const batch = await SELECT.one.from('demo.UploadBatches', ID).columns('name')
      let items = await SELECT.from('demo.UploadItems').where({ batch_ID: ID })
      if (!items.length) items = await importExcel(ID, req)

      let started = 0
      for (const item of items.filter(i => !i.process_ID)) {
        const process_ID = await pc.start('MaterialOrderImport', {
          objectKey: item.ID, objectText: `${batch.name} · row ${item.rowNo}`
        })
        await UPDATE('demo.UploadItems', item.ID).set({ process_ID })
        started++
      }
      // corrected rows continue at the step where they stopped
      const resumed = await pc.resumeParkedFor('UploadItem', items.filter(i => i.process_ID).map(i => i.ID))
      if (started) req.info(`${started} row(s) handed over to background processing`)
      if (resumed) req.info(`${resumed} parked row(s) resumed`)
    })

    this.after('READ', UploadBatches, async batches => {
      batches = [].concat(batches ?? []).filter(b => b?.ID)
      if (!batches.length) return
      const counts = await SELECT.from('demo.UploadItems')
        .columns('batch_ID', 'process.status as status', 'count(1) as n')
        .where({ batch_ID: { in: batches.map(b => b.ID) } })
        .groupBy('batch_ID', 'process.status')
      for (const b of batches) {
        const of = (...s) => counts.filter(c => c.batch_ID === b.ID && s.includes(c.status)).reduce((sum, c) => sum + c.n, 0)
        b.total = counts.filter(c => c.batch_ID === b.ID).reduce((sum, c) => sum + c.n, 0)
        b.completed = of('Completed')
        b.inProcess = of('Ready', 'Running', 'Retrying')
        b.parked = of('Parked')
        b.failed = of('Failed', 'Cancelled')
      }
    })

    return super.init()
  }
}

/** Reads the uploaded workbook: first sheet, header row with "Material" and "Quantity" columns. */
async function importExcel(batchID, req) {
  const { file } = await SELECT.one.from('demo.UploadBatches', batchID).columns('file')
  if (!file) return []
  const buffer = Buffer.isBuffer(file) ? file : Buffer.concat(await file.toArray())

  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch {
    return req.reject(400, 'The file is not a valid .xlsx workbook')
  }
  const sheet = workbook.worksheets[0]
  const header = Array.from(sheet.getRow(1).values, v => String(v ?? '').trim().toLowerCase())
  const col = name => header.findIndex(h => h.startsWith(name))
  const [cMaterial, cQuantity] = [col('material'), col('quantity')]
  if (cMaterial < 0 || cQuantity < 0) return req.reject(400, 'The first row must contain the columns "Material" and "Quantity"')

  const items = []
  sheet.eachRow((row, rowNo) => {
    if (rowNo === 1) return
    const materialNo = String(row.getCell(cMaterial).text ?? '').trim()
    if (!materialNo) return
    items.push({ ID: cds.utils.uuid(), batch_ID: batchID, rowNo, materialNo, quantity: Number(row.getCell(cQuantity).value) || 0 })
  })
  if (items.length) await INSERT.into('demo.UploadItems').entries(items)
  return items
}
