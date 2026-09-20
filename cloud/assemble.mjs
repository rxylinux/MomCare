#!/usr/bin/env node
// 组装可部署的云函数目录：dist/cloud-functions/<fn>/ = <fn>/index.js + shared/ + package.json
// 依赖版本锁定（wx-server-sdk 以官方文档为准，部署前核对最新稳定版）。
// 用法：node cloud/assemble.mjs   （不安装依赖、不访问云资源）
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// wx-server-sdk 版本锁定依据：Codex 于 2026-09-19 从 npm 获取 wx-server-sdk@4.0.2
// 发布包并逐文件核对本项目使用的契约（init 配置级 throwOnNotFound、doc.set 拒绝
// 数据内 _id、downloadFile 返回 fileContent:Buffer 等，见 DEPLOY.md）。
// 升级版本前必须重新核对这些语义。
const WX_SERVER_SDK_VERSION = '4.0.2'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcFunctions = join(root, 'cloud', 'functions')
const sharedDir = join(root, 'cloud', 'shared')
const outRoot = join(root, 'dist', 'cloud-functions')

rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })

const dirs = readdirSync(srcFunctions, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .filter(d => existsSync(join(srcFunctions, d.name, 'index.js')))

if (dirs.length === 0) {
  console.error('未发现任何云函数入口（cloud/functions/*/index.js）')
  process.exit(1)
}

for (const dir of dirs) {
  const fnDir = join(srcFunctions, dir.name)
  const outDir = join(outRoot, dir.name)
  mkdirSync(outDir, { recursive: true })
  cpSync(join(fnDir, 'index.js'), join(outDir, 'index.js'))
  // 云函数配置（如 mc-tools 的云调用权限 config.json）——存在即随包打包
  const configPath = join(fnDir, 'config.json')
  if (existsSync(configPath)) {
    cpSync(configPath, join(outDir, 'config.json'))
    console.log(`  + ${dir.name}/config.json`)
  }
  // 伴生本地模块逐文件打包（mc-restore 的 v20.js——V20 协议纯函数模块；index.js 以 require('./v20')
  // 弹性加载，缺文件+flag=true 时 handler fail-closed 拒——组装物必须包含以支持启用模式）
  const companions = readdirSync(fnDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.js') && e.name !== 'index.js')
  for (const c of companions) {
    cpSync(join(fnDir, c.name), join(outDir, c.name))
    console.log(`  + ${dir.name}/${c.name}`)
  }
  cpSync(sharedDir, join(outDir, 'shared'), { recursive: true })
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({
    name: dir.name,
    version: '1.0.0',
    main: 'index.js',
    dependencies: { 'wx-server-sdk': WX_SERVER_SDK_VERSION }
  }, null, 2))
  console.log(`assembled ${dir.name}`)
}

// 附带规则/集合定义副本，方便随函数目录一起复核
cpSync(join(root, 'cloud', 'rules'), join(outRoot, '_rules'), { recursive: true })
cpSync(join(root, 'cloud', 'collections.json'), join(outRoot, '_collections.json'))
console.log(`done: ${dirs.length} functions → dist/cloud-functions/`)
