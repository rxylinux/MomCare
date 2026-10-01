#!/usr/bin/env node
// 词典生成器：以 static/data/food-safety.json 为单一作者源，生成云端伴生模块
// cloud/functions/mc-tools/food-safety-data.js（mc-tools 的 food.search/AI 边界匹配用）。
// 改词典唯一正道：改 JSON → 跑本脚本 → 随包发布 + 重传 mc-tools；手改云模块会被覆盖。
// phase-e3-server 套件逐字段 deepEqual 钉双源——本生成器产出与其兼容。
//
// 用法：node scripts/gen-food-safety.mjs [--out <path>]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const OUT = outIdx >= 0 ? argv[outIdx + 1] : join(root, 'cloud/functions/mc-tools/food-safety-data.js')
const SRC = join(root, 'static/data/food-safety.json')

if (!existsSync(SRC)) {
  console.error('✖ 源文件不存在：' + SRC)
  process.exit(1)
}
const entries = JSON.parse(readFileSync(SRC, 'utf8'))
if (!Array.isArray(entries) || entries.length === 0) {
  console.error('✖ 词典源不是非空数组')
  process.exit(1)
}
for (const e of entries) {
  if (!e.id || !e.level || !['safe', 'caution', 'avoid', 'insufficient'].includes(e.level)) {
    console.error(`✖ 词条异常（id/level）：${JSON.stringify(e).slice(0, 80)}`)
    process.exit(1)
  }
}

const HEADER = `'use strict'

// E3 饮食/行为安全词条库（服务端副本——由 scripts/gen-food-safety.mjs 从
// static/data/food-safety.json 生成，勿手改；phase-e3-server 套件逐字段
// deepEqual 钉双源不漂移）。
// 审校依据：中国营养学会《孕期妇女膳食指南 (2022)》/ NHS / FDA-EPA / ACOG——reviewedAt 见各词条。
`

writeFileSync(OUT, HEADER + 'module.exports = ' + JSON.stringify(entries, null, 2) + '\n')
console.log(`done: ${entries.length} 词条 → ${OUT}`)
