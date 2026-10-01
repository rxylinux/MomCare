// 独立验证 IV-R4（2026-10-01，全新会话）：A23–A25 + R4 各轮边界独立反例
// （与 phase-r4 不同夹具数据/env/场景形态）。所有发布场景在自建临时项目夹具运行，
// 真实 CLI 被替换为夹具内 mock shell（upload 零调用以标记文件证明）；真实
// .trial-release-state.json / manifest.json 与本套件零接触（套件首尾断言字节不变）。
// 本文件为验证会话新增测试，不改生产源码与旧测试期望。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }

const REAL_STATE = path.join(root, '.trial-release-state.json')
const REAL_MANIFEST = path.join(root, 'manifest.json')
const realStateBefore = fs.readFileSync(REAL_STATE)
const realManifestBefore = fs.readFileSync(REAL_MANIFEST)

const FNS = ['mc-daily-push', 'mc-tools', 'mc-health', 'mc-restore', 'mc-schedule']
const ENV = 'env-iv4'

function makeFixture({ mutate, state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv4fix-'))
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
  g(['init', '-q']); g(['config', 'user.email', 'iv4@test.local']); g(['config', 'user.name', 'iv4-test'])
  for (const fn of FNS) {
    fs.mkdirSync(path.join(dir, 'cloud/functions', fn), { recursive: true })
    fs.writeFileSync(path.join(dir, 'cloud/functions', fn, 'index.js'), `// ${fn} iv4\n`)
    fs.mkdirSync(path.join(dir, 'dist/cloud-functions', fn, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/index.js`), `// ${fn} dist iv4\n`)
    for (const sf of ['auth.js', 'config.js', 'respond.js', 'constants.js']) fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/shared/${sf}`), `// ${sf}\n`)
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/shared/dailyTipCore.js`), '// core dist iv4\n')
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/package.json`), JSON.stringify({ name: fn, version: '1.0.0', main: 'index.js', dependencies: { 'wx-server-sdk': '4.0.2' } }))
  }
  fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/food-safety-data.js'), '// food data iv4\n')
  fs.writeFileSync(path.join(dir, 'cloud/functions/mc-restore/v20.js'), '// v20 iv4\n')
  fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-tools/food-safety-data.js'), '// food data iv4\n')
  fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-restore/v20.js'), '// v20 iv4\n')
  fs.mkdirSync(path.join(dir, 'cloud/shared'), { recursive: true })
  for (const f of ['auth.js', 'config.js', 'respond.js', 'constants.js']) fs.writeFileSync(path.join(dir, 'cloud/shared', f), `// ${f} iv4\n`)
  fs.mkdirSync(path.join(dir, 'utils'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'static/data'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'pages/index'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages/index/index.vue'), '// page iv4\n')
  fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core iv4\n')
  fs.writeFileSync(path.join(dir, 'static/data/food-safety.json'), JSON.stringify([{ id: 'iv4_x', name: '夹具词条', category: 'food', level: 'safe' }]) + '\n')
  fs.mkdirSync(path.join(dir, 'cloud/rules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cloud/rules/a.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'cloud/collections.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'cloud/assemble.mjs'), '// assemble iv4\n')
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts/release-dependency-closure.mjs'), path.join(dir, 'scripts/release-dependency-closure.mjs'))
  fs.copyFileSync(path.join(root, 'scripts/release-trial.mjs'), path.join(dir, 'scripts/release-trial.mjs'))
  fs.copyFileSync(path.join(root, 'scripts/.r4-real-table.mjs'), path.join(dir, 'scripts/.r4-real-table.mjs'))
  fs.copyFileSync(path.join(root, 'scripts/gen-food-safety.mjs'), path.join(dir, 'scripts/gen-food-safety.mjs'))
  execFileSync('node', [path.join(dir, 'scripts/gen-food-safety.mjs')], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ versionName: '1.1.24', versionCode: '10124' }))
  fs.writeFileSync(path.join(dir, 'utils/cloudConfig.js'), `export const CLOUD_CONFIG = { envId: '${ENV}', appId: 'wx-iv4' }\n`)
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n.upload-called-marker\n.state-at-upload.json\n')
  g(['add', '-A']); g(['commit', '-qm', 'init iv4'])
  const head = g(['rev-parse', 'HEAD']).trim()
  fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(state !== undefined ? state : { version: '1.1.24', commit: head, functions: [] }, null, 2))
  if (mutate) mutate(dir)
  return { dir, head }
}

// 自建驱动：调真实闭包模块计算
const closureMod = path.join(root, 'scripts/release-dependency-closure.mjs')
const computeDrv = path.join(os.tmpdir(), 'iv4-drv-compute.mjs')
fs.writeFileSync(computeDrv, `import { computeChangedFunctions } from ${JSON.stringify(closureMod)}\nimport { writeFileSync } from 'node:fs'\nconst env = process.argv[4] || undefined\nconst r = computeChangedFunctions(process.argv[2], env ? { envId: env } : {})\nwriteFileSync(process.argv[3], JSON.stringify(r))\n`)
async function computeWithEnv(dir, env) {
  const out = path.join(os.tmpdir(), 'iv4-out-' + crypto.randomBytes(4).toString('hex') + '.json')
  execFileSync('node', [computeDrv, dir, out, env || ''])
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}
const digestsDrv = path.join(os.tmpdir(), 'iv4-drv-digests.mjs')
fs.writeFileSync(digestsDrv, `import { distFunctionDigests } from ${JSON.stringify(closureMod)}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify(distFunctionDigests(process.argv[3])))\n`)
function realDigests(dir) {
  const out = path.join(os.tmpdir(), 'iv4-dig-' + crypto.randomBytes(3).toString('hex') + '.json')
  execFileSync('node', [digestsDrv, out, dir])
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

// 与生产同式的目录稳定摘要（独立重算用）
function iv4DirDigest(dir) {
  if (!fs.existsSync(dir)) return null
  const entries = []
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), rel)
      else entries.push([rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(d, e.name))).digest('hex')])
    }
  }
  walk(dir, '')
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

// mock 发布：替换 CLI/test/assemble/build 四个外部点（真实 CLI 路径仍在生产脚本常量里）
function armMockRelease(dir, deployScript, { uploadTouch = '.upload-called-marker' } = {}) {
  let src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
  src = src.replace(`const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'`, `const CLI = join(root, '.mock-cli.sh')`)
  src = src.replace(`execSync('npm run test:all', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs test', { cwd: root, stdio: 'inherit' })`)
  src = src.replace(`execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs assemble', { cwd: root, stdio: 'inherit' })`)
  src = src.replace(`execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs build', { cwd: root, stdio: 'inherit' })`)
  fs.writeFileSync(path.join(dir, 'scripts/release-trial.mjs'), src)
  fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst step = process.argv[2]\nif (step === 'test' || step === 'assemble') process.exit(0)\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')\nmkdirSync(mp, { recursive: true })\nwriteFileSync(join(mp, 'project.config.json'), JSON.stringify({ description: 'mock iv4' }))\nprocess.exit(0)\n")
  const defaultScript = [
    '#!/bin/sh',
    'case "$1" in',
    "  islogin) echo '{\"login\":true}'; exit 0;;",
    `  upload) touch "$PWD/${uploadTouch}"; echo "upload success"; exit 0;;`,
    '  cloud)',
    '    fn=""; prev=""',
    '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
    '    node "$PWD/scripts/.r4-real-table.mjs" "$fn" true',
    '    exit 0;;',
    'esac',
    'exit 0'
  ].join('\n')
  fs.writeFileSync(path.join(dir, '.mock-cli.sh'), deployScript || defaultScript)
  fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
}
function commitAll(dir, msg) {
  const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
  g(['add', '-A'])
  try { g(['commit', '-qm', msg]) } catch { /* 无变更 */ }
}
function fixtureState(dir) { return JSON.parse(fs.readFileSync(path.join(dir, '.trial-release-state.json'), 'utf8')) }
function runRelease(dir, args, timeout = 120000) {
  return spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), ...args], { cwd: dir, encoding: 'utf8', timeout, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
}

async function main() {
  console.log('IV-R4 独立反例（A23–A25 + R4 边界）\n')

  await scenario('A23 闭包规则自建矩阵：核心/共享/assemble→全部；food→mc-tools；伴生→本函数；纯前端不误报', async () => {
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'utils/dailyTipCore.js'), '// core iv4 v2\n') })
      const r = await computeWithEnv(dir, ENV)
      assert.deepEqual(r.requiredFunctions.map(x => x.fn).sort(), FNS.slice().sort(), 'dailyTipCore → 全部')
      assert.ok(r.requiredFunctions.every(x => x.reasons.some(rr => rr.includes('dailyTipCore'))), '理由点名共用核心')
    }
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/shared/constants.js'), '// constants iv4 v2\n') })
      const r = await computeWithEnv(dir, ENV)
      assert.equal(r.requiredFunctions.length, 5, '共享模块 → 全部')
    }
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/assemble.mjs'), '// assemble iv4 v2\n') })
      const r = await computeWithEnv(dir, ENV)
      assert.equal(r.requiredFunctions.length, 5, 'assemble → 全部')
    }
    {
      // 可信基线 + 仅 food 作者源未提交变更 → 恰 mc-tools（food 只映射 mc-tools）
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real }))
      fs.writeFileSync(path.join(dir, 'static/data/food-safety.json'), '[{"name":"iv4新"}]\n')
      const r = await computeWithEnv(dir, ENV)
      assert.deepEqual(r.requiredFunctions.map(x => x.fn), ['mc-tools'], `food 作者源恰 mc-tools（实得 ${JSON.stringify(r.requiredFunctions.map(x => x.fn))}）`)
      assert.ok(r.requiredFunctions[0].reasons.some(rr => rr.includes('food-safety')), '理由点名 food')
    }
    {
      // 可信基线 + 未跟踪新伴生文件（-uall 展开）→ 恰本函数
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real }))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/iv4-helper.js'), '// helper iv4\n')
      const r = await computeWithEnv(dir, ENV)
      assert.deepEqual(r.requiredFunctions.map(x => x.fn), ['mc-health'], `新伴生文件恰本函数（实得 ${JSON.stringify(r.requiredFunctions.map(x => x.fn))}）`)
      assert.ok(r.requiredFunctions[0].reasons.some(rr => rr.includes('iv4-helper')), '理由点名伴生文件（-uall 展开命中）')
    }
    {
      // 纯前端 + 可信基线：零源码级必需（不误报云部署）
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real }))
      fs.writeFileSync(path.join(dir, 'pages/index/index.vue'), '// page iv4 v22\n')
      const r = await computeWithEnv(dir, ENV)
      assert.equal(r.requiredFunctions.length, 0, `纯前端零必需（实得 ${JSON.stringify(r.requiredFunctions.map(x => x.fn))}）`)
    }
  })

  await scenario('A24 名单门：无基线 functions:[] 阻止；all 放行；窄名单缩减阻止并点名；幽灵函数拒绝；无例外开关', async () => {
    {
      const { dir } = makeFixture({})
      const r = runRelease(dir, ['--desc', 'iv4 gate', '--dry-run'])
      assert.equal(r.status, 1, `无基线 functions:[] → 阻止（实得 ${r.status}）`)
      assert.ok(String(r.stderr).includes('--functions all'), '提示完整集合')
      const src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
      assert.ok(!src.includes('--allow-incomplete'), '无例外开关')
    }
    {
      const { dir } = makeFixture({})
      const r = runRelease(dir, ['--desc', 'iv4 all', '--dry-run', '--functions', 'all'])
      assert.equal(r.status, 0, 'all 放行')
      assert.ok(r.stdout.includes('完整函数集合') && r.stdout.includes('零外呼'), '零外呼披露')
      assert.ok(r.stdout.includes('初步估算'), '保守估算口径')
    }
    {
      const { dir, head } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/functions/mc-restore/index.js'), '// restore iv4 v2\n') })
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real0 }))
      const rNarrow = runRelease(dir, ['--desc', 'iv4 narrow', '--dry-run', '--functions', 'mc-tools'])
      assert.equal(rNarrow.status, 1, '窄名单缩减 → 阻止')
      assert.ok(String(rNarrow.stderr).includes('mc-restore'), '缺项点名')
      const rUnion = runRelease(dir, ['--desc', 'iv4 union', '--dry-run', '--functions', 'mc-restore,mc-tools'])
      assert.equal(rUnion.status, 0, '闭包∪手工放行')
      const rGhost = runRelease(dir, ['--desc', 'iv4 ghost', '--dry-run', '--functions', 'mc-ghost-fn'])
      assert.equal(rGhost.status, 1, '幽灵函数拒绝')
    }
  })

  await scenario('A25 全部成功收据：先落盘后提交、工作区干净、提交=最终态、成功后零必需；真实 CLI 零调用', async () => {
    const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'utils/dailyTipCore.js'), '// core iv4 v3\n') })
    armMockRelease(dir)
    commitAll(dir, 'iv4 changes')
    const r = runRelease(dir, ['--desc', 'iv4 all ok', '--functions', 'all'], 300000)
    assert.equal(r.status, 0, `成功（stderr=${String(r.stderr).slice(0, 200)}）`)
    const st = fixtureState(dir)
    assert.equal(st.partial, false)
    assert.deepEqual(st.deployed.sort(), FNS.slice().sort())
    assert.equal(Object.keys(st.deployedDigests).length, 5)
    assert.equal(st.deployedEnv, ENV, '收据绑定部署目标')
    assert.equal(st.triggers.status, 'unverified', '含 mc-daily-push → 触发器平台未确认')
    assert.ok(st.uploadPackageDigest && /^[0-9a-f]{64}$/.test(st.uploadPackageDigest), '上传包摘要独立记录')
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(dirty, '', `提交后工作区干净（实得 ${dirty}）`)
    const committed = JSON.parse(execFileSync('git', ['show', 'HEAD:.trial-release-state.json'], { cwd: dir, encoding: 'utf8' }))
    assert.equal(committed.partial, false, '提交的是最终收据')
    assert.deepEqual(committed.deployed, st.deployed)
    const r2 = await computeWithEnv(dir, ENV)
    assert.equal(r2.requiredFunctions.length, 0, '成功后基线完整 → 零必需')
  })

  await scenario('A25b 部分失败（真实表目标 false+邻行 true）：partial 如实、确认项恰记、继承摘要、缺项仍必需', async () => {
    // 无基线（默认收据）+ --functions all：unknown 不中断循环——health 之外的函数照常部署
    const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'utils/dailyTipCore.js'), '// core iv4 v4\n') })
    // mc-health 的部署输出：信息日志前置 + 真实 formatter 表（目标 false + 邻行 true）
    armMockRelease(dir, [
      '#!/bin/sh',
      'case "$1" in',
      "  islogin) echo '{\"login\":true}'; exit 0;;",
      '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
      '  cloud)',
      '    fn=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
      '    case "$fn" in',
      '      mc-health) node "$PWD/scripts/.r4-real-table.mjs" --raw \'{"mc-health":{"success":false,"filesCount":9},"mc-health-ok-neighbor":{"success":true,"filesCount":7}}\'; exit 0;;',
      '      *) node "$PWD/scripts/.r4-real-table.mjs" "$fn" true; exit 0;;',
      '    esac;;',
      'esac',
      'exit 0'
    ].join('\n'))
    commitAll(dir, 'iv4 partial')
    const r = runRelease(dir, ['--desc', 'iv4 partial', '--functions', 'all'], 300000)
    assert.equal(r.status, 1, '部分失败 → exit 1')
    const st = fixtureState(dir)
    assert.equal(st.partial, true)
    assert.ok(!st.deployed.includes('mc-health'), '目标行 false 不因邻行 true 记成功')
    assert.deepEqual(st.deployed.sort(), ['mc-daily-push', 'mc-restore', 'mc-schedule', 'mc-tools'], `unknown 不中断——其余 4 项确认（实得 ${JSON.stringify(st.deployed)}）`)
    assert.ok(!st.deployedDigests['mc-health'], '未确认项零摘要（不冒充）')
    assert.equal(Object.keys(st.deployedDigests).length, 4, '恰 4 项确认摘要')
    commitAll(dir, 'record iv4 partial')
    const r2 = await computeWithEnv(dir, ENV)
    const req = r2.requiredFunctions.map(x => x.fn)
    assert.deepEqual(req, ['mc-health'], `partial 后缺项仍必需（实得 ${JSON.stringify(req)}）`)
  })

  await scenario('R4三1 env 绑定自建：缺 deployedEnv/空串/当前目标未知 → 无基线；真实发布无 envId 上传前拒绝+零上传', async () => {
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedDigests = real // 完整合法摘要但无 deployedEnv
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, ENV)
      assert.equal(r.confirmedDigests, null, '缺 deployedEnv → 摘要不构成基线')
      assert.equal(r.requiredFunctions.length, 5)
    }
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = ''; st.deployedDigests = real
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, ENV)
      assert.equal(r.confirmedDigests, null, '空 deployedEnv → 无基线')
    }
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = ENV; st.deployedDigests = real
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, '') // 当前 envId 未知
      assert.equal(r.confirmedDigests, null, '当前目标未知 → 不可借用')
      assert.equal(r.envUnknown, true)
    }
    // 换环境：deployedEnv=env-OLD ≠ 当前 env-iv4 → 旧摘要不构成基线 + dry-run 披露
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = 'env-OLD-iv4'; st.deployedDigests = real
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, ENV)
      assert.equal(r.envMismatch, true, '环境变化标记')
      assert.equal(r.confirmedDigests, null, '换环境旧摘要不可借用')
    }
    // 真实发布路径：utils/cloudConfig.js 无 envId → 上传前拒绝 + upload 零调用（标记文件）
    {
      const { dir } = makeFixture({})
      fs.writeFileSync(path.join(dir, 'utils/cloudConfig.js'), "export const CLOUD_CONFIG = { appId: 'wx-iv4' }\n")
      armMockRelease(dir)
      commitAll(dir, 'iv4 no envid')
      const r = runRelease(dir, ['--desc', 'iv4 noenv', '--functions', 'all'])
      assert.equal(r.status, 1, '未知目标 → 真实发布拒绝')
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用')
      const r2 = runRelease(dir, ['--desc', 'iv4 noenv', '--dry-run', '--functions', 'all'])
      assert.equal(r2.status, 0, 'dry-run 只披露')
      assert.ok(r2.stdout.includes('无法解析') || r2.stdout.includes('未知'), 'dry-run 披露未知目标')
    }
  })

  await scenario('R4二2/R4三2 CLI 契约自建：空输出=unknown；非零退出+true 表=unknown；业务 errCode+upload success=失败回滚', async () => {
    // ① cloud 输出空（exit 0）→ unknown 不记 deployed
    {
      const { dir } = makeFixture({})
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        "  islogin) echo '{\"login\":true}'; exit 0;;",
        '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
        '  cloud) exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'iv4 empty cloud')
      const r = runRelease(dir, ['--desc', 'iv4 empty', '--functions', 'all'], 300000)
      assert.equal(r.status, 1)
      const st = fixtureState(dir)
      assert.deepEqual(st.deployed, [], '空输出零 deployed')
      assert.equal(st.upload.status, 'uploaded', 'upload 独立判定')
    }
    // ② 非零退出 + 残留 true 表行 → unknown 不记
    {
      const { dir } = makeFixture({})
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        "  islogin) echo '{\"login\":true}'; exit 0;;",
        '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    node "$PWD/scripts/.r4-real-table.mjs" "$fn" true',
        '    exit 3;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'iv4 exit3')
      const r = runRelease(dir, ['--desc', 'iv4 exit3', '--functions', 'all'], 300000)
      assert.equal(r.status, 1)
      const st = fixtureState(dir)
      assert.deepEqual(st.deployed, [], '非零退出残留 true 表不记 deployed')
    }
    // ③ upload 输出同时含 "upload success" 与业务 errCode → failed + manifest 回滚 + 旧基线保留
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real }))
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        "  islogin) echo '{\"login\":true}'; exit 0;;",
        '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; echo "errCode: 41030 版本描述不合法"; exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'iv4 biz error upload')
      const r = runRelease(dir, ['--desc', 'iv4 upbiz', '--functions', 'all'])
      assert.equal(r.status, 1, '业务错误 → 失败')
      const st = fixtureState(dir)
      assert.equal(st.upload.status, 'failed', 'upload failed（不标 uploaded）')
      assert.equal(Object.keys(st.deployedDigests).length, 5, '旧确认基线保留')
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))).versionName, '1.1.24', 'manifest 回滚不跳号')
    }
  })

  await scenario('R4三4 上传前 pending+中断：磁盘=本次 pending（非旧完成态）；planned/uploadPackage 摘要在且独立重算相等', async () => {
    const { dir, head } = makeFixture({})
    const real = realDigests(dir)
    fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real }))
    armMockRelease(dir)
    commitAll(dir, 'iv4 first ok')
    const r1 = runRelease(dir, ['--desc', 'iv4 first', '--functions', 'all'], 300000)
    assert.equal(r1.status, 0, `首次成功（stderr=${String(r1.stderr).slice(0, 160)}）`)
    assert.equal(fixtureState(dir).partial, false, '首次=完成态')
    commitAll(dir, 'iv4 commit first')
    // 第二次：upload 快照 state 后挂死（被超时杀）——mock assemble 写新字节
    fs.writeFileSync(path.join(dir, '.mock-cli.sh'), [
      '#!/bin/sh',
      'case "$1" in',
      "  islogin) echo '{\"login\":true}'; exit 0;;",
      '  upload)',
      '    cp "$PWD/.trial-release-state.json" "$PWD/.state-at-upload.json"',
      '    sleep 300;;',
      'esac',
      'exit 0'
    ].join('\n'))
    fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
    fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core iv4 v9\n')
    const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
    fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
      "if (step === 'test' || step === 'assemble') process.exit(0)",
      "if (step === 'test') process.exit(0)\nif (step === 'assemble') { for (const fn of ['mc-daily-push','mc-tools','mc-health','mc-restore','mc-schedule']) { writeFileSync(process.cwd() + '/dist/cloud-functions/' + fn + '/index.js', '// iv4 v9\\n') } process.exit(0) }"
    ))
    commitAll(dir, 'iv4 interrupt attempt')
    const r2 = runRelease(dir, ['--desc', 'iv4 interrupt', '--functions', 'all'], 8000)
    assert.ok(r2.status !== 0 || r2.signal, `被中断（status=${r2.status} signal=${r2.signal}）`)
    const st = fixtureState(dir)
    assert.equal(st.version, '1.1.26', `磁盘=本次版本 pending（实得 ${st.version}）`)
    assert.equal(st.upload.status, 'pending', '不确定事实如实')
    assert.equal(st.partial, true)
    assert.ok(st.plannedDigests && Object.keys(st.plannedDigests).length === 5, 'plannedDigests 保留待确认')
    assert.ok(st.uploadPackageDigest && /^[0-9a-f]{64}$/.test(st.uploadPackageDigest), 'uploadPackageDigest 在')
    assert.equal(Object.keys(st.deployedDigests).length, 5, 'confirmed 仍旧 5 项（不冒充）')
    const changed = Object.keys(st.plannedDigests).filter(fn => st.plannedDigests[fn] !== st.deployedDigests[fn])
    assert.equal(changed.length, 5, `计划与确认可辨别（实得 ${changed.length} 项差异）`)
    // uploadPackageDigest 独立重算：与实际 dist/trial-upload 目录字节一致（与生产同式算法）
    const upDir = path.join(dir, 'dist/trial-upload')
    assert.ok(fs.existsSync(upDir), '上传暂存目录在')
    assert.equal(iv4DirDigest(upDir), st.uploadPackageDigest, '上传包摘要=独立重算的目录摘要')
    // upload 进入瞬间快照同样是本次 pending（版本/集合/planned 已落盘）
    const atUpload = JSON.parse(fs.readFileSync(path.join(dir, '.state-at-upload.json'), 'utf8'))
    assert.equal(atUpload.version, '1.1.26')
    assert.equal(atUpload.upload.status, 'pending')
    assert.ok(atUpload.plannedDigests && atUpload.uploadPackageDigest, '进入 upload 时计划+包摘要已耐久')
  })

  await scenario('R4终2 包完整清单自建：缺产物目录/缺源 config.json/缺共享模块 → blocked+upload 零调用；完整放行', async () => {
    // ① mock build 删除 dist/cloud-functions/mc-schedule 整目录 → blocked + upload 零调用
    {
      const { dir, head } = makeFixture({})
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real0 }))
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "const mp = join(process.cwd(), 'dist/build/mp-weixin')",
        "import { rmSync as iv4rm } from 'node:fs'\nif (step === 'build') { iv4rm(process.cwd() + '/dist/cloud-functions/mc-schedule', { recursive: true, force: true }) }\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')"
      ))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-schedule/index.js'), '// sched iv4 v2\n')
      commitAll(dir, 'iv4 missing artifact')
      const r = runRelease(dir, ['--desc', 'iv4 missart', '--functions', 'all'])
      assert.equal(r.status, 1, '缺产物 → blocked')
      assert.ok(String(r.stderr).includes('缺失') || String(r.stderr).includes('不合法'), `产物理由（实得 ${String(r.stderr).slice(0, 160)}）`)
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用（标记文件不存在）')
      assert.equal(fixtureState(dir).upload.status, 'blocked', 'blocked 收据')
    }
    // ② 源侧 config.json 未入包（夹具源写 config.json、dist 无副本）→ blocked + upload 零调用
    {
      const { dir, head } = makeFixture({})
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/config.json'), JSON.stringify({ permissions: { openapi: ['ocr.printedText'] } }))
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real0 }))
      armMockRelease(dir)
      commitAll(dir, 'iv4 src config not packaged')
      const r = runRelease(dir, ['--desc', 'iv4 srccfg', '--functions', 'all'])
      assert.equal(r.status, 1, '源 config.json 未入包 → blocked')
      assert.ok(String(r.stderr).includes('config.json'), '点名 config.json')
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用')
    }
    // ③ mock assemble 删除 shared/config.js（源共享模块清单不齐）→ blocked
    {
      const { dir, head } = makeFixture({})
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real0 }))
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "import { rmSync as iv4rm2 } from 'node:fs'\nif (step === 'test') process.exit(0)\nif (step === 'assemble') { iv4rm2(process.cwd() + '/dist/cloud-functions/mc-daily-push/shared/config.js'); process.exit(0) }"
      ))
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core iv4 v12\n')
      commitAll(dir, 'iv4 missing shared file')
      const r = runRelease(dir, ['--desc', 'iv4 missshared', '--functions', 'all'])
      assert.equal(r.status, 1, '缺 shared/config.js → blocked')
      assert.ok(String(r.stderr).includes('shared'), 'shared 理由')
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用')
    }
    // ④ 完整包 → 放行
    {
      const { dir, head } = makeFixture({})
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real0 }))
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core iv4 v13\n')
      armMockRelease(dir)
      commitAll(dir, 'iv4 full pkg')
      const r = runRelease(dir, ['--desc', 'iv4 fullpkg', '--functions', 'all'], 300000)
      assert.equal(r.status, 0, `完整包放行（stderr=${String(r.stderr).slice(0, 200)}）`)
      assert.equal(fixtureState(dir).partial, false)
    }
  })

  await scenario('R4二5 food 门自建：正文篡改（标记保留）/生成器语义变化 → 拒绝+manifest 回滚+零上传；一致放行', async () => {
    // ① 正文篡改但 source-sha256 标记保留
    {
      const { dir } = makeFixture({})
      const genPath = path.join(dir, 'cloud/functions/mc-tools/food-safety-data.js')
      const gen = fs.readFileSync(genPath, 'utf8')
      const marked = gen.replace('module.exports = [', 'module.exports = [/*iv4-tampered*/')
      assert.ok(marked !== gen, '篡改生效（标记保留）')
      fs.writeFileSync(genPath, marked)
      armMockRelease(dir)
      commitAll(dir, 'iv4 tampered food')
      const r = runRelease(dir, ['--desc', 'iv4 tamper', '--functions', 'all'])
      assert.equal(r.status, 1, '正文篡改 → 拒绝（标记匹配不放行）')
      assert.ok(String(r.stderr).includes('不一致') || String(r.stderr).includes('gen-food-safety'), 'R4二5 理由')
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))).versionName, '1.1.24', 'manifest 回滚')
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用')
    }
    // ② 生成器语义变化（输出尾部追加注释）但生成物未更新
    {
      const { dir } = makeFixture({})
      const genPath = path.join(dir, 'scripts/gen-food-safety.mjs')
      let gen = fs.readFileSync(genPath, 'utf8')
      const anchor = "module.exports = ' + JSON.stringify(entries, null, 2) + '\\n'"
      assert.ok(gen.includes(anchor), '生成器锚点在')
      gen = gen.replace(anchor, "module.exports = ' + JSON.stringify(entries, null, 2) + '\\n// iv4 semantic v2\\n'")
      fs.writeFileSync(genPath, gen)
      armMockRelease(dir)
      commitAll(dir, 'iv4 gen semantic')
      const r = runRelease(dir, ['--desc', 'iv4 gensem', '--functions', 'all'])
      assert.equal(r.status, 1, '生成器语义变化 → 拒绝')
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用')
    }
    // ③ 一致 → 放行
    {
      const { dir } = makeFixture({})
      armMockRelease(dir)
      commitAll(dir, 'iv4 fresh food')
      const r = runRelease(dir, ['--desc', 'iv4 freshfood', '--functions', 'all'], 300000)
      assert.equal(r.status, 0, `一致放行（stderr=${String(r.stderr).slice(0, 160)}）`)
      assert.equal(fixtureState(dir).partial, false)
    }
  })

  await scenario('R4二3 摘要耐久合并自建：纯前端发布不清旧基线；uploadPackageDigest 成功收据保留', async () => {
    const { dir, head } = makeFixture({})
    const real = realDigests(dir)
    fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real }))
    fs.writeFileSync(path.join(dir, 'pages/index/index.vue'), '// page iv4 v31\n')
    armMockRelease(dir)
    commitAll(dir, 'iv4 fe only')
    const r = runRelease(dir, ['--desc', 'iv4 fe'], 300000)
    assert.equal(r.status, 0, `纯前端+完整基线 functions:[] 放行（stderr=${String(r.stderr).slice(0, 160)}）`)
    const st = fixtureState(dir)
    assert.deepEqual(st.selected, [], '纯前端 selected 空')
    assert.deepEqual(st.deployed, [], '零部署不误报')
    assert.equal(Object.keys(st.deployedDigests).length, 5, '旧 5 项确认摘要全保留（不清基线）')
    assert.equal(st.upload.status, 'uploaded')
    assert.equal(st.triggers.status, 'not-applicable', 'selected 无 mc-daily-push → 不适用')
    assert.ok(st.uploadPackageDigest, '成功收据保留上传包摘要')
  })

  // 真实 state/manifest 字节不变断言（套件首尾）
  assert.ok(realStateBefore.equals(fs.readFileSync(REAL_STATE)), '真实 .trial-release-state.json 字节未变')
  assert.ok(realManifestBefore.equals(fs.readFileSync(REAL_MANIFEST)), '真实 manifest.json 字节未变')
  pass('真实 state/manifest 原始字节未变（套件全程）')

  console.log(`\nphase-iv-r4：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(async e => {
  console.error('套件异常:', e)
  console.error('真实 state/manifest 是否被改：',
    realStateBefore.equals(fs.readFileSync(REAL_STATE)) ? 'state 未变' : 'state 已变！',
    realManifestBefore.equals(fs.readFileSync(REAL_MANIFEST)) ? 'manifest 未变' : 'manifest 已变！')
  process.exit(2)
})
