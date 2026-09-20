# 索引块子协议提案 v20（紧凑身份码图——3 bit/槽；内部模块已编码，公共恢复路径待接入）

> **状态（2026-09-20）**：**预编码门已放行（协调方批准——内部首实现切片）**：纯 V20 模块 `cloud/functions/mc-restore/v20.js`（`6ee5961a`——P0 复审六修后：canonical 环/自有属性检查、file-core 碎片 Ref{len,sha256,frags} 重建元数据、refs/rmappart 精确候选量测（封套/base64 增长实测）、verifiedBlockRead 协议形状（无 blockIndex 字段——受信 i+`_id` 校验+entryCount）；焦点自检 **55/55**（`02b1959e`——含 §11 Stage1 canonicalJsonBytes 非平凡电池 24 值逐字节交叉核对全等））已落——**未接入 index.js、不经公共 action 分派**（生产 `0d73129e` 零改动，主回归 285/285 维持）。后续：协调方审查本切片 → handler 集成切片（公共路径仍禁用）→ 实现验收门（D9）。QR19-v3 定版数字采信；QR22/QR23 在案。生产快照 `0d73129e` 冻结（P16 三修已交 TESTING）。**正文所引各轮源哈希为当时快照——历史参考；最新稳定源：index.js=75ecf9c9 / v20.js=0b300000**。
>
> **V19 判死依据**：独立 P18v2（`/tmp/zcode-b3a-test-scratch/p18v2-v19-fullstream.cjs`，脚本 `fb400798`，真 `validatePackage` 完整包）实测——PR2 全异常包（`file.originalFileId=''`、mapping 与正文 `fileId` 均缺席——138,837 槽全部非等价且验包通过）`S=12.978MiB ＞ 12MiB 硬顶`（refs 侧车 4,644KiB + rmappart 8,644KiB；blocks 1,356 在界）。逐项 `"mos":"undefined"` JSON 开销 ≈2,532KiB 是破顶主因。探针 9 过/1 容量红为预期反证，非测试故障。**V20 按审查指示改紧凑位图**：每槽等价/五种短 String 例外编为 3 bit，严格长度与保留码校验；保持精确 String 比较与 Merkle 覆盖。
>
> **兼容范围用语（承审查裁定 2026-09-20 收紧）**：阶段一 `validatePackage` 是**结构/摘要验真器**——其通过是**必要条件而非充分条件**。恢复侧另有**有意更严**的身份/隐私/作用域/资源门（例：Stage1 `validateManifest` 只要求 `visibility∈{shared,private}`、允许 mood 标 shared，恢复侧必须拒；家庭归属、本人私人 scope、写入状态与聚合计数门同理）。**P16 类兼容修复仅限无害格式差异**（冗余 `f.domain`、`Number()/Boolean()` 等价比较、`String` 恒比）——不授权为追求"全部 Stage1-valid 包可恢复"而弱化任何上述门。**兼容目标是真实导出器生成的安全包不被误拒**（P15/real-export 证据链），不宣称任意合成的 Stage1-valid 包一定可恢复。本稿容量数字中**未经独立探针定版者均为投影，不作为验收证据**；已定版工件的数字（如 QR19-v3）按其标注采信。

## 0. 核心定理（六态完备性——仅依赖 L234）

**记号**：`m` = 某映射条目 `reports[r].attachments[i]`，`f` = `files[m.fileIndex]`，`S(x)=String(x)`。L234 检查 `S(m.originalFileId || '') !== S(f.originalFileId || '')` 即拒——**注意 `||` 在 `String()` 之前**（任何 falsy 值先变 `''`，再取 String；`[]` 等 truthy 值原样通过 `||`）。

**定理**：在通过 L234 的任何清单中，对每个槽：`S(m) ≠ S(f)` ⟹ `S(m) ∈ {"", "undefined", "null", "0", "false"}`（五值全 ≤9 字符）。

**证明**（分类**只按 `m` 的原始 truthiness**；`S()` 结果仅作推导输出——方向纪律见证明后）：

**A. `m` truthy**（`m||''=m`，故 L234 即 `S(f||'')=S(m)`）：
- **A1 `S(m)≠""`**：`S(f||'')≠""` ⇒ `f||''` 的 String 非空 ⇒ `f||''≠''` ⇒ `f` truthy ⇒ `f||''=f` ⇒ `S(f)=S(m)` ⇒ **等价**（A1 内不存在发散）。
- **A2 `S(m)=""`**（源为 `[]`/`[null]`/`[""]` 等 truthy-空串数组——V19r 类型 B）：`S(f||'')=""` ⇒ `f||''=''`（`f` falsy）或 `f||''=f` 且 `S(f)=""`（`f` 为 `[]` 族）。
  - `S(f)=""`（`f` 为 `[]` 族或 `f=''`）⇒ `S(f)=S(m)` ⇒ **等价**。
  - 其余 falsy `f` ⇒ **发散**，例外值 `S(m)=""` ∈ 五值集。（此处 `S(f)∈{"undefined","null","0","false"}` 是对 falsy `f` 的**单向**事实列举，非分类判据。）

**B. `m` falsy**（`m||''=''`，故 L234 要求 `S(f||'')=""`）：
- ⇒ `f||''=''`（`f` falsy）或 `f` 为 `[]` 族（同 A2 二分）。
- `S(f)=S(m)` ⇒ **等价**（含 `m=''`/`f=''`、`m=''`/`f=[]` 等 String 相等形）。
- `S(f)≠S(m)` ⇒ **发散**；由 `m` falsy **单向**得 `S(m)∈{"undefined","null","0","false",""}`（`undefined/null/0/false/''` 的 String 恰为五值集）= 五值集。

A/B 穷尽（`m` 非 truthy 即 falsy），每处发散的 `S(m)` 均落入五值集。∎

**方向纪律（无假蕴含）**：
- 全文只使用单向蕴含 **`m` falsy ⟹ `S(m)∈五值集`**。**反向为假**：truthy 字面量 `"undefined"` 的 `S()` 亦为 `"undefined"`——它按原始 truthiness 落入 **A1**（`S(m)≠""`）而强制 `f` truthy 同串 ⇒ **恒等价，绝不成为例外源**。
- `S(m)≠""` **不**蕴含 `m` truthy（`m=undefined` 为 falsy 而 String 非空——按原始 truthiness 落入 **B**）。
- 分类判据自始至终是 `m` 的原始 truthiness；`S()` 值从不用于判定 case 归属。

**truthy-空串数组的定向注意**：`S(m)=""` 的源既可为 falsy `''` 也可为 truthy `[]` 族——码图按 `S()` **结果**编码（非 truthiness），两源形同码（承 V19r 二义裁定：协议只比 String 值，不还原原始类型）。

**关键推论**：完备性**仅依赖 L234（纯 manifest 内部数据）**，不需要正文（L435 在上传期才可比）。因此码图可在 declare 派生期（manifest 单次 4MiB 重组窗口内）封闭生成；L435 的正文侧约束由上传期验证承担（§4）。

**前置条件 P-1**：服务端 `validateManifestSchema` 须实现 L234 等价门（`S(f.originalFileId||'') !== S(a.originalFileId||'')` 拒）。若该门缺失，定理前提在服务端不成立。**QR0 探针先行核实该门在场**（在场性+正反例），缺失则本稿退回补生产门后再审。

## 1. rmappart 条目（V20 形状）

```
{type:'rmappart', recIndex, part, startSlot, items:[{slot,order,fileIndex}...], codes}
```

- `items`：**均匀三元组**——不再携带任何 per-item 身份字段（V19 的 `mos?` 删除）。
- `codes`：本 part 的**身份码图**（§2），覆盖 `items` 的全部槽——**恒在场**（全等价 part 亦须携带全 0 码图——不做缺席捷径，避免双形状验证面）。
- `startSlot` = 累计实际前长（P18v2 修正语义）；`slot` 在 part 内连续；part=0..count-1 顺序读取，无目录。
- ≤56 项/part 与 ≤2KiB 条目上限不变（码图 ~0.5B/槽 有效开销，不影响装载率量级）。

## 2. 身份码图编码规范（确定性单一规范形）

**码表**（6 态——1 默认等价 + 5 短 String 例外；3 bit 编码空间 0-7）：

| code | 语义 | 重建的 `S(mapping.originalFileId)` |
|---|---|---|
| 0 | **等价**（默认） | `S(file.originalFileId)`（file 声明——>2KiB 走 filefrag 重组+`JSON.parse` 还原原始 JS 值——§3 readFidRaw） |
| 1 | 例外 `""` | `""` |
| 2 | 例外 `"undefined"` | `"undefined"` |
| 3 | 例外 `"null"` | `"null"` |
| 4 | 例外 `"0"` | `"0"` |
| 5 | 例外 `"false"` | `"false"` |
| 6,7 | **保留** | ——任何出现一律拒绝（读侧/派生侧/存储侧同拒） |

**打包**（每 part 独立）：
- 设本 part `count = items.length`，槽 j=0..count-1（part 内 0 基）。
- 码图原始字节长 **恒等于 `⌈3·count/8⌉`**（严格长度——读侧校验不等即拒）。
- 槽 j 的 3-bit 码占据全局 bit 位 `[3j, 3j+3)`，每字节内**小端**（bit 0 = 字节 0 的 LSB）。
- 尾部填充位（`3·count` 至字节边界之间的 bit）**恒为 0**——读侧校验非 0 即拒。
- 存储形态：`codes` = 上述字节的**规范 base64**（标准字母表、含 `=` 填充、非规范尾部位拒——重编码全等校验）。

**算例**（探针实现者对照）：count=4，码 `[0,2,0,5]`：
- bit 0-2=`000`、3-5=`010`、6-8=`000`、9-11=`101`；
- byte0 = `slot1<<3 | slot0 | (slot2 低 2 位)<<6` = `0b00_010_000` = `0x10`；
- byte1 = `(slot2 高 1 位)<<0 | slot3<<1` = `0b0_101_0` = `0x0A`；
- 长度 `⌈12/8⌉=2`，base64 `"EAo="`。

## 3. 身份验证（精确 L435 等价——单次通过）

```
// uploadRecord（内联）/ finalizeRecord（分片重组）同一次调用内——body 恰在内存：
fileCache: Map<fileIndex, fidRaw>   // fidRaw = f.originalFileId 原始重建值（含 null/undefined 缺席语义）
for j = 0..count-1:
  item = part.items[j]
  code = readCode(part.codes, j)                    // §2 解码——含严格校验（§5 读侧清单）
  Number(body.attachments[j].order) === Number(item.order)

  if (code === 0):
    if (!fileCache.has(item.fileIndex)):            // **has() 判命中**——不用 get()??read()：
      fileCache.set(item.fileIndex, readFidRaw(item.fileIndex))
    MString = String(fileCache.get(item.fileIndex)) // 原始值 String——精确 raw String 语义
  else:
    MString = CODE_TABLE[code]                      // {"","undefined","null","0","false"}

  String(body.attachments[j].fileId) === MString    // ← 与 L435 精确等价（等价性证明见下）
```

**`readFidRaw(fi)`**：读 file 声明并重建 `originalFileId` **原始 JS 值**——缺席→`undefined`、`null`→`null`、`>2KiB`→按下述 **碎片-解析一致协议**、其余→原值。缓存保留原始缺席/null/类型语义（**不得**缓存为字符串或归一值）——`String()` 据此产出精确的 `"undefined"`/`"null"` 及正确的 JS toString。

**碎片-解析一致协议（长非字符串身份——审查反例 2026-09-20：容器对 `originalFileId` 无字符串类型门，合法长 JSON 数组/对象可存于 file 与 mapping）**：
- **碎片载荷（单一规范形）**：`orig` filefrag 各片承载 **`canonicalJsonBytes(f.originalFileId 原始值)` 的确定性字节切片**（≤1.4KiB/片、seq 连续）——分片对象是**原始值的规范 JSON 序列化**，不是 `String(值)`、也不是其他编码（存储与验证共用同一字节源——一致性 by construction）。
- **重组**：按 seq 拼接 → 严格 UTF-8 解码 → `JSON.parse` → **原始 JS 值**（数组 join/`[object Object]`/单元素无分隔符的 String 语义保持）。
- **往返 String 等价论证**：对一切 JSON 可表示值 `v`（canonical 拒绝非 JSON 形状：undefined/孤立代理/稀疏/非有限数），`JSON.parse(canonicalJsonBytes(v)) ≅ v`（结构等价）；唯一值级变化 `-0`→`0` 的 `String()` 恒同（`"0"`）——故 `String(重组值) === String(原始值)`，code 0 等价语义保持。
- **禁止**：缓存/比对 JSON 文本字符串本身（其 `String()` ≠ 原始值的 `String()`——路径 A 假拒合法包，QR13 已证）。

**命中判据必须 `has()`（审查指认 2026-09-20）**：合法 `f.originalFileId` 可为 `null`/缺席（P10/P17④ 已证 Stage1-valid）。`fileCache.get(fi) ?? read(fi)` 的 nullish 合并把"已缓存 null/undefined"误判为"未缓存"→**每槽重读同一 file 声明**——P13 形状（138,837 槽全指同一 fileIndex）会放大为 138,837 次 keyed read。`has(fi)` 区分两种状态——**每 distinct fileIndex 恰 1 次读取，与缓存值真值性无关**。

**等价性证明**：对通过 P-1 门（L234 等价）的清单，§0 定理保证每槽真值 `S(m.oid) = (code===0 ? S(f.oid) : CODE_TABLE[code]) = MString`（派生期 fail-stop 排除第六态外输入，§4）。故 `S(body.fileId)===MString` ⟺ `S(body.fileId)===S(m.originalFileId)`——即 container.js L435 `String(bAtt.fileId) !== String(mAtt.originalFileId)` 的逐位复现。**不得**以 file 侧 `||''` 比较替代（V16 教训——会漏"映射缺席、文件空串"类合法形状）。

**读取预算（修正——审查指认）**：码图与 items 同文档——part 读取 = part 数（顺序）；file 声明读取 = **distinct fileIndex 数**（`has()` 命中判据）。**P18v2 的 `reads(fileCache)=1` 是探针理想化假设**（未建模验证器取数路径，不可引用为实测）——真实 keyed read 次数须由 QR12 独立实测。code≠0 的槽不读 file 声明（例外值在码表内）——file 读数只由等价槽的 distinct fileIndex 数决定。

## 4. 派生期校验（fail-stop，零写）

declare 派生（manifest 单次 4MiB 重组窗口）对每槽：
```
sm = String(m.originalFileId); sf = String(f.originalFileId)
code = (sm === sf) ? 0 : (sm ∈ CODE_TABLE ? 码表索引 : FAIL-STOP)
```
- FAIL-STOP：`sm` 落在六态之外 ⇒ **package-rejected，零写**（§0 定理下合法清单不可达——纯纵深防御：防派生器缺陷/对抗输入被静默误编码）。
- 派生输出为**单一规范形**（§2 的打包规范是全序确定的——相同输入恒产相同 `codes` 字节；探针与未来实现须逐字节同一派生算法，V6 教训）。

## 5. 读侧校验清单（验证期，任何一条不过即拒——错误零写）

1. `codes` 为字符串且规范 base64（重编码全等）。
2. 解码字节数 **恰为 `⌈3·count/8⌉`**（count=items.length；严格长度）。
3. 尾部填充位全 0。
4. 全部 3-bit 码 ∈ {0..5}（**保留码 6/7 一律拒**）。
5. startSlot 连续（=累计实际前长）、slot 连续、末 part 收口 Σ=attachmentsCount。
6. Merkle/根一致性（§6——含码图的叶摘要复核）。

## 6. 整索引 Merkle 根状态机（根封闭不变量+故障恢复）

rmappart 条目的**规范序列化字节（含 `items` 与 `codes`）**与其他全部条目同入叶流：叶 = `SHA256("mcpkg-blk:"‖u32be(totalBlocks)‖u32be(blockIndex)‖canonicalBytes)`——位置绑定（承 V4 裁定）。**篡改 `codes` 而 items 不变 ⇒ canonicalBytes 变 ⇒ root 不匹配 ⇒ 拒**（QR7/QR13）。

### 6.1 规范条目流（全量入根——确定性总序）

从冻结 manifest 单遍派生**唯一规范条目流**（同 manifest 恒产同流——客户端/服务端须逐字节同一派生算法，探针与实现共用）：**五个流组产出七类条目**（record+idfrag/file/filefrag+cshafrag/refs/rmappart——按 type 计 7）依次拼接——

1. **record**：按 `DOMAIN_ORDER=[pregnancy,daily,mood,checkup,bag,reports]` 域序，域内按声明 index 0..n-1。**record core canonical >2KiB（巨 ID——P7 形合法：2,780B id 真验包在案）→ 确定性拆分**：core（含 id 短承诺）≤2KiB + **idfrag 碎片**（id 原始值规范 JSON 字节切片 ≤1.4KiB/片、seq 升序）紧随其 record core——同 filefrag 法（无此拆分则 ≤2KiB fail-stop 会误拒合法包）。
2. **file**（附件 core）：按 fileIndex 升序（可选字段按 V14 在场规则投影）。
3. **filefrag**：每文件超长字段碎片，确定性分片顺序 **cshafrag→orig→path**、seq 升序，紧随其 file core。**`orig` 片载荷=`originalFileId` 原始值的规范 JSON 字节切片（≤1.4KiB/片）——存储与验证同一字节源（§3 碎片-解析一致协议）**。**触发规则（合并两轨，协调方反例裁定 2026-09-20——E1）**：单遍确定性序 csha→orig→path，字段碎片化当且仅当 **①字段 canonical >1KiB（eager）∨ ②此刻 core canonical >2KiB（强制——多字段各 <1KiB 合并超限：~950B path+~950B oid+基底可 >2,048 而 per-field 阈值漏拆误拒 Stage1-valid 包）**；只拆到 core ≤2KiB 为止（最小确定性拆分）；碎片化字段从 core 移除（碎片为唯一副本）并留 **`<field>Ref={len,sha256,frags}` 重建元数据**。
4. **refs**：按 fileIndex 升序，每文件 part 0..count-1。**items=`{order, recIndex}`（D24-r——有界）**：不复制 rid（合法 reportId 可 >2KiB——同 record idfrag 存在的理由；携 rid 全文的单项会超 ENTRY_MAX 误拒安全合法导出形——TESTING 红先行 `ff8ef5a3` 坐实）。**recIndex=records.reports 中 `id===reportId` 的数组位置（按 id 显式匹配——D24-r：Stage1 validateManifest 以 reportId 配对非数组位置，reports 可与 records.reports 不同序（Stage1-valid）——不得假设相等）**。**rid 解析经锚定 record 条目**：recIndex → domain `'reports'` 的 record 条目（index=recIndex——其 `id` 或 `idRef`+idfrag 均在已验证块载荷内——零根外数据，§6.5 链接链同径；派生期无 id 匹配则 fail-stop）。**容量模型变更**：refs item 从无界（rid 全文）→ 有界 ~30B——旧 QR19 数字基于携 rid 形，新形须重测（方向有利：item 缩小）。**换序夹具**（双报告 reports≠records.reports 序+巨 rid idfrag 解析）为强制验收形。
5. **rmappart**（含 §2 码图）：按 **recIndex 升序**（D24-r 同锚定——按 id 匹配的 records.reports 位置，非 reports 数组位置），每报告 part 0..count-1。**性能合同（协调方指认 O(N²)）**：派生须单遍 O(N)——reportId→report 条目 Map（重复 reportId fail-stop 唯一性校验）+records 序迭代 O(1) 查找；禁止 per-record 线性 find（万报告≈亿次比较）。**命名恒 recIndex**（指针键/条目字段/协议全稿一致——不用 reportIndex）。

流内位置是 manifest 的确定性函数——无根外条目（不变量 I5）。

### 6.2 块打包（确定性单一规范形）

- 贪心装填：块净荷 ≤10KiB（BLOCK_NET）**且** ≤48 条（ENTRIES_PER_BLOCK）——任一将越即切；块序 0..totalBlocks-1 按流序。
- 单条目恒 ≤2KiB（ENTRY_MAX）——派生期断言，超限 fail-stop；**例外：record core 与 file core 超 2KiB 时走确定性拆分（idfrag/filefrag——§6.1 组 1/3），拆分后 core 与碎片均 ≤2KiB**。
- 相同流恒产相同块划分（装填规则全序确定——不变量 I6）。

### 6.3 树构造（位置绑定父节点+奇叶复制规则+零块根）

**父节点索引约定（唯一规范——审查指认"层内序"歧义后钉死）**：
`parent(L,j)=SHA256("mcpkg-par:"‖u32be(totalBlocks)‖u32be(L)‖u32be(j)‖left‖right)`，其中
- **`L`=输入子节点所在层号，`L=0` 即叶层**（叶=`mcpkg-blk` 叶哈希）；
- **`j`=父节点在其输出层（第 `L+1` 层）内的索引**（父输出索引 `0,1,2,…`）——**不是**左子输入索引（`0,2,4,…`——两种约定产生不同哈希，禁止混用）；
- 该父的输入为第 `L` 层的节点 `2j`（左）与 `2j+1`（右）。

**奇数叶规则（唯一确定）**：第 `L` 层节点数 `n` 为奇数时，末父 `j=⌊n/2⌋` 的两输入均为第 `L` 层末节点（`parent=H(prefix‖u32be(L)‖u32be(j)‖h‖h)`）。
**零块包**（无 records/files/refs/rmappart）：`root=SHA256("mcpkg-empty")`。
root=顶层唯一节点；`{planRoot, totalBlocks, totalEntries}` 构成常数大小计划承诺（批次文档只存此三项——不存逐块目录）。

**三叶规范向量（探针与生产必须逐字节复现——QR7 锚）**：`T=3`。**块字节向量=任意原始字节（hex 声明）——非 V20 规范块 JSON**（协调方 2026-09-20 指认记号歧义后钉死：本向量仅锚定哈希构造公式——叶/父前缀、索引约定、奇叶自配；不得把记号重释为 JSON 文本）：
`block0 = 41`、`block1 = 42 42`、`block2 = 43 43 43`（各 1/2/3 字节）。

```
leaf0 = SHA256("mcpkg-blk:"‖u32be(3)‖u32be(0)‖0x41)         = 0c701231f815045650cfd37823eda09d55a840ce796fd97d4747f1d891bfeca7
leaf1 = SHA256("mcpkg-blk:"‖u32be(3)‖u32be(1)‖0x4242)       = 35158d772a7c6d6f67790dbc6a83dd143c21ca48eee1cfa94fbceb6b06ea86df
leaf2 = SHA256("mcpkg-blk:"‖u32be(3)‖u32be(2)‖0x434343)     = 0d4de85a897681cc2332efa85851f23c71c514dd4dad1747de34e10a483348f0
p0 = parent(0,0, leaf0, leaf1)        = c0ac3028748d6321db59600b71c47a6d55a4c73669eae2c330d95abb727e380b
p1 = parent(0,1, leaf2, leaf2)        = a9d43a77a75b63df7c6649bed1c7497a8fce7d6c907a2b64e123dde3e74771fc   ← 奇叶自配（j=1=父输出索引）
root = parent(1,0, p0, p1)            = 91298894cd60d7dae5aca1b1b257eb2c1bdd7f8431155435c6ff086b1712a42b
```

（哈希已按 hex 声明字节重算确认不变——原始计算即用裸字节。）**JSON 引号重释形**（叶输入 `0x22 41 22` 即 `"A"` 含引号）产出 leaf0=8302c4be… ≠ 声明形——**实现用重释形必须红**。

**sibling 路径示例**：leaf2（奇末叶）：层 0 自配（`parent(0,1,leaf2,leaf2)`——无外部 sibling）→ 层 1 右侧（兄弟 `p0`，`parent(1,0,p0,·)`）。leaf0：层 0 左侧（兄弟 `leaf1`）→ 层 1 左侧（兄弟 `p1`）。两侧位由 `(totalBlocks, blockIndex, 层尺寸序列)` 唯一推导（§6.4 侧位自推导同源）。
**逐字节一致要求**：独立探针与未来生产实现对上述向量产出的 `p0/p1/root` 必须**逐字节全等**——左子索引约定（`j=0,2,4`）或 **JSON 重释形**的实现将产生不同根，视为不符合本协议。

### 6.4 状态机（批次状态转移+事务边界）

```
declaring ──末片：重组≤128 chunk→既有严格验证→派生流→打包→全叶 SHA+root→硬顶 fail-stop
              （S≤12MiB ∧ totalBlocks≤2048 ∧ 单条≤2KiB）
           ──单事务──▶ preparing {planRoot,totalBlocks,totalEntries,prepCursor:0,frozenDomainBytes}
preparing ──finalizeDeclare 逐块写（末块同事务置态）──▶ indexing（根封闭原子暴露）
indexing  ──indexDeclarePage 单块消费→写声明→consumedCursor 推进；末块核对总数──▶ declared
零块包：declaring ──单事务直 declared（planRoot=empty-root）
**零块与单块行为（D29 显式）**：
- **零块包**（totalEntries=0——空域清单完整判定后）：declaring **单事务直 declared**（planRoot=SHA256("mcpkg-empty")）——**不经 preparing/finalizeDeclare**；`finalizeDeclare` 对零块包=invalid-state 拒；任何 `blockB64` 解码为 0 字节的请求恒拒（不存在空块）。
- **单块包**（totalBlocks=1）：唯一块 blockIndex=0；proof=**空串**（⌈log2(1)⌉=0 sibling）；写入同事务置 indexing；重放=blockB64 解码字节与持久 canonical 逐字节比较。`blockB64` 解码须 1..10,240B（空串解码体拒）。
abandon 任一态抢占 → abandoning → abandoned；迟到写入零写拒
```

**preparing 冻结事务——精确有界 staging 算法（审查指认：叶哈希含 totalBlocks，追加期不可定值——须先定形再哈希）**：

```
事务外（declare 末片窗口——单次调用内完成）：
  P1 重组与验证（既有）：≤128 chunk → 4MiB 字节 → digest → strict decode → schema → canonical 全等
  P2 staging（单遍派生——清单恰此一次扫描）：
     遍历 manifest 按 §6.1 总序派生条目 → 贪心装填当前块（≤10KiB ∧ ≤48 条，满即切）
     → 已切块 canonical 字节【暂存内存】（stagedBytes/stagedCount 计数）
     → 增量 fail-stop（**逻辑口径**）：stagedBytes >12MiB ∨ 条目数 >98,304（2048×48）∨ 块数将 >2048
       → 立即中止
  P3 收尾（totalBlocks 此时定值）：
     逐块计算叶 SHA256("mcpkg-blk:"‖u32be(totalBlocks)‖u32be(i)‖staged[i])——totalBlocks 已知
     → 建树（§6.3 奇叶复制）→ root → 逐块 proof 提取（sibling 集）
单事务（CAS 重读 status=declaring）：
  复核 manifestChunkTotal、紧邻前序 chunk 与当前末片尚未写入（其余前序不可变分片已在事务外完成摘要验真）
  同事务写入当前末片 chunk 和批次 {status:'preparing', planRoot,totalBlocks,totalEntries,prepCursor:0,frozenDomainBytes}
```

**末片提交原子性（2026-09-20 代码审查裁定）**：上述 P1–P3 使用本次请求的末片字节和已持久、不可变的先前分片，均在写最后一片之前完成。单一 CAS 事务同时提交最后一片和 `preparing` 承诺；事务失败时两者均不出现，同片重试可重新派生并提交。旧实现“先存最后一片、再另起事务冻结”曾在冻结失败后留下末片，重试因同 SHA 早退而永久卡在 `declaring`，不得照搬到 V20。独立故障测试先复现旧中间态，修复后验收原子回滚与正确重试；详见[代码审查](PHASE_B3B_STAGE2_CODE_REVIEW_2026-09-20.md)。

**异常持久状态补充审查门（2026-09-20）**：V20 末片单事务设计下，`declaring` 时不应存在同批次末片文档；若读取到该异常状态，不能只凭文档的 `chunkSha256` 字段等于请求值便跳过写入并冻结。必须核对已存 `rawB64` 的严格解码字节、`byteLength` 和按该字节重算的摘要与本次请求全等，或保守拒绝并留下可诊断状态。仅比较可被篡改的摘要字段不能证明已存末片就是冻结所依据的字节。

- **内存：不设声称上限（审查指认——撤回旧 ≤~17MiB 声明，且已被实测否定）**：旧数只加了 manifest 裸字节+staged 缓冲，**未计** 解析后 JSON 对象图、条目对象数组、树/proof 集、临时 canonical 序列化副本。**经验证据（2026-09-20，协调方独立复跑）**：QR1/QR2/QR3/QR11 多场景 harness（冻结源 `0d73129e`，32/32 过）整进程峰值 RSS **723,861,504B（≈690MiB）**——该数为**多场景夹具 harness 值：不可移植为 CloudBase 生产界**（非单场景、含全量夹具构造/双实现对照等 harness 自身开销）；但它**实证否定**"4MiB 裸清单+12MiB staged 缓冲可界住 JS RSS"一类断言。生产内存界须以 **QR21 隔离单 P13 场景实测**（见探针表）并据其设定 **CloudBase memorySize 与超时配置**后才可写数；此前任何内存数字均为未验证。CPU：SHA256 over ≤12MiB（一次——亦待实测计时）。
- **崩溃恢复（无每页重扫）**：P1–P3 内崩溃=零写 → 整个末片重试**重跑窗口一次**（有界一次，非每页）；preparing 冻结后，块写/indexDeclarePage/上传验证/清理**全部零 manifest 读**（只读批次字段+块文档+声明文档）——**清单全程恰扫描一次**（不变量 I9）。
- 幂等：已 preparing 且三承诺全等 → 纯比对 ok（零写零推进）；任一不等 → `plan-conflict`。

**finalizeDeclare{blockIndex, blockB64, proof}**——三分支（`proof` 为**单一 base64 字符串**——规范形见 ②）。**wire 形（D29——协调方裁定 2026-09-20）：CloudBase event 为 JSON、handler 按 `JSON.stringify(event)` 度量 64KiB——线上字段恒 `blockB64`=严格规范标准 base64 字符串**（标准字母表+`=` 填充+重编码全等）；服务端解码为内部 `blockBytes` 后按下列各款执法。**旧 `blockBytes` 线上字段=拒**（`invalid-params: 旧 wire 形 blockBytes 禁用——须 blockB64`）。
- `blockIndex===prepCursor`（**写路径**）：①**解码与规范核验（D29）**：`blockB64` 须字符串且规范 base64（重编码全等）→ 解码得 `blockBytes`（Buffer）→ **解码后恰 1..10,240B**（零字节解码体恒拒——零块包不经 finalizeDeclare，见后）→ **严格 UTF-8 解码**（非法序列拒）→ `JSON.parse` 得 entries 数组（**非数组拒**）→ `canonicalJsonBytes(entries)` 与 `blockBytes` **逐字节相等**（非 canonical 序列化形拒）→ 条目 ≤48 ∧ 每条 canonical ≤2KiB → 以 `blockBytes` 重算叶 SHA；②**位置绑定证明验证**——服务端从 `(totalBlocks, blockIndex)` **自行推导**路径每层的 sibling 侧位（不信任客户端方向标；sibling 缺/错/复用他块 → 拒）。**proof 唯一规范形**：`proof` = **一条 base64 字符串**，解码后为 `⌈log2(totalBlocks)⌉` 个 32B sibling 哈希**按父层升序（L=0 起）拼接**的二进制（解码字节长**严格等于** `⌈log2(totalBlocks)⌉×32`——T=1 时为空串）；base64 须规范（标准字母表+`=` 填充+重编码全等）。**数组分串形（11×44 字符+JSON 分隔符 ≈518 字符）显式禁用**——比单串（472 字符）更大且非规范。dup 层（奇数末位）的 sibling 位置上**必须等于当前折叠哈希**（严格比对——否则拒）；③blockIndex>0 须块文档 `blockIndex-1` 已在（顺序写不变量）；④单事务：CAS 重读（status=preparing ∧ prepCursor=blockIndex）→ 写块文档 `{_id:`${batchId}:blk:${i}`, sha256, byteLength, entryCount, entries, proof}`——**`entries = JSON.parse(strictUtf8Decode(blockBytes))`（恰从已核验字节解析——写期绑定 canonical 形）** → prepCursor←i+1 → **i===totalBlocks-1 时同一事务置 indexing**（根封闭原子暴露——不存在"全块已写未封闭"或"已封闭有块缺"的可观察中间态）。

**块载荷表示与命名（D21 修订——统一三名师各司职）**：**请求参数（wire）=`blockB64`（严格规范标准 base64 字符串——D29；服务端解码为内部 `blockBytes`）**；**staging 内存暂存=staged canonical 字节**（§6.4 P2/P3）；**持久字段=`entries`（解析后条目数组，native JSON）**——全稿不再以 `payload` 作字段名（撤回"零膨胀"声明：canonical JSON 存为文档内字符串字段会被再次序列化——实测 1,711B 转义 +282B ≈ +16.5%，10KiB 形必破 11KiB）。

- **写期绑定（finalizeDeclare——服务端持有请求字节的时刻做全部字节级核验）**：①请求 `blockB64` 解码为 `blockBytes` 后须过 **canonical 往返核验**（`JSON.parse` → `canonicalJsonBytes` → 与 `blockBytes` 逐字节相等——非 canonical 序列化形拒）；②持久 `entries = JSON.parse(strictUtf8Decode(blockBytes))`——**存储数组恰从已核验字节解析**（写期即绑定 canonical 形）；③`byteLength=blockBytes.length`、`entryCount` 同事务写入；④叶=SHA256(前缀‖blockBytes)——proof 位置绑定验证（§6.4-②）后随 entries 持久化。
**客户端确定性重建（D29——跨重启无服务端内存依赖，待实现）**：staged 块与 proof 必须从**同一份原始完整包字节**确定性重产；不得以重新导出替代，因重新导出可能改变 manifest、包摘要和索引根：
1. 客户端重读并解析已保存的原包，或要求重新选包且先核对冻结的 `packageDigest/manifestDigest` → 按与服务端逐字节同一的派生算法（§6.1 流+§6.2 打包+§6.4 P2 staging——纯函数、无状态）重产 staged 块序列与 stagedBytes；
2. 崩溃/重启后：客户端读批次 `{prepCursor, totalBlocks}` → **从 blockIndex=prepCursor 起续发** `finalizeDeclare{blockIndex, blockB64, proof}`——blockB64=该块 canonical 字节的规范 base64、proof=客户端本地按 §6.3 树构造提取的 sibling 单串 base64（确定性——与任何先前服务端状态无关）；
3. 服务端零"调用内存"依赖：每请求自带全部字节与证明；客户端重建依赖 (a) 同一原始包字节 (b) 冻结协议算法。客户端须保存原包与批次/摘要绑定及游标，或在重选包后验证摘要，不能假设微信文件选择器的临时路径跨重启有效。
**客户端路径现状**：纯模块（v20.js）提供服务端 Node 环境的派生/打包/建树/proof 原语，**尚非已验证的微信小程序客户端实现**。当前 `pages/profile/data-restore.vue` 只读取 `wx.chooseMessageFile` 的临时路径做本地验包；客户端保存或重选原包、确定性派生、续发循环、重试策略均为未来实现门，代码未实现、未验收。
- **读期根锚定（readVerifiedBlock——审查指认后修正：prepare 冻结/崩溃恢复后服务端不再持有派生期 canonical 原件，"与派生原件比对"不可实现且重扫 manifest 违 I9）**：读出 `entries` → `payloadBytes = canonicalJsonBytes(entries)`（canonical 是值的确定函数——parse 往返无损，实测全等 ✓）→ 核对 `payloadBytes.length === blk.byteLength` → 重算叶 → 折叠 proof 至 **planRoot**。**根是唯一持久的真实性承诺**——entries 的本真性由根锚定保证（planRoot 冻结自服务端自身派生），非由任何服务端留存副本保证；形状漂移/数字格式/键序/unicode 差异 → 重算叶变 → 根折叠失败 → 拒。**零 manifest 读（I9 保持）**。
- **量测双门（部署时序裁定 2026-09-20——真 CloudBase 部署统一延后至 B3/C/D 完成后）**：
  - **本地验收门（QR19——编码验收所依赖）**：**确定性保守字节度量**=逐块 `canonicalJsonBytes(完整存储文档)`（含 `_id`、`entries` 数组、`proof`、及**服务端强制写入的全部字段**）≤11KiB（BLOCK_DOC_MAX）——完全离线可复算、确定性（同文档恒同字节）。
  - **部署终门（非本地编码前置——不得据此阻塞本地实现）**：真 CloudBase 驱动物理序列化/计费字节验证，归统一部署期（与真集合/函数上传/双机验证同批）。
  - **不声称等同**：离线 canonicalJsonBytes 度量是**保守代理**——**不等于也不声称等于 DB 实际存储字节**（DB 内部序列化/计费口径可能不同——部署终门核实）。
- **备选候选（数组形若 QR19 本地门仍超界）**：**canonical base64 载荷 + BLOCK_NET↓至 7-7.5KiB**——**采纳条件（缺一不可，须整包实测非投影）**：①真 full 包 QR1/QR2/QR11 重跑 **blocks ≤2,048**（投影参考：P13 ≈1,504、QR11 ≈417——不作为采纳依据）；②逐块**完整文档 canonicalJsonBytes 本地度量 ≤11KiB**（7.5KiB×4/3=10KiB+proof 472+字段——贴顶待实测；DB 字节归部署终门）。字符串形（转义 +16.5%）恒否决。
- `blockIndex<prepCursor`（**重放字节比较**）：重放判定为**字节级**——请求 `blockB64` 解码后与持久块 canonical（`canonicalJsonBytes(已存 entries)`）**逐字节比较**；全等 → 纯比对幂等 ok（零写零推进零状态触碰）；不等 → `block-conflict`（重放不得以值等字节异的序列化形通过）。
- **持久块真实性门（重放及异常半写态）**：上述“已存同字节”是幂等的必要条件，但不足以证明已存文档仍受冻结根约束。任何以已存块为依据返回重放成功、并发败者成功，或修复游标的分支，必须先对该块执行 `verifiedBlockRead` 同等级核验（`_id`、数组/容量、`byteLength`、`entryCount`、位置绑定 `sha256`、`proof→planRoot`）；核验失败则明确拒绝、零写。单事务写块与推进游标后，`块已存而游标未进` 本不应出现；此时优先保守 fail-stop，若提供修复路径，须同时证明批次状态及块的完整根锚定，不得只看 `entries` 字节就推进游标。
- `blockIndex>prepCursor`：拒（超前）。status 已 indexing 的末块重放：同内容纯比对 ok（状态不动）；异内容 conflict。

**indexDeclarePage{blockIndex}**（消费，blockIndex===consumedCursor）：①读单块文档（≤11KiB 页处理有界）+**与 readVerifiedBlock 同径核验**——`payloadBytes=canonicalJsonBytes(blk.entries)`、`payloadBytes.length===blk.byteLength`、重算叶 `SHA256("mcpkg-blk:"‖…‖payloadBytes)` 核对存储 sha256 **并折叠块内 proof 至 planRoot**（消费期即检存储篡改，不待上传期）；②单事务（≤50 ops）写本块条目的**分层声明**——**record 条目→全量声明文档**（既有键空间/身份门/重放所依赖——字段全量+blockIndex 指针）；**file/refs/rmappart/filefrag/cshafrag/idfrag 条目→薄指针文档**（**全部六类非记录条目——清单与 §6.5-bis/链接链一致**；**恰好三字段 `{_id, type, blockIndex}`——形状钉死（增益字段须重推导结构界）**；字节上限=候选 128B 待 QR22 逐类型精确字节证明（§6.5-bis），**不复制条目内容**——内容唯一副本=已验证块条目——§6.5 链接链）+consumedCursor←i+1；③末块核对 totalDeclarations===totalEntries → 置 declared（不等 fail-stop invalid-state）；④重放：`<consumedCursor` 同块纯比对幂等、`>` 拒。

### 6.5 已验证读路径（上传验证检测存储篡改——审查指认：根字符串相等证不了单文档未变）

批次根相等**不能**证明个别 rmappart/refs/file 文档未被篡改。上传期身份验证（§3）的一切存储读取必须走**逐块成员证明**：

```
readVerifiedBlock(i)：                                   // 唯一可信读原语
  blk = read(`${batchId}:blk:${i}`)                       // {entries, proof, byteLength, sha256, _id, …}
  校验 blk._id === `${batchId}:blk:${i}`（受信 i+ID 一致——协议块文档无 blockIndex 字段）
  payloadBytes = canonicalJsonBytes(blk.entries)           // 条目数组→再规范化（canonical=值的确定函数）
  核对 payloadBytes.length === blk.byteLength（不等即拒）
  核对 entries.length === blk.entryCount（不等即拒）
  leaf = SHA256("mcpkg-blk:"‖u32be(totalBlocks)‖u32be(i)‖payloadBytes)   // totalBlocks 取自批次文档
  // 显式持久字段核对（§6.4-④/模块合同——协调方指认补齐）：
  核对 blk.sha256 为 64hex ∧ blk.sha256 === hex(leaf)（重算位置绑定叶≠持久 sha256 → 拒——sha256-only 篡改面）
  // 注：不与"派生期原件"比对——prepare 冻结后服务端不留存（重扫 manifest 违 I9）；
  // entries 本真性由根锚定：折叠 proof === batch.planRoot（唯一持久真实性承诺）
  折叠 blk.proof（§6.4-② 规范形：单一 base64 串解码为 ⌈log2(totalBlocks)⌉×32B——按父层升序 L=0 起取 sibling；
  侧位由服务端从 (totalBlocks,i) 自推导；dup 层 sibling 须严格等于当前折叠哈希——不等即拒）
  ⟶ 必须 === batch.planRoot——否则 fail-closed 拒（零写）
```

- **声明文档链接链（审查指认：声明文档如何锚定已验证块——显式规范）**：
  1. **薄指针文档（file/refs/rmappart/filefrag/cshafrag/idfrag——全部六类非记录条目）**：内容=定位键+blockIndex——**不含任何身份内容**（内容唯一副本=块条目）。服务路径：`pointer → readVerifiedBlock(blockIndex)（叶重算+proof 折叠=planRoot）→ 在已验证块载荷（entries 规范化字节）内按 (type,定位键) 定位条目 → 内容从该已验证载荷提取`。**篡改面封闭**：改指针 blockIndex/定位键 → 指向错块/找不到条目/内容核对不符 → 拒（指针无内容可伪造身份）。
  2. **record 全量声明文档**：字段（id/hash/revision/deleted 等）+blockIndex——读取后 `readVerifiedBlock(blockIndex)` → 其字段与已验证块载荷（entries 规范化字节）内对应 record 条目 **canonical 字节逐字节相等**核对 → 不等即拒（字段被篡改）。
  3. **每读取均重验根**：块文档的 proof 随 payload/SHA **联合持久化**（§6.4-④）；消费读（indexDeclarePage-①）与验证读（readVerifiedBlock）**每次都折叠 proof 至 planRoot**——不是一次性信任（先验证后存储的"verified-once"模式被明确否决——存储层篡改在每次读取时检出）。
- **fileCache 同径**：file 声明（含 blockIndex 指针）→ readVerifiedBlock → 从已验证块载荷（entries 规范化字节）提取 file core 的 `originalFileId` 原始值。读取计数仍=distinct fileIndex（§3/QR12 语义不变——块读由调用内缓存吸收）。
- **联合篡改不破**：payload+proof+声明文档同篡改仍破根折叠（叶子从 payload 重算；折叠锚=批次 planRoot）——SHA-256 抗碰撞性前提。
- **信任锚与威胁模型**：锚=批次文档 planRoot（§6.4 单事务冻结+DB 权限）；威胁模型=**个别文档存储层篡改**（含块 payload/proof/声明内容/blockIndex 指针）——全部可检测。批次文档自身被改写超出本模型（归 DB ACL/审计）。
- **每调用读预算（显式重组例外——与既有 body ≤4MiB 例外同类）**：body ≤4MiB + 目标报告的薄指针数×**128B（POINTER_PHYS_MAX）** + record 声明 + 其 **unique verified block 数**×≤11KiB（调用内块缓存命中后实际读取的 distinct 块）——线性于报告自身映射规模；**P13 形具体字节未测（旧"≈14MiB"为猜测，撤回）——QR18 须实测申报 unique verified block 计数与四项实际字节合计**。

### 6.5-bis 逻辑/物理/清理三口径（显式分立——审查指认）

**① 逻辑上限（协议硬顶——staging fail-stop 所判）**：派生流 `stagedBytes ≤12MiB ∧ 条目 ≤98,304 ∧ 块 ≤2,048`。这是**逻辑流**界——不等于磁盘占用。

**② 物理存储（申报制）**：preparing 存块 payload（=逻辑流一份），indexing 另写 record 全量声明+薄指针——**物理字节是流的复制叠加**（审查指认），分项：

| 文档 | 物理上限 | 构成 |
|---|---|---|
| 块文档 | **≤11KiB（BLOCK_DOC_MAX——QR19 本地门：完整文档 canonicalJsonBytes 确定性保守度量——QR19-v3 定版实测过界 ✓；QR19-v2 未采信为历史注记）** | entries=**解析后条目数组（native JSON——无转义膨胀：entries+proof 472+字段 ≈10.5KiB 算术投影）**；字符串形（转义 +16.5%）与 base64 形（4/3=13.33KiB）均实测否决；超界则 BLOCK_NET↓+重推块数/容量；**DB 实际字节=部署终门（非前置）、离线度量不声称等同** |
| record 全量声明 | **待实测后声明（QR19——量测口径含完整 `_id`（batchId 前缀在内））** | 条目 canonical ≤2KiB（观测最坏 2,035B）+ blockIndex + 文档封套——**旧"2KiB+~8B 指针"非物理上限，撤回**；以实测最大值+余量定 `RECORD_DECL_PHYS_MAX` |
| 薄指针（file/refs/rmappart/filefrag/cshafrag/idfrag） | **候选 ≤128B（POINTER_PHYS_MAX——余量 9B；QR19-v4r 真验包+合成全 ID 键空间实测+QR22 派生级断言后定稿）** | **实测集（协调方对真 validated 包合成全 ID 键空间 `{_id,blockIndex,type}` 精确文档——权威）**：file 91/refs 96/cshafrag 104/rmappart 105/filefrag(path) 109/idfrag 111/**filefrag(oid) 119←最长** → **候选 128B 余 9B**（旧算术 114/106 系统性低 5B——序列化差，以实测为准）；**形状钉死恰三字段 `{_id,type,blockIndex}`**（增益字段须重测）；QR19-v4r 现证=夹具+合成键空间计算——**V20 派生级+指针文档断言由 TESTING 补（QR22）** |
| 批次文档 | 恒常数（不因块数增长） | 计划承诺+双游标 |

**S_phys_all 公式界（修正——协调方指认旧式非有效上界：漏块内数组逗号/括号、`_id`、`sha256`、`byteLength`、`entryCount` 字段名与文档封套；QR19-v3 实测 12.476MiB > 旧投影 12.03 即证）**：

- **有效上界（逐文档强制上限封顶）**：`S_phys_all ≤ totalBlocks×BLOCK_DOC_MAX(11KiB) + recordCount×RECORD_DECL_PHYS_MAX + pointerCount×POINTER_PHYS_MAX(128B 候选) + BATCH_META_MAX(常数)`——结构最坏 `≤2,048×11KiB + 10,000×RECORD_DECL_PHYS_MAX + 98,304×128B + 常数`（按各协议上限；逐文档封顶 by construction 成立）。
- **实测申报（QR19）**：`Σ canonicalJsonBytes(完整文档)`（块+record+指针逐文档实际和——QR19-v3 定版 P13 形实测 **12.476MiB**，采信该工件；旧 `12MiB+2,048×~484B+…` 加法式**作废**）。
- 实测超结构界=封套/形状超预期——须重设计并重测，不得静默改口径。**DB 实际存储字节=部署终门（D22）**。

**③ 清理**：abandon/commit 删除**全部索引侧文档=物理全量 S_phys_all**——分页 ≤50 ops/页（按文档数计页），清运次数与游标续现有协议。

**旧 11.013MiB 实测=单逻辑流**——不含 proof/声明复制/封套，不再单独构成容量结论（QR19 按三口径重测）。

### 6.6 根封闭不变量（commit 比较的效力前提）

| # | 不变量 |
|---|---|
| I1 | planRoot 于 preparing 单事务冻结（status 门控——无双计划） |
| I2 | 每块经位置绑定 Merkle 证明入根（替换/换序/重复/漏块均破根） |
| I3 | 根封闭原子：末块写入与 status=indexing 同事务 |
| I4 | 封闭后无写路径接受块（indexing/declared 写块一律拒——块不可变） |
| I5 | 全量入根：§6.1 **七类条目**（record/idfrag/file/filefrag·cshafrag（组 3 双型）/refs/rmappart——按条目 type 计 7：record、idfrag、file、filefrag、cshafrag、refs、rmappart）无根外条目 |
| I6 | 派生确定性单一规范形（同 manifest 同流同块同根） |
| I7 | 验证写事务内 CAS 重读批次 planRoot 一致（下段 CAS 步） |
| I8 | 已验证读路径：上传验证的一切身份存储读取经逐块成员证明锚定 planRoot（§6.5）——单文档篡改可检测 |
| I9 | 清单恰扫描一次（declare 末片 staging 窗口）；其后块写/页消费/验证/清理零 manifest 读 |

**CAS 事务（finalizeRecord/uploadRecord 验证全过后）**：事务内读批次 → 状态检查+fail-closed → `planRoot` 与验证时所读一致（防 abandon/commit 交错）→ 写 `mc_restore_records {mappingDigest, mappingRootHash: batch.planRoot, mappingVerifiedAt}` → 递增 `contentGeneration` → commit。
**commit 预检**：`mappingVerifiedAt` 存在 ∧ `mappingRootHash === batch.planRoot`（不可变 proof，不重算）。
**⟹ 该比较仅在 I1–I9 全成立时为有效不可变证明**（QR13–QR19 逐项验）。

### 6.7 清理（全量文档枚举——协调方指认补齐）

abandon/commit 清理须**枚举七类条目生成的全部文档**+既有组，无孤儿残留：
- **块文档**：`${batchId}:blk:0..totalBlocks-1`；
- **record 全量声明**（七类之一——最易漏）+ **file/refs/rmappart/filefrag/cshafrag/idfrag 六类薄指针**（定位键空间全量）；
- **既有组**：manifest chunks、per-record anchors、record_chunks（上传期）、mc_restore_records 隔离区记录；
- 分页删除 ≤50 ops/页——续现有游标协议（可恢复续跑）；**清理完成后迟到 finalizeDeclare/indexDeclarePage/upload 写见终态零写拒**；
- **QR 清理测试**（实现验收门）：对含全部七类条目的批次 abandon/commit 后，逐集合键控扫描证明**每类文档恰零残留**（blocks/record 声明/六类指针/chunks/anchors/uploads）——不留孤儿。

## 7. 容量（**未定版数字=投影；已定版工件数字按标注采信——QR19-v3 等**）

> **独立实测注记（2026-09-20，qr-v20-probes `270b3908` 30/30）**：QR1 全等价与 QR2 全异常（138,837 槽）实测**均 S=11.013MiB ≤12MiB、blocks=1,215 ≤2048**——恒在场码图使等价/异常同容量（D13 不变式实证），V19 的 12.978MiB 破顶被修复；QR11 十千报告×1 槽 S=3.098MiB/452 块/清理 +405 页。**该测量=纯逻辑流（不含 proof/封套）——12MiB 硬顶即此口径（§6.5-bis①）**；物理层（逐文档 ≤11KiB 含 proof+封套、S_phys_all 申报）**另判**（QR19）。**容量过关不解封索引**（D9——QR4-QR10+QR12-QR19 与审查仍待）。下表其余行维持投影。

| 场景 | V19 实测 | V20 投影 | 依据 |
|---|---|---|---|
| PR1 全等价（P13 形状 138,837 槽） | S=10.505MiB / 1,106 blocks | ≈10.6MiB / ≈1,1xx blocks | 均匀 items 同 PR1 + 强制码图 ≈0.5B/槽有效 + 每 part ~34B 信封 |
| PR2 全异常（全 code 2） | **S=12.978MiB（破顶）** / 1,356 blocks | **≈10.6MiB ≤12MiB** / ≈1,1xx blocks | 码图总原始 52,064B→base64 ≈68KiB+信封 ≈32KiB+装填微降——对比 mos 的 ≈2,532KiB 省 ≈2.4MiB |
| 码值混合（固定槽数/partition/文件形状） | —— | **S 与码值分布无关**：`codes` 长=⌈3·count/8⌉ 恒定（3 bit 定宽——base64 长度只依赖 count），S/parts/blocks 只由槽数、partition 与文件形状决定——全等价、全异常、任意混合**同 S** | 结构性论证；QR3 以同形异码值包实测恒等 |
| 多报告尾部 | —— | **可超两个单报告端点**：每报告独立尾 part 信封**累加**（10,000 报告×1 槽=10,000 parts+各自信封），不可由单报告端点内插 | QR11（P14b 形）单独实测 |

- 清理：物理文档数与均匀形状同量级（~3.1k rmappart + ~2.9k refs + record/file）——页数/清运次数随 QR 实测回填。
- CloudBase 超时：默认 5s；≥20s 为**待测配置值**（非部署合同——V19 教训：不把猜测固化为合同，真云实测后写入部署配置）。

## 8. 独立探针请求（**两段门——协调方裁定 2026-09-20 破除循环依赖**）

> **循环门问题**：QR10/QR13-QR18 依赖生产 finalizeDeclare/readVerifiedBlock/commit 路径——不可能先于编码通过；旧"QR0-QR21 全过才可编码"构成死锁。**拆分**：
>
> - **预编码门（协议批准——通过后授权编码）**：①QR19 **本地门口径**（完整文档 canonicalJsonBytes 保守度量/逻辑界/写期绑定核对）——**QR19-v3 已定版 16/16（合法 batchId，工件对账收口）**；②**规范根向量**（QR7 三叶向量+父输出索引约定 D19 逐字节锚）；③**身份证明**（§0 定理机械验证+码表/碎片-解析一致/文件读取 has 语义的数学与派生级探针——QR0-QR9+QR12 已绿部分+QR20 派生级+**QR22 派生级〔待验——碎片规范字节修正中〕**）；④**设计一致性审查**（全稿无内部矛盾——两界分立/双门/字段名/D14-D23 互洽）。通过+审查批准 → **ZCode CODING 实现生产源码——公共路径禁用/不可达**（新动作不经公共 action 分派暴露/功能开关关闭）。
> - **实现验收门（post-code——对真实 handler）**：QR10、QR13-QR18、QR19 终值复核、QR20 端到端、QR21 真路径内存 + **既有全套回归**（L 系+自检五套）+ Codex 审查——**全过后才可 commit 或启用公共路径**。**Stage2 整体不得提前标验收**。
>
> 下表探针按此分类标注〔预〕/〔后〕。

| # | 探针 | 验证 |
|---|---|---|
| QR0 〔预〕| 服务端 L234 等价门在场性：违反 `S(f\|\|'')≠S(m\|\|'')` 的清单 declare 拒；L234 通过的等价/发散形状过**该格式门**（其余恢复侧身份/隐私/资源门照常适用） | **前置条件 P-1**——门缺失则本稿退回 |
| QR1 〔预〕| P13 全量等价（138,837 槽全 code 0）→ V20 派生+pack 全流 | 强制全 0 码图基线容量（S/blocks/清理/读取） |
| QR2 〔预〕| PR2 全异常复测（file=''、mapping/body 缺席→全 code 2） | **V20 核心容量主张：S≤12MiB** |
| QR3 〔预〕| **同形异码值包**：固定槽数/partition/文件形状，仅码值分布不同（全 0 / 全 2 / 六码混合 / 不齐尾部 part） | **S/parts/blocks 与码值分布恒等**（3 bit 定宽——码值不影响 base64 长度）+混合装载实测 |
| QR4 〔预〕| 五种例外各单列包（`[]`→''、null、0、false、undefined 对不同 falsy file） | 码表逐值正确+declare/上传全过 |
| QR5 〔预〕| 保留码注入（codes 内造 6/7）→ 拒+零写 | 严格保留码校验 |
| QR6 〔预〕| 长度/pad/base64 非规范（字节数≠⌈3·count/8⌉、pad 位 1、非规范 base64）→ 拒 | 严格长度与编码校验 |
| QR7 〔预〕| Merkle 绑定：篡改 codes 不动 items → root 不匹配 → 拒；**§6.3 三叶规范向量按 hex 声明字节（41/4242/434343——任意原始字节非规范块 JSON）逐字节复现断言（p0/p1/root 全等——父输出索引约定锚）——左子索引约定实现必须红、JSON 引号重释形（0x22…0x22）必须红**；三叶 sibling 路径折叠回根 | 码图入叶覆盖+索引约定唯一性+声明字节非重释 |
| QR8 〔预〕| 身份等价负例：body.fileId ≠ 重建 MString（含 file↔mapping 各 falsy 差异族）→ declaration-mismatch+零写 | 精确 String 比较保持（L435 复现） |
| QR9 〔预〕| 派生 fail-stop：超六态输入（直接单测派生器）→ package-rejected 零写 | 纵深防御 |
| QR10 〔后〕| mappingDigest/mappingRootHash CAS 复核+同请求重放+concurrent abandon | 不可变 proof+竞态 |
| QR11 〔预〕| P14b 10,000 报告×1 附件（等价与非等价两形） | 多报告尾部+清理页数（信封累加——不可端点内插） |
| QR12 〔预〕| **读取计数探针**：大量槽共享缺席与 null 身份——`file.originalFileId` 缺席、`=null` 两种形各构造多槽单 fileIndex（P13 规模 138,837）→ 真实验证器路径的 keyed read 计数 = **distinct fileIndex 数（恰 1）**，非 O(槽)；混合 fileIndex 形按 distinct 数断言 | `has()` 命中判据——nullish 合并重读缺陷的防回归钉 |
| QR13 〔后〕| **篡改探针（根状态机+已验证读路径+链接链）**：封闭后改块 payload；恶意客户端变体字节；复用他块 sibling；伪造证明方向（对错位提交合法块 A 的证明）；**存储侧单文档篡改**（payload+SHA+proof 联合 / record 声明字段 / **薄指针 blockIndex 与定位键**）——全部根折叠/字节核对/定位失败拒+零写 | I2/I4/I8——位置绑定+块不可变+逐块成员证明+链接链 |
| QR14 〔后〕| **重放探针**：同块重放三分支（prepCursor 前/后、indexing 后末块）幂等零写零推进；异内容 block-conflict | §6.4 写路径三分支 |
| QR15 〔后〕| **崩溃恢复**：块间中断→从 prepCursor 续写恰一次；末块事务后丢响应→重放 ok；indexing 中断→consumedCursor 续；末块计数不符→fail-stop | 状态转移可恢复性 |
| QR16 〔后〕| **并发探针**：并行 finalizeDeclare 同 blockIndex（CAS 一胜一幂等零丢失更新）/异 blockIndex（顺序不变量拒超前）；abandon 竞速块写/页消费→迟到写零写 | I1/I3+CAS |
| QR17 〔后〕| **零块包**：空域清单 declaring 直 declared（empty-root）+后续上传/commit 预检全路径 | §6.3/§6.4 边界 |
| QR18 〔后〕| **staging 窗口+已验证读路径+读预算实测**：末片窗口重试恰重跑一次（崩溃注入——无每页重扫）；readVerifiedBlock 全负例；P13 极端单报告验证调用**实测申报 unique verified block 数（块缓存命中后实际 distinct 读取）与四项实际字节合计（body+指针+record 声明+块）**；fileCache 经块读后 reads 仍=distinct fileIndex | §6.4 staging+I8/I9+§6.5 读预算（撤回猜测数） |
| QR19 〔后〕| **重跑（D21 格式+两界分立+量测双门）**：QR1/QR2/QR11 形——①**逻辑界**：stagedBytes ≤12MiB（不含 proof/封套——D15 修订口径）；②**本地物理门（编码验收所依赖）**：逐块**完整存储文档** `canonicalJsonBytes({_id,sha256,byteLength,entryCount,entries,proof,…全部服务端字段})` **确定性保守度量** ≤11KiB（entries=解析后数组形——§6.4 选定格式；字符串形转义 +16.5%/base64 4/3 形实现须红+记**协议表示失配非生产缺陷**）；**写期绑定核对**（请求 blockB64 解码为 blockBytes 后 canonical 往返 ∧ `canonicalJsonBytes(JSON.parse(strictUtf8Decode(blockBytes)))===blockBytes`）；**全部夹具用合法 36B 全 batchId（`rst_`+32hex——QR19r 假 7B `rstqr1` 缺陷防回归 D23）**；record 声明/薄指针度量**含 batchId 前缀完整 `_id`**（同口径 canonicalJsonBytes）——**薄指针断言 ≤128B（候选——QR22 逐类型精确字节证明后定稿）**+申报实测最大值→定 `RECORD_DECL_PHYS_MAX`；**S_phys_all 申报=Σ逐文档 canonicalJsonBytes 实际和**（结构界按 §6.5-bis 逐文档封顶式核对）；**QR19-v3 已定版 16/16（合法 batchId+脚本/日志在案）——工件对账收口，其数字采信**（QR19-v2 未采信维持历史注记——其数字不得引用）；S_phys_all 公式界核对与本地度量申报；③清理页数按文档数复核；④**超界→备选候选**（base64+BLOCK_NET 7-7.5KiB——采纳条件=整包 blocks ≤2048 ∧ 本地度量 ≤11KiB 双实测）。**DB 实际存储字节=部署终门（统一部署期——非本地编码前置）；离线度量不声称等于 DB 字节** | §6.4 双门+§6.5-bis 三口径（两界分立）+D15 修订/D20/D21/D22/D23 |
| QR20 〔后〕| **长非字符串身份真验包（code 0）**：真 `validatePackage` 过的完整包——file 与 mapping 同存 >2KiB JSON **数组**/**对象**/**单元素数组** `originalFileId`（String 相等→全 code 0）→ declare 派生 → readFidRaw 碎片-解析路径 → `String(body.fileId)===MString` 全槽过；混合变体（长数组 file code 0 + 次文件短例外 code≠0）；负例：任何以 JSON 文本字符串充缓存/比对的实现形须红 | §3 碎片-解析一致协议（路径 A 假拒防回归） |
| QR21 〔后〕| **隔离单场景 staging 内存实测（审查指认后精确化）**：**独立进程、仅单 P13 场景**（非多场景 harness——后者峰值 ≈690MiB 含夹具/harness 开销不可移植）；分相插桩 `process.memoryUsage()` 检查点（P1 解析后对象图 / P2 staging 中条目数组+暂存 / P3 建树+proof 集+临时 canonical 副本）；申报**峰值 RSS+分相增量+计时**；**据实测设定 CloudBase memorySize 与超时并写入部署配置（前置条件——不得沿用猜测值）** | §6.4 内存未测项 |
| QR22 〔预·**待验**〕| **V20 派生级指针精确字节证明（协调方指认：QR19-v4r 现证=夹具+合成键空间计算——须加真 V20 派生与指针文档断言）**：①P7 形真验包（2,780B 巨 id 记录→idfrag 拆分——record core+碎片入流）+4MiB 级长字段 filefrag 真验包（seq 四位）——均 `validatePackage` 过；②**经 V20 派生流+分页**产出指针文档，逐类型枚举做精确 `canonicalJsonBytes`（三字段形状）——申报每类型实测最大值并断言 ≤候选 128B；③实测集对照（**file 91/refs 96/cshafrag 104/rmappart 105/filefrag(path) 109/idfrag 111/filefrag(oid) 119——QR19-v4r 真验包合成键空间实测**）；实测超该集=形状漂移须查。**待验原因（协调方 2026-09-20）：v4r 派生流的 filefrag/idfrag 现按原始 UTF-8 字符串分片而非规范 JSON 字节（违 §6.1/§3 碎片-解析一致协议）——TESTING 修正中；新脚本过前 QR22 不计证** | §6.5-bis 实测集+D23 |

## 9. 裁定点

| # | 裁定 | 立场 |
|---|---|---|
| D1 | 3 bit/槽身份码图（6 态+2 保留） | 替代 V19 逐项 mos——容量破顶的修复；语义=§0 定理五值集 |
| D2 | 码图恒在场（全等价亦携带全 0） | 单一规范形——避免双形状验证面 |
| D3 | 严格校验四件套 | 长度恰 ⌈3·count/8⌉、pad 位 0、规范 base64、保留码 6/7 拒 |
| D4 | 精确 String 比较保持 | MString 重建 ⟺ L435 逐位复现——不以 `\|\|''` 替代 |
| D5 | 码图入 Merkle 叶 | canonicalBytes 含 codes——root 承诺 |
| D6 | 前置条件 P-1 | 服务端 L234 等价门须在场（QR0 先行核实） |
| D7 | 全部数字为投影 | 独立探针（QR1-QR11）复测前不作为验收证据 |
| D8 | 六态仅依赖 L234 | 派生期可封闭；L435 由上传期承担 |
| D9 | 索引两段门（破除循环依赖——协调方裁定） | **预编码门**（协议批准：QR19 本地容量〔**v3 定版 ✓**〕+规范根向量+身份证明〔含 **QR22 待验**〕+设计一致性）过+审查批准 → 编码于**禁用/不可达公共路径**；**实现验收门**（QR10+QR13-QR21 对真实 handler+既有全套回归+审查）全过 → 才可 commit 或启用；**Stage2 不得提前标验收**；容量过关≠解封；**预编码门由协调方审查后显式放行** |
| D10 | fileCache `has()` 命中判据 | null/缺席身份合法（P10/P17④）——`get()??read()` 会使 P13 形状每槽重读（可至 138,837 次）；缓存原始值保精确 String 语义；QR12 实测 |
| D11 | 根状态机已规范（§6.1–6.7：排序总序/打包/树构造含奇叶复制+零块根/**staging 算法+崩溃恢复**/四态转移+事务边界/**已验证读路径**/I1-I9 不变量/清理） | `mappingRootHash===batch.planRoot` 效力以 I1-I9 为前提——**QR13-QR19 独立篡改/重放/崩溃/并发/零块/staging/证明容量验证前维持未验收** |
| D14 | 叶哈希延后定值（staging） | 叶含 totalBlocks ⇒ 打包完成后才能哈希——§6.4 staging 算法（单遍派生+暂存 ≤12MiB 增量 fail-stop+收尾统一哈希建树）；清单恰扫描一次（I9） |
| D15 | 已验证读路径为强制原语 | 根字符串相等证不了单文档未变——上传验证一切身份读取经 readVerifiedBlock 逐块成员证明（I8）；**proof 字节计入物理层**（逐文档 ≤11KiB 上限+S_phys_all 申报）——**不计入 12MiB 逻辑硬顶（=纯 stagedBytes，§6.5-bis① 三口径裁定；早期"proof 计入 S_total 硬顶"口径作废——QR19 断言按两界分立）** |
| D16 | 长非字符串身份碎片-解析一致 | 容器无字符串类型门——`orig` 片载荷恒=原始值规范 JSON 字节切片，重组必经 `JSON.parse` 还原 JS 值（往返 String 等价论证在 §3）；禁缓存 JSON 文本（QR20 真验包+负例钉） |
| D17 | 声明分层+三口径容量 | file/refs/rmappart/filefrag/cshafrag/idfrag（**全部六类非记录条目**）声明=薄指针（零内容——内容唯一副本=已验证块；字节上限待 D23 定界）；record 声明保全量；**逻辑 12MiB（staging fail-stop）/物理 S_phys_all（**逐文档强制上限封顶结构界 `blocks×BLOCK_DOC_MAX+records×RECORD_DECL_PHYS_MAX+pointers×POINTER_PHYS_MAX+常数`+QR19 实测和申报——旧加法式作废（非有效上界，QR19-v3 实测 12.476>12.03 旧投影）/清理（物理全量分页）三口径显式分立**；旧单流 11.013MiB 不再单独构成结论 |
| D18 | 未测数字一律标注 | 内存峰值（**QR21 隔离单 P13 场景+分相插桩——harness ≈690MiB 多场景值不可移植只作否定性证据**；memorySize/超时据实测设定）/P13 读预算（QR18 unique verified block+实际字节）/record 声明物理上限（QR19）——**撤回一切未测声明数（17MiB/14MiB/2KiB+8B）** |
| D19 | 父节点索引约定=父输出索引 | `parent(L,j)`：L=输入子层号（0=叶层）、j=父在输出层内索引（0,1,2…）——非左子输入索引（0,2,4…）；§6.3 三叶规范向量（hex 声明字节 41/4242/434343——任意原始字节非规范块 JSON；root=91298894…a42b）为探针+生产逐字节锚（QR7——按声明字节测，JSON 重释形必须红） |
| D20 | proof 唯一规范形=单一 base64 串 | 解码=⌈log2(totalBlocks)⌉×32B、sibling 按父层升序（L=0 起）拼接、base64 规范（重编码全等）；T=1 空串；dup 层 sibling 严格等于当前折叠哈希；**数组分串形（≈508 字符）显式禁用**；QR19 连封套实际序列化实测（不用估算） |
| D21 | payload 持久化=**解析后条目数组（native JSON）** | 字符串形转义膨胀 +16.5%（实测 1,711B→+282B）与 base64 形 4/3（13.33KiB）均实测否决；写期绑定（blockBytes canonical 往返核验+`entries=JSON.parse(blockBytes)`）+读期根锚定（canonicalJsonBytes→byteLength→重算叶→proof 折叠 planRoot）；**指针/record 声明量测均含 batchId 前缀完整 `_id`** |
| D22 | 量测双门（部署时序裁定） | **本地验收门**=完整存储文档 canonicalJsonBytes 确定性保守度量（编码验收所依赖）；**部署终门**=真 CloudBase 驱动物理序列化/计费字节（统一部署期——**非本地编码前置**）；**离线度量不声称等于 DB 实际存储字节**（保守代理——DB 内部口径部署期核实） |
| D23 | 指针 80B 保证撤销+**候选 128B 余 9B（实测修正后）待 QR22 派生级证明**（非生产缺陷） | QR19r 73B 系 7B 假 batchId（`rstqr1`）；生产 ：589 要求 36B——反例由合法 ID 长度独立确定。**实测集（协调方 QR19-v4r 真验包+合成全 ID 键空间 `{_id,blockIndex,type}` 精确文档——权威）**：file 91/refs 96/cshafrag 104/rmappart 105/filefrag(path) 109/idfrag 111/**filefrag(oid) 119←最长** → **候选 POINTER_PHYS_MAX=128B（余量 9B）**——我方旧算术 114/106 **系统性低 5B（序列化差——以实测为准，表已修正）**；QR19-v4r 现证=夹具+合成键空间计算——**V20 派生级+指针文档断言由 TESTING 补（QR22）后定稿**。**工件对账已收口**：QR19-v2 未采信维持历史注记（其数字不得引用）；**QR19-v3 定版 16/16（合法 batchId+脚本/日志在案）——其数字采信** |
| D24 | refs items=有界 `{order, recIndex}`（不复制 rid）+**rmappart 同锚定 recIndex** | 合法 reportId 可 >2KiB（同 record idfrag 理由）——携 rid 全文单项超 ENTRY_MAX 误拒安全合法导出形（ff8ef5a3 坐实）；**D24-r：Stage1 以 reportId 配对非数组位置——recIndex 恒=records.reports 中 id===reportId 的位置（显式锚定关系，reports 可重序；无匹配 fail-stop）**；rid 解析经锚定 record（id/idRef+idfrag 均在已验证块内）；换序夹具（双报告+巨 rid idfrag 查找）为强制验收形；容量模型变更须新形重测 |
| D25 | 重复 reportId 三轨策略（协调方真包反例+G2 红证+S0 作用域修正 2026-09-20） | **Stage1-valid 形（S0 复核收窄——措辞不得超出）**：①**有效空重复**（含异原始形状：空数组/空对象/缺席——均投影零附件）；②**首非空+尾随有效空**（find-first——G2 真包 ok）；③**双非空异 order**（非重复 order——S0 对照 ok）。**Stage1-invalid（S0 坐实）**：双非空同 order 全等重复→`duplicate-report-order` 拒。V20 三轨：**①有效空尾随/重复→no-op/去重**；**②非空冲突（含 Stage1-invalid 同 order 重复）→fail-stop**——模块对 Stage1-invalid 形的接纳/拒绝仅为**纯助手边界行为，非兼容性证据**；**首空+尾非空=数据丢失形拒**。§21/§23（+TESTING dupid）为强制验收形 |
| D26 | attachments 归一语义（协调方真包反例裁定 2026-09-20） | **Stage1 container 一致以 `Array.isArray(r.attachments) ? r.attachments : []` 归一**（空对象/缺席/非数组→[]——真包 ok/零 problems 复验）；V20 全访问点同语义（`attsOf`——refs/rmappart/D25③ 判断处）；非数组静默归一 **与 Stage1 逐字一致——零静默畸形 refs 面**（不选择收紧 Stage1 验证器——该形为合法导出容错形）；§21j-l（{} 形真包复验+缺席形）为强制验收形 |
| D25-r2 | 有效空尾随终版（协调方裁定 2026-09-20——handler 集成前决策） | **Stage1 find-first 取首映射，非数组/空尾随 attachments 投影为零**；**尾随有效空映射=恒 no-op——即使携带未知 own 键（如 __proto__）**：原始字节由 manifest chunks+digest 保护，恢复业务报告用**首有效映射**，**不承诺保留未知尾随字段**；**一切非空尾随重复=拒——即使原始 canonical 全等**（Stage1 拒同 order 重复；异 order 为歧义；接受全等非空会使 refs 两 item 而 rmappart 一——不对称）；全等 canonical 去重分支已废（无 needed 面）；§21/§23/§24 为强制验收形 |
| D27 | 打包器单条目/单块硬顶（协调方纯模块复核裁定） | packBlocks 兼容入口不受信：**恒自 entry 重算 canonical 并断言与供给等价**（伪造/漂移拒）；**实算恒 ≤ENTRY_MAX 且 +封套 ≤BLOCK_NET**；rollover 新块超限与 finish 前末块超限均 fail-stop；§22（a-f 六检：伪造 canonical/真超限/漂移/伪造缓存/正常不回归/rollover）为强制验收形 |
| D28 | 读侧块硬限独立执法（协调方 handler 集成前阻断 2026-09-20） | verifiedBlockRead **不依赖写路径已检**——读时独立执法：①entries 恒数组（D21——对象形自洽 leaf/proof 亦拒）；②≤48 条/块；③每条 canonical ≤2KiB；④块 canonical ≤10KiB——任何一条违反即拒（fail-closed）；§25（a-e 五检：对象形/49 条/2KiB 条/10KiB 块/正常不回归）为强制验收形 |
| D29 | finalizeDeclare wire 形=blockB64（协调方裁定 2026-09-20——handler 集成前） | CloudBase event 为 JSON、handler 度量 `JSON.stringify(event)` 对 64KiB——线上恒 `blockB64`=严格规范标准 base64；解码 1..10,240B ∧ 严格 UTF-8 ∧ canonical JSON 数组往返逐字节等 ∧ ≤48 条/∧≤2KiB 条；旧 `blockBytes` 线上字段拒；重放=解码后**字节级**比较；零块不经 finalizeDeclare（空解码体恒拒）/单块 proof=空串；**客户端自原始包确定性重产 staged 块+proof（零服务端内存依赖）——客户端集成为未来实现门**；正文旧源哈希标历史 |
| D25-h | handler 集成首目语义（协调方 handler 警告 2026-09-20） | indexDeclarePage 的 reportsMapById 曾 Map.set 全量覆盖=**尾目胜**——G2 形冻结空附件丢原始映射（纯模块绿≠handler 安全）；修为 `!has 才 set`（首目胜——与 Stage1 find-first/纯 V20 D25 对齐）；**未来 handler 的映射数据源恒为已验证 V20 rmappart/refs（D25 首目语义）——不直接读 manifest 重建**；**G2 真 handler 测试属实现验收门（post-code）强制项** |
| D12 | 多报告尾部可超两个单报告端点 | 每报告独立尾 part 信封**累加**（10,000×1=10,000 parts）——QR11 单测，不可内插 |
| D13 | S 与码值分布无关 | `codes` 3 bit 定宽——同形（槽数/partition/文件形状）异码值同 S；QR3 同形异码恒等钉 |
