// R4 回归（含首轮审核 R4R-1/2/3/5/6/7/8）：发布依赖闭包 + 无外呼 dry-run + 分状态收据。
// R4R-8 边界：所有场景在**独立临时项目夹具**运行——真实 state/manifest 零触碰；
// 套件首尾断言真实文件字节不变。
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

function makeFixture({ mutate, state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-r4fix-'))
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
  g(['init', '-q']); g(['config', 'user.email', 'r4@test.local']); g(['config', 'user.name', 'r4-test'])
  for (const fn of ['mc-daily-push', 'mc-tools', 'mc-health', 'mc-restore', 'mc-schedule']) {
    fs.mkdirSync(path.join(dir, 'cloud/functions', fn), { recursive: true })
    fs.writeFileSync(path.join(dir, 'cloud/functions', fn, 'index.js'), `// ${fn}\n`)
    // R4终2：dist 为完整包形状（入口/清单/shared/转译核心）——包完整性门按真实形状校验
    fs.mkdirSync(path.join(dir, 'dist/cloud-functions', fn, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/index.js`), `// ${fn} dist\n`)
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/shared/auth.js`), '// auth\n')
    // 阻2：assemble 整目录复制源 cloud/shared——夹具 dist 补全全部共享模块
    for (const sf of ['config.js', 'respond.js', 'constants.js']) fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/shared/${sf}`), `// ${sf}\n`)
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/shared/dailyTipCore.js`), '// core dist\n')
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/package.json`), JSON.stringify({ name: fn, version: '1.0.0', main: 'index.js', dependencies: { 'wx-server-sdk': '4.0.2' } }))
  }
  fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/food-safety-data.js'), '// food data\n')
  fs.writeFileSync(path.join(dir, 'cloud/functions/mc-restore/v20.js'), '// v20\n')
  // R4终2：伴生物随包（dist 侧同名副本——包完整性校验源侧伴生物在包内）
  fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-tools/food-safety-data.js'), '// food data\n')
  fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-restore/v20.js'), '// v20\n')
  fs.mkdirSync(path.join(dir, 'cloud/shared'), { recursive: true })
  for (const f of ['auth.js', 'config.js', 'respond.js', 'constants.js']) fs.writeFileSync(path.join(dir, 'cloud/shared', f), `// ${f}\n`)
  fs.mkdirSync(path.join(dir, 'utils'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'static/data'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'pages/index'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages/index/index.vue'), '// page\n')
  fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core\n')
  fs.writeFileSync(path.join(dir, 'static/data/food-safety.json'), JSON.stringify([{ id: 'fixture_x', name: '夹具词条', category: 'food', level: 'safe' }]) + '\n')
  fs.mkdirSync(path.join(dir, 'cloud/rules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cloud/rules/a.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'cloud/collections.json'), '{}\n')
  fs.mkdirSync(path.join(dir, 'cloud'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cloud/assemble.mjs'), '// assemble\n')
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts/release-dependency-closure.mjs'), path.join(dir, 'scripts/release-dependency-closure.mjs'))
  fs.copyFileSync(path.join(root, 'scripts/release-trial.mjs'), path.join(dir, 'scripts/release-trial.mjs'))
  fs.copyFileSync(path.join(root, 'scripts/.r4-real-table.mjs'), path.join(dir, 'scripts/.r4-real-table.mjs'))
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n') // 构建产物不入夹具 git（成功后干净断言）
  // R4R-7：夹具内用真实生成器产出一致的 food 伴生物（mock 发布场景不被 food 门拦截）
  fs.copyFileSync(path.join(root, 'scripts/gen-food-safety.mjs'), path.join(dir, 'scripts/gen-food-safety.mjs'))
  execFileSync('node', [path.join(dir, 'scripts/gen-food-safety.mjs')], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ versionName: '1.1.24', versionCode: '10124' }))
  fs.writeFileSync(path.join(dir, 'utils/cloudConfig.js'), "export const CLOUD_CONFIG = { envId: 'env-r4', appId: 'wx-r4' }\n")
  g(['add', '-A']); g(['commit', '-qm', 'init'])
  const head = g(['rev-parse', 'HEAD']).trim()
  fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(state !== undefined ? state : { version: '1.1.24', commit: head, functions: [] }, null, 2))
  if (mutate) mutate(dir)
  return { dir, head }
}

const closureMod = path.join(root, 'scripts/release-dependency-closure.mjs')
const computeDrv = path.join(os.tmpdir(), 'r4-drv-compute.mjs')
fs.writeFileSync(computeDrv, `import { computeChangedFunctions } from ${JSON.stringify(closureMod)}\nimport { writeFileSync } from 'node:fs'\nconst env = process.argv[4] || undefined\nconst r = computeChangedFunctions(process.argv[2], env ? { envId: env } : {})\nwriteFileSync(process.argv[3], JSON.stringify(r))\n`)
async function computeWithEnv(dir, env) {
  const out = path.join(os.tmpdir(), 'r4-out-' + crypto.randomBytes(4).toString('hex') + '.json')
  execFileSync('node', [computeDrv, dir, out, env || ''])
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}
const digestsDrv = path.join(os.tmpdir(), 'r4-drv-digests.mjs')
fs.writeFileSync(digestsDrv, `import { distFunctionDigests } from ${JSON.stringify(closureMod)}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify(distFunctionDigests(process.argv[3])))\n`)
function realDigests(dir) {
  const out = path.join(os.tmpdir(), 'r4-dig-' + crypto.randomBytes(3).toString('hex') + '.json')
  execFileSync('node', [digestsDrv, out, dir])
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

function armMockRelease(dir, deployScript) {
  let src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
  src = src.replace(`const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'`, `const CLI = join(root, '.mock-cli.sh')`)
  src = src.replace(`execSync('npm run test:all', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs test', { cwd: root, stdio: 'inherit' })`)
  src = src.replace(`execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs assemble', { cwd: root, stdio: 'inherit' })`)
  src = src.replace(`execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs build', { cwd: root, stdio: 'inherit' })`)
  // 重试等待时钟注入（R4二轮：避免 mock 失败重复真实等 45s；保留重试次数/判定/收据语义）
  src = src.replace('const RETRY_WAIT_MS = Number(process.env.MOMCARE_RETRY_WAIT_MS || 45000)', 'const RETRY_WAIT_MS = Number(process.env.MOMCARE_RETRY_WAIT_MS || 45000)')
  fs.writeFileSync(path.join(dir, 'scripts/release-trial.mjs'), src)
  fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst step = process.argv[2]\nconst root = process.cwd()\nif (step === 'test' || step === 'assemble') process.exit(0)\nconst mp = join(root, 'dist/build/mp-weixin')\nmkdirSync(mp, { recursive: true })\nwriteFileSync(join(mp, 'project.config.json'), JSON.stringify({ description: 'mock' }))\nprocess.exit(0)\n")
  fs.writeFileSync(path.join(dir, '.mock-cli.sh'), deployScript || [
    '#!/bin/sh',
    'case "$1" in',
    "  islogin) echo '{\"login\":true}'; exit 0;;",
    '  upload) echo "✔ upload success"; exit 0;;',
    '  cloud)',
    '    fn=""; prev=""',
    '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
    '    node "$PWD/scripts/.r4-real-table.mjs" "$fn" true',
    '    exit 0;;',
    'esac',
    'exit 0'
  ].join('\n'))
  fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
}
function commitAll(dir, msg) {
  const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
  g(['add', '-A'])
  try { g(['commit', '-qm', msg]) } catch { /* 无变更（脚本自身已提交）——继续 */ }
}
function fixtureState(dir) { return JSON.parse(fs.readFileSync(path.join(dir, '.trial-release-state.json'), 'utf8')) }

async function main() {
  console.log('R4 回归（含 R4R-1/2/3/5/6/7/8）：依赖闭包 + 无外呼 dry-run + 分状态收据\n')

  await scenario('A23 闭包规则（dailyTipCore/food/共享/assemble/自身/纯前端/-uall）', async () => {
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'utils/dailyTipCore.js'), '// core v2\n') })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.deepEqual(r.requiredFunctions.map(x => x.fn).sort(), ['mc-daily-push', 'mc-health', 'mc-restore', 'mc-schedule', 'mc-tools'], 'dailyTipCore → 全部')
    }
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'static/data/food-safety.json'), '[{"name":"x"}]\n') })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.ok(r.requiredFunctions.some(x => x.fn === 'mc-tools' && x.reasons.some(rr => rr.includes('food-safety'))), 'food 源 → mc-tools')
    }
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/shared/respond.js'), '// respond v2\n') })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.requiredFunctions.filter(x => x.reasons.some(rr => rr.includes('共享模块'))).length, 5, '共享 → 全部')
    }
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/assemble.mjs'), '// assemble v2\n') })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.requiredFunctions.filter(x => x.reasons.some(rr => rr.includes('assemble.mjs'))).length, 5, 'R4R-3: assemble → 全部')
    }
    {
      const { dir } = makeFixture({ mutate: d => {
        fs.writeFileSync(path.join(d, 'cloud/functions/mc-daily-push/index.js'), '// push v2\n')
        fs.writeFileSync(path.join(d, 'cloud/functions/mc-restore/v20.js'), '// v20 v2\n')
      } })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.deepEqual(r.requiredFunctions.filter(x => x.reasons.some(rr => rr.includes('函数文件变更'))).map(x => x.fn).sort(), ['mc-daily-push', 'mc-restore'], '自身/伴生')
    }
    {
      const { dir } = makeFixture({ state: {} , mutate: d => fs.writeFileSync(path.join(d, 'pages/index/index.vue'), '// page v9\n') })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.requiredFunctions.filter(x => x.reasons.some(rr => !rr.includes('R4R-1') && !rr.includes('无已确认部署摘要'))).length, 0, '纯前端不产生源码级必需')
    }
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'scripts/gen-food-safety.mjs'), '// gen v2\n') })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.ok(r.requiredFunctions.some(x => x.fn === 'mc-tools' && x.reasons.some(rr => rr.includes('生成器'))), '-uall 未跟踪目录展开（反例保留）')
    }
  })

  await scenario('R4R-3 中文/空格路径；git 失败 fail-closed', async () => {
    {
      const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/functions/mc-restore/伴生 模块 v2.js'), '// companion\n') })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.ok(r.requiredFunctions.some(x => x.fn === 'mc-restore' && x.reasons.some(rr => rr.includes('伴生 模块'))), '中文/空格路径命中')
    }
    {
      const { dir } = makeFixture({})
      const st = fixtureState(dir)
      st.commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.baselineMissing, true, '坏 commit → baselineMissing（不当空变更）')
    }
    {
      const { dir } = makeFixture({})
      fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.gitError, false, '无 git 基线时不查 git（commit 已无效 → baselineMissing）')
      assert.equal(r.baselineMissing, true, 'fail closed')
    }
  })

  await scenario('R4R-1 旧收据无函数基线→全部必需；partial 缺项→缺项必需；推进 HEAD 不吞缺项', async () => {
    {
      const { dir } = makeFixture({})
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.confirmedDigests, null, '旧收据（functions:[] 上传型）无函数基线')
      assert.equal(r.requiredFunctions.length, 5, '全部必需——上传 commit 不是部署证据')
    }
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = 'env-r4'
      st.deployedDigests = { 'mc-health': real['mc-health'], 'mc-tools': 'f'.repeat(64) }
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, 'env-r4')
      assert.deepEqual(r.requiredFunctions.map(x => x.fn).sort(), ['mc-daily-push', 'mc-restore', 'mc-schedule', 'mc-tools'], '缺项+不一致必需；一致的不必需')
      assert.ok(r.requiredFunctions.find(x => x.fn === 'mc-tools').reasons.some(rr => rr.includes('≠')), '不一致理由')
    }
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null // 推进陷阱：源码 diff 不可用
      st.deployedEnv = 'env-r4'
      st.deployedDigests = { 'mc-daily-push': real['mc-daily-push'], 'mc-health': real['mc-health'], 'mc-restore': real['mc-restore'], 'mc-tools': real['mc-tools'] }
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, 'env-r4')
      assert.deepEqual(r.requiredFunctions.map(x => x.fn), ['mc-schedule'], 'partial 后源码无变化，未确认函数仍必需')
    }
  })

  await scenario('A24+R4R-2 无函数基线：functions:[] 阻止；all 放行；无 allow-incomplete', async () => {
    {
      const { dir } = makeFixture({})
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'x', '--dry-run'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r.status, 1, `旧收据 + functions:[] → 阻止（实得 ${r.status}，stderr=${String(r.stderr).slice(0, 200)}）`)
      assert.ok(String(r.stderr).includes('--functions all'), `提示完整集合（实得 ${String(r.stderr).slice(0, 200)}）`)
      assert.ok(String(r.stderr).includes('R4R-1'), `R4R-1 理由标记（实得 ${String(r.stderr).slice(0, 200)}）`)
      assert.ok(String(r.stdout || '').includes('不是部署证据') || String(r.stderr).includes('无可信函数部署基线'), '上传 commit 不是部署证据的表述在场')
      const src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
      assert.ok(!src.includes("argv.includes('--allow-incomplete')"), 'R4R-2: 无例外开关解析')
      assert.ok(!/ALLOW_INCOMPLETE/.test(src), 'R4R-2: 无例外开关变量')
    }
    {
      const { dir } = makeFixture({})
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'x', '--dry-run', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r.status, 0, 'all 放行')
      assert.ok(r.stdout.includes('完整函数集合') && r.stdout.includes('零外呼'))
    }
    {
      // R4R-4/R4二4：可信函数基线（deployedDigests+deployedEnv）+ 源码变更 → all 与窄名单交互
      const { dir, head } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/functions/mc-health/index.js'), '// health v2\n') })
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
      const r1 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'x', '--dry-run', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r1.status, 0, 'R4R-4/R4二4: 可信基线+必需+all 共存（all 先于缩减检查）')
      const r2 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'x', '--dry-run', '--functions', 'mc-tools'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r2.status, 1, '窄名单缩减 → 阻止')
      assert.ok(String(r2.stderr).includes('mc-health'), '缺失项点名')
      const r3 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'x', '--dry-run', '--functions', 'mc-health,mc-tools'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r3.status, 0, '闭包∪手工放行')
      const r4 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'x', '--dry-run', '--functions', 'mc-ghost'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r4.status, 1, '幽灵函数拒绝')
    }
  })

  await scenario('R4R-4 dry-run 零外呼（夹具脏区演练）+ 源码顺序断言', async () => {
    const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'cloud/shared/auth.js'), '// dirty\n') })
    const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'dry', '--dry-run', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    assert.equal(r.status, 0, 'dry-run 成功（脏区）')
    assert.ok(!r.stdout.includes('工作区有未提交改动'), '不做 git 干净检查')
    const src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
    assert.ok(src.indexOf('if (DRY_RUN)') < src.indexOf('existsSync(CLI)'), 'dry-run 先于 CLI 检查')
    assert.ok(src.indexOf('if (DRY_RUN)') < src.indexOf("['islogin']"), 'dry-run 先于 islogin')
    assert.ok(r.stdout.includes('built=') && r.stdout.includes('partial'), '计划含收据语义')
    assert.ok(r.stdout.includes('R4R-7') || r.stdout.includes('food'), '计划含 food 门')
  })

  await scenario('R4R-5+6 中途失败（退出0+[error]）：partial 收据、失败/中止项不记、upload 独立、下次计划缺项仍必需', async () => {
    const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'utils/dailyTipCore.js'), '// core v5\n') })
    armMockRelease(dir, [
      '#!/bin/sh',
      'case "$1" in',
      "  islogin) echo '{\"login\":true}'; exit 0;;",
      '  upload) echo "✔ upload success"; exit 0;;',
      '  cloud)',
      '    fn=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
      '    case "$fn" in',
      '      mc-schedule) echo "deploy ok $fn"; echo "[error] 80051 mock business error"; exit 0;;',
            '      *) node "$PWD/scripts/.r4-real-table.mjs" "$fn" true; exit 0;;',
      '    esac;;',
      'esac',
      'exit 0'
    ].join('\n'))
    commitAll(dir, 'changes')
    const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'partial biz', '--functions', 'all'], { cwd: dir, encoding: 'utf8', timeout: 300000, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    assert.equal(r.status, 1, '退出 0 但 [error] → 失败（R4R-6）')
    const st = fixtureState(dir)
    assert.equal(st.upload.status, 'uploaded', '小程序上传独立成功')
    assert.equal(st.partial, true, 'partial')
    assert.deepEqual(st.deployed, ['mc-daily-push', 'mc-health', 'mc-restore'], '失败前确认项（排序序）')
    assert.ok(!st.deployed.includes('mc-schedule'), '退出0+[error] 绝不记')
    assert.ok(!st.deployed.includes('mc-tools'), '中止后项不虚记')
    assert.ok(st.deployedDigests['mc-daily-push'] && st.deployedDigests['mc-daily-push'].length === 64, '确认摘要入账')
    assert.ok(!st.deployedDigests['mc-schedule'], '失败项无摘要')
    assert.equal(st.triggers.status, 'unverified')
    const dirtyAfter = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    assert.ok(dirtyAfter.includes('.trial-release-state.json'), '部分失败后 state 未提交（可恢复事实）')
    commitAll(dir, 'record partial')
    const r2 = await computeWithEnv(dir, 'env-r4')
    assert.deepEqual(r2.requiredFunctions.map(x => x.fn).sort(), ['mc-schedule', 'mc-tools'], 'partial 后再计划：缺项仍必需')
  })

  await scenario('R4R-6 unknown（退出非0无错误标记）不记 deployed', async () => {
    const { dir } = makeFixture({})
    armMockRelease(dir, [
      '#!/bin/sh',
      'case "$1" in',
      "  islogin) echo '{\"login\":true}'; exit 0;;",
      '  upload) echo "✔ upload success"; exit 0;;',
      '  cloud)',
      '    fn=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
      '    case "$fn" in',
      '      mc-tools) echo "some ambiguous output"; exit 3;;',
            '      *) node "$PWD/scripts/.r4-real-table.mjs" "$fn" true; exit 0;;',
      '    esac;;',
      'esac',
      'exit 0'
    ].join('\n'))
    commitAll(dir, 'unknown case')
    const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'unknown', '--functions', 'all'], { cwd: dir, encoding: 'utf8', timeout: 300000, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    assert.equal(r.status, 1, 'unknown → exit 1')
    const st = fixtureState(dir)
    assert.equal(st.partial, true)
    assert.ok(!st.deployed.includes('mc-tools'), 'unknown 不记 deployed')
    assert.ok(!st.deployedDigests['mc-tools'], 'unknown 无摘要')
  })

  await scenario('R4R-5 全部成功：最终收据先落盘后提交；提交后工作区干净；提交内容=最终态', async () => {
    const { dir } = makeFixture({ mutate: d => fs.writeFileSync(path.join(d, 'utils/dailyTipCore.js'), '// core v6\n') })
    armMockRelease(dir)
    commitAll(dir, 'all ok')
    const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'all ok', '--functions', 'all'], { cwd: dir, encoding: 'utf8', timeout: 300000, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    assert.equal(r.status, 0, `成功（stderr=${r.stderr.slice(0, 160)}）`)
    const st = fixtureState(dir)
    assert.equal(st.partial, false)
    assert.equal(st.deployed.length, 5)
    assert.equal(Object.keys(st.deployedDigests).length, 5, '全部函数基线建立')
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } }).trim()
    assert.equal(dirty, '', `提交后工作区干净（实得 ${dirty}）`)
    const committed = execFileSync('git', ['show', 'HEAD:.trial-release-state.json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    const committedSt = JSON.parse(committed)
    assert.equal(committedSt.partial, false, '提交的收据是最终态')
    assert.deepEqual(committedSt.deployed, st.deployed, '提交收据与盘上一致')
    const r2 = await computeWithEnv(dir, 'env-r4')
    assert.equal(r2.requiredFunctions.length, 0, '成功后基线完整+无源码变更 → 零必需')
  })

  await scenario('R4R-5 upload 成功后部署前 partial 语义（源码顺序）', async () => {
    const src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
    const upOk = src.indexOf("receipt.upload.status = 'uploaded'")
    const partialTrue = src.indexOf('receipt.partial = true', upOk)
    const deployLoop = src.indexOf('for (const fn of receipt.selected)', upOk)
    assert.ok(upOk >= 0 && partialTrue > upOk && partialTrue < deployLoop, 'upload 成功后、部署前写 partial=true')
  })

  await scenario('R4R-7 food 陈旧/无标记拒绝；再生成后放行成功', async () => {
    {
      const { dir } = makeFixture({ mutate: d => {
        fs.writeFileSync(path.join(d, 'cloud/functions/mc-tools/food-safety-data.js'), "// header\n// source-sha256: " + 'a'.repeat(64) + "\nmodule.exports = []\n")
        fs.writeFileSync(path.join(d, 'static/data/food-safety.json'), '[{"name":"新词条"}]\n')
      } })
      armMockRelease(dir)
      commitAll(dir, 'stale food')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'stale', '--functions', 'all'], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r.status, 1, '陈旧生成物 → 拒绝')
      assert.ok(String(r.stderr).includes('gen-food-safety'), '提示再生成')
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))).versionName, '1.1.24', 'manifest 回滚不跳号')
    }
    {
      const { dir } = makeFixture({ mutate: d => {
        // 覆盖为无标记旧版生成物（夹具默认已带标记——R4R-7 ②需要无标记形状）
        fs.writeFileSync(path.join(d, 'cloud/functions/mc-tools/food-safety-data.js'), '// old generator output, no marker\nmodule.exports = []\n')
      } })
      armMockRelease(dir)
      commitAll(dir, 'no marker')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'nomark', '--functions', 'all'], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r.status, 1, '无标记 → 拒绝')
      assert.ok(String(r.stderr).includes('标记') || String(r.stderr).includes('source-sha256'), '无标记提示')
    }
    {
      const { dir } = makeFixture({})
      fs.copyFileSync(path.join(root, 'scripts/gen-food-safety.mjs'), path.join(dir, 'scripts/gen-food-safety.mjs'))
      execFileSync('node', [path.join(dir, 'scripts/gen-food-safety.mjs')], { cwd: dir })
      armMockRelease(dir)
      commitAll(dir, 'fresh food')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'fresh', '--functions', 'all'], { cwd: dir, encoding: 'utf8', timeout: 300000, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r.status, 0, `一致生成物放行（stderr=${r.stderr.slice(0, 160)}）`)
      assert.equal(fixtureState(dir).partial, false)
    }
  })

  await scenario('A25 纯前端零云部署（完整基线）：selected=[]/deployed=[] 不误报', async () => {
    const { dir } = makeFixture({ state: undefined })
    const real = realDigests(dir)
    const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    const head = g(['rev-parse', 'HEAD']).trim()
    fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
    fs.writeFileSync(path.join(dir, 'pages/index/index.vue'), '// page v10\n')
    armMockRelease(dir)
    commitAll(dir, 'frontend only')
    const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'pure frontend'], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
    assert.equal(r.status, 0, `成功（stderr=${r.stderr.slice(0, 160)}）`)
    const st = fixtureState(dir)
    assert.deepEqual(st.selected, [])
    assert.deepEqual(st.deployed, [])
    assert.equal(st.upload.status, 'uploaded')
    assert.equal(st.triggers.status, 'not-applicable')
    assert.equal(st.partial, false, '计划内零函数——非 partial')
  })

  // ══ R4 第二轮审核反例（R4_REVIEW_ROUND2 1–5）══

  await scenario('R4二1 dist 缺失/invalid done fail-closed；新 assemble 摘要重核对补入', async () => {
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = 'env-r4'; st.deployedDigests = real
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      fs.rmSync(path.join(dir, 'dist/cloud-functions/mc-schedule'), { recursive: true, force: true })
      const r = await computeWithEnv(dir, 'env-r4')
      assert.ok(r.requiredFunctions.some(x => x.fn === 'mc-schedule' && x.reasons.some(rr => rr.includes('未知') || rr.includes('fail closed'))), 'dist 缺失 → 必需')
    }
    {
      const { dir } = makeFixture({})
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = 'env-r4'
      st.deployedDigests = { 'mc-health': 'not-hex', 'mc-tools': '' }
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, 'env-r4')
      assert.ok(r.requiredFunctions.some(x => x.fn === 'mc-health' && x.reasons.some(rr => rr.includes('64hex'))), '非 64hex done → 必需')
      assert.ok(r.requiredFunctions.some(x => x.fn === 'mc-tools'), '空 done → 必需')
    }
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      armMockRelease(dir)
      // mock assemble 改写 mc-restore 的 dist（新字节 ≠ 确认摘要）→ selected 重核对补入
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "if (step === 'test') process.exit(0)\nif (step === 'assemble') { writeFileSync(process.cwd() + '/dist/cloud-functions/mc-restore/index.js', '// restored NEW\\n'); process.exit(0) }"
      ))
      commitAll(dir, 'assemble changes dist')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'late'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `成功（stderr=${r.stderr.slice(0, 200)}）`)
      const st2 = fixtureState(dir)
      assert.ok(st2.selected.includes('mc-restore'), `新摘要重核对补入 mc-restore（实得 ${JSON.stringify(st2.selected)}）`)
      assert.ok(r.stdout.includes('重核对') || r.stdout.includes('补入'), '重核对披露在场')
    }
  })

  await scenario('R4二2 CLI 契约：空输出0=unknown；upload 无确认=unknown；契约形状成功；errCode 无标记失败', async () => {
    {
      const { dir } = makeFixture({})
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; exit 0;;',
        '  cloud) exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'empty output')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'empty', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, 'unknown → exit 1')
      const st = fixtureState(dir)
      assert.equal(st.partial, true)
      assert.deepEqual(st.deployed, [], '空输出 0 不记任何 deployed')
      assert.equal(st.upload.status, 'uploaded')
    }
    {
      const { dir } = makeFixture({})
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "some random output"; exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'no upload confirm')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'noupload', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1)
      assert.equal(fixtureState(dir).upload.status, 'unknown', '不标 uploaded（R4二2）')
    }
    {
      const { dir } = makeFixture({})
      armMockRelease(dir)
      commitAll(dir, 'contract ok')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'contract', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `契约输出成功（stderr=${r.stderr.slice(0, 200)}）`)
      assert.equal(fixtureState(dir).deployed.length, 5)
    }
    {
      const { dir } = makeFixture({})
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo \"upload success\"; exit 0;;',
        '  cloud) echo "errCode: 80051 some failure" >&2; exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'errCode no marker')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'errcode', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, 'errCode 业务错误 → 失败')
      assert.deepEqual(fixtureState(dir).deployed, [])
    }
  })

  await scenario('R4二3 摘要耐久合并：纯前端/上传失败/部分成功不清旧基线；换环境拒绝旧基线', async () => {
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      fs.writeFileSync(path.join(dir, 'pages/index/index.vue'), '// page v11\n')
      armMockRelease(dir)
      commitAll(dir, 'fe again')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'fe2'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0)
      const st = fixtureState(dir)
      assert.equal(Object.keys(st.deployedDigests).length, 5, '旧 5 项确认摘要全保留')
      assert.deepEqual(st.deployed, [])
    }
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "[error] upload failed"; exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'upload fail')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'upfail', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1)
      assert.equal(fixtureState(dir).upload.status, 'failed')
      assert.equal(Object.keys(fixtureState(dir).deployedDigests).length, 5, '上传失败保留旧基线')
    }
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core v7\n')
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    case "$fn" in',
        '      mc-schedule) echo "errCode 500" >&2; exit 1;;',
        '      *) node "$PWD/scripts/.r4-real-table.mjs" "$fn" true; exit 0;;',
        '    esac;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'partial merge')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'pmerge', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, 'mc-schedule 失败 → exit 1')
      const st = fixtureState(dir)
      assert.ok(!st.deployed.includes('mc-schedule'), '未确认项绝不记 deployed')
      assert.deepEqual(st.deployed.filter(f => f !== 'mc-tools'), ['mc-daily-push', 'mc-health', 'mc-restore'], '确认项在（unknown 不中断——tools 亦部署）')
      assert.equal(Object.keys(st.deployedDigests).length, 5, '摘要 5 项全在（合并保留）')
      assert.ok(st.deployedDigests['mc-schedule'] === real['mc-schedule'], '未确认项保留旧摘要')
    }
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: null, deployedEnv: 'env-OLD', deployedDigests: real }))
      const rr = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'envchange', '--dry-run', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(rr.status, 0)
      assert.ok(rr.stdout.includes('环境变化'), `环境变化披露（实得 ${rr.stdout.slice(0, 300)}）`)
      const rr2 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'envblock', '--dry-run'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(rr2.status, 1, '换环境 + functions:[] → 阻止（旧基线无效）')
    }
  })

  await scenario('R4二5 food 真实再生成比对：生成器语义变化/正文篡改拒绝；一致放行', async () => {
    {
      const { dir } = makeFixture({})
      const genPath = path.join(dir, 'scripts/gen-food-safety.mjs')
      let gen = fs.readFileSync(genPath, 'utf8')
      gen = gen.replace("module.exports = ' + JSON.stringify(entries, null, 2) + '\\n'", "module.exports = ' + JSON.stringify(entries, null, 2) + '\\n// v2 semantic change\\n'")
      fs.writeFileSync(genPath, gen)
      armMockRelease(dir)
      commitAll(dir, 'gen semantic change')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'gensem', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '生成器语义变化未更新生成物 → 拒绝')
      assert.ok(String(r.stderr).includes('不一致') || String(r.stderr).includes('gen-food-safety'), 'R4二5 理由')
    }
    {
      const { dir } = makeFixture({})
      const genPath = path.join(dir, 'cloud/functions/mc-tools/food-safety-data.js')
      let gen = fs.readFileSync(genPath, 'utf8')
      gen = gen.replace('module.exports = [', 'module.exports = [/*tampered*/')
      fs.writeFileSync(genPath, gen)
      armMockRelease(dir)
      commitAll(dir, 'tampered body')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'tamper', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, 'marker 在但正文篡改 → 拒绝')
      assert.ok(String(r.stderr).includes('不一致'), '正文比对拒绝')
    }
    {
      const { dir } = makeFixture({})
      armMockRelease(dir)
      commitAll(dir, 'consistent')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'okfood', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `一致 → 放行（stderr=${r.stderr.slice(0, 160)}）`)
      assert.equal(fixtureState(dir).partial, false)
    }
  })


  // ══ R4 第三轮审核反例（R4_REVIEW_ROUND3 1–4）══

  await scenario('R4三1 deployedEnv 缺失/当前 env 未知 → 无基线不可借用', async () => {
    // ① 完整合法摘要但 deployedEnv 缺失 → 无基线（全部必需）
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null
      st.deployedDigests = real // 完整合法摘要
      // 无 deployedEnv —— legacy/畸形
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.confirmedDigests, null, 'deployedEnv 缺失 → 摘要不构成基线')
      assert.equal(r.requiredFunctions.length, 5, '全部必需（R4三1）')
      assert.ok(r.requiredFunctions.every(x => x.reasons.some(rr => rr.includes('deployedEnv') || rr.includes('R4三1'))), '理由注明缺绑定')
    }
    // ② deployedEnv 空字符串 → 同样无基线
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = ''
      st.deployedDigests = real
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, 'env-r4')
      assert.equal(r.confirmedDigests, null, '空 deployedEnv → 无基线')
    }
    // ③ 当前 envId 无法解析（compute 不传 env）→ 不可借用任何摘要
    {
      const { dir } = makeFixture({})
      const real = realDigests(dir)
      const st = fixtureState(dir)
      st.commit = null; st.deployedEnv = 'env-r4'
      st.deployedDigests = real
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(st))
      const r = await computeWithEnv(dir, '') // 无 env
      assert.equal(r.confirmedDigests, null, '当前目标未知 → 不可借用（R4三1）')
      assert.equal(r.requiredFunctions.length, 5, '全部必需')
    }
    // ④ 真实发布路径：utils/cloudConfig.js 无 envId → 上传前拒绝（非 dry-run）
    {
      const { dir } = makeFixture({})
      fs.writeFileSync(path.join(dir, 'utils/cloudConfig.js'), "export const CLOUD_CONFIG = { appId: 'wx-r4' }\n") // 无 envId
      armMockRelease(dir)
      commitAll(dir, 'no envid')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'noenv', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '未知目标 → 真实发布上传前拒绝')
      assert.ok(String(r.stderr).includes('envId') || String(r.stderr).includes('目标'), `理由（实得 ${r.stderr.slice(0, 160)}）`)
      // dry-run 明确 fail closed 披露
      const r2 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'noenv', '--dry-run', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r2.status, 0, `dry-run 输出计划（实得 ${r2.status} stderr=${r2.stderr.slice(0, 120)}）`)
      assert.ok(r2.stdout.includes('无法解析') || r2.stdout.includes('未知'), `dry-run 明确披露未知目标（实得 ${r2.stdout.slice(0, 300)}）`)
    }
  })

  await scenario('R4三2 CLI 精确表行：邻行 true 不串/同名前缀不认/非零退出不成功/业务 error 失败', async () => {
    // ① 目标 success:false + 邻行他函数 success:true → 不成功
    {
      const { dir } = makeFixture({})
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    echo "| name | success |"',
        '    echo "| $fn | false |",',
        '    echo "| other-fn | true |",',
        '    exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'neighbor true')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'nb', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1)
      const st = fixtureState(dir)
      assert.deepEqual(st.deployed, [], '目标 false 行不因邻行 true 成功（每函数都被误判）')
    }
    // ② 同名前缀：mc-tools 的行写成 mc-tools-extra=true → mc-tools 不认
    {
      const { dir, head } = makeFixture({})
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    echo "| mc-tools-extra | true |",',
        '    echo "| other | true |",',
        '    exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/index.js'), '// tools v3\n')
      commitAll(dir, 'prefix')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'pfx', '--functions', 'mc-tools'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, `unknown 最终 exit 1（实得 ${r.status} stderr=${r.stderr.slice(0, 120)}）`)
      assert.deepEqual(fixtureState(dir).deployed, [], 'mc-tools-extra 不算 mc-tools（词元边界）')
    }
    // ③ 目标 true 但退出 3 → unknown 不成功
    {
      const { dir, head } = makeFixture({})
      const real0 = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; exit 0;;',
        '  cloud)',
        '    echo "| mc-health | true |",',
        '    exit 3;;',
        'esac',
        'exit 0'
      ].join('\n'))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/index.js'), '// health v5\n')
      commitAll(dir, 'exit3 true row')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'e3', '--functions', 'mc-health'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '非零退出 → 最终 exit 1')
      assert.deepEqual(fixtureState(dir).deployed, [], '残留 true 表行不记 deployed')
    }
    // ④ stdout 业务 error（无 [error]）与 upload success 同在 → upload 不标 uploaded
    {
      const { dir } = makeFixture({})
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; echo "errCode 43101 quota"; exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'biz error with success')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'bizup', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1)
      const st = fixtureState(dir)
      assert.equal(st.upload.status, 'failed', '业务 error + success 同在 → failed 不 uploaded')
      assert.deepEqual(st.deployed, [])
    }
  })

  await scenario('R4三3 最终集合前置验证：晚补定时函数 trigger 重算；assemble 缺产物拒绝；dry-run 保守披露', async () => {
    // ① 初始 selected=[] 但新 assemble 变化晚补 mc-daily-push → trigger=unverified（非 not-applicable）
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "if (step === 'test') process.exit(0)\nif (step === 'assemble') { writeFileSync(process.cwd() + '/dist/cloud-functions/mc-daily-push/index.js', '// push NEW\\n'); process.exit(0) }"
      ))
      commitAll(dir, 'late daily-push')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'latedp'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `成功（stderr=${r.stderr.slice(0, 200)}）`)
      const st = fixtureState(dir)
      assert.ok(st.selected.includes('mc-daily-push'), '晚补 mc-daily-push')
      assert.equal(st.triggers.status, 'unverified', 'trigger 按最终 selected 重算（非 not-applicable）')
    }
    // ② assemble 缺目标产物（dist 函数目录被删）→ 上传前明确拒绝（非 CLI 事后兜底）
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "if (step === 'test') process.exit(0)\nif (step === 'assemble') { rmSync(process.cwd() + '/dist/cloud-functions/mc-tools', { recursive: true, force: true }); process.exit(0) }"
      ).replace("import { mkdirSync, writeFileSync }", "import { mkdirSync, writeFileSync, rmSync }"))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/index.js'), '// tools v2\n') // 源变更使 mc-tools 必需
      commitAll(dir, 'missing artifact')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'missart', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '缺产物 → 上传前拒绝')
      assert.ok(String(r.stderr).includes('前置验证') || String(r.stderr).includes('缺失'), `前置验证理由（实得 ${r.stderr.slice(0, 200)}）`)
      assert.equal(fixtureState(dir).upload.status, 'blocked', '前置验证 blocked（本次计划已落盘）')
      assert.equal(fixtureState(dir).version, '1.1.25', '留下本次版本事实')
    }
    // ③ dry-run 保守披露：无法证明新鲜
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      commitAll(dir, 'clean for dryrun')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'dryfresh', '--dry-run'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
      assert.equal(r.status, 0, `dry-run 成功（实得 ${r.status} stderr=${r.stderr.slice(0, 120)}）`)
      assert.ok(r.stdout.includes('无法证明') || r.stdout.includes('保守'), `dry-run 明确披露未知新鲜度（实得 ${r.stdout.slice(0, 400)}）`)
      assert.ok(r.stdout.includes('assemble 后重核对'), '说明实际发布会重核对')
    }
  })

  await scenario('R4三4 上传前耐久 pending：mock CLI 进入时 state 已本次 pending；中断保留不确定事实', async () => {
    // ① mock upload 检查进入时 state 已是本次版本 pending/partial
    {
      const { dir } = makeFixture({})
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst step = process.argv[2]\nif (step === 'test' || step === 'assemble') process.exit(0)\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')\nmkdirSync(mp, { recursive: true })\nwriteFileSync(join(mp, 'project.config.json'), JSON.stringify({ description: 'mock' }))\nprocess.exit(0)\n")
      // 记录 upload 被调用时的 state 快照
      fs.writeFileSync(path.join(dir, '.mock-cli.sh'), [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload)',
        '    cp "$PWD/.trial-release-state.json" "$PWD/.state-at-upload.json"',
        '    echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    node "$PWD/scripts/.r4-real-table.mjs" "$fn" true; exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
      let src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
      src = src.replace(`const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'`, `const CLI = join(root, '.mock-cli.sh')`)
      src = src.replace(`execSync('npm run test:all', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs test', { cwd: root, stdio: 'inherit' })`)
      src = src.replace(`execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs assemble', { cwd: root, stdio: 'inherit' })`)
      src = src.replace(`execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs build', { cwd: root, stdio: 'inherit' })`)
      fs.writeFileSync(path.join(dir, 'scripts/release-trial.mjs'), src)
      commitAll(dir, 'pending check')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'pendck', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `成功（stderr=${r.stderr.slice(0, 200)}）`)
      const atUpload = JSON.parse(fs.readFileSync(path.join(dir, '.state-at-upload.json'), 'utf8'))
      assert.equal(atUpload.version, '1.1.25', 'upload 进入时 state=本次版本')
      assert.equal(atUpload.upload.status, 'pending', 'upload 进入时 upload:pending（R4三4）')
      assert.equal(atUpload.partial, true, 'upload 进入时 partial:true')
      assert.ok(Array.isArray(atUpload.selected) && atUpload.selected.length === 5, '计划集合已落盘')
      assert.equal(atUpload.deployedEnv, 'env-r4', '部署目标已落盘')
    }
    // ② upload 阶段中断（mock upload 杀掉脚本进程模拟超时/崩溃）→ 磁盘保留本次 pending（不回退旧完成态）
    {
      const { dir, head } = makeFixture({})
      // 先跑一次成功发布建立"旧完成收据"
      armMockRelease(dir)
      commitAll(dir, 'first release')
      const r1 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'first', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r1.status, 0)
      const afterFirst = fixtureState(dir)
      assert.equal(afterFirst.partial, false, '首次发布完成收据')
      commitAll(dir, 'commit first')
      // 第二次发布：源变更 + upload 阶段模拟中断（mock upload 用 SIGKILL 杀父进程组不可靠——
      // 改为 upload 永不返回（挂起）+ 外部 timeout 杀进程）
      fs.writeFileSync(path.join(dir, '.mock-cli.sh'), [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) sleep 300;;', // 挂起——外部超时杀
        'esac',
        'exit 0'
      ].join('\n'))
      fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core v9\n')
      commitAll(dir, 'second release attempt')
      const r2 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'interrupted', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 8000 })
      assert.ok(r2.status !== 0 || r2.signal, `进程被中断（status=${r2.status} signal=${r2.signal}）`)
      const stAfter = fixtureState(dir)
      assert.notEqual(stAfter.version, afterFirst.version, '磁盘不再是旧次版本')
      assert.equal(stAfter.version, '1.1.26', '中断留下本次版本 pending')
      assert.equal(stAfter.upload.status, 'pending', 'upload:pending（不确定事实保留——可能已发出）')
      assert.equal(stAfter.partial, true, 'partial:true')
    }
  })


  // ══ R4 终审反例（R4_REVIEW_FINAL_DETAILS 1–3）══

  await scenario('R4终1 表头定位 success 列：真实表形/其他列 true/信息日志不确认；前置日志不遮挡', async () => {
    const mkTableMock = (rows, pre) => [
      '#!/bin/sh',
      'case "$1" in',
      '  islogin) echo \'{"login":true}\'; exit 0;;',
      '  upload) echo "upload success"; exit 0;;',
      '  cloud)',
      '    fn=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
      ...(pre || []),
      '    echo "┌─────────┬─────────┬────────────┬──────────┐"',
      '    echo "│ (index) │ success │ filesCount │ packSize │"',
      '    echo "├─────────┼─────────┼────────────┼──────────┤"',
      ...rows,
      '    echo "└─────────┴─────────┴────────────┴──────────┐"',
      '    exit 0;;',
      'esac',
      'exit 0'
    ].join('\n')
    const armAndRun = async (dir, script, fns) => {
      armMockRelease(dir, script)
      commitAll(dir, 'table case')
      return spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'tbl', '--functions', fns], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
    }
    const withBaseline = dir => {
      const real0 = realDigests(dir)
      const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      const head = g(['rev-parse', 'HEAD']).trim()
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
    }
    // ① 真实表头 + 目标 success:false + 其他列真值 → 不成功
    {
      const { dir } = makeFixture({})
      withBaseline(dir)
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/index.js'), '// h v2\n')
      const r = await armAndRun(dir, mkTableMock(['    echo "│ 0       │ false   │ 12         │ true     │"', '    echo "│ 1       │ true    │ 8          │ 3.2kB    │"']), 'mc-health')
      assert.equal(r.status, 1, '目标 false 行不因其他列 true 成功')
      assert.ok(!fixtureState(dir).deployed.includes('mc-health'), '不记 deployed')
    }
    // ② 普通非表格日志含 "mc-health | true" → 无表头不确认
    {
      const { dir } = makeFixture({})
      withBaseline(dir)
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/index.js'), '// h v3\n')
      const r = await armAndRun(dir, [
        '#!/bin/sh', 'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; exit 0;;',
        '  cloud) echo "some info: mc-health | true done"; exit 0;;',
        'esac', 'exit 0'
      ].join('\n'), 'mc-health')
      assert.equal(r.status, 1, '非表格日志不构成确认')
      assert.ok(!fixtureState(dir).deployed.includes('mc-health'))
    }
    // ③ 前置信息日志后合法目标表项 → 成功（信息日志不遮挡）
    {
      const { dir } = makeFixture({})
      withBaseline(dir)
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/index.js'), '// h v4\n')
      const fnVar = '    echo "│ \"$fn\"   │ true    │ 10         │ 2kB      │"'
      const r = await armAndRun(dir, mkTableMock([fnVar], ['    echo "info: starting deploy for $fn"']), 'mc-health')
      assert.equal(r.status, 0, `前置信息日志后表项成功（stderr=${r.stderr.slice(0, 200)}）`)
      assert.ok(fixtureState(dir).deployed.includes('mc-health'), '记 deployed')
    }
    // ④ 正常 true 表项（同名前缀/邻行反例已在 R4三2 保留）
    {
      const { dir } = makeFixture({})
      withBaseline(dir)
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/index.js'), '// t v5\n')
      const fnVar2 = '    echo "│ \"$fn\"  │ true    │ 15         │ 4kB      │"'
      const r = await armAndRun(dir, mkTableMock([fnVar2]), 'mc-tools')
      assert.equal(r.status, 0, '正常表项成功')
      assert.ok(fixtureState(dir).deployed.includes('mc-tools'))
    }
  })

  await scenario('R4终2 包完整性：缺 index/空目录/缺 shared 拒绝且零外呼；合法完整包放行', async () => {
    // 夹具 dist 已是完整包形状（makeFixture 补全）；伴生物补充（v20/food）：
    const completeDist = dir => {
      fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-restore/v20.js'), '// v20\n')
      fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-tools/food-safety-data.js'), '// food\n')
    }
    // ① 删 index.js（保留目录）→ blocked，upload/deploy 零调用
    {
      const { dir } = makeFixture({})
      completeDist(dir)
      const real0 = realDigests(dir)
      const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      const head = g(['rev-parse', 'HEAD']).trim()
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
      let uploadCalls = 0
      armMockRelease(dir, [
        '#!/bin/sh', 'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) echo "upload success"; exit 0;;',
        'esac', 'exit 0'
      ].join('\n'))
      // 计数经 .mock-cli 包装：直接改 mock 记录 upload 调用
      fs.appendFileSync(path.join(dir, '.mock-cli.sh'), '\n# upload counter\n')
      const origCall = spawnSync
      void origCall
      // 注入计数：脚本 spawnSync CLI upload——通过 mock 在 upload 时写标记文件
      fs.writeFileSync(path.join(dir, '.mock-cli.sh'), fs.readFileSync(path.join(dir, '.mock-cli.sh'), 'utf8').replace(
        '  upload) echo "upload success"; exit 0;;',
        '  upload) touch "$PWD/.upload-called"; echo "upload success"; exit 0;;'
      ))
      fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
      // 删 index.js 后使该函数必需（源变更）+ dist 缺入口
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/index.js'), '// h v6\n')
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "import { rmSync as rm2 } from 'node:fs'\nif (step === 'test') process.exit(0)\nif (step === 'assemble') { rm2(process.cwd() + '/dist/cloud-functions/mc-health/index.js'); process.exit(0) }"
      ))
      commitAll(dir, 'missing index')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'missidx', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '缺 index.js → blocked')
      assert.ok(String(r.stderr).includes('index.js') || String(r.stderr).includes('入口'), '入口缺失理由')
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called')), 'upload 零调用（R4终2）')
      const st = fixtureState(dir)
      assert.equal(st.upload.status, 'blocked', 'blocked 收据')
    }
    // ② 空目录（保留目录无文件）→ blocked
    {
      const { dir } = makeFixture({})
      completeDist(dir)
      const real0 = realDigests(dir)
      const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      const head = g(['rev-parse', 'HEAD']).trim()
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "import { rmSync as rm3, readdirSync as rd3 } from 'node:fs'\nif (step === 'test') process.exit(0)\nif (step === 'assemble') { const d = process.cwd() + '/dist/cloud-functions/mc-schedule'; for (const f of rd3(d)) rm3(d + '/' + f, { recursive: true }); process.exit(0) }"
      ))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-schedule/index.js'), '// s v2\n')
      commitAll(dir, 'empty dir')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'emptydir', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '空目录 → blocked')
      assert.ok(String(r.stderr).includes('缺失') || String(r.stderr).includes('入口'), '完整性理由')
    }
    // ③ 缺必需 shared（dailyTipCore）→ blocked
    {
      const { dir } = makeFixture({})
      completeDist(dir)
      const real0 = realDigests(dir)
      const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      const head = g(['rev-parse', 'HEAD']).trim()
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "import { rmSync as rm4 } from 'node:fs'\nif (step === 'test') process.exit(0)\nif (step === 'assemble') { rm4(process.cwd() + '/dist/cloud-functions/mc-restore/shared/dailyTipCore.js'); process.exit(0) }"
      ))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-restore/index.js'), '// r v2\n')
      commitAll(dir, 'missing shared')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'missshared', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '缺 shared/dailyTipCore → blocked')
      assert.ok(String(r.stderr).includes('dailyTipCore') || String(r.stderr).includes('共享'), 'shared 理由')
    }
    // ④ 合法完整包 → 放行成功
    {
      const { dir } = makeFixture({})
      completeDist(dir)
      const real0 = realDigests(dir)
      const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      const head = g(['rev-parse', 'HEAD']).trim()
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core v10\n')
      armMockRelease(dir)
      commitAll(dir, 'full pkg')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'fullpkg', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `完整包放行（stderr=${r.stderr.slice(0, 200)}）`)
      assert.equal(fixtureState(dir).partial, false)
    }
  })

  await scenario('R4终3 计划摘要独立记录：mock 进入时核对 plannedDigests；中断保留待确认不冒充 confirmed', async () => {
    // ① mock upload 进入时快照 state 含 plannedDigests（独立于 deployedDigests）
    {
      const { dir } = makeFixture({})
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst step = process.argv[2]\nif (step === 'test' || step === 'assemble') process.exit(0)\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')\nmkdirSync(mp, { recursive: true })\nwriteFileSync(join(mp, 'project.config.json'), JSON.stringify({ description: 'mock' }))\nprocess.exit(0)\n")
      fs.writeFileSync(path.join(dir, '.mock-cli.sh'), [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload)',
        '    cp "$PWD/.trial-release-state.json" "$PWD/.state-at-upload.json"',
        '    echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    node "$PWD/scripts/.r4-real-table.mjs" "$fn" true; exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
      let src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
      src = src.replace(`const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'`, `const CLI = join(root, '.mock-cli.sh')`)
      src = src.replace(`execSync('npm run test:all', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs test', { cwd: root, stdio: 'inherit' })`)
      src = src.replace(`execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs assemble', { cwd: root, stdio: 'inherit' })`)
      src = src.replace(`execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs build', { cwd: root, stdio: 'inherit' })`)
      fs.writeFileSync(path.join(dir, 'scripts/release-trial.mjs'), src)
      commitAll(dir, 'planned digests')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'plan', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `成功（stderr=${r.stderr.slice(0, 200)}）`)
      const atUpload = JSON.parse(fs.readFileSync(path.join(dir, '.state-at-upload.json'), 'utf8'))
      assert.ok(atUpload.plannedDigests && typeof atUpload.plannedDigests === 'object', 'plannedDigests 在 upload 进入时已落盘（R4终3）')
      assert.equal(Object.keys(atUpload.plannedDigests).length, 5, '全部函数计划摘要')
      assert.ok(Object.values(atUpload.plannedDigests).every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)), '每个都是合法 64hex')
      assert.ok(atUpload.stagedDigests && Object.keys(atUpload.stagedDigests).length === 5, 'stagedDigests（部署目录快照）同落盘')
      // 独立性：plannedDigests 与 deployedDigests 分离（upload 进入时 deployed 尚为继承值）
      assert.deepEqual(atUpload.deployed, [], 'upload 进入时 deployed 为空（planned≠confirmed）')
    }
    // ② 中断（upload 挂起被杀）后：磁盘保留 plannedDigests 待确认——不塞进 deployedDigests
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      armMockRelease(dir)
      commitAll(dir, 'before interrupt')
      const r1 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'ok1', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r1.status, 0)
      commitAll(dir, 'commit ok1')
      fs.writeFileSync(path.join(dir, '.mock-cli.sh'), [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) sleep 300;;',
        'esac',
        'exit 0'
      ].join('\n'))
      fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core v11\n')
      // mock assemble 产生新字节（新 dist ≠ 旧确认摘要——planned 与 confirmed 可辨别）
      const steps2 = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps2.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "if (step === 'test') process.exit(0)\nif (step === 'assemble') { for (const fn of ['mc-daily-push','mc-tools','mc-health','mc-restore','mc-schedule']) { writeFileSync(process.cwd() + '/dist/cloud-functions/' + fn + '/index.js', '// v11\\n') } process.exit(0) }"
      ))
      commitAll(dir, 'interrupt attempt')
      const r2 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'interrupt2', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 8000 })
      assert.ok(r2.status !== 0 || r2.signal, '被中断')
      const st = fixtureState(dir)
      assert.equal(st.version, '1.1.26', '本次版本')
      assert.equal(st.upload.status, 'pending', '不确定事实')
      assert.ok(st.plannedDigests && Object.keys(st.plannedDigests).length === 5, '中断保留待确认计划摘要（R4终3）')
      assert.equal(Object.keys(st.deployedDigests).length, 5, 'confirmed 仍是旧 5 项（planned 不冒充 confirmed）')
      // 计划摘要 ≠ 已确认摘要（源变了）——可辨别
      const changed = Object.keys(st.plannedDigests).filter(fn => st.plannedDigests[fn] !== st.deployedDigests[fn])
      assert.ok(changed.length >= 1, `计划与确认可辨别（变更 ${changed.length} 项）`)
    }
  })


  // ══ R4 最后确认反例（R4_REVIEW_FINAL_CONFIRMATION 1–2）══

  await scenario('R4确1 index 精确相等：非目标索引含目标词元不认；引号规范化后恰等则认', async () => {
    const armAndRun = (dir, script, fns) => {
      armMockRelease(dir, script)
      commitAll(dir, 'exact index case')
      return spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'xi', '--functions', fns], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
    }
    const withBaseline = dir => {
      const real0 = realDigests(dir)
      const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      const head = g(['rev-parse', 'HEAD']).trim()
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
    }
    const mkRawMock = (rowsJson) => [
      '#!/bin/sh',
      'case "$1" in',
      '  islogin) echo \'{"login":true}\'; exit 0;;',
      '  upload) echo "upload success"; exit 0;;',
      '  cloud)',
      `    node "$PWD/scripts/.r4-real-table.mjs" --raw '${rowsJson}'`,
      '    exit 0;;',
      'esac',
      'exit 0'
    ].join('\n')
    const touch = (dir, fn) => fs.writeFileSync(path.join(dir, `cloud/functions/${fn}/index.js`), `// ${Math.random().toString(36).slice(2, 6)}\n`)
    // ① 真实 formatter：'not mc-tools'（success:true）+ 无目标行 → mc-tools 不认
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-tools')
      const r = armAndRun(dir, mkRawMock('{"not mc-tools":{"success":true,"filesCount":1},"other":{"success":true,"filesCount":2}}'), 'mc-tools')
      assert.equal(r.status, 1, '非目标索引含目标词元不认（词元包含→精确相等）')
      assert.ok(!fixtureState(dir).deployed.includes('mc-tools'), '不记 deployed')
    }
    // ② 真实 formatter："'mc-tools copied'"（引号包裹+后缀，success:false）→ 不认
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-tools')
      const r = armAndRun(dir, mkRawMock(String.raw`{"'mc-tools copied'":{"success":false,"filesCount":3}}`), 'mc-tools')
      assert.equal(r.status, 1, '引号包裹+后缀索引不认')
      assert.ok(!fixtureState(dir).deployed.includes('mc-tools'))
    }
    // ③ 精确目标 + true → 成功（正例保持）
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-health')
      const r = armAndRun(dir, mkRawMock('{"mc-health":{"success":true,"filesCount":10}}'), 'mc-health')
      assert.equal(r.status, 0, `精确目标成功（stderr=${r.stderr.slice(0, 200)}）`)
      assert.ok(fixtureState(dir).deployed.includes('mc-health'))
    }
    // ④ 前缀拒绝保持（mc-tools-extra ≠ mc-tools）
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-tools')
      const r = armAndRun(dir, mkRawMock('{"mc-tools-extra":{"success":true,"filesCount":1}}'), 'mc-tools')
      assert.equal(r.status, 1, '前缀拒绝')
      assert.ok(!fixtureState(dir).deployed.includes('mc-tools'))
    }
    // ⑤ 列重排 + 精确目标 → 成功（正例保持）
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-schedule')
      const r = armAndRun(dir, mkRawMock('{"mc-schedule":{"filesCount":5,"packSize":"1 kB","success":true}}'), 'mc-schedule')
      assert.equal(r.status, 0, '列重排按列名确认')
      assert.ok(fixtureState(dir).deployed.includes('mc-schedule'))
    }
  })

  await scenario('R4确2 缺 auth.js（保留核心）/源 config.json 未入包：拒绝+零外呼；上传包摘要独立断言', async () => {
    const withBaseline = dir => {
      const real0 = realDigests(dir)
      const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      const head = g(['rev-parse', 'HEAD']).trim()
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real0 }))
    }
    // ① 保留 dailyTipCore 但删 shared/auth.js → blocked + upload 零调用
    {
      const { dir } = makeFixture({})
      withBaseline(dir)
      // 让函数必需（源变更）
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/index.js'), '// h x1\n')
      armMockRelease(dir, [
        '#!/bin/sh', 'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) touch "$PWD/.upload-called"; echo "upload success"; exit 0;;',
        'esac', 'exit 0'
      ].join('\n'))
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "import { rmSync as rmA } from 'node:fs'\nif (step === 'test') process.exit(0)\nif (step === 'assemble') { rmA(process.cwd() + '/dist/cloud-functions/mc-health/shared/auth.js'); process.exit(0) }"
      ))
      commitAll(dir, 'no auth.js')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'noauth', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '缺 auth.js → blocked')
      assert.ok(String(r.stderr).includes('auth.js') || String(r.stderr).includes('源共享模块'), `理由（实得 ${r.stderr.slice(0, 160)}）`)
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called')), 'upload 零调用')
      assert.equal(fixtureState(dir).upload.status, 'blocked')
    }
    // ② 源 config.json 存在但包内无副本 → blocked + upload 零调用
    {
      const { dir } = makeFixture({})
      withBaseline(dir)
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/config.json'), JSON.stringify({ permissions: { openapi: [] } }))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/index.js'), '// t x2\n')
      armMockRelease(dir, [
        '#!/bin/sh', 'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) touch "$PWD/.upload-called"; echo "upload success"; exit 0;;',
        'esac', 'exit 0'
      ].join('\n'))
      commitAll(dir, 'config not in pkg')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'nocfg', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 1, '源 config.json 未入包 → blocked')
      assert.ok(String(r.stderr).includes('config.json') || String(r.stderr).includes('函数配置'), `理由（实得 ${r.stderr.slice(0, 160)}）`)
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called')), 'upload 零调用')
      assert.equal(fixtureState(dir).upload.status, 'blocked')
    }
    // ③ 合法完整包 + mock upload 进入/中断后 uploadPackageDigest 独立重算等于实际 --project 目录摘要
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core final\n')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), "import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst step = process.argv[2]\nif (step === 'test' || step === 'assemble') process.exit(0)\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')\nmkdirSync(mp, { recursive: true })\nwriteFileSync(join(mp, 'project.config.json'), JSON.stringify({ description: 'mock', appid: 'wx-final' }))\n// 小程序包内容（供独立摘要重算）：真实文件树\nmkdirSync(join(mp, 'pages/index'), { recursive: true })\nwriteFileSync(join(mp, 'pages/index/index.js'), '// page final\\n')\nwriteFileSync(join(mp, 'app.js'), '// app final\\n')\nprocess.exit(0)\n")
      fs.writeFileSync(path.join(dir, '.mock-cli.sh'), [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload)',
        '    # 快照进入时 state + 实际 --project 目录（独立重算用）',
        '    cp "$PWD/.trial-release-state.json" "$PWD/.state-at-upload.json"',
        '    proj=""',
        '    prev=""',
        '    for a in "$@"; do if [ "$prev" = "--project" ]; then proj="$a"; fi; prev="$a"; done',
        '    echo "$proj" > "$PWD/.upload-project-path.txt"',
        '    tar cf "$PWD/.upload-project-snapshot.tar" -C "$proj" . 2>/dev/null || true',
        '    echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    node "$PWD/scripts/.r4-real-table.mjs" "$fn" true',
        '    exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
      let src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
      src = src.replace(`const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'`, `const CLI = join(root, '.mock-cli.sh')`)
      src = src.replace(`execSync('npm run test:all', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs test', { cwd: root, stdio: 'inherit' })`)
      src = src.replace(`execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs assemble', { cwd: root, stdio: 'inherit' })`)
      src = src.replace(`execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs build', { cwd: root, stdio: 'inherit' })`)
      fs.writeFileSync(path.join(dir, 'scripts/release-trial.mjs'), src)
      commitAll(dir, 'upload digest check')
      const r = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'updig', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r.status, 0, `成功（stderr=${r.stderr.slice(0, 200)}）`)
      // mock 进入时快照的 uploadPackageDigest 与实际 --project 目录（trial-upload）独立重算相等
      const atUpload = JSON.parse(fs.readFileSync(path.join(dir, '.state-at-upload.json'), 'utf8'))
      const projPath = fs.readFileSync(path.join(dir, '.upload-project-path.txt'), 'utf8').trim()
      assert.ok(projPath.includes('trial-upload'), `--project 指向上传暂存目录（实得 ${projPath}）`)
      // 用与生产同式的目录摘要独立重算
      const drv = path.join(os.tmpdir(), 'r4-drv-updigest.mjs')
      fs.writeFileSync(drv, `import { createHash } from 'node:crypto'\nimport { existsSync, readFileSync, readdirSync } from 'node:fs'\nimport { join } from 'node:path'\nfunction dig(dir) {\n  if (!existsSync(dir)) return null\n  const entries = []\n  const walk = (d, prefix) => {\n    for (const e of readdirSync(d, { withFileTypes: true })) {\n      const rel = prefix ? prefix + '/' + e.name : e.name\n      if (e.isDirectory()) walk(join(d, e.name), rel)\n      else entries.push([rel, createHash('sha256').update(readFileSync(join(d, e.name))).digest('hex')])\n    }\n  }\n  walk(dir, '')\n  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))\n  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')\n}\nconsole.log(dig(process.argv[2]))`)
      const actual = execFileSync('node', [drv, projPath]).toString().trim()
      assert.ok(atUpload.uploadPackageDigest && /^[0-9a-f]{64}$/.test(atUpload.uploadPackageDigest), 'uploadPackageDigest 合法')
      assert.equal(atUpload.uploadPackageDigest, actual, `mock 进入时摘要 = 实际 --project 目录字节摘要（${atUpload.uploadPackageDigest ? atUpload.uploadPackageDigest.slice(0, 8) : '?'} vs ${actual.slice(0, 8)}）`)
      // 成功收据保留同值；不冒充 confirmed（deployedDigests 是函数摘要——不同域）
      const finalSt = fixtureState(dir)
      assert.equal(finalSt.uploadPackageDigest, actual, '退出后保留同值')
      assert.equal(finalSt.partial, false)
      assert.equal(finalSt.upload.status, 'uploaded')
    }
    // ④ 中断后保留 uploadPackageDigest（待确认）
    {
      const { dir, head } = makeFixture({})
      const real = realDigests(dir)
      fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: 'env-r4', deployedDigests: real }))
      armMockRelease(dir)
      commitAll(dir, 'first ok')
      const r1 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'ok', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 120000 })
      assert.equal(r1.status, 0)
      commitAll(dir, 'commit ok')
      fs.writeFileSync(path.join(dir, '.mock-cli.sh'), [
        '#!/bin/sh',
        'case "$1" in',
        '  islogin) echo \'{"login":true}\'; exit 0;;',
        '  upload) cp "$PWD/.trial-release-state.json" "$PWD/.state-at-interrupt.json"; sleep 300;;',
        'esac',
        'exit 0'
      ].join('\n'))
      fs.chmodSync(path.join(dir, '.mock-cli.sh'), 0o755)
      fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core interrupt\n')
      const steps3 = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps3.replace(
        "if (step === 'test' || step === 'assemble') process.exit(0)",
        "if (step === 'test') process.exit(0)\nif (step === 'assemble') { for (const fn of ['mc-daily-push','mc-tools','mc-health','mc-restore','mc-schedule']) { writeFileSync(process.cwd() + '/dist/cloud-functions/' + fn + '/index.js', '// vF\\n') } process.exit(0) }"
      ))
      commitAll(dir, 'interrupt attempt')
      const r2 = spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), '--desc', 'upint', '--functions', 'all'], { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' }, timeout: 8000 })
      assert.ok(r2.status !== 0 || r2.signal, '被中断')
      const atInt = JSON.parse(fs.readFileSync(path.join(dir, '.state-at-interrupt.json'), 'utf8'))
      assert.ok(atInt.uploadPackageDigest && /^[0-9a-f]{64}$/.test(atInt.uploadPackageDigest), '中断进入时摘要已落盘')
      assert.equal(atInt.upload.status, 'pending', '待确认')
      const st = fixtureState(dir)
      assert.equal(st.uploadPackageDigest, atInt.uploadPackageDigest, '中断后保留同值')
      assert.equal(st.upload.status, 'pending')
      assert.equal(st.partial, true)
    }
  })


  console.log(`\nphase-r4：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) }).finally(() => {
  const stateAfter = fs.readFileSync(REAL_STATE)
  const manifestAfter = fs.readFileSync(REAL_MANIFEST)
  if (!stateAfter.equals(realStateBefore) || !manifestAfter.equals(realManifestBefore)) {
    console.error('✖✖ 真实 state/manifest 被修改——违反 R4R-8 边界')
    process.exit(2)
  }
})
