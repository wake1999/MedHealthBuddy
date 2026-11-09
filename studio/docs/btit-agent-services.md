# BTIT 智能体服务接入

BTIT 场景下的 14 个智能体统一走外部的 `5090` 服务网关：

```text
POST http://36.140.151.191:5090/api/services/<slug>/chat
Authorization: Bearer <service-key>
Content-Type: application/json

{
  "message": "user message",
  "conversationId": 40,
  "variables": {},
  "metadata": {}
}
```

服务返回普通 JSON：

```json
{
  "ok": true,
  "service": "collect-file",
  "conversation": { "id": 40 },
  "reply": "..."
}
```

## 服务映射

| appId | 服务 slug | 智能体 |
|---|---|---|
| `6a9fcb10346bb4e43a8de666` | `file-download` | 文件下载 |
| `6a9f890d4462925b788de668` | `collect-file` | 采集文件 |
| `6a9f890d4462925b788de667` | `collect-record` | 采集记录 |
| `6a9fcb10346bb4e43a8de667` | `signal-parse` | 信号解析 |
| `6aa0c9714949d182eb8de667` | `ontology-compose` | 本体组合 |
| `6aa0c9714949d182eb8de666` | `metadata-compose` | 元数据组合 |
| `6a9fbda643ba3da4fa8de667` | `file-algorithm-link` | 文件算法关联 |
| `6a9fcb10346bb4e43a8de668` | `quality-check` | 质量校验 |
| `6aa0dc9b91b8c1cf048de667` | `metric-report` | 指标报告 |
| `6a9fbda643ba3da4fa8de666` | `pipeline-schedule` | 编排调度 |
| `6a9f890d4462925b788de666` | `auth-token` | 认证 |
| `6aa3a50056f8e51cf88de666` | `llm-assistant` | LLM 助手 |
| `69b7587d330e92f004b3f7b5` | `subject-mining` | 潜在受试者挖掘 v2.0 |
| `69a987978b217b5660504fee` | `plan-generate` | 个性化方案生成 |

## 密钥存储

服务密钥不进入 Git，也不下发给浏览器。服务端从以下文件读取：

```text
<HERMES_WEBUI_STATE_DIR 或 HERMES_WEB_UI_HOME>/agent-service-keys.json
```

或通过环境变量指定：

```text
STUDIO_AGENT_SERVICE_KEYS_FILE=/path/to/agent-service-keys.json
```

文件格式：

```json
{
  "6a9fcb10346bb4e43a8de666": "sk_live_...",
  "6a9f890d4462925b788de668": "sk_live_..."
}
```

`.gitignore` 已忽略 `agent-service-keys.json`。云端文件权限应保持 `600`。

## 代理行为

Studio 前端仍然只调用：

```text
POST /api/studio/fastgpt-agents/chat
```

服务端根据 `appId` 选择：

1. 已配置服务网关 → 调用 `5090`，把 JSON `reply` 转成 SSE `{delta}`；
2. 未配置服务网关 → 保持原来的 FastGPT `/api/v2/chat/completions`。

`chatId` 映射到服务端保存的 `conversationId`，同一 Studio 会话的多轮消息会复用同一个网关会话。

## 当前验证

```text
5090 服务列表                    14 个 running
OpenAPI 契约                     POST /api/services/{slug}/chat
collect-file 鉴权                200
signal-parse 鉴权                200
ontology-compose 鉴权            200
metadata-compose 鉴权            200
file-algorithm-link 鉴权         200
quality-check 鉴权               200
metric-report 鉴权               200
pipeline-schedule 鉴权           200
auth-token 鉴权                  200
llm-assistant 鉴权               200
subject-mining 鉴权              200
plan-generate 鉴权               200
file-download 鉴权               401 / 服务密钥无效
```

云端服务端直接访问 `5090` 时，`collect-file` 返回 `401`，而同一密钥从本地访问返回 `200`。这需要在 `5090` 服务侧确认密钥是否绑定来源 IP/环境，或为云端出口放行；在此之前云端原生智能体对话无法完成真实回复。

## 取消/清理

`agent-service-keys.json`、服务端进程内 `conversationId` 缓存都不需要写入源码或数据库；删除密钥文件后，服务端会自动回退到 FastGPT 或返回未配置错误。
