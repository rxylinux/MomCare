// R4阻1/最后确认 测试辅助：本地 Node 真实 console.table formatter（不运行 CLI）。
// 用法：node .r4-real-table.mjs <fn> <success:true|false> [key:val 额外行…] [--raw '<json>']
const args = process.argv.slice(2)
const rawIdx = args.indexOf('--raw')
let rows
if (rawIdx >= 0) {
  rows = JSON.parse(args[rawIdx + 1])
} else {
  const fn = args[0]
  const succ = args[1] === 'false' ? false : true
  rows = { [fn]: { success: succ, filesCount: 12, packSize: '3.5 kB' } }
  for (let i = 2; i + 1 < args.length; i += 2) {
    rows[args[i]] = { success: args[i + 1] === 'false' ? false : true, filesCount: 8, packSize: '2 kB' }
  }
}
console.table(rows)
