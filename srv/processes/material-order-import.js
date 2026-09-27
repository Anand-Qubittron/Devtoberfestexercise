const pc = require('../process-center/engine')
const { BusinessError, TechnicalError } = pc

/**
 * One Excel row → one purchase request.
 *
 *   1 Validate               material exists, supplier not blocked, quantity > 0
 *   2 CreatePurchaseRequest  the business document
 *   3 NotifyBuyer            the side effect
 *
 * Each step only states *what* went wrong (BusinessError / TechnicalError);
 * retries, parking, resuming and logging are the engine's job.
 */
const settings = tx => tx.run(SELECT.one.from('pc.DemoSettings').where({ ID: 1 }))

/** Demo "chaos": a stable pseudo-random subset of steps fails on the first attempt only. */
async function simulateTransientFailures(ctx, what) {
  const s = await settings(ctx.tx)
  if (s?.stepDelayMs) await new Promise(r => setTimeout(r, s.stepDelayMs))
  const hash = [...(ctx.instance.ID + ctx.step)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  if (ctx.attempt === 1 && hash % 100 < (s?.technicalErrorRate ?? 0)) throw new TechnicalError(what)
}

async function validate(ctx) {
  const { tx } = ctx
  const item = await tx.run(SELECT.one.from('demo.UploadItems').where({ ID: ctx.instance.objectKey }))
  if (!item) throw new BusinessError('The upload row no longer exists')

  await simulateTransientFailures(ctx, 'Simulated: master data record locked by another session (SQL error 131)')

  if (!(item.quantity > 0)) throw new BusinessError(
    `Row ${item.rowNo}: quantity must be greater than 0 — correct the row in the upload`,
    { waitFor: { type: 'UploadItem', key: item.ID } })

  const material = await tx.run(SELECT.one.from('demo.Materials').where({ materialNo: item.materialNo }))
  if (!material) throw new BusinessError(
    `Material ${item.materialNo} does not exist — create it in Manage Materials, or correct the row`,
    { waitFor: { type: 'Material', key: item.materialNo } })

  const supplier = await tx.run(SELECT.one.from('demo.Suppliers').where({ ID: material.supplier_ID }))
  if (supplier.blocked) throw new BusinessError(
    `Supplier ${supplier.supplierNo} ${supplier.name} is blocked for purchasing — unblock it in Manage Suppliers`,
    { waitFor: { type: 'Supplier', key: supplier.ID } })

  // master data must not change under our feet until the process has finished
  await ctx.lock([
    { type: 'Material', key: material.ID, text: `Material ${material.materialNo}` },
    { type: 'Supplier', key: supplier.ID, text: `Supplier ${supplier.supplierNo}` }
  ])

  Object.assign(ctx.data, {
    itemID: item.ID, quantity: item.quantity, batchID: item.batch_ID,
    materialID: material.ID, materialNo: material.materialNo, price: Number(material.price),
    supplierID: supplier.ID, supplierNo: supplier.supplierNo
  })
  ctx.log(`${item.quantity} × ${material.materialNo} (${material.description}) from ${supplier.supplierNo} ${supplier.name}`)
}

async function createPurchaseRequest(ctx) {
  const { tx, data } = ctx
  await simulateTransientFailures(ctx, 'Simulated: purchasing number range temporarily locked')

  // belt and braces — the step already runs exactly once, and sourceItem is unique on top
  const existing = await tx.run(SELECT.one.from('demo.PurchaseRequests').where({ sourceItem: data.itemID }))
  if (existing) {
    data.prNo = existing.prNo
    return ctx.log(`${existing.prNo} already exists — not created again`)
  }
  const { count } = await tx.run(SELECT.one.from('demo.PurchaseRequests').columns('count(1) as count'))
  data.prNo = 'PR-' + String(count + 1).padStart(6, '0')
  await tx.run(INSERT.into('demo.PurchaseRequests').entries({
    prNo: data.prNo, material_ID: data.materialID, supplier_ID: data.supplierID,
    quantity: data.quantity, amount: Math.round(data.price * data.quantity * 100) / 100, sourceItem: data.itemID
  }))
  ctx.log(`Created ${data.prNo}`)
}

async function notifyBuyer(ctx) {
  const { tx, data } = ctx
  await simulateTransientFailures(ctx, 'Simulated: mail server timeout')
  const batch = await tx.run(SELECT.one.from('demo.UploadBatches').columns('createdBy', 'name').where({ ID: data.batchID }))
  await tx.run(INSERT.into('demo.Notifications').entries({
    recipient: batch?.createdBy,
    text: `${data.prNo}: ${data.quantity} × ${data.materialNo} from ${data.supplierNo} (upload "${batch?.name}")`
  }))
  ctx.log(`Notified ${batch?.createdBy}`)
}

pc.define('MaterialOrderImport', {
  objectType: 'UploadItem',
  maxAttempts: 4,
  retryDelayMs: async (attempt, tx) => ((await settings(tx))?.retryDelaySeconds ?? 5) * 1000 * attempt,
  steps: [
    { name: 'Validate', run: validate, skippable: false },
    { name: 'CreatePurchaseRequest', run: createPurchaseRequest, skippable: false },
    { name: 'NotifyBuyer', run: notifyBuyer }
  ]
})

module.exports = { settings }
