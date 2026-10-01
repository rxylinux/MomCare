#!/usr/bin/env node
// 体验版重新发布脚本（R4 2026-10-01 + R4R-1..8 + 二轮 R4二1/2/3/4/5）。
// 关键语义：
// - R4二1：当前侧摘要未知 fail closed；assemble 后以**新组装摘要**重核对 required/selected，
//   上传/部署前若新摘要 ≠ 确认摘要且未在 selected → 补入（绝不让 selected=[] 蒙混过上传）。
// - R4二2：CLI 成功判定按本机 CLI 真实输出契约（Codex 只读 asar 源码证据）：
//   upload 成功 → "upload success" 字样；函数部署 → console.table 表行含函数名且
//   success true（无 error）。退出 0 但无任何可识别确认 → unknown（不记 deployed/不标 uploaded）。
// - R4二3：deployedDigests 耐久合并——新 receipt 继承 state 既有确认项，仅本次成功函数
//   更新；partial/失败/未执行项保留旧摘要；绑定 deployedEnv=当前 envId，换环境后
//   旧摘要不构成基线（closure 侧 envMismatch → 完整集合）。
// - R4二4：--functions all 在有基线时直接取完整集合（先于 missing 缩减检查）。
// - R4二5：food 门在受控目录真实再生成比对（不信任自报标记）。
// - 重试等待时钟可注入（MOMCARE_RETRY_WAIT_MS，测试用；默认 45s）。
// - 外部命令一律参数数组；dry-run 零外呼（先于 git/CLI/islogin）。

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeChangedFunctions, readReleaseState, ALL_FUNCTION_DIRS, checkFoodStaleness, distFunctionDigests } from './release-dependency-closure.mjs'
import { createHash as r4CreateHash } from 'node:crypto'
// 单目录稳定摘要（与 closure 模块 distFunctionDigests 同式：文件名排序+逐文件 SHA）
function distFunctionDigestsSingle(dir) {
  if (!existsSync(dir)) return null
  const entries = []
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else entries.push([rel, r4CreateHash('sha256').update(readFileSync(join(d, e.name))).digest('hex')])
    }
  }
  walk(dir, '')
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return r4CreateHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MP_DIR = join(root, 'dist/build/mp-weixin')
const MANIFEST = join(root, 'manifest.json')
const STATE_FILE = join(root, '.trial-release-state.json')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const RETRY_WAIT_MS = Number(process.env.MOMCARE_RETRY_WAIT_MS || 45000)

const argv = process.argv.slice(2)
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const DESC = argOf('--desc') || argOf('-d')
const DRY_RUN = argv.includes('--dry-run')
const FUNCTIONS_RAW = (argOf('--functions') || argOf('-f') || '')
  .split(',').map(s => s.trim()).filter(Boolean)
const FUNCTIONS_ALL = FUNCTIONS_RAW.includes('all')
const FUNCTIONS = FUNCTIONS_ALL ? [] : FUNCTIONS_RAW

function die(msg) { console.error(`\n✖ ${msg}`); process.exit(1) }
function step(name) { console.log(`\n── ${name} ──`) }

// ── CLI 输出契约（R4二2，依据 Codex 只读本机 CLI 源码证据）──
// upload：成功路径输出 "upload success"；函数部署：console.table 表行（函数名 + success 列）。
function cliUploadConfirmed(text) {
  return /upload\s+success/i.test(text)
}
// R4三2：精确目标表行判定——(1) 行内含**完整函数名词元**（表格分隔符/空白/行首尾为界，
// 不匹配同名前缀：mc-tools-extra 不算 mc-tools）；(2) 该行 success 列值；邻行不作证据；
// (3) status 必须 ===0（非零退出/进程错误不因残留表行成功）；(4) 行内 error/fail → failed；
// (5) 其余 unknown。stdout 业务 error（无 [error] 标记）也判失败。
function fnTokenInLine(line, fn) {
  // 以非 [A-Za-z0-9_-] 字符为词元边界的完整匹配
  const re = new RegExp(`(?:^|[^A-Za-z0-9_-])${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`)
  return re.test(line)
}
// R4终1 + 阻1：按**本地 Node 真实 console.table formatter 输出**解析（已用本地 Node
// 生成标准形状核对：┌─┬─┐ 边框 / │ (index) │ success │ … 表头 / ├─┼─┤ 横向分隔 /
// │ <行键> │ <值> │ 数据行 / └─┴─┘ 底框）。解析规则：
// - 表头 = 含 (index) 与 success 列名的行 → 记录 index 列与 success 列位置；
// - 横向边框（├─┼─┤ 等无 │ 单元格分隔的行）与顶/底框跳过（不截断表体）；
// - 目标函数名只匹配 **(index) 列单元格**（完整词元——前缀不认）；success 只接受
//   **该行 success 列**的布尔 true（其他列真值不算）；目标行 success=false → 不成功；
// - 无真实表头/目标名只在其他列/普通信息日志 → unknown；表头前信息日志不遮挡。
function splitTableRow(line) {
  const parts = line.split('│')
  if (parts.length > 1 && parts[0].trim() === '') parts.shift()
  if (parts.length > 1 && parts[parts.length - 1].trim() === '') parts.pop()
  return parts.map(c => c.trim())
}
function isBorderRow(line) {
  // 边框/横向分隔行：┌┬┐ ├┼┤ └┴┘ 开头 + ─ 填充（无数据单元格）
  return /^[┌├└][─┬┼┴]+[┐┤┘]\s*$/.test(line.trim())
}
function parseTableHeaders(lines) {
  // 返回 [{indexIdx, successIdx, dataStart, dataEnd}]——dataStart 跳过横向分隔行
  const tables = []
  for (let i = 0; i < lines.length; i++) {
    if (isBorderRow(lines[i])) continue
    if (!lines[i].includes('│')) continue
    const cells = splitTableRow(lines[i])
    const indexIdx = cells.findIndex(c => /^\(index\)$/i.test(c))
    const successIdx = cells.findIndex(c => /^success$/i.test(c))
    if (indexIdx < 0 || successIdx < 0) continue // 非真实表头
    let end = i + 1
    while (end < lines.length && (lines[end].includes('│') || isBorderRow(lines[end]))) end++
    tables.push({ headerIdx: i, indexIdx, successIdx, dataStart: i + 1, dataEnd: end })
    i = end - 1
  }
  return tables
}
function cliDeployVerdict(status, text, fn) {
  if (/\[error\]/.test(text)) return 'failed'
  if (/error|errCode|fail/i.test(text)) return 'failed'
  if (status !== 0) return status === null ? 'failed' : 'unknown'
  const lines = text.split('\n')
  const tables = parseTableHeaders(lines)
  if (tables.length === 0) return 'unknown' // 无真实 console.table 表头（阻1）
  for (const t of tables) {
    for (let r = t.dataStart; r < t.dataEnd; r++) {
      const row = lines[r]
      if (!row || isBorderRow(row) || !row.includes('│')) continue
      const cells = splitTableRow(row)
      // 最后确认1：index 单元格规范化后**完整等于**目标 fn——词元包含不接受真实
      // formatter 的 'not mc-tools'/'mc-tools copied' 等其他索引（规范化仅处理已证实的
      // formatter 引号包裹与空白；未知/装饰索引不猜）。
      const idxVal = cells[t.indexIdx]
      if (idxVal === undefined) continue
      const norm = String(idxVal).trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1').trim()
      if (norm !== fn) continue
      const val = cells[t.successIdx]
      if (val === undefined) return 'unknown'
      // 仅认契约布尔 true 字面值（✔/yes 不属于当前 CLI 契约——不猜）
      if (val === 'true') return 'ok'
      return 'unknown' // 目标行 success 列非 true（false 等）——其他列/装饰值不算
    }
  }
  return 'unknown' // 无目标表行
}
function cliUploadVerdict(status, text) {
  if (/\[error\]/.test(text) || /error|errCode|fail/i.test(String((text.match(/^(?!.*upload success).*$/m) || [''])[0]))) {
    // 简化：任何 error/errCode/fail 字样都构成业务错误——即使同输出也有 upload success
    return 'failed'
  }
  if (/error|errCode|fail/i.test(text)) return 'failed'
  if (status !== 0) return status === null ? 'failed' : 'unknown'
  return cliUploadConfirmed(text) ? 'ok' : 'unknown'
}

if (!DESC) die('缺少 --desc "<本次发布说明>"')

// ── envId（部署目标，收据与基线绑定）──
const envId = (readFileSync(join(root, 'utils/cloudConfig.js'), 'utf8')
  .match(/envId:\s*'([^']+)'/) || [])[1]

step('依赖闭包计算（部署基线=deployedDigests@env + 源码级理由）')
const closure = computeChangedFunctions(root, envId ? { envId } : {})
const allFns = ALL_FUNCTION_DIRS(root)
if (closure.gitError) die('git 查询失败——无法计算变更闭包，发布中止（fail closed）')
if (closure.envMismatch) {
  console.log(`  ⚠ 部署目标环境变化（基线 ${closure.stateEnv} ≠ 当前 ${closure.scopeEnv}）——旧摘要不构成基线（R4二3）`)
}
const required = closure.requiredFunctions.map(r => r.fn)
if (closure.envUnknown) {
  console.log('  ⚠ 当前部署目标环境无法解析（utils/cloudConfig.js envId）——不可借用任何确认摘要（R4三1）')
  if (!envId && !DRY_RUN) {
    die('无法解析当前部署目标 envId——真实发布必须先修复 utils/cloudConfig.js（R4三1：未知目标不得上传）')
  }
}
if (!closure.confirmedDigests) {
  console.log(closure.envMismatch ? '  （环境变化→完整集合）' : '  ⚠ 无函数部署基线（state.deployedDigests 缺失/无效）——上传 commit 不是部署证据（R4R-1）')
  if (FUNCTIONS_ALL) {
    console.log(`  --functions all → 完整函数集合（${allFns.length} 个）`)
  } else {
    die([
      '无可信函数部署基线，且未指定完整集合（R4R-1/R4R-2）：',
      '  --functions all        部署全部函数（唯一安全默认）',
      'functions:[] 在无基线时不代表"无需部署云函数"（A24）'
    ].join('\n'))
  }
} else {
  const unconfirmed = allFns.filter(fn => typeof closure.confirmedDigests[fn] !== 'string')
  if (unconfirmed.length > 0) console.log(`  上次收据未确认：${unconfirmed.join(', ')}（必需部署）`)
  for (const r of closure.requiredFunctions) console.log(`  必需 ${r.fn}：${r.reasons.join('；')}`)
  for (const infra of closure.infraChanges) console.log(`  ${infra}`)
  if (FUNCTIONS_ALL) {
    console.log(`  --functions all → 完整函数集合（${allFns.length} 个，含全部必需——R4二4）`)
  } else {
    const missing = required.filter(f => !FUNCTIONS.includes(f))
    if (missing.length > 0) {
      die([
        `手工名单缩减了必需集合（A24）——缺：${missing.join(', ')}`,
        ...closure.requiredFunctions.filter(r => missing.includes(r.fn)).map(r => `  ${r.fn}: ${r.reasons.join('；')}`),
        `请用 --functions ${[...new Set([...FUNCTIONS, ...required])].join(',')} 或 --functions all`
      ].join('\n'))
    }
  }
}
const selected = FUNCTIONS_ALL ? allFns.slice() : [...new Set([...required, ...FUNCTIONS])].filter(f => allFns.includes(f)).sort()
const invalidFns = FUNCTIONS.filter(f => !allFns.includes(f))
if (invalidFns.length > 0) die(`--functions 中的函数不存在：${invalidFns.join(', ')}（现有：${allFns.join(', ')}）`)
if (selected.length > 0 && !envId && !DRY_RUN) {
  // R4三1：真实发布在计划期即拒绝未知目标；dry-run 只披露（其计划输出含 envUnknown 提示）
  die('无法从 utils/cloudConfig.js 提取 envId（部署云函数需要；R4三1：未知目标不得上传）')
}
if (selected.length > 0 && !envId && DRY_RUN) {
  console.log('  ⚠ 当前部署目标 envId 无法解析——实际发布将被拒绝（R4三1）')
}
// R4终（dry-run 统一估算口径）：不打印确定的"无"——以下始终是未经 assemble 验证的初步估算
console.log(`  初步估算将部署：${selected.length > 0 ? selected.join(', ') : '（初步估算为空——须经 assemble 后重核对确认，未知新鲜度）'}`)

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const mVer = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(manifest.versionName || '').trim())
if (!mVer) die(`manifest.versionName 不是 x.y.z 格式：${manifest.versionName}`)
const [major, minor, patch] = mVer.slice(1).map(Number)
const newPatch = patch + 1
const NEW_VERSION = `${major}.${minor}.${newPatch}`
const NEW_CODE = String(major * 10000 + minor * 100 + newPatch)
console.log(`  ${manifest.versionName} → ${NEW_VERSION}（versionCode ${manifest.versionCode} → ${NEW_CODE}）`)
console.log(`  发布说明：${DESC}`)

if (DRY_RUN) {
  console.log('\n[dry-run] 以下步骤将依次执行（现已跳过——零外呼，未探测 CLI/islogin/git 干净检查）：')
  // R4三3：dry-run 未执行 assemble——无法证明当前 dist 对当前源新鲜。以下 selected 是
  // 基于现有 dist/源差异的保守估计；实际发布会在 assemble 后重核对并可能补入更多必需
  // 函数。未知新鲜度保守披露，不宣称确定计划。
  console.log('  ⚠ 保守提示：dry-run 未执行 assemble——无法证明当前 dist 对当前源新鲜；')
  console.log('    实际发布将在 assemble 后重核对最终集合（可能补入更多必需函数）')
  console.log(`  前置检查：git 工作区干净 + DevTools CLI 存在 + islogin`)
  console.log(`  npm run test:all`)
  console.log(`  写入 manifest ${NEW_VERSION}（构建前落盘；失败回滚——不跳号）`)
  console.log(`  node cloud/assemble.mjs + food 真实再生成一致性门（R4二5）+ 以新组装摘要重核对 selected（R4二1）`)
  console.log(`  npm run build:mp-weixin`)
  console.log(`  恢复 cloudfunctions/ + project.config.json 补丁 + 上传暂存目录`)
  console.log(`  CLI upload（参数数组；成功判定=upload success 契约——R4二2）`)
  for (const fn of selected) console.log(`  CLI cloud functions deploy --names ${fn}（逐个；成功判定=表行 success 契约；unknown 不记 deployed——R4二2）`)
  console.log(`  最终收据：built=${allFns.length} / selected（assemble 后重核对）/ deployed 逐项确认 / deployedDigests 耐久合并旧确认项（R4二3）/ deployedEnv 绑定 / trigger=unverified / 部署中 partial（R4R-5）`)
  console.log(`  git 提交 manifest+最终收据（提交后不再改 state）`)
  process.exit(0)
}

step('前置检查')
const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim()
if (dirty) die(`工作区有未提交改动，发布必须基于已提交代码：\n${dirty}\n先提交（git add/commit）再发布`)
if (!existsSync(CLI)) die(`未找到微信开发者工具 CLI：${CLI}`)
const loginOut = spawnSync(CLI, ['islogin'], { encoding: 'utf8' }).stdout || ''
if (!loginOut.includes('"login":true')) die('DevTools CLI 未登录——先打开微信开发者工具并执行登录')

step('全量回归测试（不过不许发）')
try { execSync('npm run test:all', { cwd: root, stdio: 'inherit' }) }
catch { die('测试未通过——发布中止（未落盘任何版本变更）') }

step(`落盘新版本号 ${NEW_VERSION}（构建前——包内版本显示用）`)
manifest.versionName = NEW_VERSION
manifest.versionCode = NEW_CODE
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
const rollbackManifestAndDie = msg => {
  try { execSync('git checkout -- manifest.json', { cwd: root }) } catch { /* 回滚失败保留现场 */ }
  die(msg)
}

const head = execSync('git rev-parse HEAD', { cwd: root }).toString().trim()
// R4二3：收据继承旧确认摘要（耐久合并）——仅本次成功函数更新
const prevState = readReleaseState(root) || {}
const inheritedDigests = (prevState.deployedEnv === envId && prevState.deployedDigests && typeof prevState.deployedDigests === 'object')
  ? { ...prevState.deployedDigests } : {}
const receipt = {
  version: NEW_VERSION,
  desc: DESC,
  commit: head,
  baseline: closure.baselineMissing ? null : closure.baseline,
  closureReasons: Object.fromEntries(closure.requiredFunctions.map(r => [r.fn, r.reasons])),
  built: allFns.slice(),
  selected,
  deployed: [],
  deployedDigests: inheritedDigests,
  deployedEnv: envId || null,
  upload: { status: 'pending', version: NEW_VERSION },
  triggers: { status: selected.includes('mc-daily-push') ? 'unverified' : 'not-applicable' },
  partial: true,
  releasedAt: new Date().toISOString()
}
function writeReceipt() {
  const st = readReleaseState(root) || {}
  writeFileSync(STATE_FILE, JSON.stringify({ ...st, ...receipt }, null, 2) + '\n')
}

step('组装 + food 真实一致性门 + 构建')
try { execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' }) }
catch { rollbackManifestAndDie('组装失败——已回滚 manifest 版本号') }
const foodCheck = checkFoodStaleness(root)
if (foodCheck.applicable && foodCheck.stale) {
  rollbackManifestAndDie(`食物词典生成物不一致（R4二5）——${foodCheck.reason}\n先运行 node scripts/gen-food-safety.mjs 并提交生成物，再发布`)
}
try { execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' }) }
catch { rollbackManifestAndDie('构建失败——已回滚 manifest 版本号') }

// R4二1：以新组装摘要重核对——新摘要 ≠ 确认摘要 且不在 selected 的函数必须补入
const postAssembleDigests = distFunctionDigests(root)
const lateRequired = []
for (const fn of allFns) {
  if (selected.includes(fn)) continue
  const done = inheritedDigests[fn]
  const cur = postAssembleDigests[fn]
  if (typeof done !== 'string' || !/^[0-9a-f]{64}$/.test(done) || cur === undefined || cur === null || cur !== done) {
    lateRequired.push(fn)
  }
}
if (lateRequired.length > 0) {
  receipt.selected = [...new Set([...selected, ...lateRequired])].sort()
  console.log(`  ⚠ 新组装摘要重核对（R4二1）：补入必需——${lateRequired.join(', ')}（selected 更新为 ${receipt.selected.length} 个）`)
}
// R4三3 + R4终2：最终集合统一前置验证——新摘要合法 + **实际包完整性**（index.js 入口、
// 有效 package.json（main/依赖）、shared/dailyTipCore.js 转译核心、源侧伴生物全部在包）
// ——空目录或缺 index.js 同样能 hash 出合法摘要，不算完整包；任何缺失在上传前
// 明确失败（upload/deploy 调用为零，不靠 CLI 事后错误兜底、不记 null 摘要）。
function validateFunctionPackage(baseDir, fn, srcRoot) {
  const dir = join(baseDir, fn)
  if (!existsSync(dir)) return `dist/cloud-functions/${fn} 目录不存在`
  if (!existsSync(join(dir, 'index.js'))) return `dist/cloud-functions/${fn}/index.js 入口缺失`
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return `dist/cloud-functions/${fn}/package.json 清单缺失`
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!pkg || typeof pkg !== 'object' || pkg.main !== 'index.js') return `dist/cloud-functions/${fn}/package.json main≠index.js`
    if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || !pkg.dependencies['wx-server-sdk']) return `dist/cloud-functions/${fn}/package.json 缺 wx-server-sdk 依赖`
  } catch (e) { return `dist/cloud-functions/${fn}/package.json 不可解析` }
  const sharedDir = join(dir, 'shared')
  if (!existsSync(sharedDir)) return `dist/cloud-functions/${fn}/shared/ 共享模块目录缺失`
  if (!existsSync(join(sharedDir, 'dailyTipCore.js'))) return `dist/cloud-functions/${fn}/shared/dailyTipCore.js（转译核心）缺失`
  // 阻2：assemble 把源 cloud/shared **整目录递归复制**进每个函数——按源侧实际清单核对
  // 每个共享模块文件（缺 auth.js/respond.js 等仍能让 hash 合法但 handler 无法加载）
  const srcShared = join(srcRoot, 'cloud/shared')
  const checkSharedFiles = (srcD, rel) => {
    for (const e of readdirSync(srcD, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { checkSharedFiles(join(srcD, e.name), relPath); continue }
      if (!existsSync(join(sharedDir, relPath))) return `dist/cloud-functions/${fn}/shared/${relPath}（源共享模块）缺失`
    }
    return null
  }
  if (existsSync(srcShared)) {
    const sharedErr = checkSharedFiles(srcShared, '')
    if (sharedErr) return sharedErr
  }
  const srcFnDir = join(srcRoot, 'cloud/functions', fn)
  if (existsSync(srcFnDir)) {
    for (const e of readdirSync(srcFnDir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js') && e.name !== 'index.js') {
        if (!existsSync(join(dir, e.name))) return `dist/cloud-functions/${fn}/${e.name}（伴生物）缺失`
      }
      // 阻2：源侧 config.json（云调用权限等）随包打包
      if (e.isFile() && e.name === 'config.json') {
        if (!existsSync(join(dir, 'config.json'))) return `dist/cloud-functions/${fn}/config.json（函数配置）缺失`
      }
    }
  }
  return null
}
for (const fn of receipt.selected) {
  const cur = postAssembleDigests[fn]
  if (typeof cur !== 'string' || !/^[0-9a-f]{64}$/.test(cur)) {
    receipt.upload.status = 'blocked'
    writeReceipt()
    rollbackManifestAndDie(`最终集合前置验证失败（R4三3）：${fn} 组装产物缺失或摘要不合法（dist/cloud-functions/${fn}）——不进入上传`)
  }
  const pkgErr = validateFunctionPackage(join(root, 'dist/cloud-functions'), fn, root)
  if (pkgErr) {
    receipt.upload.status = 'blocked'
    writeReceipt()
    rollbackManifestAndDie(`最终包完整性验证失败（R4终2）：${pkgErr}——不进入上传`)
  }
}
if (receipt.selected.length > 0 && !envId) {
  receipt.upload.status = 'blocked'
  writeReceipt()
  rollbackManifestAndDie('最终集合前置验证失败（R4三3）：selected 非空但 envId 无法解析——未知部署目标，不进入上传')
}
// trigger 按最终 selected 重算（初始空集合晚补 mc-daily-push 的场景）
receipt.triggers.status = receipt.selected.includes('mc-daily-push') ? 'unverified' : 'not-applicable'

step('恢复 cloudfunctions 目录与 project.config.json 补丁')
const cfDir = join(MP_DIR, 'cloudfunctions')
mkdirSync(cfDir, { recursive: true })
for (const fn of readdirSync(join(root, 'dist/cloud-functions'))) {
  if (fn.startsWith('mc-')) cpSync(join(root, 'dist/cloud-functions', fn), join(cfDir, fn), { recursive: true })
}
// R4终2b：staged 部署目录与计划同快照——部署用 MP_DIR/cloudfunctions/<fn> 必须与
// dist/cloud-functions/<fn>（本次摘要来源）字节一致；旧目录/不同字节不得当本轮摘要。
const stagedDigests = {}
for (const fn of receipt.selected) {
  const stagedDir = join(cfDir, fn)
  const stagedDigest = distFunctionDigestsSingle(stagedDir)
  if (stagedDigest !== postAssembleDigests[fn]) {
    receipt.upload.status = 'blocked'
    writeReceipt()
    rollbackManifestAndDie(`staged 部署目录与计划摘要不一致（R4终2b）：MP_DIR/cloudfunctions/${fn} ≠ dist/cloud-functions/${fn}——不进入上传`)
  }
  stagedDigests[fn] = stagedDigest
}
// R4终3：本次计划产物摘要独立于已确认 deployedDigests 耐久记录（上传前）——中断后磁盘
// 保留"本次拟发什么字节"的证明；实际 stage 与计划绑定；不塞进 confirmed 冒充成功。
receipt.plannedDigests = { ...postAssembleDigests }
receipt.stagedDigests = stagedDigests
const projCfgPath = join(MP_DIR, 'project.config.json')
const projCfg = JSON.parse(readFileSync(projCfgPath, 'utf8'))
delete projCfg.cloudfunctionRoot
const out = {}
for (const [k, v] of Object.entries(projCfg)) { out[k] = v; if (k === 'description') out.cloudfunctionRoot = 'cloudfunctions/' }
writeFileSync(projCfgPath, JSON.stringify(out, null, 2) + '\n')

step('生成上传暂存目录')
const UPLOAD_DIR = join(root, 'dist/trial-upload')
rmSync(UPLOAD_DIR, { recursive: true, force: true })
cpSync(MP_DIR, UPLOAD_DIR, { recursive: true })
rmSync(join(UPLOAD_DIR, 'static/data'), { recursive: true, force: true })
rmSync(join(UPLOAD_DIR, 'cloudfunctions'), { recursive: true, force: true })
const upCfgPath = join(UPLOAD_DIR, 'project.config.json')
const upCfg = JSON.parse(readFileSync(upCfgPath, 'utf8'))
delete upCfg.cloudfunctionRoot
writeFileSync(upCfgPath, JSON.stringify(upCfg, null, 2) + '\n')
console.log('  上传源 = dist/trial-upload（static/data 与 cloudfunctions 已物理排除）')

// 阻3：实际上传小程序包（dist/trial-upload，物理排除后）的稳定摘要——独立于云函数
// plannedDigests 记录（小程序包字节 ≠ 云函数产物），与版本/目标绑定。
receipt.uploadPackageDigest = distFunctionDigestsSingle(UPLOAD_DIR)
// R4三4：任何外部上传前——本次计划耐久落盘（版本/目标/最终集合/产物摘要/上传包摘要/
// upload:pending/partial:true）：上传期间进程中断时磁盘不再残留旧次"完成"收据；
// 上传返回后按事实更新。
step('落盘本次发布计划（upload:pending，partial）')
writeReceipt()
console.log(`  计划已落盘：v${NEW_VERSION}@${receipt.deployedEnv} selected=${receipt.selected.length} upload=pending partial=true 上传包摘要=${receipt.uploadPackageDigest ? receipt.uploadPackageDigest.slice(0, 8) + '…' : 'n/a'}`)

step(`上传 ${NEW_VERSION}`)
const up = spawnSync(CLI, ['upload', '--project', UPLOAD_DIR, '-v', NEW_VERSION, '-d', DESC], { encoding: 'utf8' })
const upText = `${up.stdout || ''}\n${up.stderr || ''}`
if (up.stdout) process.stdout.write(up.stdout)
if (up.stderr) process.stderr.write(up.stderr)
// RL5 不变量保持（形状）：退出码 + [error] stdout/stderr 双检在显式条件中（R4三2 verdict 内含同语义）
if (up.status !== 0 || /\[error\]/.test(up.stdout || '') || /\[error\]/.test(up.stderr || '')) {
  receipt.upload.status = 'failed'
  writeReceipt()
  rollbackManifestAndDie('上传失败——收据 upload:failed（旧确认基线保留），manifest 已回滚')
}
const upVerdict = cliUploadVerdict(up.status, upText)
if (upVerdict === 'failed') {
  receipt.upload.status = 'failed'
  writeReceipt()
  rollbackManifestAndDie('上传失败（业务错误输出——R4三2）——收据 upload:failed（旧确认基线保留），manifest 已回滚')
}
if (upVerdict !== 'ok') {
  receipt.upload.status = 'unknown'
  writeReceipt()
  rollbackManifestAndDie('上传结果未获可识别确认（无 upload success 契约/退出码异常——R4三2）——收据 upload:unknown（不标 uploaded），manifest 已回滚')
}
receipt.upload.status = 'uploaded'
receipt.partial = true
writeReceipt()

const deployUnknown = []
for (const fn of receipt.selected) {
  let confirmedDep = false
  for (let attempt = 1; attempt <= 3 && !confirmedDep; attempt++) {
    const r = spawnSync(CLI, ['cloud', 'functions', 'deploy', '--env', envId, '--names', fn, '--project', MP_DIR, '-r'], { encoding: 'utf8' })
    const so = String(r.stdout || '')
    const se = String(r.stderr || '')
    if (so) process.stdout.write(so)
    if (se) process.stderr.write(se)
    const text = `${so}\n${se}`
    const verdict = cliDeployVerdict(r.status, text, fn)
    if (verdict === 'ok') {
      confirmedDep = true
    } else if (verdict === 'failed' && attempt >= 3) {
      receipt.partial = true
      writeReceipt()
      console.error(`  ✖ ${fn} 部署失败（明确错误${r.status === 0 ? '——退出码 0 但业务错误' : ''}）——收据 partial；旧确认摘要保留（R4二3）`)
      console.error(`  手动补跑：${CLI} cloud functions deploy --env ${envId} --names ${fn} --project "${MP_DIR}" -r`)
      process.exit(1)
    } else if (attempt >= 3) {
      deployUnknown.push(fn)
      receipt.partial = true
      writeReceipt()
      console.error(`  ? ${fn} 三次尝试无可识别成功确认（unknown）——不记 deployed（R4二2）`)
    } else {
      console.log(`  ${fn} 未确认成功（尝试 ${attempt}/3，${verdict === 'failed' ? '明确错误' : '无可识别确认'}）——重试`)
      await new Promise(r2 => setTimeout(r2, RETRY_WAIT_MS))
    }
  }
  if (confirmedDep) {
    if (!receipt.deployed.includes(fn)) receipt.deployed.push(fn)
    receipt.deployedDigests[fn] = postAssembleDigests[fn] || null // R4二3：仅本次成功函数更新；其余继承
    receipt.partial = true // 部署进行中保持 partial（R4R-5）
    writeReceipt()
    console.log(`  ✔ ${fn} deployed（摘要 ${receipt.deployedDigests[fn] ? receipt.deployedDigests[fn].slice(0, 8) + '…' : 'n/a'}）`)
  }
}
if (deployUnknown.length > 0) {
  receipt.partial = true
  writeReceipt()
  console.error(`\n✖ ${deployUnknown.join(', ')} 部署结果未知（未记 deployed；旧摘要保留）——人工核对后重跑`)
  process.exit(1)
}

receipt.partial = false
writeReceipt()
step('提交 release commit（最终收据已落盘）')
const addRes = spawnSync('git', ['add', 'manifest.json', '.trial-release-state.json'], { cwd: root, stdio: 'inherit' })
const commitRes = spawnSync('git', ['commit', '-m', `chore(release): trial ${NEW_VERSION} — ${DESC}`], { cwd: root, stdio: 'inherit' })
if (addRes.status !== 0 || commitRes.status !== 0) {
  // 上传已成功——此时严禁回滚 manifest（会导致下次跳号）
  die(`提交失败但收据已落盘（严禁回滚）——手动补提交：\n  git add manifest.json .trial-release-state.json && git commit -m "chore(release): trial ${NEW_VERSION} — ${DESC}"`)
}
console.log(`  已提交 release commit（版本 ${NEW_VERSION}，基于 ${head.slice(0, 8)}）`)
console.log(`\n✔ 发布完成：体验版 ${NEW_VERSION}（收据：built=${receipt.built.length} selected=${receipt.selected.length} deployed=${receipt.deployed.length}；确认摘要=${Object.keys(receipt.deployedDigests).length}@${receipt.deployedEnv}；触发器=${receipt.triggers.status}——平台未确认，人工核对）`)
