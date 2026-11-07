# MedHealthBuddy

> 本地优先的科研与多智能体工作台：对话、科研工作台、编码 Agent、技能市场、可视化工作流和远程连接器统一在一个桌面应用中。

MedHealthBuddy 面向文献驱动的研究、实验执行、论文草稿和 Agent 协作场景。桌面端基于 Electron，Web UI 与服务端基于 Node.js，数据默认保存在本机，也可以连接远程 Studio / DSH / Hermes 服务。

> **用途声明**：仅用于科研与工程验证，不用于临床诊断、治疗或医疗决策。自动抽取、自动判定和统计结果都需要人工复核。

[![Vue 3](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D23-339933)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-42-47848f)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20BSL--1.1-blue)](#许可证)

---

## 目录

- [为什么需要 MedHealthBuddy](#为什么需要-medhealthbuddy)
- [模块总览](#模块总览)
- [核心模块详解](#核心模块详解)
  - [1. 单聊与多智能体对话](#1-单聊与多智能体对话)
  - [2. 群聊与共享会话](#2-群聊与共享会话)
  - [3. 科研工作台](#3-科研工作台)
  - [4. 工作流、任务与看板](#4-工作流任务与看板)
  - [5. 编码 Agent](#5-编码-agent)
  - [6. 技能、技能市场与提示词模板](#6-技能技能市场与提示词模板)
  - [7. 模型、API Relay 与可观测性](#7-模型api-relay-与可观测性)
  - [8. 连接、设备与浏览器](#8-连接设备与浏览器)
  - [9. 记忆、旅程与桌宠](#9-记忆旅程与桌宠)
  - [10. 账户、Profile、权限与设置](#10-账户profile权限与设置)
  - [11. 桌面应用](#11-桌面应用)
  - [12. 远程连接器](#12-远程连接器)
  - [13. CLI、MCP 与扩展](#13-climcp-与扩展)
- [整体架构](#整体架构)
- [技术栈](#技术栈)
- [安装与使用](#安装与使用)
- [目录结构](#目录结构)
- [数据、安全与边界](#数据安全与边界)
- [开发与测试](#开发与测试)
- [贡献方式](#贡献方式)
- [许可证](#许可证)
- [截图资源清单](#截图资源清单)

---

## 为什么需要 MedHealthBuddy

常见 AI 工具通常只解决一个环节：聊天、写代码、查文献或画流程。MedHealthBuddy 把这些能力放进同一个本地工作台，并保留清晰的数据边界：

- **对话是入口**：单聊、群聊、编码 Agent 和外部智能体共享同一个会话工作区。
- **科研有状态**：研究不是一段长对话，而是可恢复的 Run、证据、Claim、实验和报告。
- **数据在本地**：项目、文献、实验记录、会话和 Profile 默认保存在本机。
- **远程可连接**：本地桌面应用可以通过设备管理连接远程 Studio；独立远程连接器可通过 SSH 连接 DSH / Hermes。
- **流程可审计**：证据、Claim、实验结果和最终报告都有人工门禁。

---

## 模块总览

| 模块 | 主要入口 | 价值 |
|---|---|---|
| 单聊与多智能体 | `/hermes/chat` | 对话、工具调用、附件、Agent 选择 |
| 群聊 | `/hermes/group-chat` | 多 Agent 房间、共享会话链接 |
| 科研工作台 | `/hermes/research` | 文献、证据、Claim、实验、论文、研究运行 |
| 工作流 | `/hermes/workflow` | 可视化流程、节点编排、任务执行 |
| 任务与看板 | `/hermes/jobs`、`/hermes/kanban` | 后台任务和项目看板 |
| 编码 Agent | `/studio/agents/:agentId/settings` | Claude、Codex、Pi、Grok、Cursor 等 Runtime |
| 技能市场 | `/hermes/skill-market` | 技能发现、安装、启停和使用统计 |
| 提示词模板 | `/hermes/prompt-templates` | 可复用 Prompt、分类和胶囊 |
| 模型管理 | `/hermes/models` | Provider、模型目录、路由、组合和回退 |
| 连接与设备 | `/hermes/connections`、`/hermes/devices` | App Relay、MCU、终端、桌面设备 |
| 可观测性 | `/hermes/usage`、`/hermes/logs`、`/hermes/performance` | 用量、日志、性能和技能使用 |
| 账户与权限 | `/hermes/settings`、`/hermes/profiles` | 用户、角色、模块权限、Profile 隔离 |
| 桌面应用 | `studio/packages/desktop` | Electron 外壳、本地服务、设备切换 |
| 远程连接器 | `packages/desktop` | SSH 连接 DSH / Hermes / Studio |
| CLI / MCP | `studio/bin` | 命令行启动、MCP Server |

---

## 核心模块详解

### 1. 单聊与多智能体对话

统一聊天工作区，支持普通对话、Agent 选择、文件附件、工具调用、历史会话和会话分类。

主要特性：

- 单聊会话与全局 Agent 会话
- 会话历史、收藏、重命名、删除、导出
- 模型选择、推理强度选择、上下文长度提示
- 文件/图片/视频附件与工作区预览
- 工具调用时间线、运行状态和中断恢复
- Agent 选择器：MedHealthBuddy Agent、编码 Agent、FastGPT 智能体
- 快速提示词和提示词模板胶囊
- 本地 Profile 隔离

![单聊与多智能体对话](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/chat.png)

### 2. 群聊与共享会话

面向多 Agent 协作的房间式聊天。

主要特性：

- 创建群聊房间和邀请 Agent
- 多 Agent 消息流与角色区分
- 群聊共享链接
- 共享会话只读访问
- 群聊与单聊共用 Agent、模型和工具能力

![群聊与共享会话（空状态）](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/group-chat.png)

### 3. 科研工作台

科研工作台是 MedHealthBuddy 的核心差异化模块。它以 Project 为聚合根，以 Research Run 为编排状态机。

#### 3.1 核心工作区页签

| 页签 | 作用 |
|---|---|
| 总览 | 项目阶段、统计和工作清单 |
| 论文 | LaTeX 编辑、编译、引用和论文目录 |
| 文献 | arXiv/PDF/Zotero 文献库、标签、笔记 |
| 实验 | 实验记录、指标、Job 和日志 |
| 图表 | 论文图表上传、组织、重命名和插入 |
| 组会 | 组会材料、论文选择和汇报 Deck |
| 服务器 | SSH 服务器、连接信息和远程任务 |
| 记录 | 研究过程、快照、里程碑和成长记录 |
| 会议 | 会议记录、汇报和材料管理 |
| 研究运行 | Research Run 阶段、审批和自动流程 |
| 投稿截止 | Venue 关注、截止日期和投稿日历 |

#### 3.2 Research Run 状态机

```text
界定问题
→ 文献
→ 证据表
→ Claim 审核
→ 研究假设
→ 实验计划
→ SSH 实验
→ 结果分析
→ 报告 / Results 草稿
→ 最终报告审批
→ 完成
```

主要特性：

- 文献全文读取和页码标记
- 来源证据抽取、引文定位和真实页码校验
- Claim ↔ Evidence 关联、证据覆盖和矛盾标记
- 假设、实验计划和实验记录自动串联
- SSH Job 提交、后台轮询和重启恢复
- 多 seed 统计、置信区间和统计检验
- 报告、Results 草稿和 LaTeX 论文插入
- 证据、Claim、实验、结果和最终报告的人工门禁
- 审批后自动恢复 Run
- fixture Run 与真实文献隔离

#### 3.3 自动化与人工门禁

```text
自动选文 → 证据抽取 → 证据审批
→ Claim 生成 → Claim 审批
→ 实验计划 → 实验执行审批
→ SSH Job / 后台轮询
→ 结果记录 → 实验结果审批
→ 报告生成 → 最终报告审批
```

可查看完整架构图：

![科研工作台模块关系](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/studio/docs/architecture/research-workbench-modules.png)

![研究运行自动化流程](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/studio/docs/architecture/research-automation-flow.png)

![科研工作台总览](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/research-overview.png)

![Research Run 与审批](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/research-runs.png)

![文献库](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/research-papers.png)

### 4. 工作流、任务与看板

面向重复性 Agent 流程和项目执行。

主要特性：

- 基于 Vue Flow 的可视化工作流画布
- Agent 节点、工具节点和条件分支
- 工作流运行状态与节点输出
- 后台 Job 列表、重试和结果查看
- 项目看板与任务状态流转
- 工作流结果可回到聊天或科研项目

![可视化工作流（空状态）](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/workflow.png)

![定时任务与运行历史](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/jobs-kanban.png)

### 5. 编码 Agent

把本机编码 Agent 统一接入聊天和项目工作区。

支持的 Agent 类型：

```text
MedHealthBuddy Agent / Claude Code / Codex / Pi / Grok
OpenCode / DeepSeek Harness / Cursor / Antigravity
Qwen Code / Kimi Code / CodeBuddy / Qoder / GitHub Copilot / ZCode
```

主要特性：

- Agent 运行模式：scoped / global
- 会话级模型、推理强度和启动参数
- 工作区目录绑定
- 工具调用、终端输出和代码变更预览
- Agent 配置页、MCP 配置和运行时状态
- 不同 Agent 共用会话历史与文件面板

![编码 Agent 管理](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/coding-agents.png)

### 6. 技能、技能市场与提示词模板

技能系统让 Agent 获得可复用的领域能力。

主要特性：

- 技能市场浏览、搜索和安装
- Skill Bundle 导入、导出和启停
- 内置技能与用户技能分离
- 技能使用统计
- Prompt 模板分类、排序、启用和胶囊
- 模板按对话/创造域过滤
- 模板选择可持久化到会话

入口：

```text
/hermes/skill-market
/hermes/skills
/hermes/skills-usage
/hermes/prompt-templates
```

技能生命周期与外部暴露的完整说明见：

```text
studio/docs/skill-lifecycle.md
```

![技能市场](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/skill-market.png)

![提示词模板](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/prompt-templates.png)

### 7. 模型、API Relay 与可观测性

统一管理多 Provider、模型路由和运行成本。

主要特性：

- Provider 配置和 API Key 管理
- 模型目录、上下文长度和价格
- 主模型、辅助模型、组合模型和回退 Provider
- OpenAI-compatible API Relay
- Token、费用和缓存命中统计
- 请求日志、错误日志和性能指标
- 技能调用统计
- 超级管理员性能面板

![模型与 Provider 管理](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/models.png)

![用量统计](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/usage.png)

### 8. 连接、设备与浏览器

把本地、远程和硬件设备接入同一个工作台。

主要特性：

- App Relay / API Relay
- 设备管理与远程 Studio 切换
- SSH 终端
- 远程服务器连接
- 桌面浏览器面板
- 浏览器快照和页面自动化
- MCU / ESP32-C3 设备接入
- 通知渠道与外部连接配置

![设备互联](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/connections.png)

### 9. 记忆、旅程与桌宠

围绕 Agent 个性化和使用体验的辅助模块。

主要特性：

- Memory：Agent 记忆查看、编辑和管理
- Journey：使用旅程、能力和引导
- Petdex / Desktop Pet：桌宠与 Agent 个性化
- 主题定制和多语言

![Petdex 宠物](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/memory-petdex.png)

### 10. 账户、Profile、权限与设置

面向团队和本地多用户场景。

主要特性：

- 登录、用户、角色和账户管理
- 模块级权限：`module.<key>:view`
- 操作级权限：例如 `research.run:approve`
- 超级管理员专属模块：Agent Manager、Performance、Profiles
- Profile 数据隔离
- 主题、语言、语音、STT/TTS 设置
- 版本预览和系统设置

![角色与模块权限](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/settings-rbac.png)

### 11. 桌面应用

Electron 桌面应用把本地服务、Web UI 和设备管理打包在一起。

主要特性：

- 内置 Node/Python/Electron 运行时
- 本地服务自动启动
- 设备管理：本机 / 远程 Studio 切换
- 独立远程设备的会话与浏览器存储
- 系统托盘、窗口状态和自动更新
- Windows / macOS / Linux 打包脚本

启动方式：

```text
start-studio.cmd            本地模式（默认）
start-studio.cmd local      本地模式
start-studio.cmd remote     SSH 隧道连接远程 Studio
```

兼容入口：

```text
start-studio-local.cmd      → start-studio.cmd local
start-studio-desktop.cmd    → start-studio.cmd remote
```

![MedHealthBuddy 桌面应用](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/desktop.png)

### 12. 远程连接器

根目录 `packages/desktop` 是独立的**远程连接器**，通过系统 SSH 连接远端服务。

它通过系统 SSH 连接服务器上的：

```text
DSH
Hermes
Studio 兼容服务
```

主要特性：

- 轻量 Electron 外壳
- 系统 SSH 连接
- 独立运行时不依赖当前 Studio 桌面应用
- 入口为 `start-remote-connector.cmd`
- `start-desktop.cmd` 作为兼容包装保留

![远程连接器](https://cdn.jsdelivr.net/gh/wake1999/MedHealthBuddy@main/docs/screenshots/remote-connector.png)

### 13. CLI、MCP 与扩展

除桌面和 Web UI 外，仓库还提供命令行和 MCP 入口。

主要命令：

```text
hermes-web-ui
hermes-web-ui-mcp
hermes-studio-mcp
ekko-studio-mcp
ekko-studio-web
medhealthbuddy-webui
medhealthbuddy
```

主要特性：

- 启动 Web UI 服务
- 通过 MCP 暴露 Studio 工具
- 外部 Agent / IDE 接入
- npm 包构建与发布脚本
- 插件系统与扩展入口

CLI/MCP 属于终端界面，实际输出示例如下：

```text
$ node bin/hermes-web-ui.mjs --help
$ npx hermes-studio-mcp
```

---

## 整体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                        Electron Desktop                      │
│  ┌────────────────────────┐   ┌───────────────────────────┐  │
│  │  Local Studio Web UI   │   │  Device Manager / Remote  │  │
│  └────────────┬───────────┘   └─────────────┬─────────────┘  │
└───────────────┼─────────────────────────────┼────────────────┘
                │ HTTP / WebSocket            │ SSH tunnel
                ▼                             ▼
┌──────────────────────────────┐   ┌───────────────────────────┐
│  Koa Server / Studio API     │   │  Remote DSH / Hermes /    │
│  - chat sessions             │   │  Studio service           │
│  - research state            │   └───────────────────────────┘
│  - skills / models / usage   │
│  - MCP / App Relay           │
└──────────────┬───────────────┘
               │
      ┌────────┴─────────┐
      ▼                  ▼
┌──────────────┐   ┌──────────────┐
│ node:sqlite  │   │ Local files  │
│ sessions /   │   │ papers /     │
│ users / runs │   │ figures /    │
│              │   │ projects     │
└──────────────┘   └──────────────┘
```

---

## 技术栈

| 层 | 技术 |
|---|---|
| Web UI | Vue 3、TypeScript、Vite、Vue Router、Pinia、Naive UI、Vue I18n |
| 复杂面板 | React 18 islands、Vue Flow、Monaco Editor、Mermaid、PDF.js、KaTeX |
| 服务端 | Node.js >= 23、Koa、Koa Router、Socket.IO、Pino |
| 数据库 | Node.js 内置 `node:sqlite`，WAL 模式 |
| Agent | MedHealthBuddy Agent、Hermes / Ekko Agent、编码 Agent CLI |
| 外部集成 | MCP、FastGPT、SSH、App Relay、Lark/飞书 SDK |
| 桌面 | Electron 42、electron-builder |
| 文档/论文 | LaTeX、Tectonic、Markdown、pptxgenjs |
| 语音 | WebRTC / Socket.IO、sherpa-onnx、TTS/STT |
| 测试 | Vitest、Vue Test Utils、Playwright |

---

## 安装与使用

### 环境要求

- Node.js **>= 23**
- npm
- Windows / macOS / Linux
- 可选：Python、Tectonic/LaTeX、SSH 客户端
- 可选：目标编码 Agent 的本地 CLI

### 1. Web UI 开发

```bash
git clone https://github.com/wake1999/MedHealthBuddy.git
cd MedHealthBuddy/studio
npm install
npm run build
npm run dev
```

默认地址：

```text
http://127.0.0.1:8648
```

### 2. 生产构建

```bash
cd studio
npm run build
PORT=8648 BIND_HOST=0.0.0.0 node dist/server/index.js
```

健康检查：

```text
GET /health/ready
```

### 3. 桌面应用

```bash
cd studio
npm run build:desktop:win
```

输出：

```text
studio/packages/desktop/release/MedHealthBuddy-<version>-x64.exe
```

本地启动：

```text
start-studio.cmd
```

### 4. 远程模式

在根目录创建 `.deploy.local`，第一行填写：

```text
user@your-server
```

然后：

```text
start-studio.cmd remote
```

远程模式会建立：

```text
127.0.0.1:8648 → remote:8648
```

### 5. 远程连接器

```bash
pnpm install
setup-electron-runtime.cmd
start-remote-connector.cmd
```

### 6. 常用测试

```bash
cd studio
npm run test
npm run test:e2e
npx vue-tsc -b --force
npx tsc --noEmit -p packages/server/tsconfig.json
```

---

## 目录结构

```text
MedHealthBuddy/
├── studio/                         # 当前 Studio 产品源码
│   ├── packages/
│   │   ├── client/                 # Vue Web UI
│   │   │   ├── src/views/          # 页面
│   │   │   ├── src/features/       # 科研工作台等大型功能岛
│   │   │   ├── src/components/     # 通用组件
│   │   │   ├── src/stores/         # Pinia 状态
│   │   │   └── src/api/            # API Client
│   │   ├── server/                 # Koa API、SQLite、MCP、Relay
│   │   ├── desktop/                # Electron 桌面应用
│   │   ├── ekko-agent/             # Agent Runtime 与内置技能
│   │   ├── skills/                 # 技能资源
│   │   └── esp32-c3/               # MCU 固件
│   ├── docs/
│   │   ├── architecture/           # 架构图与设计说明
│   │   └── chat-chain-changes/     # 变更记录
│   ├── tests/                      # Vitest / Playwright 测试
│   ├── scripts/                    # 构建与开发脚本
│   └── dist/                       # 构建产物（Git 忽略）
│
├── packages/                       # 远程连接器
│   └── desktop/                    # SSH → DSH/Hermes/Studio
├── docs/                           # 仓库级文档与截图
│   ├── screenshots/
│   └── workspace-structure.md
├── scripts/                        # 同步/部署脚本
├── data/                           # 本地运行数据（不提交）
├── .electron-dist-cache/           # Electron 运行时缓存
├── start-studio.cmd                # Studio 统一入口
├── start-remote-connector.cmd      # 远程连接器入口
├── deploy-studio.ps1               # 源码同步脚本
├── README.md
├── PROVENANCE.md
├── LICENSE
└── NOTICE
```

---

## 数据、安全与边界

- 科研项目、文献、证据、Claim、实验和快照保存在本地 Profile 中。
- 会话、账户、角色和模型配置保存在本地 SQLite。
- 远程设备的会话和浏览器存储按服务地址隔离。
- SSH 私钥、模型 API Key 不会写入 Research Run 报告。
- 自动抽取只保存能在原文定位的引文。
- 生成报告不会补写缺失事实。
- 不要提交模型 API Key、SSH 私钥、患者数据或 `.deploy.local`。
- 自动证据抽取仍受全文长度和模型上下文限制。
- Claim 映射和自动结果判定是辅助，不替代人工审核。
- 统计检验使用近似方法，不替代完整统计分析。
- 不支持临床诊断、治疗决策或自动伦理审查。

---

## 开发与测试

常用命令：

```bash
cd studio
npm run dev
npm run build
npm run test
npm run test:e2e
npm run harness:check
npm run harness:memory
```

类型检查：

```bash
cd studio
npx vue-tsc -b --force
npx tsc --noEmit -p packages/server/tsconfig.json
```

桌面端：

```bash
cd studio/packages/desktop
npm run dev
npm run dist:win
```

提交前请确认：

- 不提交 `node_modules`、`dist`、`release`、`.deploy.local`
- 不提交 API Key、SSH 私钥和患者数据
- 不提交一次性的 `.tmp-*` 脚本或临时截图
- 修改 UI 时补充对应真实截图
- 修改权限逻辑时同时验证只读用户

---

## 贡献方式

1. Fork 本仓库并创建功能分支：

   ```bash
   git checkout -b feat/your-feature
   ```

2. 保持改动聚焦，避免把构建产物、备份和个人配置带入提交。
3. 为服务端逻辑补充 Vitest 测试，为关键 UI 流程补充 Playwright 测试。
4. 提交前运行类型检查和测试。
5. 提交 Pull Request，说明：
   - 解决的问题
   - 主要改动
   - 验证方式
   - 真实截图
   - 对权限、数据迁移和兼容性的影响

发现安全或数据隔离问题时，请优先通过私下渠道联系维护者，不要直接公开患者数据或密钥。

---

## 许可证

本仓库包含两层许可证：

```text
根目录 MedHealthBuddy 集成代码：MIT，见 LICENSE
studio/ 上游 Ekko Studio 及相关组件：BSL-1.1，见 studio/LICENSE
```

第三方依赖和来源记录见：

```text
NOTICE
PROVENANCE.md
studio/LICENSE
```

使用、分发或商用前请分别阅读对应目录的许可证。上游项目声明和许可证信息必须保留。

---

## 截图资源清单

截图统一放在 `docs/screenshots/`，当前使用 1440×900 的真实运行画面；GitHub 页面通过 jsDelivr CDN 加载，避免 `raw.githubusercontent.com` 重定向失败。

| 文件 | 模块 | 建议画面 |
|---|---|---|
| `chat.png` | 单聊 | 会话列表、消息流、Agent 选择器、工具调用 |
| `group-chat.png` | 群聊 | 多 Agent 房间、成员面板、共享链接 |
| `research-overview.png` | 科研总览 | 项目阶段、统计卡片、最近动态 |
| `research-runs.png` | 研究运行 | Run 阶段、审批卡片、自动流程 |
| `research-papers.png` | 文献 | 项目文献卡片、筛选和 PDF 状态 |
| `workflow.png` | 工作流 | Vue Flow 画布、节点和运行日志 |
| `jobs-kanban.png` | 任务/看板 | Job 列表、看板列和状态 |
| `coding-agents.png` | 编码 Agent | Agent 选择器和工作区配置 |
| `skill-market.png` | 技能市场 | 技能卡片、安装和启停 |
| `prompt-templates.png` | 提示词模板 | 分类、编辑和胶囊 |
| `models.png` | 模型 | Provider、路由、回退 |
| `usage.png` | 用量 | Token/费用趋势和分解 |
| `connections.png` | 连接 | 设备、App Relay、终端 |
| `settings-rbac.png` | 权限 | 用户、角色、模块权限 |
| `desktop.png` | 桌面端 | 真实 Electron 桌面窗口 |
| `remote-connector.png` | 远程连接器 | SSH 连接状态和会话 |
| CLI/MCP | 终端 | 使用命令示例，不需要 GUI 截图 |

新增模块请按上表命名补充真实截图；已有截图不要用占位图覆盖。`install.png`、`server.png`、`sessions.png`、`settings.png` 为早期截图，可按需更新。
