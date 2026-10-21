# TECH：新机器一键构建 1数据（bootstrap）· 技术方案

> 背景：数据负责人审查结论——schema 可从 0数据格式 唯一重建，但「1数据 目录约定与真实库落位」无构建者，新机器无法一条命令得到规范空库。
> 目标：**clone 0数据格式 → `python3 bootstrap.py` → 得到规范、空的 1数据 目录**。

## 1. 路径约定（定稿）

- `bootstrap.py --target <DIR>`，**缺省 `./1数据`**（相对调用目录；绝不硬编码用户家目录——D-1 教训）。
- 产出布局：
  ```
  <DIR>/
  ├── knowledge.db      # 真实库，schema 直接以 v6 全量 DDL 创建（user_version=6）
  ├── docs/             # doc.file_path 的相对根（README 已约定前端只展示）
  ├── exports/          # export_md 默认输出根
  └── media/            # 媒体地址登记的相对根（media.path_kind='archive' 的根）
  ```
- 预留 v0.5：`--account <wxid>` 可选参数（提供时产出 `<DIR>` 即账号根，布局不变）；
  多账号/目录重排在 v0.5 窗口另行迁移，**本脚本不预设**。

## 2. 行为规范

1. `knowledge.db` 不存在 → 用 schema.sql 全量 DDL 创建（等价 `user_version=6` 空库）；
2. 已存在 → **不重建不修改**：校验 `user_version`，=6 打印 OK；<6 提示「将走 report_cli 自动迁移」并仍退出 0；>6 报错退出非 0；
3. 三个子目录不存在则创建，存在则跳过（幂等，可重复运行）；
4. 全程零网络、零真实数据；创建物只有空库与空目录；
5. 退出码：0 成功/幂等重跑；非 0 参数或版本错误。

## 3. 配套文档

- README.md 增「新机器初始化」一节：`git clone … && python3 bootstrap.py --target 1数据`，
  说明产出布局、与 TS 镜像默认路径（`~/WeChat/1数据/knowledge.db`）的关系——
  **TS 镜像路径是运行配置，不在本脚本职责内**（PRIVACY 红线：家目录路径不进码）；
- 明确声明：bootstrap 产出的是**空库与目录骨架**；历史数据回填走
  `scripts/import-state-to-sqlite.mjs`（2水群）与 `extract_docs_from_reports.py`，不在本脚本范围。

## 4. 测试

1. 临时目录运行：布局四项齐全、uv=6、六表两视图（v6 全量对象）在位且全 0 行；
2. 重跑幂等：无报错、无重建（mtime 不变或库仍空）；
3. 已存在 v5 库：提示迁移路径、退出 0、不改动；已存在 uv=7 假库：报错退出非 0；
4. `--account demo0001` 产出账号根布局（为 v0.5 预留验证）；
5. check-sensitive 通过（脚本与文档零家目录字面量）。

## 5. 排期

单文件 `bootstrap.py` + README 章节即可，随下一次模板仓提交窗口上远端。
