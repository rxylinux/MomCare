#!/usr/bin/env node
// 内容库 v2 生成器：以 utils/dailyTipCore.js 的 STAGE_TIPS 为单一作者源，
// 重写 static/data/pregnancy-daily.json 的 tip_text 列（280 天）。
// 宝宝/妈妈两栏保持原值不动——只换"今日提醒"文案列。
// 词库修改流程（唯一正道）：改 dailyTipCore.js 的 STAGE_TIPS → 跑本脚本 → 随包发布。
// 手改 JSON 会在下次生成时被覆盖。
//
// 用法：node scripts/gen-daily-content.mjs [--out <path>]
//   --out 缺省写回仓库 static/data/pregnancy-daily.json（测试用临时路径）
//
// 轮换口径：同一周段内按"孕天数 % 段内词条数"轮换。静态库与推送提示行
// 同源同池（共用 STAGE_TIPS）——但推送侧把水果组合行混入候选池按日轮换，
// 同一天两端未必同句（同池同风格，允许）；水果行仅推送侧有（静态库无月份概念）。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const OUT = outIdx >= 0 ? argv[outIdx + 1] : join(root, 'static/data/pregnancy-daily.json')
const SRC = join(root, 'static/data/pregnancy-daily.json')

if (!existsSync(SRC)) {
  console.error('✖ 源文件不存在：' + SRC)
  process.exit(1)
}

// 共用核心是纯 ESM（客户端 vite 直引/云端 assemble 转译）——此处同法转译后 require，
// 与 tests 的 bundle 手法一致，保证读到的是与两端同一份字节（createRequire 驱动 CJS）
const { createRequire } = await import('node:module')
const nodeRequire = createRequire(import.meta.url)
const { buildSync } = await import('esbuild')
const tmp = mkdtempSync(join(os.tmpdir(), 'momcare-gen-'))
const coreCjs = join(tmp, 'dailyTipCore.cjs')
buildSync({
  entryPoints: [join(root, 'utils/dailyTipCore.js')],
  bundle: true, platform: 'node', format: 'cjs',
  outfile: coreCjs, logLevel: 'silent'
})
const { stageTipsForWeek } = nodeRequire(coreCjs)

const data = JSON.parse(readFileSync(SRC, 'utf8'))
if (!Array.isArray(data) || data.length === 0) {
  console.error('✖ 源数据不是非空数组')
  process.exit(1)
}

let changed = 0
for (const entry of data) {
  const td = entry.total_days
  if (!Number.isInteger(td) || td < 0 || td > 279) {
    console.error(`✖ 异常 total_days：${td}`)
    process.exit(1)
  }
  const tips = stageTipsForWeek(Math.floor(td / 7))
  const next = tips[td % tips.length]
  if (entry.tip_text !== next) {
    entry.tip_text = next
    changed++
  }
}

writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n')
const uniq = new Set(data.map(e => e.tip_text)).size
console.log(`done: ${data.length} 天，改写 ${changed} 条 tip；唯一文案 ${uniq} 条 → ${OUT === SRC ? '仓库静态库' : OUT}`)
