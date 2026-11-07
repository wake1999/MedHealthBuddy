# MedHealthBuddy

MedHealthBuddy 是一个本地优先的科研工作台，面向文献驱动的证据整理、研究运行、实验计划和论文草稿。桌面端基于 Electron，Web UI 与服务端基于 Node.js。

> 仅用于科研与工程验证，不用于临床诊断、治疗或医疗决策。自动抽取、自动判定和统计结果都需要人工复核。

## 启动入口

当前 Studio 桌面应用统一使用：

```text
start-studio.cmd            本地模式（默认）
start-studio.cmd local      本地模式
start-studio.cmd remote     SSH 隧道连接远程 Studio
```

本地模式也可以打开应用内的“设备管理”，添加远程 Studio 服务并切换，不需要单独重启。

兼容入口仍然保留：

```text
start-studio-local.cmd      → start-studio.cmd local
start-studio-desktop.cmd    → start-studio.cmd remote
```

根目录 `packages/desktop` 是独立的**远程连接器**，通过系统 SSH 连接服务器上的 DSH、Hermes 或其他兼容服务；入口为：

```text
start-remote-connector.cmd
```

`start-desktop.cmd` 作为兼容包装保留。

## 当前能力

### Research Run

研究运行把一次研究拆成可恢复的阶段，而不是一段长对话：

```text
界定问题
→ 文献
→ 证据表
→ Claim 审核
→ 研究假设
→ 实验
→ 结果分析
```

每个阶段都有持久化状态、产物和人工门禁。中断后可以从已保存的阶段继续。

### 文献与证据

- 读取论文全文，保留页码标记
- 自动抽取来源证据
- 校验引文是否能在原文中定位
- 自动计算真实页码，而不是相信模型给出的页码
- 证据来源可跳转回论文阅读器
- 手动添加、编辑、删除证据
- 证据表人工批准后锁定

### Claim 审核

- 从证据表归纳 Claim
- 每条 Claim 必须绑定真实 evidence id
- 审核状态：待审核 / 已批准 / 已驳回 / 证据不足
- 证据覆盖统计
- 矛盾证据标记
- 进入假设前必须至少批准一条 Claim，并处理证据不足和矛盾项

### 实验

- 结构化研究假设与证伪条件
- 实验计划：数据集、基线、指标、seed、命令、资源、停止条件
- 指标 schema：目标值、基线、最小提升
- 通过 SSH 提交实验任务并绑定实验记录
- 刷新 job 状态，读取日志尾部
- 从日志解析指标和失败类型
- 多 seed 均值、标准差、95% CI
- 配对 t 近似、Wilcoxon 精确/近似检验、Holm 校正
- 自动结果判定；人工改判必须填写理由

### 论文

- 生成 Research Run Markdown 报告
- 生成 Results 草稿
- 输出 Markdown 和 LaTeX
- 自动生成主结果表
- 引用项目中已有的 figure
- 没有 figure 时输出占位和警告
- 插入 `main.tex` 前自动创建快照
- 插入后调用 LaTeX 编译并返回日志

## 科研门禁

当前流程坚持“可生成，但不代替人判断”：

- 证据表必须人工批准
- Claim 必须人工审核
- 进入假设阶段需要已批准的 Claim
- 实验结果必须确认是最终结果
- 自动判定与人工选择不一致时必须填写理由
- 论文编译失败不会静默通过

## 安装与发布产物

这个 Git 仓库只保存源码。安装包、`.tgz` 和 `release-*` 目录都是构建产物，不提交到 Git，所以在 README 里不会直接看到可下载的二进制文件。

### Windows 安装包

在源码目录构建：

```bash
cd studio
npm install
npm run build:desktop:win
```

默认输出类似：

```text
studio/packages/desktop/release-*/MedHealthBuddy-0.8.11-x64.exe
```

安装包体积约 1.1 GB，不放进 Git 仓库。

### npm 包

生成 npm tarball：

```bash
cd studio
npm run pack:npm -- release/npm
```

产物：

```text
studio/release/npm/medhealthbuddy-webui-0.7.35.tgz
```

本地安装：

```bash
npm install -g ./release/npm/medhealthbuddy-webui-0.7.35.tgz
medhealthbuddy
```

要求 Node.js >= 23。

当前包名为 `medhealthbuddy-webui`，**尚未发布到 npm registry**，所以不能直接使用：

```bash
npm install -g medhealthbuddy-webui
```

要对外发布安装包，应在 GitHub Releases 中上传 `.exe` 和 `.tgz`，不要提交进 Git 历史。

## 快速开始

要求：

- Node.js >= 23
- Windows / macOS / Linux
- 需要 LaTeX 编译时安装 `latexmk`、`tectonic` 或 `pdflatex`

### Web UI 开发

```bash
cd studio
npm install
npm run build
npm run dev
```

默认打开：

```text
http://127.0.0.1:8648
```

### 桌面端开发

```bash
cd studio/packages/desktop
npm install
npm run dev
```

### 构建 Windows 安装包

```bash
cd studio
npm run build:desktop:win
```

安装包输出到 `studio/packages/desktop/release-*`。

## 测试

```bash
cd studio
npm run test
npx vue-tsc -b --force
npx tsc --noEmit -p packages/server/tsconfig.json
```

## 目录

```text
studio/                       主应用
  packages/server/            服务端与科研工作台 API
  packages/client/            Web UI
  packages/desktop/           Electron 桌面壳
  packages/ekko-agent/        Agent 与内置 Skill
  packages/ekko-agent/skills/ 科研 Skill
```

## 数据与安全

- 研究项目、文献、证据、Claim、实验和快照保存在本机科研 profile 中
- SSH 密钥和模型 API Key 不会写入 Research Run 报告
- 自动抽取只保存能在原文定位的引文
- 生成报告不会调用模型，不会补写缺失事实
- 不要提交模型 API Key、SSH 私钥或患者数据

## 已知边界

- 自动证据抽取仍受全文长度和模型上下文限制
- 抽取任务是后台任务，但进度状态保存在内存中，服务重启后会丢失
- Claim 映射是辅助归纳，不能替代人工审核
- 统计检验使用近似方法，不能替代完整统计分析
- 自动结果判定只适用于已配置目标值和基线的指标
- 论文 Results 是草稿，不自动写完整论文
- 没有自动投稿、自动伦理审查或临床验证能力

## 仓库

```text
https://github.com/wake1999/MHB-Studio-v2
```

## License

BSL-1.1。使用和分发时请保留上游项目声明与许可证信息。
