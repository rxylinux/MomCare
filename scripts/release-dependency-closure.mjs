#!/usr/bin/env node
// R4 发布依赖闭包计算（2026-10-01；含 R4R-1/3/7 与二轮 R4二1/3/5）。
// 纯本地计算（git + 文件读取），零外呼。
//
// 闭包规则（与 cloud/assemble.mjs 实际组装行为一一对应）：
//   函数自身/伴生/config → 该函数；cloud/shared/ 与 utils/dailyTipCore.js 与
//   cloud/assemble.mjs → 全部函数；static/data/food-safety.json 与
//   scripts/gen-food-safety.mjs → mc-tools；cloud/rules/collections.json → infra。
//
// 部署基线（R4R-1 + R4二1/3）：
//   - 函数级基线 = state.deployedDigests[fn]（64hex，该函数已确认部署的 dist 摘要），
//     且必须与 state.deployedEnv 绑定同一部署目标（envId）——换环境后旧摘要不构成基线。
//   - 当前侧摘要（dist）缺失 → 未知当前态 fail closed：该函数必需（不得凭"现有文件
//     不存在"推出"无需部署"）。
//   - done 非 64hex → 视为无有效确认 → 必需。
//   - git 源差异只做理由；不做部署充分性证据。git 查询失败 → gitError（fail closed）。
//
// food 生成物一致性（R4R-7 + R4二5）：除 source-sha256 标记外，实际在受控目录内以
// 当前生成器 + 当前作者源重新生成并逐字节比对（不信任自报标记——生成器语义变化/
// 正文篡改都会被真实再生成暴露）。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const HEX64 = /^[0-9a-f]{64}$/
function sha256OfBuf(buf) { return createHash('sha256').update(buf).digest('hex') }
function sha256OfDir(dir) {
  if (!existsSync(dir)) return null
  const entries = []
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(d, e.name), rel)
      else entries.push([rel, sha256OfBuf(readFileSync(join(d, e.name)))])
    }
  }
  walk(dir, '')
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return sha256OfBuf(Buffer.from(JSON.stringify(entries)))
}

export const ALL_FUNCTION_DIRS = root => {
  const src = join(root, 'cloud/functions')
  if (!existsSync(src)) return []
  return readdirSync(src, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .filter(d => existsSync(join(src, d.name, 'index.js')))
    .map(d => d.name)
    .sort()
}

export function readReleaseState(root) {
  const statePath = join(root, '.trial-release-state.json')
  if (!existsSync(statePath)) return null
  try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return null }
}

function gitZ(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
  } catch {
    return null
  }
}
function gitLinesZ(buf) {
  if (!buf) return null
  return buf.toString('utf8').split('\0').filter(Boolean)
}
function commitExists(root, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// food 真实一致性（R4二5）：在受控临时目录内以当前生成器 + 当前作者源再生成，
// 与仓库内生成物逐字节比对。生成器缺失/运行失败/输出不一致 → stale（如实拒绝）。
export function checkFoodStaleness(root) {
  const src = join(root, 'static/data/food-safety.json')
  const genScript = join(root, 'scripts/gen-food-safety.mjs')
  const gen = join(root, 'cloud/functions/mc-tools/food-safety-data.js')
  if (!existsSync(src)) return { applicable: false }
  if (!existsSync(gen)) return { applicable: true, stale: true, reason: 'mc-tools/food-safety-data.js 缺失（作者源在而生成物不在）' }
  if (!existsSync(genScript)) return { applicable: true, stale: true, reason: 'scripts/gen-food-safety.mjs 缺失——无法证明生成物与作者源一致（R4二5）' }
  let tmp = null
  try {
    tmp = mkdtempSync(join(tmpdir(), 'r4-food-'))
    const out = join(tmp, 'food-safety-data.js')
    const r = execFileSync('node', [genScript, '--out', out], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    void r
    if (!existsSync(out)) return { applicable: true, stale: true, reason: '生成器运行未产出（R4二5）' }
    const expected = readFileSync(out)
    const actual = readFileSync(gen)
    if (!expected.equals(actual)) {
      const m = /source-sha256:\s*([0-9a-f]{64})/.exec(actual.toString('utf8'))
      const srcDigest = sha256OfBuf(readFileSync(src))
      const markerOk = Boolean(m && m[1] === srcDigest)
      return { applicable: true, stale: true, reason: markerOk
        ? '生成物正文与"当前生成器+当前作者源"的预期输出不一致（生成器语义变化或正文被改——标记匹配不足以放行，R4二5）'
        : `生成物正文不一致且无有效 source-sha256 标记（实得 ${m ? m[1].slice(0, 8) : '无标记'} vs 源 ${srcDigest.slice(0, 8)}）` }
    }
    return { applicable: true, stale: false }
  } catch (e) {
    return { applicable: true, stale: true, reason: `生成器运行失败（${String(e && e.message).slice(0, 80)}）——不能证明一致（R4二5）` }
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ } }
  }
}

export function distFunctionDigests(root) {
  const dist = join(root, 'dist/cloud-functions')
  const out = {}
  if (!existsSync(dist)) return out
  for (const fn of readdirSync(dist, { withFileTypes: true })) {
    if (!fn.isDirectory() || fn.name.startsWith('_')) continue
    const d = sha256OfDir(join(dist, fn.name))
    if (d) out[fn.name] = d
  }
  return out
}

export function computeChangedFunctions(root, { baseline, envId } = {}) {
  const allFns = ALL_FUNCTION_DIRS(root)
  const state = readReleaseState(root)
  const distDigests = distFunctionDigests(root)

  // ── 部署目标作用域（R4二3）：envId 绑定 ──
  const scopeEnv = typeof envId === 'string' && envId ? envId : null
  const stateEnv = state && typeof state.deployedEnv === 'string' && state.deployedEnv ? state.deployedEnv : null
  // R4三1：环境绑定必须可验证——state 无/空 deployedEnv（legacy/畸形收据）视为无基线；
  // 当前 envId 无法解析时同样不可借用任何确认摘要（未知目标 ≠ 任意目标）。
  const envUnbound = Boolean(state && state.deployedDigests && !stateEnv)
  const envUnknown = state && state.deployedDigests && !scopeEnv
  const envMismatch = Boolean(scopeEnv && stateEnv && scopeEnv !== stateEnv)

  // ── 函数级部署基线 ──
  let confirmed = null
  if (state && state.deployedDigests && typeof state.deployedDigests === 'object') {
    if (envMismatch || envUnbound || envUnknown) {
      confirmed = null // 换环境/无环境绑定/当前目标未知：旧摘要不构成基线（R4二3 + R4三1）
    } else {
      confirmed = state.deployedDigests
    }
  }
  const fnReasons = new Map()
  if (envUnknown) {
    for (const fn of allFns) fnReasons.set(fn, new Set(['当前部署目标环境无法解析（utils/cloudConfig.js envId 缺失）——不可借用任何确认摘要，完整集合必需（R4三1）']))
  } else if (envUnbound) {
    for (const fn of allFns) fnReasons.set(fn, new Set(['收据缺 deployedEnv 绑定（legacy/畸形）——不可验证部署目标，无基线（R4三1）']))
  } else if (envMismatch) {
    for (const fn of allFns) fnReasons.set(fn, new Set([`部署目标环境变化（state.deployedEnv=${stateEnv} ≠ 当前 ${scopeEnv}）——旧目标摘要不构成基线，完整集合必需（R4二3）`]))
  } else if (!confirmed) {
    for (const fn of allFns) fnReasons.set(fn, new Set(['无可信函数部署基线（state.deployedDigests 缺失/无效）——全部函数必需（R4R-1）']))
  } else {
    for (const fn of allFns) {
      const cur = distDigests[fn]
      const done = confirmed[fn]
      if (typeof done !== 'string' || !HEX64.test(done)) {
        fnReasons.set(fn, new Set([`函数 ${fn} 无有效已确认摘要（缺失/非 64hex）——必需部署（R4二1）`]))
      } else if (cur === undefined || cur === null) {
        fnReasons.set(fn, new Set([`当前组装产物摘要未知（dist 缺该函数）——fail closed：必需部署（R4二1）`]))
      } else if (cur !== done) {
        fnReasons.set(fn, new Set([`当前组装产物摘要 ≠ 已确认部署摘要（${done.slice(0, 8)}… → ${cur.slice(0, 8)}…）`]))
      }
    }
  }

  // ── git 源差异（理由；fail closed）──
  let base = null
  let baselineMissing = false
  let gitError = false
  if (baseline !== undefined) {
    base = baseline
  } else if (state && typeof state.commit === 'string' && state.commit) {
    base = state.commit
  }
  if (base !== null) {
    if (!/^[0-9a-f]{7,40}$/i.test(base) || !commitExists(root, base)) {
      base = null
      baselineMissing = true
    }
  } else {
    baselineMissing = true
  }

  const infraChanges = []
  const uncommitted = []
  if (base !== null) {
    const diffBuf = gitZ(root, ['diff', '--name-only', '-z', `${base}..HEAD`])
    const statusBuf = gitZ(root, ['status', '--porcelain', '-z', '-uall'])
    if (diffBuf === null || statusBuf === null) {
      gitError = true
    } else {
      const changed = new Set()
      for (const f of gitLinesZ(diffBuf) || []) changed.add(f)
      const statusRecords = gitLinesZ(statusBuf) || []
      for (let i = 0; i < statusRecords.length; i++) {
        const rec = statusRecords[i]
        if (rec.length < 4) continue
        const f = rec.slice(3)
        changed.add(f); uncommitted.push(f)
        if (/^[RC]/.test(rec.slice(0, 2)) && i + 1 < statusRecords.length) {
          changed.add(statusRecords[i + 1]); uncommitted.push(statusRecords[i + 1]); i++
        }
      }
      for (const f of changed) {
        const m1 = /^cloud\/functions\/([^/]+)\/(.+)$/.exec(f)
        if (m1 && allFns.includes(m1[1])) {
          if (!fnReasons.has(m1[1])) fnReasons.set(m1[1], new Set())
          fnReasons.get(m1[1]).add(`函数文件变更：${f}`)
          continue
        }
        if (/^cloud\/shared\//.test(f)) { infraChanges.push(`共享模块：${f}`); continue }
        if (/^utils\/dailyTipCore\.js$/.test(f)) { infraChanges.push(`共用核心单源（assemble 转译投放全部函数）：${f}`); continue }
        if (/^cloud\/assemble\.mjs$/.test(f)) { infraChanges.push(`组装器（影响全部函数打包产物）：${f}`); continue }
        if (/^static\/data\/food-safety\.json$/.test(f)) { infraChanges.push(`食物词典作者源（生成 mc-tools 伴生模块）：${f}`); continue }
        if (/^scripts\/gen-food-safety\.mjs$/.test(f)) { infraChanges.push(`词典生成器（影响 mc-tools 生成物语义）：${f}`); continue }
        if (/^cloud\/(rules\/|collections\.json)/.test(f)) { infraChanges.push(`基础设施副本（不映射函数部署）：${f}`); continue }
      }
      const sharedChanged = [...changed].some(f => /^cloud\/shared\//.test(f))
      const coreChanged = [...changed].some(f => /^utils\/dailyTipCore\.js$/.test(f))
      const assembleChanged = [...changed].some(f => /^cloud\/assemble\.mjs$/.test(f))
      if (sharedChanged || coreChanged || assembleChanged) {
        for (const fn of allFns) {
          if (!fnReasons.has(fn)) fnReasons.set(fn, new Set())
          if (sharedChanged) fnReasons.get(fn).add('cloud/shared/ 共享模块变更（整目录随每个函数打包）')
          if (coreChanged) fnReasons.get(fn).add('utils/dailyTipCore.js 变更（assemble 转译投放全部函数）')
          if (assembleChanged) fnReasons.get(fn).add('cloud/assemble.mjs 变更（组装方法/依赖版本影响全部函数产物）')
        }
      }
      if ([...changed].some(f => /^static\/data\/food-safety\.json$/.test(f)) && allFns.includes('mc-tools')) {
        if (!fnReasons.has('mc-tools')) fnReasons.set('mc-tools', new Set())
        fnReasons.get('mc-tools').add('static/data/food-safety.json 变更（mc-tools/food-safety-data.js 伴生模块源）')
      }
      if ([...changed].some(f => /^scripts\/gen-food-safety\.mjs$/.test(f)) && allFns.includes('mc-tools')) {
        if (!fnReasons.has('mc-tools')) fnReasons.set('mc-tools', new Set())
        fnReasons.get('mc-tools').add('scripts/gen-food-safety.mjs 变更（生成器语义影响 mc-tools 伴生物）')
      }
    }
  }

  const requiredFunctions = [...fnReasons.entries()]
    .map(([fn, reasons]) => ({ fn, reasons: [...reasons].sort() }))
    .sort((a, b) => a.fn.localeCompare(b.fn))

  return {
    baselineMissing,
    baseline: base,
    gitError,
    envMismatch,
    envUnbound,
    envUnknown,
    stateEnv,
    scopeEnv,
    infraChanges,
    requiredFunctions,
    uncommitted: uncommitted.sort(),
    distDigests,
    confirmedDigests: confirmed
  }
}
