'use strict'

// E3 饮食/行为安全词条库（服务端副本——由 scripts/gen-food-safety.mjs 从
// static/data/food-safety.json 生成，勿手改；phase-e3-server 套件逐字段
// deepEqual 钉双源不漂移）。
// 审校依据：中国营养学会《孕期妇女膳食指南 (2022)》/ NHS / FDA-EPA / ACOG——reviewedAt 见各词条。
// source-sha256: 0e15a2c57bdece067dde2ba1efd4b4370c48ccb23d468d9eabc5c60a7da95beb
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
  },
  {
    "id": "food_undercooked_meat",
    "name": "五分熟牛排 / 带血畜禽肉",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "五分熟",
      "七分熟牛排",
      "带血牛肉",
      "生肉",
      "tartare",
      "鞑靼牛肉",
      "未熟肉"
    ],
    "summary": "孕期畜肉、禽肉必须全熟——切面不见血、肉色转灰才算安全。",
    "conditions": "无安全前提。外出就餐主动要\"全熟\"；如已误食少量且无不适不必恐慌，后续避免并产检时告知医生。",
    "risks": "弓形虫、沙门氏菌与大肠杆菌感染风险；弓形虫可经胎盘感染胎儿，致流产或严重先天损伤。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》 / 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_drunk_raw_seafood",
    "name": "生腌醉虾 / 醉蟹",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "生腌",
      "醉虾",
      "醉蟹",
      "呛蟹",
      "生腌海鲜",
      "捞汁生蚝"
    ],
    "summary": "酒精腌制不能杀菌——生腌海鲜是\"生食+酒精\"双重风险，孕期全程避免。",
    "conditions": "无安全前提。高度酒浸泡无法杀灭寄生虫与细菌。",
    "risks": "寄生虫（肝吸虫等）与李斯特菌风险；酒精成分同样进入母体。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》 / 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_raw_milk",
    "name": "现挤生牛羊奶",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "现挤奶",
      "生牛奶",
      "生羊奶",
      "鲜挤奶",
      "散装奶"
    ],
    "summary": "未经巴氏杀菌的现挤奶可能携带布鲁氏菌与结核菌，孕期不要喝。",
    "conditions": "想喝奶选超市巴氏杀菌奶或常温奶；现挤奶煮沸也不推荐（家庭煮沸温度时间难保证）。",
    "risks": "布鲁氏菌病可致流产；结核菌及其他病原体风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》 / 美国 CDC 李斯特菌预防指南",
    "sourceUrl": "https://www.cdc.gov/listeria/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_century_egg",
    "name": "皮蛋（松花蛋）",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "松花蛋",
      "变蛋",
      "皮蛋瘦肉粥里的皮蛋"
    ],
    "summary": "传统工艺皮蛋含铅且多为生制，孕期避免；标明\"无铅工艺\"的也建议少吃。",
    "conditions": "无铅皮蛋偶尔少量风险较低，但不必为它冒险。",
    "risks": "铅暴露影响胎儿神经发育；生制过程沙门氏菌风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_high_mercury_fish",
    "name": "鲨鱼 / 剑鱼 / 旗鱼等高汞鱼",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "鲨鱼肉",
      "剑鱼",
      "旗鱼",
      "方头鱼",
      "大眼金枪鱼",
      "高汞鱼",
      "掠食鱼"
    ],
    "summary": "大型掠食鱼汞富集明显，孕期避开；低汞鱼（三文鱼、鳕鱼、鲈鱼等）每周 2~3 次照吃。",
    "conditions": "选低汞富硒鱼种；罐头淡金枪鱼（chunk light）汞较低，限量每周不超过一小罐。",
    "risks": "甲基汞损害胎儿大脑与神经系统发育。",
    "source": "美国 FDA/EPA 鱼类食用建议 / 中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.fda.gov/food/consumers/advice-about-eating-fish",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_alcohol_cooking",
    "name": "含酒精料理（醉鸡 / 酒糟 / 朗姆蛋糕）",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "醉鸡",
      "酒糟",
      "糟卤",
      "朗姆蛋糕",
      "酒心巧克力",
      "料酒放很多",
      "含酒精料理"
    ],
    "summary": "烹饪只能挥发部分酒精，孕期对含酒精料理也应回避——酒精没有安全剂量。",
    "conditions": "少量料酒炝锅（几毫升、充分加热）残留极低，风险很小；以酒为主料的菜整道回避。",
    "risks": "酒精可自由通过胎盘，影响胎儿发育，孕期饮酒无已知安全阈值。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》 / 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_energy_drink",
    "name": "能量饮料",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "红牛",
      "功能饮料",
      "提神饮料",
      "energy drink",
      "魔爪"
    ],
    "summary": "咖啡因剂量不透明，叠加牛磺酸等成分孕期安全性未确立——提神换咖啡因含量明确的饮品并计入每日额度。",
    "conditions": "每日咖啡因总额 ≤200mg（约一杯美式）。",
    "risks": "过量咖啡因与流产、低出生体重相关；其他刺激成分缺乏孕期安全数据。",
    "source": "美国妇产科医师学会（ACOG）孕期运动指南 / 中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.acog.org/womens-health/faqs/exercise-during-pregnancy",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_raw_sprouts",
    "name": "未煮熟豆芽",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "生豆芽",
      "凉拌豆芽",
      "豆苗生吃",
      "苜蓿芽",
      "sprouts"
    ],
    "summary": "豆芽在温暖潮湿环境培育，细菌可进入芽体内部——必须彻底炒熟，凉拌生吃不行。",
    "conditions": "餐馆里的\"爆炒绿豆芽\"没问题；自己的凉拌菜别放生豆芽。",
    "risks": "沙门氏菌、大肠杆菌、李斯特菌风险。",
    "source": "美国 CDC 李斯特菌预防指南 / 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.cdc.gov/listeria/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_unwashed_raw_produce",
    "name": "未洗净的生食蔬果 / 来路不明沙拉",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "生蔬菜没洗",
      "路边沙拉",
      "凉拌菜卫生不明",
      "生食蔬果未洗"
    ],
    "summary": "土传弓形虫与李斯特菌可附着在生蔬果表面——生吃前流水彻底清洗，来源不明的凉拌菜不碰。",
    "conditions": "自己制作：流水搓洗+去皮更稳；外食选可加热的菜式更安心。",
    "risks": "弓形虫经胎盘感染胎儿；李斯特菌可致早产。",
    "source": "美国 CDC 李斯特菌预防指南 / 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.cdc.gov/listeria/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_mold_cheese",
    "name": "霉变奶酪（蓝纹 / 软质霉皮）",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "蓝纹奶酪",
      "布里奶酪",
      "卡门贝尔",
      "mould-ripened",
      "霉皮奶酪"
    ],
    "summary": "霉菌熟成的软质奶酪是李斯特菌高危食物，孕期避开；硬质奶酪与再制奶酪可以吃。",
    "conditions": "看配料：巴氏杀菌+硬质（切达、马苏里拉烘焙全熟）没问题。",
    "risks": "李斯特菌可通过胎盘，导致流产、早产或新生儿严重感染。",
    "source": "英国 NHS 孕期饮食指南 / 美国 CDC 李斯特菌预防指南",
    "sourceUrl": "https://www.cdc.gov/listeria/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_self_medication",
    "name": "自行服用保健品 / 中草药",
    "category": "behavior",
    "level": "avoid",
    "synonyms": [
      "自己买药吃",
      "中药调理",
      "活血药材",
      "红花",
      "桃仁",
      "藏红花",
      "自行进补"
    ],
    "summary": "任何补充剂、中草药（尤其活血类：红花/桃仁/藏红花等）孕期必须先问医生，不要自行服用。",
    "conditions": "医生开具的孕期专用制剂（叶酸/铁剂/钙剂等）按时吃；其余\"调理\"一律先问诊。",
    "risks": "部分药材兴奋子宫平滑肌可致流产；保健品成分剂量不明可能与孕期需求冲突。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/vitamins-supplements-and-nutrition/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_fetal_detox_folk",
    "name": "\"去胎毒\"偏方（黄连水等）",
    "category": "behavior",
    "level": "avoid",
    "synonyms": [
      "黄连水",
      "去胎毒",
      "胎毒",
      "清胎毒",
      "民间偏方去毒"
    ],
    "summary": "\"胎毒\"不是医学概念，新生儿黄疸与它无关——黄连水等去胎毒偏方对母婴都有害无益，别喝也别给新生儿灌。",
    "conditions": "黄疸由胆红素代谢引起，病理性黄疸就医光照治疗即可。",
    "risks": "黄连素（小檗碱）对新生儿有风险；偏方延误正规处理。",
    "source": "中华医学会儿科学会黄疸诊治共识相关科普 / 中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/conditions/jaundice-newborn/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_hot_exercise",
    "name": "高温瑜伽 / 高温运动课",
    "category": "behavior",
    "level": "avoid",
    "synonyms": [
      "热瑜伽",
      "高温瑜珈",
      "暴汗课",
      "高温运动",
      "汗蒸房运动"
    ],
    "summary": "使核心体温显著升高的高温环境运动孕期避免（与温泉/桑拿同理）——运动选常温环境。",
    "conditions": "常温瑜伽、快走、游泳都可以；运动中能正常说话的强度为界。",
    "risks": "孕早期核心体温过高与神经管缺陷相关。",
    "source": "美国妇产科医师学会（ACOG）孕期运动指南",
    "sourceUrl": "https://www.acog.org/womens-health/faqs/exercise-during-pregnancy",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_cat_litter",
    "name": "清理猫砂",
    "category": "behavior",
    "level": "avoid",
    "synonyms": [
      "猫砂",
      "铲猫砂",
      "猫粪便",
      "养猫",
      "铲屎"
    ],
    "summary": "猫粪是弓形虫主要传播途径——孕期让家人清理猫砂；必须自己来就戴一次性手套、事后彻底洗手。",
    "conditions": "室内只吃猫粮的猫感染率很低；不接触流浪猫幼猫粪便即可。养猫本身无需弃养。",
    "risks": "弓形虫初次感染可经胎盘致胎儿先天感染。",
    "source": "美国 CDC 李斯特菌预防指南",
    "sourceUrl": "https://www.cdc.gov/toxoplasmosis/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_fugu",
    "name": "河豚 / 河豚制品",
    "category": "food",
    "level": "avoid",
    "synonyms": [
      "河豚",
      "豚鼠鱼",
      "fugu",
      "河豚干",
      "养殖河豚"
    ],
    "summary": "河豚毒素无解毒剂，任何\"处理到位\"的说法都不值得孕期冒险——直接不吃。",
    "conditions": "无安全前提（草稿审阅时由 caution 定级为 avoid 落库）。",
    "risks": "河豚毒素中毒可致呼吸麻痹死亡，且无有效解救手段。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_strong_tea",
    "name": "浓茶（餐后即饮）",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "浓茶",
      "饭后茶",
      "铁观音浓泡",
      "普洱浓茶",
      "喝茶影响补铁"
    ],
    "summary": "茶中鞣酸抑制铁吸收——别泡太浓、别随餐及餐后一小时内喝，与补铁时间错开。",
    "conditions": "两餐之间淡茶一两杯可以；服用铁剂前后 2 小时不喝茶。",
    "risks": "加重孕期缺铁性贫血风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/caffeine/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_milk_tea",
    "name": "奶茶（市售）",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "奶茶",
      "珍珠奶茶",
      "果茶",
      "奶盖",
      "bm奶茶"
    ],
    "summary": "市售奶茶咖啡因与糖分常双高——偶尔解馋可以，咖啡因要计入每日 200mg 总额，糖分高的别当水喝。",
    "conditions": "选真茶真奶款、小杯、一周一两次为宜。",
    "risks": "咖啡因超量+额外精制糖，与体重过快增长、血糖波动相关。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》 / 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/caffeine/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_animal_liver",
    "name": "动物肝脏",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "猪肝",
      "鸡肝",
      "鸭肝",
      "鹅肝",
      "肝脏",
      "肝泥"
    ],
    "summary": "肝脏维 A 含量极高——补铁好东西但频率限量：每周不超过 1~2 次、每次小块，大量维 A 有致畸风险。",
    "conditions": "吃\"块\"不吃\"碗\"；维 A 补充剂（视黄醇）另算，孕期制剂应以 β-胡萝卜素为主。",
    "risks": "过量视黄醇（预成型维 A）与胎儿致畸相关。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》 / 英国 NHS 孕期饮食指南",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/vitamins-supplements-and-nutrition/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_fast_food",
    "name": "高频外卖快餐",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "快餐",
      "外卖天天吃",
      "炸鸡",
      "薯条",
      "汉堡"
    ],
    "summary": "高钠高脂低营养密度——偶尔吃没问题，别成为常态；长期高频与体重过快增长、妊娠高血压风险相关。",
    "conditions": "点外卖优先\"有菜有肉有主食\"的组合，少选油炸与重芡汁。",
    "risks": "钠与饱和脂肪超标、微量营养素密度低。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_iced_drinks",
    "name": "生冷冰饮（肠胃敏感者）",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "冰饮",
      "冰水",
      "冰淇淋",
      "冷饮拉肚子",
      "冰的"
    ],
    "summary": "冰的东西本身不伤胎儿，顾虑是刺激肠胃引起腹泻——肠胃敏感的妈妈适度，无碍者照常。",
    "conditions": "吃了不胀不泻就继续；腹泻伴宫缩感要及时就医。",
    "risks": "严重腹泻可诱发宫缩。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_high_sodium_canned_fish",
    "name": "高钠鱼罐头",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "鱼罐头",
      "罐头鱼",
      "豆豉鲮鱼",
      "高钠罐头"
    ],
    "summary": "鱼肉本身没问题，问题在钠——选低钠款、看营养成分表，钠高的泡去汤汁再吃。",
    "conditions": "淡金枪鱼罐头（低汞）每周一小罐以内。",
    "risks": "钠摄入过高与孕期水肿、血压相关。",
    "source": "美国 FDA/EPA 鱼类食用建议 / 中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.fda.gov/food/consumers/advice-about-eating-fish",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_stall_fresh_juice",
    "name": "摊贩鲜榨果汁",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "鲜榨果汁",
      "路边果汁",
      "鲜榨摊",
      "cold-pressed 路边"
    ],
    "summary": "现榨不杀菌、器具卫生不可控——选正规巴氏包装果汁，或自己榨立即喝。",
    "conditions": "水果直接吃比喝汁更好（纤维+饱腹+控糖）。",
    "risks": "微生物污染；游离糖浓缩易过量。",
    "source": "美国 CDC 李斯特菌预防指南 / 中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.cdc.gov/listeria/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_dubious_hotpot",
    "name": "卫生存疑的火锅 / 外食凉菜",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "火锅卫生",
      "小店火锅",
      "外食凉拌",
      "大排档"
    ],
    "summary": "辣不伤胎儿，风险在卫生——锅底烧开、肉烫足时、菜洗净；卫生没把握的店换一家。",
    "conditions": "火锅食材务必烫熟再捞；凉菜卤味在孕期慎选。",
    "risks": "不洁食材的寄生虫与细菌感染风险。",
    "source": "英国 NHS 孕期饮食指南 / 中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_high_altitude",
    "name": "高海拔旅行（>2500 米）",
    "category": "behavior",
    "level": "caution",
    "synonyms": [
      "高原旅行",
      "西藏",
      "高海拔",
      "爬山海拔高",
      "高原反应"
    ],
    "summary": "高海拔低氧环境对胎儿的影响证据尚不充分——计划高海拔行程前先和产科医生商量，缓慢适应、备氧。",
    "conditions": "常住高原者遵当地产检医嘱；平原孕妇尽量避免首次快速上高原。",
    "risks": "低氧环境潜在影响胎盘供氧；高原反应处置用药受限。",
    "source": "美国妇产科医师学会（ACOG）孕期运动指南",
    "sourceUrl": "https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2021/05/travel-during-pregnancy",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_long_drive",
    "name": "长途自驾",
    "category": "behavior",
    "level": "caution",
    "synonyms": [
      "自驾长途",
      "开车出门",
      "跑长途",
      "高速自驾"
    ],
    "summary": "安全带低位贴骨盆系好，连续驾驶每 1~2 小时下车活动——久坐增加血栓风险。",
    "conditions": "孕期开车本身可以；疲劳、孕晚期腹部贴近方向盘时让家人开。",
    "risks": "久坐静脉血栓；急刹时安全带位置不当的压力伤。",
    "source": "美国妇产科医师学会（ACOG）孕期运动指南",
    "sourceUrl": "https://www.acog.org/clinical/clinical-guidance/committee-opinion/articles/2021/05/travel-during-pregnancy",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_high_impact_exercise",
    "name": "跳跃 / 对抗性高强度运动",
    "category": "behavior",
    "level": "caution",
    "synonyms": [
      "跳绳",
      "hiit跳跃",
      "篮球",
      "羽毛球对抗",
      "滑雪",
      "骑马"
    ],
    "summary": "孕中晚期重心变化、韧带松弛，摔倒与腹部撞击风险上升——换成游泳、快走、孕妇瑜伽更稳。",
    "conditions": "孕前长期训练者在医生评估下可保留部分强度；出现腹痛出血立即停并就医。",
    "risks": "摔碰外伤、胎盘早剥风险。",
    "source": "美国妇产科医师学会（ACOG）孕期运动指南",
    "sourceUrl": "https://www.acog.org/womens-health/faqs/exercise-during-pregnancy",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_refined_sweets",
    "name": "精制甜食（控糖期）",
    "category": "food",
    "level": "caution",
    "synonyms": [
      "蛋糕",
      "甜点",
      "含糖饮料",
      "奶茶糖",
      "饼干",
      "控糖"
    ],
    "summary": "与主页\"每周涨 0.5kg 以内\"口径一致：控体重先砍含糖饮料和甜点——不必戒断，减频减量。",
    "conditions": "妊娠糖尿病诊断者按营养科方案执行。",
    "risks": "游离糖过量与体重过快增长、血糖异常相关。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_crab_shrimp_cooked",
    "name": "全熟虾 / 全熟螃蟹",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "螃蟹",
      "大闸蟹",
      "虾",
      "基围虾",
      "蟹",
      "虾蟹",
      "寒凉滑胎"
    ],
    "summary": "澄清条目：\"螃蟹寒凉滑胎\"没有科学依据——前提是彻底煮熟、新鲜、适量，孕期可以吃。",
    "conditions": "选活鲜彻底蒸煮；一次别过量（蛋白质+胆固醇密度高，肠胃负担）。",
    "risks": "无特殊风险（生食或不新鲜才有风险）。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》（民间说法无文献支持）",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/foods-to-avoid/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_soybean_milk_boiled",
    "name": "豆浆（彻底煮沸）",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "豆浆",
      "豆奶",
      "自制豆浆",
      " soy milk",
      "豆浆必须煮熟"
    ],
    "summary": "优质植物蛋白——关键在\"彻底煮沸\"：生豆浆含皂苷，假沸后再煮 5 分钟。",
    "conditions": "自制豆浆务必煮透；市售灭菌豆浆直接喝。",
    "risks": "未煮透的皂苷刺激肠胃（与孕期无特殊关系）。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_yogurt",
    "name": "酸奶",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "酸奶",
      "希腊酸奶",
      "常温酸奶",
      "yogurt",
      "益生菌"
    ],
    "summary": "钙与益生菌的好来源——冷藏链完整的正规品牌放心喝，孕期便秘时尤其友好。",
    "conditions": "选无糖/低糖款更好；乳糖不耐者用它替代牛奶。",
    "risks": "无特殊风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_leafy_greens",
    "name": "深绿色叶菜",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "菠菜",
      "西兰花",
      "油麦菜",
      "青菜",
      "绿叶菜",
      "深色蔬菜"
    ],
    "summary": "叶酸+铁+钙+膳食纤维的主力——每天餐桌上都该有深色蔬菜。",
    "conditions": "流水洗净；焯水可去部分草酸提升钙铁利用。",
    "risks": "无特殊风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_oats_wholegrain",
    "name": "燕麦 / 全谷物主食",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "燕麦",
      "燕麦片",
      "全麦",
      "糙米",
      "藜麦",
      "杂粮",
      "全谷物"
    ],
    "summary": "缓释碳水+B 族维生素+纤维——替代一部分精米白面，饱腹又稳血糖。",
    "conditions": "选纯燕麦片而非\"营养麦片\"（加糖型）。",
    "risks": "无特殊风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_plain_nuts",
    "name": "原味坚果",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "核桃",
      "腰果",
      "扁桃仁",
      "巴旦木",
      "坚果",
      "每日坚果"
    ],
    "summary": "优质脂肪+蛋白质+微量元素——每天一小把（约 25g）正好，原味无霉变的优先。",
    "conditions": "控制量的意义在热量高；霉变/哈喇味的整包丢弃。",
    "risks": "无特殊风险（热量密度高）。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_seasonal_fruit",
    "name": "当季新鲜水果（适量）",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "水果",
      "当季水果",
      "苹果",
      "橙子",
      "葡萄",
      "吃水果"
    ],
    "summary": "每天 200~350 克，当季优先——与每日提醒推送口径一致；水果好但不催多吃。",
    "conditions": "完整吃优于榨汁；血糖异常者按医嘱选低糖果种。",
    "risks": "无特殊风险（过量则游离糖超标）。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_watermelon",
    "name": "西瓜（适量）",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "西瓜",
      "冰西瓜",
      "吃西瓜伤胎"
    ],
    "summary": "澄清条目：\"西瓜伤胎\"无据——真实问题只有糖分与量，一牙两牙解暑完全没问题。",
    "conditions": "控糖期减量；冰镇的不刺激出肠胃不适即可。",
    "risks": "无特殊风险（糖分计入水果总量）。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》（民间说法无文献支持）",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_chili_cooked",
    "name": "辣椒（熟制）",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "辣椒",
      "辣",
      "吃辣",
      "上火",
      "辣椒让宝宝上火"
    ],
    "summary": "澄清条目：\"吃辣让宝宝上火/长湿疹\"无据——孕前能吃辣的孕期照吃，顾虑只在肠胃自己的感受。",
    "conditions": "吃完胃痛腹泻就减量；外食辣菜注意卫生与油盐。",
    "risks": "无特殊风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》（民间说法无文献支持）",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_soy_sauce",
    "name": "酱油（正常调味量）",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "酱油",
      "生抽",
      "老抽",
      "宝宝皮肤黑",
      "吃酱油变黑"
    ],
    "summary": "澄清条目：\"吃酱油让宝宝皮肤变黑\"无据——肤色由遗传决定，正常调味量的酱油尽管用。",
    "conditions": "需要控钠时减的是总盐量（酱油计入其中），不是颜色深浅。",
    "risks": "无特殊风险。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》（民间说法无文献支持）",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "food_hawthorn_small",
    "name": "山楂（少量调味）",
    "category": "food",
    "level": "safe",
    "synonyms": [
      "山楂",
      "糖葫芦",
      "山楂条",
      "山楂致宫缩"
    ],
    "summary": "澄清条目：\"山楂大量致宫缩\"只见于动物实验的极端剂量——零食量、调味量无碍；不吃浓缩制剂即可。",
    "conditions": "山楂片/糖葫芦偶尔吃没问题；山楂干泡水当水喝不建议。",
    "risks": "无确证风险（浓缩大剂量缺乏人体数据，保守回避）。",
    "source": "中国营养学会《中国居民膳食指南（2022）· 孕期妇女膳食指南》（民间说法缺乏人体证据）",
    "sourceUrl": "https://www.nhs.uk/pregnancy/keeping-well/have-a-healthy-diet/",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_swimming",
    "name": "游泳（卫生泳池）",
    "category": "behavior",
    "level": "safe",
    "synonyms": [
      "游泳",
      "泳池",
      "孕期运动",
      "水中运动"
    ],
    "summary": "孕期最推荐的运动之一——浮力卸掉腰膝负担，泳池氯消毒水不伤胎儿。",
    "conditions": "水质合规的泳池；破水、前置胎盘等医嘱禁忌者除外。",
    "risks": "无特殊风险（滑倒注意池边）。",
    "source": "美国妇产科医师学会（ACOG）孕期运动指南",
    "sourceUrl": "https://www.acog.org/womens-health/faqs/exercise-during-pregnancy",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  },
  {
    "id": "behavior_prenatal_yoga_walk",
    "name": "孕妇瑜伽 / 快走",
    "category": "behavior",
    "level": "safe",
    "synonyms": [
      "瑜伽",
      "散步",
      "快走",
      "孕妇操",
      "拉玛泽配合练习"
    ],
    "summary": "中等强度规律运动全程有益——控制体重、改善睡眠、为产程攒体力；以\"运动中能正常说话\"为强度界。",
    "conditions": "无禁忌症前提下每周 150 分钟中低强度；出现腹痛、出血、规律宫缩立即停并就医。",
    "risks": "无特殊风险（过量或高危妊娠遵医嘱）。",
    "source": "美国妇产科医师学会（ACOG）孕期运动指南",
    "sourceUrl": "https://www.acog.org/womens-health/faqs/exercise-during-pregnancy",
    "reviewedAt": "2026-10-01",
    "version": "2.0"
  }
]
