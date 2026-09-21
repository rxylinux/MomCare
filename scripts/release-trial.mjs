#!/usr/bin/env node
// 体验版重新发布脚本（流程固化：修 bug 后一条命令完成全流程）。
//
// 用法：
//   npm run release:trial -- --desc "修复XX" [--functions mc-health,mc-tools] [--dry-run]
//
// 步骤（顺序即固化的发布流程）：
//   1. 前置检查：git 工作区干净（发布必须基于已提交代码）、DevTools CLI 已登录、
//      --functions 名单真实存在
//   2. 版本计算：manifest.json versionName 为唯一权威源，patch 位 +1；
//      versionCode = major*10000 + minor*100 + patch
//   3. 全量回归 npm run test:all（不过不许发）
//   4. node cloud/assemble.mjs 重新组装云函数产物
//   5. npm run build:mp-weixin 构建小程序包
//   6. 恢复被 build 清掉的 dist/build/mp-weixin/cloudfunctions/ 并补
//      project.config.json 的 cloudfunctionRoot（部署实录教训）
//   7. DevTools CLI 上传新版本（体验版即时生效）
//   8. 上传成功后才落盘：manifest 版本号 + .trial-release-state.json + git 提交。
//      失败不落盘——下次重跑沿用同一新版本号，不会跳号
//   9. --functions 时逐个重新部署云函数（首次部署 Creating 竞态自动重试）
//
// 不访问任何第三方网络：CLI 只与本地 DevTools IDE 服务（127.0.0.1）通信。

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MP_DIR = join(root, 'dist/build/mp-weixin')
const MANIFEST = join(root, 'manifest.json')
const STATE_FILE = join(root, '.trial-release-state.json')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'

// ── 参数 ──
const argv = process.argv.slice(2)
function argOf(name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const DESC = argOf('--desc') || argOf('-d')
const DRY_RUN = argv.includes('--dry-run')
const FUNCTIONS = (argOf('--functions') || argOf('-f') || '')
  .split(',').map(s => s.trim()).filter(Boolean)

function die(msg) { console.error(`\n✖ ${msg}`); process.exit(1) }
function step(name) { console.log(`\n── ${name} ──`) }

if (!DESC) die('缺少 --desc "<本次发布说明>"（微信后台开发版本列表靠它区分每次上传）')

// ── 1. 前置检查 ──
step('前置检查')
const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim()
if (dirty) {
  die(`工作区有未提交改动，发布必须基于已提交代码：\n${dirty}\n先提交（git add/commit）再发布`)
}
if (!existsSync(CLI)) die(`未找到微信开发者工具 CLI：${CLI}`)
const loginOut = spawnSync(CLI, ['islogin'], { encoding: 'utf8' }).stdout || ''
if (!loginOut.includes('"login":true')) {
  die('DevTools CLI 未登录——先打开微信开发者工具并执行登录，或运行：\n  ' + CLI + ' login')
}
for (const fn of FUNCTIONS) {
  if (!existsSync(join(root, 'cloud/functions', fn, 'index.js'))) {
    die(`--functions 中的 "${fn}" 不存在（cloud/functions/${fn}/index.js）`)
  }
}
// 环境变量部署目标（云函数用）：从 utils/cloudConfig.js 提取，保持单一事实源
const envId = (readFileSync(join(root, 'utils/cloudConfig.js'), 'utf8')
  .match(/envId:\s*'([^']+)'/) || [])[1]
if (FUNCTIONS.length > 0 && !envId) die('无法从 utils/cloudConfig.js 提取 envId（--functions 需要）')

// ── 2. 版本计算 ──
step('版本计算（权威源 manifest.json versionName）')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(manifest.versionName || '').trim())
if (!m) die(`manifest.versionName 不是 x.y.z 格式：${manifest.versionName}`)
const [major, minor, patch] = m.slice(1).map(Number)
const newPatch = patch + 1
const NEW_VERSION = `${major}.${minor}.${newPatch}`
const NEW_CODE = String(major * 10000 + minor * 100 + newPatch)
console.log(`  ${manifest.versionName} → ${NEW_VERSION}（versionCode ${manifest.versionCode} → ${NEW_CODE}）`)
console.log(`  发布说明：${DESC}`)
if (FUNCTIONS.length) console.log(`  同时部署云函数：${FUNCTIONS.join(', ')}（env ${envId}）`)

if (DRY_RUN) {
  console.log('\n[dry-run] 以下命令将依次执行（现已跳过）：')
  console.log('  npm run test:all')
  console.log('  node cloud/assemble.mjs')
  console.log('  npm run build:mp-weixin')
  console.log('  cp dist/cloud-functions/mc-* → dist/build/mp-weixin/cloudfunctions/')
  console.log('  patch project.config.json: cloudfunctionRoot = "cloudfunctions/"')
  console.log(`  ${CLI} upload --project dist/build/mp-weixin -v ${NEW_VERSION} -d "${DESC}"`)
  for (const fn of FUNCTIONS) {
    console.log(`  ${CLI} cloud functions deploy --env ${envId} --names ${fn} --project dist/build/mp-weixin -r`)
  }
  console.log('  成功后：写回 manifest 版本 + .trial-release-state.json + git 提交')
  process.exit(0)
}

// ── 3. 全量回归 ──
step('全量回归测试（不过不许发）')
try { execSync('npm run test:all', { cwd: root, stdio: 'inherit' }) }
catch { die('测试未通过——发布中止（未落盘任何版本变更）') }

// ── 4/5. 组装云函数产物 + 构建小程序 ──
step('组装云函数产物 + 构建小程序包')
try {
  execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' })
  execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' })
} catch { die('构建失败——发布中止（未落盘任何版本变更）') }

// ── 6. 恢复被 build 清掉的 cloudfunctions + 补 cloudfunctionRoot ──
step('恢复 cloudfunctions 目录与 project.config.json 补丁（build 会清掉）')
const cfDir = join(MP_DIR, 'cloudfunctions')
mkdirSync(cfDir, { recursive: true })
for (const fn of readdirSync(join(root, 'dist/cloud-functions'))) {
  if (fn.startsWith('mc-')) cpSync(join(root, 'dist/cloud-functions', fn), join(cfDir, fn), { recursive: true })
}
const projCfgPath = join(MP_DIR, 'project.config.json')
const projCfg = JSON.parse(readFileSync(projCfgPath, 'utf8'))
delete projCfg.cloudfunctionRoot
const out = {}
for (const [k, v] of Object.entries(projCfg)) { out[k] = v; if (k === 'description') out.cloudfunctionRoot = 'cloudfunctions/' }
writeFileSync(projCfgPath, JSON.stringify(out, null, 2) + '\n')
console.log(`  已恢复 ${readdirSync(cfDir).length} 个云函数目录 + cloudfunctionRoot`)

// ── 7. 上传新版本 ──
step(`上传 ${NEW_VERSION}（体验版即时生效）`)
// DevTools CLI 上传失败时退出码仍为 0（如 80051 包体超限），必须同时检查输出错误标记
const up = spawnSync(CLI, ['upload', '--project', MP_DIR, '-v', NEW_VERSION, '-d', DESC.replace(/"/g, "'")], { encoding: 'utf8' })
if (up.stdout) process.stdout.write(up.stdout)
if (up.stderr) process.stderr.write(up.stderr)
if (up.status !== 0 || /\[error\]/.test(up.stdout || '') || /\[error\]/.test(up.stderr || '')) {
  die('上传失败——版本未落盘，修复问题后重跑本脚本将沿用同一版本号')
}

// ── 8. 落盘版本 + 状态 + 提交（仅在上传成功后） ──
step('落盘版本号与发布状态并提交')
manifest.versionName = NEW_VERSION
manifest.versionCode = NEW_CODE
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
const head = execSync('git rev-parse HEAD', { cwd: root }).toString().trim()
writeFileSync(STATE_FILE, JSON.stringify({ version: NEW_VERSION, desc: DESC, commit: head, functions: FUNCTIONS, releasedAt: new Date().toISOString() }, null, 2) + '\n')
execSync(`git add manifest.json .trial-release-state.json && git commit -m "chore(release): trial ${NEW_VERSION} — ${DESC.replace(/"/g, "'")}"`, { cwd: root, stdio: 'inherit' })
console.log(`  已提交 release commit（版本 ${NEW_VERSION}，基于 ${head.slice(0, 8)}）`)

// ── 9. 可选：重新部署云函数 ──
if (FUNCTIONS.length > 0) {
  step(`重新部署云函数：${FUNCTIONS.join(', ')}`)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  for (const fn of FUNCTIONS) {
    let done = false
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      const r = spawnSync(CLI, ['cloud', 'functions', 'deploy', '--env', envId, '--names', fn, '--project', MP_DIR, '-r'], { stdio: 'inherit' })
      done = r.status === 0
      if (!done && attempt < 3) {
        console.log(`  ${fn} 部署失败（尝试 ${attempt}/3）——首次部署有 Creating 竞态，45s 后重试`)
        await sleep(45000)
      }
    }
    if (!done) {
      die(`云函数 ${fn} 三次部署均失败——小程序已发布成功；手动补跑：\n  ${CLI} cloud functions deploy --env ${envId} --names ${fn} --project "${MP_DIR}" -r`)
    }
  }
}

console.log(`\n✔ 发布完成：体验版已更新到 ${NEW_VERSION}（两台手机杀掉小程序进程重开即生效）`)
