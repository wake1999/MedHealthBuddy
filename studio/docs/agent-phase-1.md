# MedHealthBuddy Agent：第一阶段

## 目标

保留现有 `ekko-agent` 运行时，不从 TypeScript 迁移到 Python，也不引入 AgentOS 的运行时替代。

第一阶段只吸收 AgentOS 中与 MedHealthBuddy 最相关的设计：

- 受控的多 Agent 分工
- 类型化的专家角色
- 证据优先的审查边界
- 不引入运行时自写工具
- 不引入递归专家生成

## 查看位置

```text
Agent 管理 → MedHealthBuddy 卡片 → 专家团队
```

弹窗展示：

- 7 个专家角色
- 每个角色的用途
- 每个角色的工具白名单
- 是否允许继续委派
- 最大委派深度

## 本次实现

### 1. 静态专家角色目录

新增：

```text
studio/packages/ekko-agent/src/orchestration/specialists.ts
```

角色：

| 角色 | 用途 | 可委派 |
|---|---|---|
| `research-lead` | 规划小团队、拆分任务并汇总证据 | 是，仅此角色 |
| `literature-scout` | 检索和筛选文献，输出可追溯证据表 | 否 |
| `evidence-reviewer` | 审查证据质量、偏倚和不确定性 | 否 |
| `protocol-designer` | 起草研究方案组件，标记需人工确认的决策 | 否 |
| `statistician` | 统计设计、假设、样本量和敏感性分析 | 否 |
| `medical-writer` | 基于已核实材料撰写科研草稿 | 否 |
| `data-steward` | 数据 schema、质量、来源和 PHI 边界 | 否 |

### 2. `delegate_task` 支持角色

`delegate_task` 新增可选参数：

```json
{
  "goal": "...",
  "mode": "foreground",
  "specialist": "evidence-reviewer"
}
```

约束：

- 只接受静态角色目录中的 ID
- 最多两层：父 Agent → `research-lead` → 专家
- 只有 `research-lead` 的 allowlist 包含 `delegate_task`
- 第二层专家不能再委派
- 角色只影响任务提示、审查视角和工具白名单
- 最终结论仍由父 Agent 负责
- 不执行动态生成的专家代码
- 不绕过现有工具授权、审批和记忆策略

### 3. 半自动确认

顶层专家委派不是静默执行。父 Agent 选中专家后会先弹出确认：

```text
建议调用专家「证据审查」：审查证据质量、偏倚和不确定性。
确认后会委派一个隔离子 Agent，使用该角色的工具白名单完成任务。
是否继续？

[调用专家] [取消]
```

行为：

- 用户点“调用专家”才执行
- 用户点“取消”则返回父 Agent，不创建子 Agent
- 没有确认通道时失败关闭，不自动委派
- `research-lead` 获批准后的内部委派不重复打断用户

### 4. 角色级工具白名单

每个专家有独立的工具 allowlist。运行时同时做两层限制：

1. 模型请求里不展示未授权工具；
2. 即使模型绕过 schema 调用，也会在执行前被拒绝。

例如：

```text
evidence-reviewer 不允许 terminal_exec
data-steward 允许 terminal_exec
只有 research-lead 允许 delegate_task
```

默认最大委派深度：

```ts
maxDelegationDepth = 2
```

### 3. 角色提示词

角色提示词明确要求：

- 不伪造 DOI、PMID、引用或研究结论
- 区分直接证据、间接证据、假设和未支持陈述
- 不给出临床诊断或治疗建议
- 方案和统计决策标记为需要人工复核
- 原始患者数据默认留在本地

## 验证

```text
专家角色枚举                 通过
合法角色传递给运行时         通过
非法角色被拒绝               通过
角色提示词包含临床边界       通过
两层委派深度限制             通过
Lead 才可继续委派            通过
角色工具白名单               通过
运行时模型工具列表过滤       通过
白名单外工具执行拦截         通过
半自动确认后启动子 Agent     通过
确认取消不创建子 Agent       通过
无确认通道失败关闭           通过
运行时回归测试               65 passed
新增测试                     13 passed
ekko-agent 类型检查          通过
```

## 后续阶段

第一阶段暂不包含：

- 技能市场中的角色选择 UI
- 角色预算/最大委派次数
- 角色级评估集和回归基准
- 动态专家生成
- 运行时自写工具

这些能力应在有真实评测结果和医疗安全评审后再逐步引入。

## 与 AgentOS / Agno 的关系

- 借鉴 AgentOS 的“专家分工”思想，但使用静态角色和现有 `ekko-agent` 委派机制。
- 不采用 AgentOS 的 Emergent Forge 和动态专家铸造。
- 暂不引入 Agno 的 Python Control Plane；未来需要企业治理时再作为独立服务评估。
