// Generates sample/material-orders.xlsx: 50 rows with a few deliberate problems
const ExcelJS = require('exceljs')
const path = require('path')
const fs = require('fs')

const good = ['M-1001', 'M-1002', 'M-1003', 'M-2001', 'M-2002', 'M-2003']
const rows = []
for (let i = 0; i < 50; i++) rows.push([good[i % good.length], 10 + ((i * 7) % 90)])

rows[6] = ['M-9999', 25]  // material does not exist yet  → Parked, resumes when M-9999 is created
rows[17] = ['M-9999', 40]
rows[11] = ['M-3001', 60] // supplier S-300 is blocked     → Parked, resumes when S-300 is unblocked
rows[29] = ['M-3002', 12]
rows[23] = ['M-2001', 0]  // wrong quantity               → Parked, resumes after correcting the row

const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('Orders')
ws.columns = [{ header: 'Material', width: 14 }, { header: 'Quantity', width: 10 }]
ws.getRow(1).font = { bold: true }
rows.forEach(r => ws.addRow(r))

const out = path.join(__dirname, '..', 'sample', 'material-orders.xlsx')
fs.mkdirSync(path.dirname(out), { recursive: true })
wb.xlsx.writeFile(out).then(() => console.log('Written', out))
