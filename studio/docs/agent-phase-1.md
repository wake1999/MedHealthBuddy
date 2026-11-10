# MedHealthBuddy Agent：第一阶段

## 目标

保留现有 `ekko-agent` 运行时，不从 TypeScript 迁移到 Python，也不引入 AgentOS 的运行时替代。

第一阶段只吸收 AgentOS 中与 MedHealthBuddy 最相关的设计：

- 受控的多 Agent 分工
- 类型化的专家角色
- 证据优先的审查边界
- 不引入运行时自写工具
- 不引入递归专家生成

## 本次实现

### 1. 静态专家角色目录

新增：

```text
studio/packages/ekko-agent/src/orchestration/specialists.ts
```

角色：

| 角色 | 用途 |
|---|---|
| `literature-scout` | 检索和筛选文献，输出可追溯证据表 |
| `evidence-reviewer` | 审查证据质量、偏倚和不确定性 |
| `protocol-designer` | 起草研究方案组件，标记需人工确认的决策 |
| `statistician` | 统计设计、假设、样本量和敏感性分析 |
| `medical-writer` | 基于已核实材料撰写科研草稿 |
| `data-steward` | 数据 schema、质量、来源和 PHI 边界 |

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
- 子 Agent 不能再委派（现有递归保护保留）
- 角色只影响任务提示和审查视角
- 最终结论仍由父 Agent 负责
- 不执行动态生成的专家代码
- 不绕过现有工具授权、审批和记忆策略

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
单元测试                     4 passed
ekko-agent 类型检查          通过
```

## 后续阶段

第一阶段暂不包含：

- 技能市场中的角色选择 UI
- 每个角色的独立工具白名单
- 角色预算/最大委派次数
- 角色级评估集和回归基准
- 动态专家生成
- 运行时自写工具

这些能力应在有真实评测结果和医疗安全评审后再逐步引入。

## 与 AgentOS / Agno 的关系

- 借鉴 AgentOS 的“专家分工”思想，但使用静态角色和现有 `ekko-agent` 委派机制。
- 不采用 AgentOS 的 Emergent Forge 和动态专家铸造。
- 暂不引入 Agno 的 Python Control Plane；未来需要企业治理时再作为独立服务评估。
