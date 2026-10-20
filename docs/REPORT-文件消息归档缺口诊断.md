# REPORT — 文件消息归档缺口诊断

- 日期：2026-10-19（诊断 agent，只读调查）
- 现象：两个群的 groupStore `files` 表 0 行；store `messages` 中 `kind='file'` 0 条；但群内确有文件消息（如 `[文件] 作业4.pdf`、`[文件] 金融数学引论.pdf`）。
- 结论先行：**读取窗口与游标没有问题，文件消息已经入库——但全部被归一化成 `kind='link'`（占位 `[链接]`）**；file-index 只扫 `kind='file'`，因此永远空转。断点在「归一化分类」这一环，根子是微信 4.x 的 `local_type` 低 32 位对链接/文件/小程序统一为 49，而 CLI 又不导出 appmsg XML，适配层无从区分。

## 1. 逐项取证

### 1.1 微信库侧（wechat_db.py read --limit 50，Test 群）

最新 50 条 `local_type` 解包（`(scene<<32)|type` 取低 32 位）分布：

| 低 32 位 | 条数 | 含义 |
|---|---|---|
| 1 | 14 | 文本 |
| 3 | 11 | 图片 |
| **49** | 15 | appmsg（链接/文件/小程序统称） |

实测打包值样本：`25769803825 = (6<<32)|49`、`244813135921 = (57<<32)|49`、`81604378673 = (19<<32)|49`、`21474836529 = (5<<32)|49`——**高 32 位（scene）各不相同，低 32 位全是 49**。文件消息与链接消息在 `local_type` 上不可区分。

文件消息行 `text = null`，带 `omitted: "non_text_message; XML/media credentials are not exported"`——CLI 设计上不导出 appmsg XML，而文件名（`<title>`）和 appmsg 子类型（`<type>6</type>`）恰好在 XML 里。**适配层拿到的信息不足以判定「这是文件」**。

两个 PDF 消息确实在微信库中：`wechat_db.py files --chat-id <Test群>` 返回 12 个文件，含 `金融数学引论.pdf`（available=false）与多个 `*.pdf/*.pptx/*.xlsx/*.tex`。

### 1.2 读取窗口与游标侧

- `files` 子命令返回的 12 个文件 msg_id **全部**（12/12）已在 `cursor.json` 该群 `recent`（total=42）中 → 游标没有越过丢失，读取窗口覆盖了它们。
- store 中该群 `messages` kind 分布：`image=12, link=15, text=8`——15 条 link 恰好对应微信库 15 条 type-49 消息。**读取层读了、入库了，只是类别错**。

### 1.3 归一化侧（断点）

`src/source/wechat-db.ts`：

- L39 `decodePackedType`：打包值正确解包为 49 ✔
- L66 `RAW_TYPE_MAP[49] = { label: '[链接]', kind: 'link' }` ← **唯一归类，无 file 分支**
- L780 `normalizeRowText`：`text=null` → 走 L257 `return mapRawType(type).label` → `'[链接]'`
- L783-784 `kind = mapRawType(decodedType).kind` → `'link'`

结果：文件消息以 `{text:'[链接]', kind:'link'}` 入库（store 实测 15 条 link、text 均为 `[链接]`）。**没有被过滤、没有被丢弃，是分类错误。**

### 1.4 file-index 触发侧

`src/index.ts` L695/L856-868：每条消息入库后即触发 `fileIndex.scanChat(chatId)`（`fileIndexEnabled` 开启时），接线本身没问题。

`src/file-index.ts` L227-231 `run()`：

```ts
const msgs = this.options.groupStore.getMessages(chatId, {
  afterTs: this.watermark(chatId), kinds: ['file'], ...
```

数据源 = store `messages` 且 `kinds: ['file']`（`group-store.ts` L703-705 SQL `kind IN (?)`）。**store 里永远没有 `kind='file'` 的行 → 每轮扫描 0 条 → `files` 表 0 行**。且 L234-236：msgs 为空时提前返回、水位不推——所以这不是「错过窗口」，是源头为空。

## 2. 根因证据链

```
微信库: 文件消息 local_type=(scene<<32)|49, text=null（XML 不导出）
  → 适配层: decodePackedType → 49 → RAW_TYPE_MAP[49] → {label:'[链接]', kind:'link'}   ← 断点 A
  → store: messages 落库为 kind='link'（15 条），kind='file' 恒为 0
  → file-index: getMessages(kinds:['file']) → 0 条 → files 表 0 行                     ← 断点 B（被 A 决定）
读取窗口/游标：12/12 文件 msg_id 均在 cursor.recent，无越界丢失                            ← 排除
```

一个待修注意点：`wechat_db.py files` 返回的 `msg_id` 与 `read` 返回的 `server_id` **不总是一致**（12 个文件里 1 个在 store 中无对应行；`files` 的 5521569729602777272 在 store 里对应行的 server_id 实为 2215744605296949383，疑似不同 id 命名空间/库域）。修复方案若按 msg_id 关联需做兜底（name+ts 匹配）。

## 3. 修复建议（按优先级，均未改动产品代码）

1. **首选：file-index 改用 `wechat_db.py files` 子命令作数据源**（或作为 `kind='file'` 之外的补充源）。它直接返回 `{msg_id, name, path, available}`，无需 XML。改动点：`src/file-index.ts` 的 `run()`——新增一条「从 CLI files 列表 upsert」路径，接线处在 `src/index.ts` L695 附近已有现成的 `refreshPaths`（同样调 files 子命令）可复用为数据回调；注意 §2 的 msg_id 命名空间差异，用 `name|size|sender` 兜底去重键（现 L246-249 已有该键）。
2. **次选（纯 store 内自洽）**：`src/file-index.ts` L231 `kinds: ['file']` 扩为 `['file', 'link']`，再用 `classifyExt`（现成函数）按文件扩展名过滤——但 `[链接]` 占位文本不含文件名，扩展名判断会失效；需先解决文件名来源，故实际仍绕回方案 1。
3. **归一化层修正展示**：`src/source/wechat-db.ts` L66 的 49 归类保持 `kind:'link'` 是当前信息下的正确上限；若未来 CLI 导出 appmsg 的 `<type>` 或文件名，可在 `normalizeRow` 中加 file 分支并回填 `RAW_TYPE_MAP`。可在 `docs/ERROR-REFERENCE.md` 补一条「49 ≠ 一定是链接」的已知误判。
4. **数据修复**：存量 15 条 link 行无需迁移；file-index 用方案 1 重建索引即可（files 表为空正是干净起点）。

## 4. 产出

- 探针脚本：[spikes/file-archive-probe.mjs](../spikes/file-archive-probe.mjs)（只读；真值走 `DSH_CHAT_ID`/`DSH_DB_ROOT`/`DSH_CLI_DIR` 环境变量，不入库）
- 本报告全部使用占位标识符（AGENTS.md §2 红线）；实测原始值仅存在于探针运行输出，未写入仓库。
