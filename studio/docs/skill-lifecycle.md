# Skill 生命周期与对外暴露

更新时间：2026-11-07

本文说明 MedHealthBuddy 中 Skill 的沉淀、共享和对外交互能力，以及当前实现边界。

## 1. 能力矩阵

| 能力 | 状态 | 入口 / 实现 |
|---|---|---|
| 第三方导入：技能市场安装 | 已实现 | 技能市场 → 安装 → 选择 Agent/分类 |
| 第三方导入：ZIP / 文件夹 | 已实现 | 添加技能 → 安装技能包；`POST /api/hermes/skills/import` |
| 用户自行构建 | 已实现 | 添加技能 → 新建技能；`POST /api/hermes/skills/create` |
| 编辑已有本地技能 | 已实现 | `SkillDetail` → 编辑；`PUT /api/ekko/skills/:name` |
| 技能启停 | 已实现 | 技能市场开关；Ekko/Hermes 配置 |
| 技能导出 / 分享 | 已实现 | 已安装技能行 → 导出 / 分享；`GET /api/hermes/skills/:category/:skill/export` |
| 导入分享包 | 已实现 | 与第三方 ZIP 导入共用 |
| 对外读取技能契约 | 已实现 | `GET /api/ekko/skills/:name/prompt` |
| 外部 MCP 发现/加载技能 | 已实现 | MCP `prompts/list`、`prompts/get` |
| 公开技能市场发布 | 未实现 | 当前使用 ZIP/市场外部源 |
| 分享链接 / 二维码 | 未实现 | 当前分享边界是 ZIP |
| 技能签名与完整性校验 | 未实现 | 计划增加 manifest + signature |
| 技能执行 Runtime | 未实现 | 当前 MCP prompt 把技能指令交给调用方执行 |
| 单技能级 RBAC | 未实现 | 当前沿用模块权限和管理员权限 |

## 2. 沉淀路径

### 2.1 第三方导入

```text
技能市场搜索
→ 选择 Agent / 分类
→ 安装到 skills 目录
→ 写入启停配置
→ 技能出现在已安装列表
```

也支持把本地 ZIP 或整个文件夹导入：

```text
技能市场 → 添加技能
→ 安装技能包
→ 选择目标 Agent 和目录
→ POST /api/hermes/skills/import?target=<agent>
```

也可以继续使用独立导入弹窗：

```text
SkillImportModal
→ POST /api/hermes/skills/import
或 Ekko：POST /api/ekko/skills/import
```

### 2.2 用户自行构建

入口：

```text
技能市场 → 添加技能 → 新建技能
```

实现：

```text
POST /api/hermes/skills/create?target=<agent>
```

写入所选 Agent 的目录；普通登录用户只能写入自己的 Profile，不经过超级管理员创建接口。`target=ekko`、`target=hermes` 等均可在同一弹窗中选择。

SKILL.md 必须包含：

```yaml
---
name: weekly-report
description: 把记录整理成周报
metadata:
  keywords:
    - weekly-report
---
```

`metadata.keywords` 是当前技能校验的必填字段。

### 2.3 技能共享

当前使用可移植 ZIP 作为共享格式：

```text
已安装技能
→ 行操作菜单「导出 / 分享」
→ GET /api/hermes/skills/:category/:skill/export
→ skill-name.zip
→ 对方通过技能导入导入
```

这样不需要额外的中心化存储，也避免把私有技能自动上传到第三方服务。

## 3. 对外暴露

### 3.1 HTTP 只读契约

```text
GET /api/ekko/skills
GET /api/ekko/skills/:name/prompt
```

`prompt` 返回：

```json
{
  "ok": true,
  "prompt": {
    "name": "weekly-report",
    "description": "把记录整理成周报",
    "category": "productivity",
    "content": "SKILL.md 内容"
  }
}
```

该接口不返回文件系统路径，也不暴露管理写操作。

### 3.2 MCP Prompts

MCP 服务已声明：

```json
"capabilities": { "tools": {}, "prompts": {} }
```

提供：

```text
prompts/list
prompts/get
```

外部 MCP 客户端可以：

1. 列出当前 Profile 的可用技能；
2. 通过技能名加载完整 SKILL.md；
3. 可选传入 `input`，把它附加到技能指令后交给外部 Agent 执行。

执行仍由调用方 Agent 负责，Studio 不替外部客户端调用模型。

## 4. 当前边界与后续方案

### 公开分享链接

当前未实现。原因是没有中心化技能存储和权限模型；直接实现会引入公开托管、滥用和版本管理问题。

建议：

```text
Phase 2：技能分享 manifest
- 生成 skill-id / version / checksum
- 上传到对象存储或 GitHub Release
- 生成只读分享链接
- 导入时校验 checksum
```

### 技能签名

当前只做 ZIP 导入和目录校验，没有签名。建议后续：

```text
manifest.json + SHA-256
→ 可选 ed25519 签名
→ 导入时校验来源和文件哈希
```

### 技能执行 Runtime

当前 MCP 将技能作为 prompt 暴露给外部 Agent；Studio 不直接执行技能脚本。若需要直接执行：

```text
POST /api/ekko/skills/:name/invoke
→ 选择模型 / Agent
→ 绑定输入 schema
→ 写入 SkillUsage
→ 返回运行结果
```

需要同时加入超时、成本、权限和审计。

### 单技能 RBAC

当前技能管理沿用模块权限和管理员权限，尚未做单技能 ACL。建议：

```text
skill.read:<name>
skill.write:<name>
skill.share:<name>
```

## 5. 验证

已通过：

```text
第三方 ZIP 导入                 已有实现
普通用户创建本地技能            201
管理员创建本地技能              201
创建到 ekko target              201 / 列表可见
创建到 hermes target            201 / 列表可见
ZIP 导入到 ekko target          200 / 列表可见
导出 ZIP                        200 / application/zip
删除测试技能                    200
MCP prompts/list                31 个技能
MCP prompts/get                 返回技能内容并附加 input
```
