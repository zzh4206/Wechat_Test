# VENDOR-NOTE：macos-wechat-export 本地化快照

> 本目录是第三方仓库的**已提交状态快照**，用于异地备份与可复现性。
> 快照日期：2026-10-16 · 体积 324K / 33 文件

## 来源与许可

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/DaneelOlivaw1/macos-wechat-export |
| 上游基线 commit | `88ca1be`（Merge PR #1 fix/finderinfo-bootstrap） |
| 许可 | MIT（本目录保留 LICENSE 与 NOTICE，符合署名义务） |
| 快照对应 commit | `2c210e5`（含本仓库两个补丁，见下） |

## 本仓库对上游的补丁

| commit | 内容 | 用途 |
|---|---|---|
| `d5eda50` | `read` 子命令新增 `--before-id` 向前翻页 | 掉线积压追赶补读（插件端 readOnce 追赶循环依赖它） |
| `2c210e5` | 新增 `files` 子命令（按会话查询文件消息存储路径） | F7 文件索引的 wx_path 定位 |

## 未包含在本快照中的内容（重要）

1. **未提交的本地修改**：`Send.swift` 的 composerEmpty 中文环境修复（本次实测发现：中文版微信空输入框无英文占位提示，且底部工具栏图标会被像素密度检查误判为非空内容）与并行开发中的窗口枚举改动——按约定，**快照只取已提交状态**，未提交改动待其作者提交后再刷新本快照；
2. **敏感与可再生内容**（上游 .gitignore 已排除，本快照同样不含）：
   - `.wechat-local/`（**含 keys.json 密钥**——绝不入库、绝不外传）
   - `wechat-ui` / `wechat-ui-tests` 编译产物（可由 `sh build.sh` 再生）
   - `.wechat-ui-state/`、各类媒体缓存与数据库文件

## 与运行时的关系（快照不等于运行副本）

插件运行时读取的是**可写工作副本**（配置项 `sourceToolDir`，当前指向 `$HOME/WeChat/macos-wechat-export`），它持有密钥、编译产物与本地补丁，**不可用本快照直接替换**。本目录的用途仅限：备份、代码审阅、上游对比、灾难重建的参照。

## 快照刷新方法（工具仓库有新的已提交改动时）

```bash
cd $HOME/WeChat/macos-wechat-export
rm -rf $HOME/WeChat/2水群/vendor/macos-wechat-export
mkdir -p $HOME/WeChat/2水群/vendor/macos-wechat-export
git archive HEAD | tar -x -C $HOME/WeChat/2水群/vendor/macos-wechat-export
cd $HOME/WeChat/2水群
git add vendor/macos-wechat-export && git commit -m "chore(vendor): 刷新 macos-wechat-export 快照至 <commit>"
```
