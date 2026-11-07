# 工作空间审查与目录规范

审查时间：2026-11-07

## 1. 审查范围

本次审查覆盖工作空间根目录、`studio/` 当前产品 monorepo、`packages/` 旧版桌面壳、文档、启动脚本、构建输出、备份和本地运行数据。

审查方式：

- 按文件哈希查找源代码重复文件
- 检查 Git 跟踪状态与忽略规则
- 检查脚本、README、启动入口的文件引用
- 区分源码、运行数据、构建产物、缓存和一次性测试文件

未直接移动业务源码目录，避免破坏 TypeScript/Vite 的导入路径、Electron 入口和现有启动快捷方式。

## 2. 已删除内容

| 类型 | 路径 | 大小 | 原因 |
|---|---|---:|---|
| 旧构建 | `studio/packages/desktop/release-0811-release/` | 4449.9 MB | 旧版解包产物，当前启动使用 `release/win-unpacked` |
| 构建缓存 | `.translation-plugin-build/` | 2364.3 MB | 可再生成 |
| 旧备份 | `.hermes-agent-backup-20261104/` | 1479.3 MB | 时间点备份，未被源码或脚本引用 |
| 旧备份 | `.translation-plugin-installed-backup/` | 995.9 MB | 旧插件备份，可再生成 |
| 旧构建 | `dist/`（根目录） | 877.2 MB | 旧版根目录产物，当前产品使用 `studio/dist` |
| 测试依赖 | `.npm-test/` | 417.6 MB | 一次性测试安装 |
| 重复仓库 | `.push-v2-clean/` | 89.7 MB | 包含 `.git` 的整仓副本 |
| 缓存 | `.cache/` | 44.1 MB | 构建缓存 |
| npm 缓存 | `.npm-home/` | 9.2 MB | 本地测试缓存 |
| 本地同步 | `.hermes-sync/` | 2.8 MB | 旧同步工作区，未参与运行 |
| 重复源码 | `packages/desktop/.stage/` | 1.2 MB | 与 `packages/desktop/src` 逐文件重复 |
| 历史快照 | `.upstream-07.35/`、`.upstream-08.11/`、`.upstream-ekko/` | 约 1.4 MB | 上游快照，无运行时引用 |
| 空目录 | `.pdf2zh-probe/`、`.tmp-matt-skills/` | 0 MB | 一次性探测目录 |
| 临时文件 | `.tmp-*.cjs`、`.tmp-*.py`、`.tmp-*.sh` | 约 0.2 MB | 一次性 Playwright/脚本 |
| 截图/日志 | `.cloud-*.png`、`.login-*.png`、`.roles-*.png`、`.probe*`、`.startup-*`、`.translate-server.*` 等 | 约 0.2 MB | 一次性验证产物 |

合计释放约 **9.4 GB**，磁盘可用空间从 **243.73 GB** 增加到 **253.14 GB**。

## 3. 重复文件结论

### 已删除的重复

- `.push-v2-clean/`：整仓副本，包含独立的 `.git`
- `packages/desktop/.stage/`：`packages/desktop/src/` 的完整副本
- `studio/packages/desktop/release-0811-release/`：旧安装构建，重复当前 `release/`
- 旧 release 中的 `runtime-release.json`：与 `studio/packages/desktop/build/runtime-release.json` 重复
- 旧 release 中的 `hermes-studio-mcp.mjs` / `hermes-web-ui-mcp.mjs`：同一旧产物内的重复文件

### 保留的“看似重复”

- `studio/packages/ekko-agent/skills/.../references/workbench-api.md`：两个技能包各自需要自包含引用，保留
- `packages/`（根目录）：旧版桌面壳源码，和 `studio/packages/` 不是逐文件复制；保留为 legacy
- `studio/docs/` 与 `docs/`：分别保存产品内部文档和仓库级运维文档，不合并

## 4. 保留内容

| 路径 | 用途 |
|---|---|
| `studio/` | 当前产品源码 monorepo |
| `studio/packages/client` | Vue 客户端 |
| `studio/packages/server` | Node 服务端 |
| `studio/packages/desktop` | Electron 桌面壳 |
| `studio/packages/ekko-agent` | Agent 运行时与技能 |
| `studio/packages/skills` | 内置技能 |
| `studio/packages/esp32-c3` | 硬件固件 |
| `studio/docs/` | 产品架构、运行和研究文档 |
| `docs/` | 仓库级部署、连接、数据治理文档 |
| `data/` | 本地运行数据，非源码 |
| `.electron-dist-cache/` | 本地 Electron 运行时，启动脚本使用 |
| `studio/packages/desktop/release/` | 当前桌面运行/打包输出 |
| `node_modules/`、`studio/node_modules/` | 依赖，保留以避免重新安装 |
| `packages/`、`start-desktop.cmd` | 旧版桌面壳，legacy 保留 |
| `start-studio-local.cmd`、`start-studio-desktop.cmd` | 当前产品启动入口 |

## 5. 目标结构

```text
MedHealthBuddy/
├── studio/                         # 当前产品源码
│   ├── packages/
│   │   ├── client/                 # Web UI
│   │   ├── server/                 # API / 业务服务
│   │   ├── desktop/                # Electron 桌面壳
│   │   ├── ekko-agent/             # Agent 运行时
│   │   ├── skills/                 # 内置技能
│   │   └── esp32-c3/               # 固件
│   ├── docs/                       # 产品文档
│   │   ├── architecture/           # 架构图与设计说明
│   │   └── chat-chain-changes/     # 变更记录
│   ├── tests/                      # 服务端/客户端测试
│   ├── scripts/                    # 构建与开发脚本
│   └── dist/                       # 构建产物（Git 忽略）
│
├── packages/                       # 旧版桌面壳（legacy）
├── docs/                           # 仓库级文档
│   ├── screenshots/
│   └── workspace-structure.md
├── scripts/                        # 部署/同步脚本
├── data/                           # 本地运行数据（不提交）
├── .electron-dist-cache/           # Electron 运行时缓存（Git 忽略）
│
├── start-studio-local.cmd          # 本地模式启动
├── start-studio-desktop.cmd        # 远程模式启动
├── start-desktop.cmd               # 旧版桌面启动
├── deploy-studio.ps1               # 源码同步
├── connect-from-mac.sh             # 连接脚本
├── README.md
├── PROVENANCE.md
└── LICENSE / NOTICE
```

### 后续可选整理

以下动作会改变路径，建议单独开分支执行，并同步修改快捷方式和脚本：

1. 将旧版 `packages/` 移到 `legacy/desktop-shell/`。
2. 将安装包和构建输出统一放到 `artifacts/`。
3. 将 Electron 缓存统一放到 `tools/electron-runtime/`。
4. 将根目录启动脚本收进 `scripts/launchers/`，并重做开始菜单快捷方式。

在完成路径迁移前，保持根目录启动入口不变，避免再次出现快捷方式失效。
