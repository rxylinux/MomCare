// 独立验证 IV-R4b（2026-10-01 第二轮，按 INDEPENDENT_REVIEW_NOTES R4 缺口补全）：
// 1) 包完整性补充：目录可 hash 但缺 index.js / 缺 package.json → blocked + upload 零调用。
// 2) 已 hash 的旧 dist 在 assemble 后改变 → 部署选择重新计算（lateRequired 补入+披露+新摘要入账）。
// 3) 部署 CLI 进入时实际 staged 函数字节与 plannedDigests 一致（夹具内独立重算比对）。
// 4) 真实 Node formatter 边界：列重排/带空白引号索引可认；非目标含词元/前后缀/其他列 true/
//    非表格日志不可认；前置信息日志后合法表可认。
// 5) 有旧确认基线的部分成功：失败项保留旧摘要、成功项更新为当前 dist 摘要、下一轮缺项仍必需；
//    实际切 env 后旧 env 摘要不可借用（发布被完整集合门阻止）。
// 生产源码只读；真实 CLI/上传零调用（标记文件证明）；真实 state/manifest 套件首尾断言不变。
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
const ENV = 'env-iv4b'

function makeFixture({ mutate, state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momcare-iv4bfix-'))
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
  g(['init', '-q']); g(['config', 'user.email', 'iv4b@test.local']); g(['config', 'user.name', 'iv4b-test'])
  for (const fn of FNS) {
    fs.mkdirSync(path.join(dir, 'cloud/functions', fn), { recursive: true })
    fs.writeFileSync(path.join(dir, 'cloud/functions', fn, 'index.js'), `// ${fn} iv4b\n`)
    fs.mkdirSync(path.join(dir, 'dist/cloud-functions', fn, 'shared'), { recursive: true })
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/index.js`), `// ${fn} dist iv4b\n`)
    for (const sf of ['auth.js', 'config.js', 'respond.js', 'constants.js']) fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/shared/${sf}`), `// ${sf}\n`)
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/shared/dailyTipCore.js`), '// core dist iv4b\n')
    fs.writeFileSync(path.join(dir, `dist/cloud-functions/${fn}/package.json`), JSON.stringify({ name: fn, version: '1.0.0', main: 'index.js', dependencies: { 'wx-server-sdk': '4.0.2' } }))
  }
  fs.writeFileSync(path.join(dir, 'cloud/functions/mc-tools/food-safety-data.js'), '// food data iv4b\n')
  fs.writeFileSync(path.join(dir, 'cloud/functions/mc-restore/v20.js'), '// v20 iv4b\n')
  fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-tools/food-safety-data.js'), '// food data iv4b\n')
  fs.writeFileSync(path.join(dir, 'dist/cloud-functions/mc-restore/v20.js'), '// v20 iv4b\n')
  fs.mkdirSync(path.join(dir, 'cloud/shared'), { recursive: true })
  for (const f of ['auth.js', 'config.js', 'respond.js', 'constants.js']) fs.writeFileSync(path.join(dir, 'cloud/shared', f), `// ${f} iv4b\n`)
  fs.mkdirSync(path.join(dir, 'utils'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'static/data'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'pages/index'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pages/index/index.vue'), '// page iv4b\n')
  fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core iv4b\n')
  fs.writeFileSync(path.join(dir, 'static/data/food-safety.json'), JSON.stringify([{ id: 'iv4b_x', name: '夹具词条', category: 'food', level: 'safe' }]) + '\n')
  fs.mkdirSync(path.join(dir, 'cloud/rules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cloud/rules/a.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'cloud/collections.json'), '{}\n')
  fs.writeFileSync(path.join(dir, 'cloud/assemble.mjs'), '// assemble iv4b\n')
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  for (const f of ['release-dependency-closure.mjs', 'release-trial.mjs', '.r4-real-table.mjs', 'gen-food-safety.mjs']) fs.copyFileSync(path.join(root, 'scripts', f), path.join(dir, 'scripts', f))
  execFileSync('node', [path.join(dir, 'scripts/gen-food-safety.mjs')], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ versionName: '1.1.24', versionCode: '10124' }))
  fs.writeFileSync(path.join(dir, 'utils/cloudConfig.js'), `export const CLOUD_CONFIG = { envId: '${ENV}', appId: 'wx-iv4b' }\n`)
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n.upload-called-marker\n.state-at-upload.json\n.staged-check.txt\n')
  g(['add', '-A']); g(['commit', '-qm', 'init iv4b'])
  const head = g(['rev-parse', 'HEAD']).trim()
  fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify(state !== undefined ? state : { version: '1.1.24', commit: head, functions: [] }, null, 2))
  if (mutate) mutate(dir)
  return { dir, head }
}

// staged 字节核对辅助（夹具内独立实现：与生产同式目录摘要，比对 plannedDigests）
const STAGED_CHECK = `import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const fn = process.argv[2]
const root = process.cwd()
function dig(d) {
  const es = []
  const walk = (p, pre) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const r = pre ? pre + '/' + e.name : e.name
      if (e.isDirectory()) walk(join(p, e.name), r)
      else es.push([r, createHash('sha256').update(readFileSync(join(p, e.name))).digest('hex')])
    }
  }
  walk(d, '')
  es.sort((a, b) => (a[0] < b[0] ? -1 : 1))
  return createHash('sha256').update(JSON.stringify(es)).digest('hex')
}
const st = JSON.parse(readFileSync(join(root, '.trial-release-state.json'), 'utf8'))
const expected = st.plannedDigests && st.plannedDigests[fn]
const actual = dig(join(root, 'dist/build/mp-weixin/cloudfunctions', fn))
appendFileSync(join(root, '.staged-check.txt'), (expected === actual ? 'ok' : 'bad') + ' ' + fn + ' expected=' + expected + ' actual=' + actual + '\\n')
`

const digestsDrv = path.join(os.tmpdir(), 'iv4b-drv-digests.mjs')
fs.writeFileSync(digestsDrv, `import { distFunctionDigests } from ${JSON.stringify(path.join(root, 'scripts/release-dependency-closure.mjs'))}\nimport { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify(distFunctionDigests(process.argv[3])))\n`)
function realDigests(dir) {
  const out = path.join(os.tmpdir(), 'iv4b-dig-' + crypto.randomBytes(3).toString('hex') + '.json')
  execFileSync('node', [digestsDrv, out, dir])
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}

function armMockRelease(dir, deployScript) {
  fs.writeFileSync(path.join(dir, 'scripts/.iv4b-staged-check.mjs'), STAGED_CHECK)
  let src = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
  src = src.replace(`const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'`, `const CLI = join(root, '.mock-cli.sh')`)
  src = src.replace(`execSync('npm run test:all', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs test', { cwd: root, stdio: 'inherit' })`)
  src = src.replace(`execSync('node cloud/assemble.mjs', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs assemble', { cwd: root, stdio: 'inherit' })`)
  src = src.replace(`execSync('npm run build:mp-weixin', { cwd: root, stdio: 'inherit' })`, `execSync('node .mock-steps.mjs build', { cwd: root, stdio: 'inherit' })`)
  fs.writeFileSync(path.join(dir, 'scripts/release-trial.mjs'), src)
  fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\nconst step = process.argv[2]\nif (step === 'test' || step === 'assemble') process.exit(0)\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')\nmkdirSync(mp, { recursive: true })\nwriteFileSync(join(mp, 'project.config.json'), JSON.stringify({ description: 'mock iv4b' }))\nprocess.exit(0)\n")
  const defaultScript = [
    '#!/bin/sh',
    'case "$1" in',
    "  islogin) echo '{\"login\":true}'; exit 0;;",
    '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
    '  cloud)',
    '    fn=""; prev=""',
    '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
    '    node "$PWD/scripts/.iv4b-staged-check.mjs" "$fn"',
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
function runRelease(dir, args, timeout = 300000) {
  return spawnSync('node', [path.join(dir, 'scripts/release-trial.mjs'), ...args], { cwd: dir, encoding: 'utf8', timeout, env: { ...process.env, MOMCARE_RETRY_WAIT_MS: '1' } })
}
function withBaseline(dir) {
  const real0 = realDigests(dir)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(dir, '.trial-release-state.json'), JSON.stringify({ version: '1.1.24', commit: head, deployedEnv: ENV, deployedDigests: real0 }))
  return real0
}
const mkRawMock = rowsJson => [
  '#!/bin/sh',
  'case "$1" in',
  "  islogin) echo '{\"login\":true}'; exit 0;;",
  '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
  '  cloud)',
  '    fn=""; prev=""',
  '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
  `    node "$PWD/scripts/.iv4b-staged-check.mjs" "$fn"`,
  `    node "$PWD/scripts/.r4-real-table.mjs" --raw '${rowsJson}'`,
  '    exit 0;;',
  'esac',
  'exit 0'
].join('\n')

async function main() {
  console.log('IV-R4b 独立反例（R4 审核缺口：包完整性补充/旧 dist 变后重算/staged=planned/formatter 边界/旧基线部分成功+换 env）\n')

  await scenario('包完整性补充：目录可 hash 但缺 index.js / 缺 package.json → blocked + upload 零调用', async () => {
    // ① 缺 index.js（其余文件俱在——目录仍可计算合法摘要）
    {
      const { dir } = makeFixture({})
      const real0 = withBaseline(dir)
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "const mp = join(process.cwd(), 'dist/build/mp-weixin')",
        "import { rmSync as r1, writeFileSync as w1 } from 'node:fs'\nif (step === 'build') { r1(process.cwd() + '/dist/cloud-functions/mc-health/index.js'); w1(process.cwd() + '/dist/cloud-functions/mc-health/README.md', 'placeholder so dir still hashes\\n') }\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')"
      ))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-health/index.js'), '// health iv4b v2\n')
      commitAll(dir, 'no index.js')
      const r = runRelease(dir, ['--desc', 'iv4b noindex', '--functions', 'all'])
      assert.equal(r.status, 1, '缺 index.js → blocked')
      assert.ok(String(r.stderr).includes('index.js'), `入口缺失点名（实得 ${String(r.stderr).slice(0, 160)}）`)
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用')
      assert.equal(fixtureState(dir).upload.status, 'blocked')
    }
    // ② 缺 package.json（清单缺失）
    {
      const { dir } = makeFixture({})
      withBaseline(dir)
      armMockRelease(dir)
      const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
      fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
        "const mp = join(process.cwd(), 'dist/build/mp-weixin')",
        "import { rmSync as r2 } from 'node:fs'\nif (step === 'build') { r2(process.cwd() + '/dist/cloud-functions/mc-restore/package.json') }\nconst mp = join(process.cwd(), 'dist/build/mp-weixin')"
      ))
      fs.writeFileSync(path.join(dir, 'cloud/functions/mc-restore/index.js'), '// restore iv4b v2\n')
      commitAll(dir, 'no package.json')
      const r = runRelease(dir, ['--desc', 'iv4b nopkg', '--functions', 'all'])
      assert.equal(r.status, 1, '缺 package.json → blocked')
      assert.ok(String(r.stderr).includes('package.json'), '清单缺失点名')
      assert.ok(!fs.existsSync(path.join(dir, '.upload-called-marker')), 'upload 零调用')
    }
  })

  await scenario('已 hash 旧 dist 在 assemble 后改变：部署选择重算补入+披露+新摘要入账；staged 字节=plannedDigests', async () => {
    const { dir } = makeFixture({})
    const oldReal = withBaseline(dir) // 基线=旧 dist 摘要；无源码变更 → 计划期 selected=[]
    armMockRelease(dir)
    // mock assemble 改写 mc-tools dist 字节（新摘要 ≠ 旧确认摘要）
    const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
    fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
      "if (step === 'test' || step === 'assemble') process.exit(0)",
      "import { writeFileSync as w2 } from 'node:fs'\nif (step === 'test') process.exit(0)\nif (step === 'assemble') { w2(process.cwd() + '/dist/cloud-functions/mc-tools/index.js', '// mc-tools NEW iv4b\\n'); process.exit(0) }"
    ))
    commitAll(dir, 'assemble rewrites dist')
    const r = runRelease(dir, ['--desc', 'iv4b late']) // 无 --functions：计划期零必需零名单 → selected=[]
    assert.equal(r.status, 0, `成功（stderr=${String(r.stderr).slice(0, 200)}）`)
    const st = fixtureState(dir)
    assert.deepEqual(st.selected, ['mc-tools'], `assemble 后重核对补入 mc-tools（实得 ${JSON.stringify(st.selected)}）`)
    assert.ok(r.stdout.includes('重核对') || r.stdout.includes('补入'), '重核对披露在场')
    assert.ok(st.deployedDigests['mc-tools'] && st.deployedDigests['mc-tools'] !== oldReal['mc-tools'], '成功项入账为**新**摘要')
    assert.equal(st.deployedDigests['mc-daily-push'], oldReal['mc-daily-push'], '未部署项保留旧摘要')
    // staged 字节核对：部署 CLI 进入时实际 MP_DIR/cloudfunctions/<fn> 与 plannedDigests 一致
    const checkFile = path.join(dir, '.staged-check.txt')
    assert.ok(fs.existsSync(checkFile), 'staged 核对记录在')
    const lines = fs.readFileSync(checkFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, `恰对 selected 内 1 个函数核对（实得 ${lines.length}）`)
    assert.ok(lines[0].startsWith('ok mc-tools '), `staged 字节=plannedDigests（实得 ${lines[0].slice(0, 80)}）`)
  })

  await scenario('真实 formatter 边界：列重排/空白引号索引可认；词元包含/前后缀/其他列 true/非表格日志不可认；前置日志后可认', async () => {
    const touch = (dir, fn) => fs.writeFileSync(path.join(dir, `cloud/functions/${fn}/index.js`), `// ${Math.random().toString(36).slice(2, 6)}\n`)
    // ① 列重排（success 列在最后）：按列名定位 → 成功
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-health')
      armMockRelease(dir, mkRawMock('{"mc-health":{"filesCount":7,"packSize":"2 kB","success":true}}'))
      commitAll(dir, 'col reorder ok')
      const r = runRelease(dir, ['--desc', 'iv4b reorder', '--functions', 'mc-health'])
      assert.equal(r.status, 0, `列重排按列名确认成功（stderr=${String(r.stderr).slice(0, 200)}）`)
      assert.ok(fixtureState(dir).deployed.includes('mc-health'))
    }
    // ② 目标索引带首尾空白（真实 formatter 引号包裹展示）→ 规范化后精确相等可认
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-tools')
      armMockRelease(dir, mkRawMock(String.raw`{" mc-tools ":{"success":true,"filesCount":5}}`))
      commitAll(dir, 'ws index')
      const r = runRelease(dir, ['--desc', 'iv4b wsidx', '--functions', 'mc-tools'])
      assert.equal(r.status, 0, `空白+引号包裹索引规范化后可认（stderr=${String(r.stderr).slice(0, 200)}）`)
      assert.ok(fixtureState(dir).deployed.includes('mc-tools'))
    }
    // ③ 非目标索引含目标词元（not-mc-tools / mc-tools-copied / xmc-toolsy）→ 均不可认
    for (const [label, rows] of [
      ['前缀否定词', '{"not-mc-tools":{"success":true,"filesCount":1}}'],
      ['后缀复制词', String.raw`{"mc-tools-copied":{"success":true,"filesCount":2}}`],
      ['首尾粘连', '{"xmc-toolsy":{"success":true,"filesCount":3}}'],
    ]) {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-tools')
      armMockRelease(dir, mkRawMock(rows))
      commitAll(dir, 'token ' + label)
      const r = runRelease(dir, ['--desc', 'iv4b tok', '--functions', 'mc-tools'])
      assert.equal(r.status, 1, `${label} → 不认（unknown 不记 deployed）`)
      assert.ok(!fixtureState(dir).deployed.includes('mc-tools'), `${label} 不记 deployed`)
    }
    // ④ 其他列 true 而 success=false → 不认
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-restore')
      armMockRelease(dir, mkRawMock('{"mc-restore":{"success":false,"filesCount":true,"packSize":true}}'))
      commitAll(dir, 'other col true')
      const r = runRelease(dir, ['--desc', 'iv4b othertrue', '--functions', 'mc-restore'])
      assert.equal(r.status, 1, '其他列 true 不算 success')
      assert.ok(!fixtureState(dir).deployed.includes('mc-restore'))
    }
    // ⑤ 非表格日志含 目标名+true（无真实表头）→ 不可认
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-schedule')
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        "  islogin) echo '{\"login\":true}'; exit 0;;",
        '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    node "$PWD/scripts/.iv4b-staged-check.mjs" "$fn"',
        '    echo "[iv4b] deploy $fn | status true | success true"',
        '    exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'plain log true')
      const r = runRelease(dir, ['--desc', 'iv4b plainlog', '--functions', 'mc-schedule'])
      assert.equal(r.status, 1, '非表格日志 true 不可认')
      assert.ok(!fixtureState(dir).deployed.includes('mc-schedule'))
    }
    // ⑥ 前置信息日志之后合法真实表 → 可认（信息日志不遮挡表头定位）
    {
      const { dir } = makeFixture({})
      withBaseline(dir); touch(dir, 'mc-daily-push')
      armMockRelease(dir, [
        '#!/bin/sh',
        'case "$1" in',
        "  islogin) echo '{\"login\":true}'; exit 0;;",
        '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
        '  cloud)',
        '    fn=""; prev=""',
        '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
        '    node "$PWD/scripts/.iv4b-staged-check.mjs" "$fn"',
        '    echo "ℹ env check ok"',
        '    echo "ℹ uploading package for $fn … done"',
        '    node "$PWD/scripts/.r4-real-table.mjs" "$fn" true',
        '    exit 0;;',
        'esac',
        'exit 0'
      ].join('\n'))
      commitAll(dir, 'info then table')
      const r = runRelease(dir, ['--desc', 'iv4b infolog', '--functions', 'mc-daily-push'])
      assert.equal(r.status, 0, `前置信息日志后真实表可认（stderr=${String(r.stderr).slice(0, 200)}）`)
      assert.ok(fixtureState(dir).deployed.includes('mc-daily-push'))
    }
  })

  await scenario('有旧确认基线的部分成功：失败项保留旧摘要、成功项更新为当前摘要、缺项下轮仍必需；换 env 不可借用', async () => {
    const { dir } = makeFixture({})
    const oldReal = withBaseline(dir)
    fs.writeFileSync(path.join(dir, 'utils/dailyTipCore.js'), '// core iv4b v5\n')
    armMockRelease(dir, [
      '#!/bin/sh',
      'case "$1" in',
      "  islogin) echo '{\"login\":true}'; exit 0;;",
      '  upload) touch "$PWD/.upload-called-marker"; echo "upload success"; exit 0;;',
      '  cloud)',
      '    fn=""; prev=""',
      '    for a in "$@"; do if [ "$prev" = "--names" ]; then fn="$a"; fi; prev="$a"; done',
      '    case "$fn" in',
      '      mc-schedule) node "$PWD/scripts/.iv4b-staged-check.mjs" "$fn"; echo "deploy attempt $fn"; echo "[error] 80051 iv4b partial fail"; exit 0;;',
      '      *) node "$PWD/scripts/.iv4b-staged-check.mjs" "$fn"; node "$PWD/scripts/.r4-real-table.mjs" "$fn" true; exit 0;;',
      '    esac;;',
      'esac',
      'exit 0'
    ].join('\n'))
    // mock assemble 把全部 5 个函数 dist 改写为新字节（当前 dist ≠ 旧确认摘要）
    const steps = fs.readFileSync(path.join(dir, '.mock-steps.mjs'), 'utf8')
    fs.writeFileSync(path.join(dir, '.mock-steps.mjs'), steps.replace(
      "if (step === 'test' || step === 'assemble') process.exit(0)",
      "import { writeFileSync as w3 } from 'node:fs'\nif (step === 'test') process.exit(0)\nif (step === 'assemble') { for (const fn of ['mc-daily-push','mc-tools','mc-health','mc-restore','mc-schedule']) { w3(process.cwd() + '/dist/cloud-functions/' + fn + '/index.js', '// iv4b v5\\n') } process.exit(0) }"
    ))
    commitAll(dir, 'iv4b partial with baseline')
    const r = runRelease(dir, ['--desc', 'iv4b pb', '--functions', 'all'])
    assert.equal(r.status, 1, 'mc-schedule 失败 → exit 1')
    const st = fixtureState(dir)
    assert.equal(st.partial, true)
    assert.deepEqual(st.deployed, ['mc-daily-push', 'mc-health', 'mc-restore'], `失败前确认项（实得 ${JSON.stringify(st.deployed)}）`)
    for (const fn of ['mc-daily-push', 'mc-health', 'mc-restore']) {
      assert.ok(st.deployedDigests[fn] && st.deployedDigests[fn] !== oldReal[fn], `${fn} 成功项入账**当前**（新）摘要`)
    }
    for (const fn of ['mc-schedule', 'mc-tools']) {
      assert.equal(st.deployedDigests[fn], oldReal[fn], `${fn} 未成功项保留**旧**确认摘要（不清不误标）`)
    }
    // 下一轮：缺项/不一致项仍必需（旧摘要 ≠ 当前 dist）
    commitAll(dir, 'record iv4b partial')
    const newReal = realDigests(dir)
    const computeDrv = path.join(os.tmpdir(), 'iv4b-drv-compute.mjs')
    fs.writeFileSync(computeDrv, `import { computeChangedFunctions } from ${JSON.stringify(path.join(root, 'scripts/release-dependency-closure.mjs'))}\nimport { writeFileSync } from 'node:fs'\nconst r2 = computeChangedFunctions(process.argv[2], { envId: process.argv[3] })\nwriteFileSync(process.argv[4], JSON.stringify(r2))\n`)
    const outJson = path.join(os.tmpdir(), 'iv4b-out-' + crypto.randomBytes(3).toString('hex') + '.json')
    execFileSync('node', [computeDrv, dir, ENV, outJson])
    const closure = JSON.parse(fs.readFileSync(outJson, 'utf8'))
    assert.deepEqual(closure.requiredFunctions.map(x => x.fn).sort(), ['mc-schedule', 'mc-tools'], `下轮缺项仍必需（实得 ${JSON.stringify(closure.requiredFunctions.map(x => x.fn))}）`)
    // 换 env：旧 env 的摘要不可借用——完整集合门阻止 functions:[] 发布
    fs.writeFileSync(path.join(dir, 'utils/cloudConfig.js'), `export const CLOUD_CONFIG = { envId: '${ENV}-B', appId: 'wx-iv4b' }\n`)
    commitAll(dir, 'switch env')
    const rEnv = runRelease(dir, ['--desc', 'iv4b switchenv']) // 无 --functions：若旧摘要可借用则 selected=[] 放行——必须被阻止
    assert.equal(rEnv.status, 1, '换 env 后旧 env 摘要不可借用 → functions:[] 被完整集合门阻止')
    assert.ok(String(rEnv.stderr).includes('--functions all'), '提示完整集合')
    const outJson2 = path.join(os.tmpdir(), 'iv4b-out2-' + crypto.randomBytes(3).toString('hex') + '.json')
    execFileSync('node', [computeDrv, dir, `${ENV}-B`, outJson2])
    const closure2 = JSON.parse(fs.readFileSync(outJson2, 'utf8'))
    assert.equal(closure2.envMismatch, true, '闭包标记环境变化')
    assert.equal(closure2.confirmedDigests, null, '旧 env 摘要不构成基线')
  })

  // 真实 state/manifest 字节不变断言（套件首尾）
  assert.ok(realStateBefore.equals(fs.readFileSync(REAL_STATE)), '真实 .trial-release-state.json 字节未变')
  assert.ok(realManifestBefore.equals(fs.readFileSync(REAL_MANIFEST)), '真实 manifest.json 字节未变')
  pass('真实 state/manifest 原始字节未变（套件全程）')

  console.log(`\nphase-iv-r4b：${passed} 通过，${failed.length} 失败`)
  if (failed.length > 0) { console.log('失败场景：', failed.join(' | ')); process.exit(1) }
}

main().catch(async e => {
  console.error('套件异常:', e)
  console.error('真实 state/manifest：',
    realStateBefore.equals(fs.readFileSync(REAL_STATE)) ? 'state 未变' : 'state 已变！',
    realManifestBefore.equals(fs.readFileSync(REAL_MANIFEST)) ? 'manifest 未变' : 'manifest 已变！')
  process.exit(2)
})
