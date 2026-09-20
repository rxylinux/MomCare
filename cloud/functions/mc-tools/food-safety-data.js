'use strict'

// E3 饮食/行为安全词条库（服务端副本——与 static/data/food-safety.json 同源同内容；
// phase-e3-server 套件逐字段 deepEqual 钉双源不漂移）。
// 审校依据：中国营养学会《孕期妇女膳食指南 (2022)》/ NHS / FDA-EPA / ACOG——reviewedAt 见各词条。
module.exports = [
  {
    "id": "food_salmon_cooked",
    "name": "三文鱼（熟）",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "熟三文鱼",
      "大西洋鲑",
      "熟鱼",
      "鲑鱼煮熟"
    ],
    "summary": "优质蛋白质与 DHA 重要来源，富含 Omega-3 脂肪酸，属于低汞鱼类，孕期适量食用有益。",
    "conditions": "必须完全煮熟至鱼肉中心不透明、易被叉子挑散（中心温度 ≥63°C）；避免生食或烟熏半生三文鱼；每周建议总量参照膳食指南鱼类推荐份量。",
    "risks": "生食存在寄生虫与李斯特菌感染风险；长期过量摄入大型掠食性鱼类存在甲基汞蓄积风险。",
    "source": "中国营养学会《孕期妇女膳食指南 (2022)》/ 美国 FDA-EPA 鱼类建议",
    "sourceUrl": "https://www.fda.gov/food/consumers/advice-about-eating-fish",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_sashimi_raw_fish",
    "name": "生鱼片 / 刺身",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "刺身",
      "寿司生鱼",
      "生鱼",
      "鱼生",
      "sashimi"
    ],
    "summary": "孕期应避免一切生的鱼、贝类水产，包括刺身、生腌、烟熏半生鱼类。",
    "conditions": "无安全前提——孕期全程避免；如已误食少量且无不适，不必恐慌，后续避免并在产检时告知医生。",
    "risks": "李斯特菌、沙门氏菌与寄生虫感染风险显著升高；李斯特菌可通过胎盘感染胎儿，可致流产、早产或严重新生儿感染。",
    "source": "中国营养学会《孕期妇女膳食指南 (2022)》/ 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_raw_egg_soft",
    "name": "生鸡蛋 / 溏心蛋",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "溏心蛋",
      "半熟蛋",
      "太阳蛋",
      "生蛋液",
      "提拉米苏生蛋",
      "沙门氏菌蛋"
    ],
    "summary": "未全熟的鸡蛋及其制品（溏心蛋、生蛋黄酱、含生蛋液甜点）孕期应避免。",
    "conditions": "无安全前提——蛋黄与蛋白均须完全凝固；外卖甜品若无法确认鸡蛋全熟应避免。",
    "risks": "沙门氏菌感染可引起严重呕吐腹泻、脱水与高热，孕期感染可能与早产相关。",
    "source": "英国 NHS 孕期饮食指南 / 中国营养学会《孕期妇女膳食指南 (2022)》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_egg_fully_cooked",
    "name": "全熟蛋",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "熟鸡蛋",
      "水煮蛋",
      "全熟荷包蛋",
      "炒熟鸡蛋"
    ],
    "summary": "蛋黄蛋白完全凝固的鸡蛋是孕期优质蛋白与胆碱来源，日常适量食用安全。",
    "conditions": "蛋黄与蛋白均须完全凝固；冷藏储存、充分复热后食用。",
    "risks": "未全熟时的沙门氏菌风险（见「生鸡蛋 / 溏心蛋」条目）。",
    "source": "中国营养学会《孕期妇女膳食指南 (2022)》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_caffeine",
    "name": "咖啡 / 含咖啡因饮料",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "咖啡",
      "拿铁",
      "美式",
      "奶茶",
      "浓茶",
      "可乐",
      "能量饮料",
      "咖啡因"
    ],
    "summary": "孕期不必完全戒断咖啡因，但须严格限制每日总量。",
    "conditions": "每日咖啡因总量建议不超过 200mg（约一杯 350ml 美式）；奶茶、浓茶、可乐、能量饮料同计入总量；孕早期尤其建议限量。",
    "risks": "过量咖啡因与流产、低出生体重风险升高相关；个体代谢差异大，敏感者应进一步减量。",
    "source": "英国 NHS / 美国妇产科医师学会 (ACOG) 咖啡因意见",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_milk_pasteurized",
    "name": "巴氏杀菌奶",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "巴氏奶",
      "鲜奶杀菌",
      "纯牛奶",
      "常温奶",
      "超高温灭菌乳"
    ],
    "summary": "经巴氏杀菌或超高温灭菌的牛奶安全，是孕期钙与蛋白质的重要来源。",
    "conditions": "须为正规市售灭菌/巴氏产品并在保质期内；开封后冷藏并尽快饮用；避免现挤生牛奶。",
    "risks": "未经杀菌生奶含李斯特菌、布鲁氏菌等风险（见生奶相关警示）。",
    "source": "中国营养学会《孕期妇女膳食指南 (2022)》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_cheese_unpasteurized",
    "name": "未经巴氏杀菌乳酪",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "生乳酪",
      "软质奶酪",
      "布里奶酪",
      "卡门贝尔",
      "蓝纹奶酪",
      "羊奶软酪"
    ],
    "summary": "由未巴氏杀菌（生）乳制成的软质与霉纹奶酪孕期应避免。",
    "conditions": "无安全前提——查看配料表确认「巴氏杀菌乳」制作的硬质奶酪可食用；餐厅自制奶酪来源不明应避免。",
    "risks": "李斯特菌污染风险高——孕期感染可经胎盘传染胎儿，导致流产、早产或严重新生儿感染。",
    "source": "英国 NHS 孕期饮食指南 / 美国 FDA",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_tuna",
    "name": "金枪鱼",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "吞拿鱼",
      "鲔鱼",
      "tuna",
      "金枪鱼罐头"
    ],
    "summary": "金枪鱼属中高汞鱼类，孕期须严格限量食用。",
    "conditions": "建议每周不超过约 100g 且选择小体型/罐头淡金枪鱼；避免大型生食级金枪鱼腹（大腹）等高汞部位；同周不再叠加其他高汞鱼。",
    "risks": "甲基汞蓄积可影响胎儿神经系统发育。",
    "source": "美国 FDA-EPA 鱼类建议 / 中国营养学会《孕期妇女膳食指南 (2022)》",
    "sourceUrl": "https://www.fda.gov/food/consumers/advice-about-eating-fish",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "food_alcohol",
    "name": "酒精 / 含酒精饮品",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "酒",
      "啤酒",
      "红酒",
      "白酒",
      "料酒大量",
      "酒心巧克力",
      "无醇啤酒"
    ],
    "summary": "孕期不存在已知安全的酒精摄入量，应全程避免一切含酒精饮品与大量料酒菜肴。",
    "conditions": "无安全前提——备孕期即建议戒酒；「无醇」产品仍可能含微量酒精，应谨慎。",
    "risks": "酒精可致胎儿酒精谱系障碍（FASD），包括不可逆的神经发育损害与畸形。",
    "source": "中国营养学会《孕期妇女膳食指南 (2022)》/ 世界卫生组织 (WHO)",
    "sourceUrl": "https://www.who.int/news-room/fact-sheets/detail/fetal-alcohol-spectrum-disorders",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "behavior_hot_spring_sauna",
    "name": "高温温泉 / 桑拿",
    "category": "behavior",
    "level": "avoid",
    "synonyms": [
      "温泉",
      "桑拿",
      "汗蒸",
      "高温瑜伽",
      "热水浴高温",
      "蒸汽房"
    ],
    "summary": "孕期避免使核心体温显著升高（＞39°C）的高温环境，尤其在孕早期。",
    "conditions": "无安全前提——孕早期（器官形成期）严格避免；温水淋浴（非长时间浸泡）一般无碍。",
    "risks": "核心体温过高与神经管缺陷等发育风险升高相关；高温环境还可能引起头晕、脱水与低血压。",
    "source": "美国妇产科医师学会 (ACOG) / 英国 NHS",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "behavior_hair_perm_dye",
    "name": "烫发 / 染发",
    "category": "behavior",
    "level": "caution",
    "synonyms": [
      "烫头",
      "染头",
      "染发剂",
      "烫发剂",
      "头发护理化学"
    ],
    "summary": "孕期并非绝对禁止，但建议尽量避免，尤其孕早期；确需进行须满足条件。",
    "conditions": "优先避开孕早期；选择正规合格产品、通风良好环境、皮肤无破损且做过敏测试；避免接触头皮的植物/化学染剂长期频繁使用；咨询产科医生后进行。",
    "risks": "现有证据未发现合格染烫产品与明确致畸关联，但数据有限；部分化学物可经头皮微量吸收。",
    "source": "美国妇产科医师学会 (ACOG) / 美国皮肤科学会 (AAD)",
    "sourceUrl": "https://www.acog.org/womens-health/faqs",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "behavior_dental_local_anesthesia",
    "name": "口腔局部麻醉",
    "category": "behavior",
    "level": "safe",
    "synonyms": [
      "补牙麻醉",
      "拔牙麻药",
      "牙科局麻",
      "利多卡因口腔"
    ],
    "summary": "常规牙科局部麻醉（如利多卡因）在孕期是安全的，必要治疗不应因怀孕而拖延。",
    "conditions": "就诊时告知牙医孕周与产科情况；优先孕中期进行择期治疗；配合使用含或不含肾上腺素的常规局麻药剂，由医生评估。",
    "risks": "拖延牙科感染不处理的危害（感染扩散、早产关联）大于规范局麻的风险。",
    "source": "美国妇产科医师学会 (ACOG) 委员会意见 / 美国牙科协会 (ADA)",
    "sourceUrl": "https://www.acog.org/clinical/clinical-guidance/committee-opinion",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "behavior_chest_xray",
    "name": "胸部 X 光",
    "category": "behavior",
    "level": "caution",
    "synonyms": [
      "X光",
      "X射线",
      "胸片",
      "放射检查",
      "拍片"
    ],
    "summary": "单次诊断性胸部 X 光辐射剂量极低，必要时在防护下可安全进行。",
    "conditions": "仅在医学需要时进行并告知医生已孕孕周；规范腹部屏蔽防护；避免短期内多次无指征摄片。",
    "risks": "单次胸片胎儿受照剂量远低于致畸阈值；不必要的高剂量反复暴露才存在理论风险。",
    "source": "美国放射学会 (ACR) / 美国妇产科医师学会 (ACOG)",
    "sourceUrl": "https://www.acr.org/Clinical-Resources/Radiology-Safety",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  },
  {
    "id": "behavior_commercial_flight",
    "name": "民航乘机",
    "category": "behavior",
    "level": "caution",
    "synonyms": [
      "坐飞机",
      "航班",
      "飞机出行",
      "乘机",
      "航空旅行"
    ],
    "summary": "健康孕妇在孕中期（约 14-28 周）乘机通常安全，须满足航空公司与自身条件。",
    "conditions": "无并发症、无先兆流产/早产史；孕 36 周后（部分航司更早）多数航司要求医疗证明或拒载；长途飞行每 1-2 小时起身活动、充足饮水；购票前查阅航司孕产乘客规定并咨询产科医生。",
    "risks": "久坐增加深静脉血栓风险；机舱压力变化对健康孕妇影响有限，但有并发症者需个体评估。",
    "source": "国际航空运输协会 (IATA) / 英国 NHS 旅行健康建议",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/travel/",
    "reviewedAt": "2026-03-01",
    "version": "1.0"
  }
]
