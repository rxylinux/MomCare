#!/usr/bin/env node
// 生成"两成员本人暂存目录限定写入"的云存储安全规则（JSON）。
//
// 规则语法依据官方《安全规则语言》文档（2026-09-19 核对）：
// - 条件用 JS 风格表达式；判空写 auth != null（不是 nil）
// - 正则匹配写法：正则字面量 .test(resource.path)，结果必须显式 == true
//   （不支持 =~ 运算符）
// - resource.path 不含桶名与前导斜杠；auth.openid 为调用者 OpenID
//
// 产出：所有客户端读取一律 false；写入仅允许两位白名单 OpenID 写自己的
// 暂存子目录；正式目录与匿名/他人一律拒绝。
//
// 用法（部署时由用户提供真实值；本脚本不访问任何云资源）：
//   node cloud/rules/generate-staging-rules.mjs --family fam-momcare \
//        --openid-mama oXXX... --openid-papa oYYY... > staging.rules.json
// 生成后必须先在控制台"规则校验"验证语法，并完成四个边界用例
//（本人目录可写、互写拒绝、正式目录拒绝、匿名拒绝）后才可应用到存储，
// 再把云函数环境变量 MC_UPLOAD_ENABLED 置 true。本地测试只验证生成语义，
// 不冒充真实控制台验证。
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    family: { type: 'string' },
    'openid-mama': { type: 'string' },
    'openid-papa': { type: 'string' }
  }
})

const missing = ['family', 'openid-mama', 'openid-papa'].filter(k => !values[k])
if (missing.length > 0) {
  console.error('缺少参数：' + missing.join('、'))
  process.exit(1)
}

// family 会进入正则字面量：只允许安全字符并做正则转义，防注入
if (!/^[A-Za-z0-9_-]{1,48}$/.test(values.family)) {
  console.error('family 只允许 1-48 位字母/数字/下划线/连字符')
  process.exit(1)
}
const family = values.family

const openids = [values['openid-mama'], values['openid-papa']]
if (openids[0] === openids[1]) {
  console.error('两位成员 OpenID 不能相同')
  process.exit(1)
}
for (const oid of openids) {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(oid)) {
    console.error('OpenID 形态异常：' + oid)
    process.exit(1)
  }
}

// 每位成员：auth.openid 精确等于本人 && 本人暂存目录（一层文件名）正则命中
// JSON.stringify 会处理引号/反斜杠转义；正则按字面量语法书写
const clauses = openids.map(oid =>
  `(auth.openid == "${oid}" && (/^mc\\/${family}\\/stage\\/${oid}\\/[^\\/]+$/.test(resource.path)) == true)`
)

const rule = {
  read: false,
  write: `auth != null && (${clauses.join(' || ')})`
}

console.log(JSON.stringify(rule, null, 2))
console.error('已生成。请先在控制台校验语法并完成四项边界用例（本人可写/互写拒/正式拒/匿名拒），再应用并开启 MC_UPLOAD_ENABLED。')
