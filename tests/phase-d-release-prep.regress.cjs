// Phase D 本地发布准备回归：脚本安全 / 包体过滤 / 云函数装配 / 密钥防泄漏 / 冻结源哈希。
// D1 package.json 脚本审计（无直接 deploy/preview 盲目执行 Cloudflare；assemble:cloud/test 在场）
// D2 manifest.json 审计（mp-weixin.packOptions.ignore 排除 mobileconfig 与 logo.png，产物透传防陈旧）
// D3 云函数装配审计（10 函数产物齐备：index.js + package.json 锁版 + shared 一致 + 伴生模块）
// D4 密钥与敏感信息防泄漏审计（无硬编码真实密钥；AI 密钥仅经环境变量）
// D5 冻结源哈希断言（本阶段触碰文件运行期间未被并发编辑）
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
async function scenario(name, fn) { try { await fn(); pass(name) } catch (e) { fail(name, e) } }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

// D5 冻结源哈希（加载时快照；D1/D2 审计的即同批字节）
const FROZEN_RELS = ['manifest.json', 'package.json', 'cloud/assemble.mjs']
const frozenBytes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, fs.readFileSync(path.join(root, rel))]))
const frozenHashes = Object.fromEntries(FROZEN_RELS.map(rel => [rel, sha256(frozenBytes[rel])]))
console.log('冻结源哈希（加载时快照）:')
for (const [rel, h] of Object.entries(frozenHashes)) console.log(`  ${h.slice(0, 8)}  ${rel}`)

const pkg = JSON.parse(frozenBytes['package.json'].toString('utf8'))
const manifest = JSON.parse(frozenBytes['manifest.json'].toString('utf8'))
const scripts = pkg.scripts || {}

// 装配产物契约（源目录 cloud/functions/*/index.js 全集，排序后须恰为这 10 个）
const EXPECTED_FUNCTIONS = ['mc-collab', 'mc-daily-push', 'mc-files', 'mc-health', 'mc-identity', 'mc-private-notes',
  'mc-reports', 'mc-restore', 'mc-schedule', 'mc-shared-records', 'mc-tools']
const DIST_FNS = path.join(root, 'dist/cloud-functions')
const SRC_FNS = path.join(root, 'cloud/functions')

function walkFiles(dir, filter = () => true, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkFiles(p, filter, acc); continue }
    if (filter(p)) acc.push(p)
  }
  return acc
}

async function main() {
  console.log('Phase D 本地发布准备回归（脚本安全 + 包体过滤 + 装配 + 防泄漏）\n')

  await scenario('D1a 脚本安全：无 deploy/preview 直连命令，legacy 归档命名在场', async () => {
    assert.ok(!('deploy' in scripts), '不得存在可直接误执行的 deploy 脚本')
    assert.ok(!('preview' in scripts), '不得存在可直接误执行的 preview 脚本')
    const legacyDeploy = scripts['deploy:legacy-preview']
    assert.ok(typeof legacyDeploy === 'string' && legacyDeploy.includes('wrangler deploy'), 'deploy:legacy-preview 须指向 wrangler deploy（历史归档命令）')
    const legacyPreview = scripts['preview:legacy']
    assert.ok(typeof legacyPreview === 'string' && legacyPreview.includes('wrangler dev'), 'preview:legacy 须指向 wrangler dev（历史归档命令）')
  })

  await scenario('D1b 脚本安全：全 scripts 中仅两个 legacy 命令可触达 wrangler', async () => {
    const wranglerScripts = Object.entries(scripts).filter(([, v]) => String(v).includes('wrangler')).map(([k]) => k).sort()
    assert.deepEqual(wranglerScripts, ['deploy:legacy-preview', 'preview:legacy'],
      `触达 wrangler 的脚本须恰为两个 legacy 命令（实得 ${JSON.stringify(wranglerScripts)}）`)
    assert.ok(typeof scripts['build:mp-weixin'] === 'string' && scripts['build:mp-weixin'].includes('uni build'), 'build:mp-weixin 在场')
  })

  await scenario('D1c 规范脚本契约：assemble:cloud / test / test:all', async () => {
    assert.equal(scripts['assemble:cloud'], 'node cloud/assemble.mjs', 'assemble:cloud 恰为 node cloud/assemble.mjs')
    assert.equal(scripts['test'], 'node tests/phase-d-release-prep.regress.cjs', 'test 恰指向本套件')
    const all = scripts['test:all']
    assert.ok(typeof all === 'string' && all.includes('tests/*.regress.cjs') && all.includes('node'),
      `test:all 须遍历执行 tests/*.regress.cjs（实得 ${JSON.stringify(all)}）`)
    assert.ok(!/deploy|wrangler/.test(all), 'test:all 不得触达部署命令')
  })

  await scenario('D2a manifest 包体过滤：mp-weixin.packOptions.ignore 排除两大文件', async () => {
    const mpw = manifest['mp-weixin']
    assert.ok(mpw && mpw.packOptions && Array.isArray(mpw.packOptions.ignore), 'mp-weixin.packOptions.ignore 须为数组')
    const entries = new Set(mpw.packOptions.ignore.map(e => `${e.type}:${e.value}`))
    assert.ok(entries.has('file:static/momcare.mobileconfig'), `须忽略 static/momcare.mobileconfig（实得 ${JSON.stringify([...entries])}）`)
    assert.ok(entries.has('file:static/logo.png'), `须忽略 static/logo.png（实得 ${JSON.stringify([...entries])}）`)
    // 锚定被排除的确实是两个大文件（防同名小文件使排除失去意义）
    for (const rel of ['static/momcare.mobileconfig', 'static/logo.png']) {
      assert.ok(fs.statSync(path.join(root, rel)).size > 1024 * 1024, `${rel} 须为 MB 级大文件`)
    }
  })

  await scenario('D2b 产物透传：构建产物 project.config.json 含同样 ignore（防陈旧产物）', async () => {
    const distProject = path.join(root, 'dist/build/mp-weixin/project.config.json')
    if (!fs.existsSync(distProject)) { console.log('      （未发现构建产物，跳过——首次构建后此断言强制生效）'); return }
    const dist = JSON.parse(fs.readFileSync(distProject, 'utf8'))
    const entries = new Set(((dist.packOptions && dist.packOptions.ignore) || []).map(e => `${e.type}:${e.value}`))
    assert.ok(entries.has('file:static/momcare.mobileconfig'), `产物须含 mobileconfig 排除（实得 ${JSON.stringify([...entries])}——若为陈旧产物请重新 build:mp-weixin）`)
    assert.ok(entries.has('file:static/logo.png'), `产物须含 logo.png 排除（实得 ${JSON.stringify([...entries])}）`)
  })

  await scenario('D3a 云函数装配：执行 assemble 后 dist 恰 11 函数齐备', async () => {
    execFileSync('node', [path.join(root, 'cloud/assemble.mjs')], { stdio: 'pipe' })
    const dirs = fs.readdirSync(DIST_FNS, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => e.name).sort()
    assert.deepEqual(dirs, EXPECTED_FUNCTIONS, `11 函数齐备（实得 ${JSON.stringify(dirs)}）`)
    assert.ok(fs.existsSync(path.join(DIST_FNS, '_collections.json')), '附 _collections.json 副本')
    const rules = fs.readdirSync(path.join(DIST_FNS, '_rules'))
    assert.ok(rules.includes('database.rules.json') && rules.includes('storage.rules.json'), '附 _rules 规则副本')
  })

  await scenario('D3b 函数产物形状：index.js 非空 + package.json 锁 wx-server-sdk@4.0.2 + shared 在场', async () => {
    for (const fn of EXPECTED_FUNCTIONS) {
      const outDir = path.join(DIST_FNS, fn)
      const idx = fs.readFileSync(path.join(outDir, 'index.js'))
      assert.ok(idx.length > 0, `${fn}/index.js 非空`)
      const pj = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'))
      assert.equal(pj.main, 'index.js', `${fn} main=index.js`)
      assert.equal(pj.dependencies && pj.dependencies['wx-server-sdk'], '4.0.2', `${fn} wx-server-sdk 版本锁定 4.0.2`)
      const sharedDir = path.join(outDir, 'shared')
      assert.ok(fs.existsSync(sharedDir) && fs.statSync(sharedDir).isDirectory(), `${fn}/shared 在场`)
      assert.ok(walkFiles(sharedDir).length > 0, `${fn}/shared 非空`)
    }
  })

  await scenario('D3c 伴生模块与 shared 一致性：产物字节与源逐一致', async () => {
    const srcShared = Object.fromEntries(walkFiles(path.join(root, 'cloud/shared')).map(p => [path.relative(path.join(root, 'cloud/shared'), p), sha256(fs.readFileSync(p))]))
    for (const fn of EXPECTED_FUNCTIONS) {
      // 伴生 .js（如 mc-restore/v20.js、mc-tools/food-safety-data.js）逐文件齐且同字节
      const companions = fs.readdirSync(path.join(SRC_FNS, fn), { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.js') && e.name !== 'index.js').map(e => e.name)
      for (const c of companions) {
        assert.equal(sha256(fs.readFileSync(path.join(DIST_FNS, fn, c))), sha256(fs.readFileSync(path.join(SRC_FNS, fn, c))), `${fn}/${c} 与源逐字节一致`)
      }
      // Phase G：伴生 config.json（mc-tools 云调用权限 ocr.printedText）存在即随包且同字节
      const cfgSrc = path.join(SRC_FNS, fn, 'config.json')
      const hasCfg = fs.existsSync(cfgSrc)
      if (hasCfg) {
        assert.equal(sha256(fs.readFileSync(path.join(DIST_FNS, fn, 'config.json'))), sha256(fs.readFileSync(cfgSrc)), `${fn}/config.json 与源逐字节一致`)
      }
      // 产物目录恰为 index.js + package.json + shared + 伴生集（+config.json 如有；无多余夹带）
      const expect = ['index.js', 'package.json', 'shared', ...companions, ...(hasCfg ? ['config.json'] : [])].sort()
      const actual = fs.readdirSync(path.join(DIST_FNS, fn)).sort()
      assert.deepEqual(actual, expect, `${fn} 产物恰为期望文件集（实得 ${JSON.stringify(actual)}）`)
      // shared 与源同构 + assemble 转译产物（dailyTipCore.js 由 utils/ 单源转译投放，
      // 非源拷贝——字节断言不适用，改为存在性 + CJS 可加载断言）
      const distShared = Object.fromEntries(walkFiles(path.join(DIST_FNS, fn, 'shared')).map(p => [path.relative(path.join(DIST_FNS, fn, 'shared'), p), sha256(fs.readFileSync(p))]))
      const expectKeys = [...Object.keys(srcShared), 'dailyTipCore.js'].sort()
      assert.deepEqual(Object.keys(distShared).sort(), expectKeys, `${fn}/shared 文件集=源+转译产物`)
      for (const [rel, h] of Object.entries(srcShared)) assert.equal(distShared[rel], h, `${fn}/shared/${rel} 与源逐字节一致`)
      const artifact = require(path.join(DIST_FNS, fn, 'shared', 'dailyTipCore.js'))
      assert.equal(typeof artifact.buildPushContent, 'function', `${fn}/shared/dailyTipCore.js 可 CJS 加载（共用核心单源投放）`)
    }
  })

  await scenario('D4a 密钥防泄漏：私钥/sk- 长串/AKID/appSecret(32hex) 全仓零命中', async () => {
    const targets = []
    for (const d of ['pages', 'components', 'services', 'stores', 'utils', 'cloud', 'tests', 'docs', 'static/data']) {
      const dp = path.join(root, d)
      if (fs.existsSync(dp)) targets.push(...walkFiles(dp, p => /\.(js|mjs|cjs|vue|json|md|scss|css|html)$/.test(p)))
    }
    for (const f of ['.dev.vars.example', '.env.example', 'package.json', 'manifest.json', 'pages.json', 'vite.config.js', 'App.vue', 'main.js', 'uni.promisify.adaptor.js', 'index.html', 'uni.scss']) {
      const p = path.join(root, f)
      if (fs.existsSync(p)) targets.push(p)
    }
    const strong = [
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥块'],
      [/\bsk-[A-Za-z0-9_-]{16,}/, 'sk- 长串密钥'],
      [/AKID[A-Za-z0-9]{12,}/, '腾讯云 SecretId 形态'],
      [/appsecret['"]?\s*[:=]\s*['"][0-9a-fA-F]{32}['"]/i, '微信 appSecret(32hex) 配值'],
    ]
    const offenders = []
    for (const p of targets) {
      const content = fs.readFileSync(p, 'utf8')
      for (const [re, label] of strong) {
        const m = content.match(re)
        if (m) offenders.push(`${label} @ ${path.relative(root, p)}: ${String(m[0]).slice(0, 24)}…`)
      }
    }
    assert.deepEqual(offenders, [], `强模式命中（实得 ${JSON.stringify(offenders)}）`)
  })

  await scenario('D4b 密钥防泄漏：生产目录无 token 形态硬编码', async () => {
    const generic = /(password|passwd|secret|apikey|api_key)['"]?\s*[:=]\s*['"][A-Za-z0-9+/=_-]{24,}['"]/i
    const offenders = []
    for (const d of ['pages', 'components', 'services', 'stores', 'utils', 'cloud']) {
      for (const p of walkFiles(path.join(root, d), p => /\.(js|mjs|cjs|vue|json)$/.test(p))) {
        const m = fs.readFileSync(p, 'utf8').match(generic)
        if (m) offenders.push(`${path.relative(root, p)}: ${String(m[0]).slice(0, 40)}…`)
      }
    }
    assert.deepEqual(offenders, [], `生产目录 token 形态命中（实得 ${JSON.stringify(offenders)}）`)
  })

  await scenario('D4c 密钥防泄漏：DEEPSEEK_API_KEY 仅经 process.env，示例文件仅占位符', async () => {
    const tools = fs.readFileSync(path.join(root, 'cloud/functions/mc-tools/index.js'), 'utf8')
    assert.ok(/process\.env\.DEEPSEEK_API_KEY/.test(tools), 'mc-tools 须以 process.env 读取 AI 密钥')
    assert.ok(!/DEEPSEEK_API_KEY['"]?\s*[:=]\s*['"][^'"]+/.test(tools), 'DEEPSEEK_API_KEY 不得字面量赋值')
    assert.ok(!/['"][0-9a-f]{32,}['"]/.test(tools), 'mc-tools 不得内嵌 hex 长串密钥')
    const examplePath = path.join(root, '.dev.vars.example')
    if (fs.existsSync(examplePath)) {
      for (const line of fs.readFileSync(examplePath, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/)
        if (!m) continue
        assert.ok(m[2] === '' || m[2].startsWith('your_'), `.dev.vars.example ${m[1]} 须为占位符（实得 ${JSON.stringify(m[2].slice(0, 12))}…）`)
      }
    }
  })

  await scenario('D4d 密钥防泄漏：.gitignore 封锁 .dev.vars / .env', async () => {
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    assert.ok(/(^|\n)\.dev\.vars/.test(gi), '.gitignore 须忽略 .dev.vars')
    assert.ok(/(^|\n)(\*\*\/)?\.env/.test(gi), '.gitignore 须忽略 .env')
  })

  await scenario('D5 冻结源哈希：运行期间本阶段触碰文件未被并发编辑', async () => {
    for (const [rel, h] of Object.entries(frozenHashes)) {
      assert.equal(sha256(fs.readFileSync(path.join(root, rel))), h, `${rel} 被并发编辑——结果作废须复跑`)
    }
  })

  console.log(`\n${passed} 通过, ${failed.length} 失败`)
  if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(` - ${f}`); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('套件异常:', e); process.exit(2) })
