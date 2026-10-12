# W1 报告：本机微信库可读性验证（生死步）

> 任务书：[REPORT-wechat-db-plan.md](REPORT-wechat-db-plan.md) §2 W1 · 日期：2026-10-11
> **结论：(b) 需 key 且 key 途径可行（高置信度，有实测先例）——D1 继续。**

## 1. 本机实测（证据：本会话直接只读检查）

| 项 | 实测结果 |
|---|---|
| 微信数据目录 | `~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/`（4.x 新结构） |
| 本人账号目录 | `wxid_xxx/db_storage/`（含 message/contact/favorite/sns 等 15+ 子库） |
| 消息库 | `db_storage/message/message_0/1/2.db` + WAL/SHM/material 增量文件 |
| 加密形态 | **SQLCipher**（文件头随机，非 `SQLite format 3`；实测 `sqlite3` 打开报 "file is not a database"） |
| 盐值 | 各库文件头 16 字节即 SQLCipher salt（标准布局） |
| key_info.db | `all_users/login/<wxid>/key_info.db` 为**明文** SQLite，`LoginKeyInfoTable` 含 69 行 `key_info_data`（180B protobuf：field1=168B blob、field2/3 varint）——**key_md5 列为空**，直接解析未获裸 key，判断为封装/派生材料而非明文密钥 |
| keychain | 无 "WeChat Key" 类条目（3.x 时代的途径在 4.x 失效） |

## 2. 关键外部证据（社区已验证路径）

[DaneelOlivaw1/macos-wechat-export](https://github.com/DaneelOlivaw1/macos-wechat-export)（MIT，基于 [acmerfight 公开 Gist](https://gist.github.com/acmerfight/0a01249ef72970d07a2603dbb629e80f)）：
- **实测环境与我们高度重合**：Apple Silicon · macOS 15.6.1 · 微信 4.1.15；
- 机制：退出原版微信 → 复制临时副本、仅对副本 ad-hoc 重签 → LLDB 启动副本捕获 `CCKeyDerivationPBKDF` 派生参数 → 对各库头部盐值做 HMAC 校验 → **逐库密钥**私密保存（keys.json 0600）→ 恢复官方签名原版 → 此后日常对 DB+WAL 做 SQLCipher **只读**打开；
- 硬边界与本项目红线吻合：不动 `/Applications/WeChat.app`、不关 SIP、密钥与聊天不出本机、只读打开；
- 附带能力：联系人/群解析（resolve）、增量 watch/ack——**W2–W4 的大量工作它已实现**；
- 明确警告：不要用 wx-cli（4.1+ 取钥为 0 且涉 DMCA）。
- 其他佐证：[wechat-export-macos](https://github.com/ydotdog/wechat-export-macos)、[wxkey](https://github.com/r266-tech/wxkey)、[fomomo](https://github.com/nishuzumi/fomomo)、[wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool)。

## 3. 结论与影响

- **判定 (b)**：key 不能从磁盘直接抄，但"临时副本重签 + LLDB 取钥"是有实测、有代码、有 HMAC 校验的成熟路径；key 属**逐库密钥**，换库/换号需重新捕获（一次成本）。
- **对计划的影响**：
  - W2/W3/W4 优先评估**直接复用 macos-wechat-export 的 sqlcipher 封装与增量机制**（作为本机外部工具，MIT 兼容；其 keys.json 对接我们的白名单适配器），而不是重写解密层；
  - 取钥流程需要**用户一次性配合**：退出微信几分钟、接受临时副本调试运行（其作者提示副本可能被客户端感知，属已知风险，数据全程不出本机）；
  - 运行前提新增：Xcode CLT、brew sqlcipher（+python3.14，按其 build.sh）。
- **风险更新**：微信升级可能同时破坏"读取层"与"取钥层"，后者恢复成本更高（重跑 bootstrap）；key 文件为最高敏资产，权限 0600、绝不入库。

## 4. 下一步（D1 继续）

1. 用户配合跑一次 macos-wechat-export 的 bootstrap_keys（产出 keys.json）；
2. 派 W2：读取适配器——白名单硬闸门 + 调用 sqlcipher 只读增量读取（复用其 wechat_db.py watch/ack 思路或直接 exec 其 CLI）；
3. W3 规范化（发送者剥离/系统消息过滤/昵称映射——其 resolve 能力可复用）。
