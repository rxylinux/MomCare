// 家庭诊断页"试发每日提醒"的结果文案（纯函数）。
// 2026-10-01 从 pages/family/index.vue 抽出——补 0cce2f2 的测试欠账（改动必须有
// 测试用例规矩）；语义与页面原内联实现逐一相同，勿"顺手优化"。
// warn=黄字警示：任一成员未发出即亮；空结果沿用原语义（warn=false，文案回落 message）。

const memberName = m => (m === 'mama' ? '妈妈' : '爸爸')

export function summarizePushTest(res) {
	if (!res || !res.ok) {
		return { text: `试发未执行：${(res && (res.message || res.code)) || '未知错误'}`, warn: true }
	}
	const results = (res.data && res.data.results) || []
	if (results.length === 0) {
		return { text: res.message || '无返回结果', warn: false }
	}
	const parts = results.map(r => {
		const name = memberName(r.member)
		if (r.sent) return `${name}已发送`
		if (r.skipped === 'quota') return `${name}未订阅或配额用尽（点首页问候卡授权后重试）`
		return `${name}发送失败：${r.error || '未知'}`
	})
	return { text: parts.join('；'), warn: !results.every(r => r.sent) }
}
