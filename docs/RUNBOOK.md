# RUNBOOK：dsh-group-lurker 安装 / 授权 / 白名单 / 审计 / 卸载

> 适用：macOS（Apple Silicon 已验证）+ DSH（`~/.dsh`）+ 插件 `@zzh4206/dsh-group-lurker`。
> 本手册只覆盖**小号**路径。**大号只承担一个动作：把小号拉进需要旁听的群**（如 Test 群模式）；除此之外大号不出现：不取钥、不配置、不读取，本手册也不提供任何大号库的配置方法。

## 0. 账号边界（先读，不可越）

- **读取面 = 小号库 + 小号被拉入的群白名单**。`sourceDbRoot` 必须指向**小号**的 `db_storage`；`groups` 白名单只能是**小号已在其中**的群 chatId。
- 小号入群对群友可见（公开旁听，无隐匿预期）；小号不保证常在线，掉线积压由补读机制处理（T1.5）。
- 不读白名单以外任何微信数据；白名单为空即拒绝读取（fail-closed）。

## 1. 前置安装（一次性）

```sh
xcode-select -p          # 缺则 xcode-select --install
brew install python@3.14 sqlcipher
git clone https://github.com/DaneelOlivaw1/macos-wechat-export.git
cd macos-wechat-export
sh build.sh && sh test.sh && python3.14 test_db.py
```

小号取钥（工具的 `bootstrap_keys.py` 流程，详见该仓库 QUICKSTART.md 第 2 节）：**先在微信里登录小号**，菜单退出原版 → 跑 bootstrap → 恢复原版。产物：

- `.wechat-local/keys.json` —— **权限必须 0600，目录 0700（umask 077）**。
- **密钥纪律：keys.json 只留在工具目录 `.wechat-local/` 内；不复制、不移动、不 `cat`/打印、不提交 git、不写进任何配置文件正文。** 配置里只出现它的**路径**（经 `sourceToolDir` 间接指向），不出现内容。

## 2. 查小号的 db_storage 路径与群 chatId

```sh
cd macos-wechat-export
python3.14 disk_inventory.py        # 多账号列表里选【小号】的 db_storage 绝对路径
python3.14 wechat_db.py verify      # 全部 verified 才继续
python3.14 wechat_db.py resolve '群名关键词'   # 用小号库查目标群 → 得到 xxx@chatroom
```

把查到的 `xxx@chatroom` 逐个填进白名单。**resolve 只对小号库执行**——查不到的群即视为小号不在该群，不该进白名单。

## 3. 安装插件到 DSH profile

```sh
# 1) 构建插件（产物 lib/，发布/安装只认 lib）
cd /path/to/2水群
npm run build

# 2) 装进 profile（profile 目录以 ~/.dsh/profiles/web 为例，含自己的 package.json）
cd ~/.dsh/profiles/web
pnpm add file:/path/to/2水群
```

## 4. 配置（profile 的 cordis.patch.yml）

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert:` 列表加一段。**以下全部路径均为占位，必须替换为本机小号实际路径；仓库内 cordis.patch.yml 是本地运行配置，不入库。**

```yaml
- id: group-lurker
  name: '@zzh4206/dsh-group-lurker'
  config:
    groups:                          # 白名单：小号被拉入的群
      - 'xxxxxxxxxx@chatroom'
    source: wechat-db
    sourceToolDir: /替换/为/macos-wechat-export 绝对路径
    sourceDbRoot: /替换/为/【小号】的 db_storage 绝对路径
    sourcePython: /opt/homebrew/bin/python3.14
    # 提炼节奏（正式值；观察期临时调大的参数记得手动调回）
    distillEveryMessages: 25
    distillIntervalMin: 15
    # M1 调度 / 通知（T1.3/T1.4）
    schedulerEnabled: false          # M3 接报告生成后再开
    dailyReportTime: '20:30'
    weeklyReportTime: '20:40'
    monthlyReportTime: '08:00'
    staggerMinutes: 5                # 按白名单顺序每群错峰 5 分钟
    notifyDryRun: true               # true = 只记日志不弹系统通知
```

红线自查：`groups` 为空 → 插件拒读（fail-closed）；任何配置不得包含 keys.json 内容；`sourceDbRoot` 指向小号。

## 5. macOS 完全磁盘访问授权

微信 4.x 数据在 `~/Library/Containers/com.tencent.xinWeChat/...`，宿主进程必须被授予**完全磁盘访问**才能只读打开：

1. 系统设置 → 隐私与安全性 → 完全磁盘访问；
2. 把**运行 DSH 的宿主程序**（终端 / DSH app 实际进程）加入并打开开关；
3. **完全退出并重启宿主**（授权只对新启动的进程生效）。

只读旁听**不需要**屏幕录制/辅助功能授权（那是发送/UI 自动化才用的，本插件不发送）。

## 6. 启动与审计日志查看

启动 DSH（正常流程），日志出现 `group-lurker ready, stateDir=...` 即装好。状态目录默认 `~/.dsh/dsh-group-lurker/`：

```sh
ls ~/.dsh/dsh-group-lurker
# groups/<chatId>/insights.jsonl   每群提炼产出（引用 ≤50 字，无消息全文）
# groups/<chatId>/cursor.json     读取游标（只记消息 id，不记内容）
# reports/YYYY-MM-DD.md           每日日报
# scheduler/state.json            调度器已触发时点（只记 kind/时间戳，不记内容）
# notify/audit.jsonl              通知审计（只记时间 + kind 元数据，不记标题正文）
```

审计纪律：所有日志只记**元数据**（时间、群号、kind、计数），不记消息正文、不记密钥、不记通知正文。

## 7. 验收清单

- [ ] `wechat_db.py verify` 对**小号**库全部 verified；
- [ ] 白名单里每个 chatId 都能用小号库 resolve 到；
- [ ] DSH 日志无 `refused (fail-closed)` / `source start refused`；
- [ ] `groups/<chatId>/insights.jsonl` 有新行；
- [ ] `keys.json` 权限仍为 0600（`stat -f '%Lp' .wechat-local/keys.json`）。

## 8. 卸载

```sh
cd ~/.dsh/profiles/web
pnpm remove @zzh4206/dsh-group-lurker   # 移除插件（cordis.patch.yml 对应 insert 段一并删掉）
# 数据删除（不可逆，含全部提炼产出与日报）：
rm -rf ~/.dsh/dsh-group-lurker
# 密钥销毁（不再用时）：
rm -rf /path/to/macos-wechat-export/.wechat-local
```

宿主 dispose 保证无定时器/监听残留；卸载后自动回到"不读取"状态。

## 9. 换机 / 重装微信（不迁移，重取钥）

`.wechat-local/` 整个目录（`keys.json`、`original-signature.txt` 等）是**绑定本机与本次取钥过程的临时产物**，换机、重装微信、微信大版本升级后一律**不迁移、重新取钥**：

1. 新环境按 QUICKSTART 重跑 `bootstrap_keys.py`——它会重新生成签名快照与逐库密钥；
2. **切勿**把旧机器的 `.wechat-local/` 拷过去：旧签名快照会让 `bootstrap_keys.py` 的原版签名对照（第 101 行）误判"原版被改动"而中止；旧 keys.json 对新环境的库也不适用；
3. 取钥成功后插件侧只需核对 `sourceDbRoot`/`sourceToolDir` 指向无误，游标（stateDir/cursor.json）与新库位点不一致时会自动按新库重新对齐（最坏情况：少量近期消息重复投递，下游幂等消化）。
