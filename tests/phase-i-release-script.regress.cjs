// Phase I 发版脚本回归：scripts/release-trial.mjs 的流程顺序不变量。
// 背景事故：1.1.4 前包内版本号慢一拍（构建后才写 manifest）——已根治于 b60eebb，
// 本套件把该修复的顺序前提锁死，防止日后重构脚本时无声回退。
// 性质声明：脚本真跑会触发 DevTools CLI 上传/git 提交（不可执行），故为源码级
// 顺序/结构断言（标记存在性 + 相对次序），非行为执行——phase-d 对产物结构静态
// 校验的同族做法。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')

let passed = 0
const failed = []
function pass(name) { passed++; console.log(`  ok  ${name}`) }
function fail(name, e) { failed.push(name); console.log(`FAIL  ${name}\n      ${e && e.message}`) }
function scenario(name, fn) {
  try { fn(); pass(name) } catch (e) { fail(name, e) }
}

const SRC = fs.readFileSync(path.join(root, 'scripts/release-trial.mjs'), 'utf8')
// 标记必须存在（防误删），并返回其首次位置供顺序比较
function at(marker, label) {
  const i = SRC.indexOf(marker)
  assert.ok(i >= 0, `脚本缺失标记：${label || marker}`)
  return i
}

scenario('RL1 版本解析门：x.y.z 正则 + 非法格式 die（权威源 manifest.versionName）', () => {
  at('/^(\\d+)\\.(\\d+)\\.(\\d+)$/', '版本格式正则')
  at('不是 x.y.z 格式', '非法版本 die 文案')
  at("readFileSync(MANIFEST, 'utf8')", '读 manifest 权威源')
})

scenario('RL2 全量回归门先于版本落盘（不过不许发）', () => {
  const testGate = at("execSync('npm run test:all'", '全量回归执行')
  const versionWrite = at('manifest.versionName = NEW_VERSION', '版本号赋值')
  assert.ok(testGate < versionWrite, 'test:all 必须跑在写版本号之前——测试不过不许动版本')
  at('未落盘任何版本变更', '测试失败 die 文案')
})

scenario('RL3 构建前落盘（1.1.4 版本慢一拍事故的根治前提）', () => {
  const versionWrite = at('manifest.versionName = NEW_VERSION')
  const manifestWrite = at('writeFileSync(MANIFEST', 'manifest 落盘')
  const build = at("execSync('npm run build:mp-weixin'", '小程序构建')
  assert.ok(versionWrite < manifestWrite, '先改内存再落盘')
  assert.ok(manifestWrite < build, '版本号必须先于构建落盘——包内"版本 v"读构建时静态值')
})

scenario('RL4 构建失败回滚：assemble/build 任一失败→git 回滚 manifest 不跳号', () => {
  at("execSync('node cloud/assemble.mjs'", '组装云函数')
  at('git checkout -- manifest.json', '回滚实现')
  at("rollbackManifestAndDie('构建失败", '构建失败回滚入口')
})

scenario('RL5 上传双检+回滚：退出码非 0 或输出含 [error] 均判失败（80051 退出码 0 陷阱）', () => {
  at('up.status !== 0', '退出码检查')
  at('/\\[error\\]/.test(up.stdout', 'stdout 错误标记检查')
  at('/\\[error\\]/.test(up.stderr', 'stderr 错误标记检查')
  at("rollbackManifestAndDie('上传失败", '上传失败回滚入口')
})

scenario('RL6 提交失败严禁回滚：上传已成功后回滚会导致下次跳号', () => {
  const dieMsg = at('严禁回滚', '严禁回滚语义注释/提示')
  const around = SRC.slice(dieMsg - 400, dieMsg + 400)
  assert.ok(!around.includes('rollbackManifestAndDie'), '提交失败分支不得调用回滚')
  assert.ok(!around.includes('git checkout -- manifest.json'), '提交失败分支不得直接回滚')
})

scenario('RL7 上传暂存目录物理排除：static/data 与 cloudfunctions 删净+摘 cloudfunctionRoot+upload 指向暂存目录', () => {
  at("rmSync(join(UPLOAD_DIR, 'static/data')", '物理删 static/data')
  at("rmSync(join(UPLOAD_DIR, 'cloudfunctions')", '物理删 cloudfunctions')
  at('delete upCfg.cloudfunctionRoot', '摘除暂存目录声明')
  const upload = at("spawnSync(CLI, ['upload', '--project', UPLOAD_DIR", '上传指向暂存目录')
  const staging = at('上传源 = dist/trial-upload', '暂存目录说明')
  assert.ok(staging < upload, '先备暂存目录再上传')
})

scenario('RL8 versionCode 公式与双字段落盘', () => {
  at('major * 10000 + minor * 100 + newPatch', 'versionCode 公式')
  at('manifest.versionCode = NEW_CODE', 'versionCode 落盘')
})

scenario('RL9 dry-run 零副作用：在任何写盘之前退出', () => {
  const dryExit = at('process.exit(0)', 'dry-run 退出')
  const manifestWrite = at('writeFileSync(MANIFEST')
  assert.ok(dryExit < manifestWrite, 'dry-run 必须先于首次写盘退出')
})

scenario('RL10 前置检查三件套：git 脏区拒发/--functions 名单校验/CLI 缺失拒发', () => {
  at('git status --porcelain', '脏区探测')
  at('工作区有未提交改动', '脏区 die')
  at('--functions 中的', '名单校验 die')
  at('未找到微信开发者工具 CLI', 'CLI 缺失 die')
})

console.log(`\n${passed} 通过, ${failed.length} 失败`)
if (failed.length) { console.log('失败场景：' + failed.join(' | ')); process.exit(1) }
