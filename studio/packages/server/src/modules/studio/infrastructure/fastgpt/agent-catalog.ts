/**
 * FastGPT 智能体目录。
 *
 * 首页每个「场景」（BTIT 的数据采集 / 个性化方案生成 / 潜在受试者挖掘）下面挂的
 * 卡片就来自这里。FastGPT 侧的应用本身没有场景字段，所以场景靠应用名映射；
 * 没有 API Key 时用内置清单兜底，配了 `FASTGPT_API_KEY` 就实时拉取应用列表，
 * 名称/简介以 FastGPT 为准，映射不到场景的应用不会出现在卡片里。
 */

import { agentServiceSlug } from './agent-services'

export interface FastGptAgentSeed {
  appId: string
  sceneId: string
  name: string
  /** 卡片封面上的一行短名，去掉「数据采集-」这类公共前缀。 */
  short: string
  desc: string
  /**
   * 免登录分享链接（FastGPT「发布渠道 → 分享链接」里拿到的东西），可以是完整
   * `/chat/share?shareId=...` 地址，也可以只写 shareId。留空则卡片回落到详情弹层。
   */
  shareId?: string
}

/** 卡片挂在哪个 chat app 上。目前只有 BTIT 接了 FastGPT。 */
export const FASTGPT_CHAT_APP_ID = 'btit'

const FALLBACK_TINT = 'linear-gradient(135deg, #6f7f95, #47566b)'

/** 场景显示名，客户端的应用面板按它分组。 */
export const FASTGPT_SCENE_LABELS: Record<string, string> = {
  collect: '数据采集',
  plan: '个性化方案生成',
  recruit: '潜在受试者挖掘',
}

const DEFAULT_BASE_URL = 'http://146.56.201.241:3000'

/**
 * BTIT 三个场景对应的 FastGPT 应用（与 146.56.201.241 上现有应用一致）。
 * 顺序即卡片顺序：先编排/入口，再采集链路，最后两个独立场景。
 */
export const FASTGPT_AGENT_SEEDS: readonly FastGptAgentSeed[] = [
  {
    appId: '6a9fbda643ba3da4fa8de666',
    sceneId: 'collect',
    name: '数据采集-编排调度智能体',
    short: '编排调度',
    desc: '调度采集链路里各子智能体的执行顺序、重试与失败回退。',
    shareId: 't9rS4qKh2WRlURcs5iqSY6fk',
  },
  {
    appId: '6a9f890d4462925b788de666',
    sceneId: 'collect',
    name: '数据采集-认证智能体',
    short: '认证',
    desc: '校验调用方身份与云端凭证，签发采集链路的访问令牌。',
    shareId: 'cKnXFqp7fAvTcyI0YIfw6Njm',
  },
  {
    appId: '6a9f890d4462925b788de667',
    sceneId: 'collect',
    name: '数据采集-采集记录智能体',
    short: '采集记录',
    desc: '按记录粒度登记采集数据，做记录级对账与状态流转。',
    shareId: 'rGYssIFrAYneMXRVcwRDSEyy',
  },
  {
    appId: '6a9f890d4462925b788de668',
    sceneId: 'collect',
    name: '数据采集-采集文件智能体',
    short: '采集文件',
    desc: '清点设备侧文件（算法 JSON、报告、音视频、波形），登记并与记录对账。',
    shareId: 'yhrjn8zzSzCpTtqFx6fn59pQ',
  },
  {
    appId: '6a9fbda643ba3da4fa8de667',
    sceneId: 'collect',
    name: '数据采集-文件算法关联智能体',
    short: '文件算法关联',
    desc: '把采集文件与算法产出关联，形成文件级可追溯的算法链路。',
    shareId: 'zK6SrobTAaoSFIIvXtXtWC0A',
  },
  {
    appId: '6a9fcb10346bb4e43a8de666',
    sceneId: 'collect',
    name: '数据采集-文件下载智能体',
    short: '文件下载',
    desc: '按清单把设备侧文件拉到云端，支持断点续传与完整性核对。',
    shareId: 'bvTS0iKVX2fyS5NVPgOFw30i',
  },
  {
    appId: '6a9fcb10346bb4e43a8de667',
    sceneId: 'collect',
    name: '数据采集-信号解析智能体',
    short: '信号解析',
    desc: '解析设备信号（波形、生理信号）并结构化落库。',
    shareId: 'zbMRjhsDFfk2qRGtESQG3ZtL',
  },
  {
    appId: '6aa0c9714949d182eb8de666',
    sceneId: 'collect',
    name: '数据采集-元数据组合智能体',
    short: '元数据组合',
    desc: '组合元数据定义，生成可执行的采集口径与字段映射。',
    shareId: 'iKxwlqGW6SDkGwc1z9TaMiZi',
  },
  {
    appId: '6aa0c9714949d182eb8de667',
    sceneId: 'collect',
    name: '数据采集-本体组合智能体',
    short: '本体组合',
    desc: '按本体（概念、属性、关系）组合采集结构，供下游查询使用。',
    shareId: 'jaXVqXzI78c7XQJCq9fWInnz',
  },
  {
    appId: '6a9fcb10346bb4e43a8de668',
    sceneId: 'collect',
    name: '数据采集-质量校验智能体',
    short: '质量校验',
    desc: '校验采集数据的完整性、一致性与取值范围，输出问题清单。',
    shareId: 'l8zPfM0omOrpbfIUyPvbe8pJ',
  },
  {
    appId: '6aa0dc9b91b8c1cf048de667',
    sceneId: 'collect',
    name: '数据采集-指标报告智能体',
    short: '指标报告',
    desc: '汇总采集指标并生成结构化报告，带异常项与趋势。',
    shareId: 'slZB9i672ZIrHRwVWCHh4pg1',
  },
  {
    appId: '6aa3a50056f8e51cf88de666',
    sceneId: 'collect',
    name: '数据采集-LLM助手',
    short: 'LLM 助手',
    desc: '采集链路的自然语言助手，解答字段口径、流程与异常处理。',
    shareId: 'loUQK3UExU4R1HuehRc4w9dM',
  },
  {
    appId: '69a987978b217b5660504fee',
    sceneId: 'plan',
    name: '个性化方案生成智能体',
    short: '个性化方案',
    desc: '基于受试者基线特征与既往用药，生成个体化给药方案。',
    shareId: 'jHSWVvey3iBdENQFlHkz7tCP',
  },
  {
    appId: '69b7587d330e92f004b3f7b5',
    sceneId: 'recruit',
    name: '潜在受试者挖掘智能体v2.0',
    short: '受试者挖掘',
    desc: '从病历中筛查符合入排标准的候选受试者，并按入组可能性排序。',
    shareId: 'jXHSO5uElNKg6CgqDohjw6gX',
  },
]

/**
 * 每个智能体自带的预设提示词：选中后输入框上方的胶囊换成本组，点一下直接发。
 * 场景级提示词（上面的 `quickPrompts`）是「还没选智能体」时的兜底。
 */
export const FASTGPT_AGENT_PROMPTS: Record<string, readonly { label: string; text: string }[]> = {
  '6a9fbda643ba3da4fa8de666': [
    { label: '全量跑一遍', text: '全量执行一次采集链路：记录 → 文件 → 关联 → 解析 → 校验，全部跑完。' },
    { label: '只跑增量', text: '只同步设备侧新增的采集记录与文件，已处理过的不要重复拉取。' },
  ],
  '6a9f890d4462925b788de666': [
    { label: '刷新云端凭证', text: '刷新一次云端凭证，并告诉我新的有效期。' },
    { label: '查看凭证状态', text: '检查当前云端凭证还能用多久，需不需要重新登录。' },
  ],
  '6a9f890d4462925b788de667': [
    { label: '同步 CR-10', text: '同步 CR-10 这条采集记录，登记到台账。' },
    { label: '全量同步记录', text: '全量同步所有采集记录，按记录粒度登记并与云端对账。' },
  ],
  '6a9f890d4462925b788de668': [
    { label: '清点文件', text: '清点这条记录在设备侧的所有文件，登记并与记录对账。' },
    { label: '核对文件数量', text: '核对这条记录的文件数量与云端清单是否一致，列出差异。' },
  ],
  '6a9fbda643ba3da4fa8de667': [
    { label: '生成文件关联', text: '为这条记录生成文件与算法的关联关系，标明每条规则命中了哪些文件。' },
    { label: '未匹配文件', text: '列出这条记录里没有匹配上算法的文件，并说明可能原因。' },
  ],
  '6a9fcb10346bb4e43a8de666': [
    { label: '下载文件', text: '把这条记录的设备侧文件拉到云端，支持断点续传并核对完整性。' },
    { label: '校验完整性', text: '校验已下载文件的 MD5 与大小，列出失败或缺失的文件。' },
  ],
  '6a9fcb10346bb4e43a8de667': [
    { label: '解析信号', text: '解析这条记录的波形与生理信号，结构化落库并给出统计摘要。' },
    { label: '解析统计', text: '汇总这条记录已解析的信号条数、指标数与特征数。' },
  ],
  '6aa0c9714949d182eb8de666': [
    { label: '组合元数据', text: '组合这条记录的元数据定义，生成可执行的采集口径与字段映射。' },
    { label: '检查字段映射', text: '检查现有字段映射是否有缺口或类型不匹配。' },
  ],
  '6aa0c9714949d182eb8de667': [
    { label: '组合本体', text: '按本体（概念、属性、关系）组合这条记录的采集结构。' },
    { label: '查看本体关系', text: '列出当前本体里的核心概念与它们之间的关系。' },
  ],
  '6a9fcb10346bb4e43a8de668': [
    { label: '完整质量校验', text: '对这条记录做一次完整质量校验，输出问题清单与严重级别。' },
    { label: '只看问题项', text: '只列出错误与警告项，通过的检查可以省略。' },
  ],
  '6aa0dc9b91b8c1cf048de667': [
    { label: '生成综合报告', text: '生成这条记录的综合指标报告，覆盖全部指标域。' },
    { label: '只看基础域', text: '只解读基础指标域（basic），其它域先跳过。' },
    { label: '列出异常项', text: '把这次采集里的异常项挑出来，说明判定依据。' },
  ],
  '6aa3a50056f8e51cf88de666': [
    { label: '今天采了多少条', text: '今天一共采集了多少条记录？各记录的文件数分别是多少？' },
    { label: 'CR-10 的心率呼吸', text: 'CR-10 的心率、呼吸率和体温分别是多少？' },
    { label: '哪条记录异常', text: '当前记录里有没有文件数或质量异常的需要重点关注？' },
  ],
  '69a987978b217b5660504fee': [
    { label: '生成个体化方案', text: '基于这位受试者的基线特征与既往用药，生成一份个体化给药方案。' },
    { label: '风险与禁忌筛查', text: '列出该方案的主要风险与禁忌，给出监测指标、复查频率与停药标准。' },
  ],
  '69b7587d330e92f004b3f7b5': [
    { label: '筛查候选受试者', text: '从这批病历中筛查符合入排标准的候选受试者，输出命中原因。' },
    { label: '候选优先级排序', text: '把候选受试者按入组可能性排序，并列出每人还需补充的检查项。' },
  ],
}

/** FastGPT 站点地址，可用 `FASTGPT_BASE_URL` 覆盖（不要带结尾斜杠）。 */
export function fastGptBaseUrl(): string {
  const raw = (process.env.FASTGPT_BASE_URL || process.env.FASTGPT_URL || DEFAULT_BASE_URL).trim()
  return raw.replace(/\/+$/, '')
}

/** FastGPT 开放接口密钥；没有就只回内置清单。 */
export function fastGptApiKey(): string {
  return (process.env.FASTGPT_API_KEY || '').trim()
}

/** 应用名 → 场景。改名称前缀就等于改归属，不需要动表。 */
export function fastGptSceneForName(name: string): string | null {
  const value = name.trim()
  if (!value) return null
  if (value.startsWith('数据采集')) return 'collect'
  if (value.includes('受试者')) return 'recruit'
  if (value.includes('方案')) return 'plan'
  return null
}

/** 去掉「数据采集-」这类公共前缀，做卡片封面上的短名。 */
export function fastGptShortName(name: string): string {
  const value = name.trim()
  const cut = value.indexOf('-')
  const short = cut > 0 ? value.slice(cut + 1) : value
  return short.trim() || value
}

/** 同场景内按 appId 哈希取色，避免一屏卡片全是同一块蓝。 */
const SCENE_PALETTES: Record<string, readonly string[]> = {
  collect: [
    'linear-gradient(135deg, #4aa3f0, #2f6fe0)',
    'linear-gradient(135deg, #5f8ff5, #3c5fd8)',
    'linear-gradient(135deg, #3fb6e8, #2566b8)',
    'linear-gradient(135deg, #6fa8e8, #35509c)',
  ],
  plan: [
    'linear-gradient(135deg, #a78bfa, #6d5ce0)',
    'linear-gradient(135deg, #8f7bf0, #5b46c8)',
    'linear-gradient(135deg, #b99cf7, #7a5ee6)',
  ],
  recruit: [
    'linear-gradient(135deg, #34d3c0, #1e9e8f)',
    'linear-gradient(135deg, #2fc3b4, #177f76)',
    'linear-gradient(135deg, #48ddc4, #22a894)',
  ],
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}

export function fastGptTint(sceneId: string, appId = ''): string {
  const palette = SCENE_PALETTES[sceneId]
  if (!palette || palette.length === 0) return FALLBACK_TINT
  return palette[hashString(appId) % palette.length]
}

export interface FastGptAgentView {
  appId: string
  sceneId: string
  /** 场景显示名（数据采集…），应用面板的分组标题。 */
  sceneLabel: string
  name: string
  short: string
  desc: string
  tint: string
  chatUrl: string
  manageUrl: string
  /** 免登录分享链接；空串表示这个智能体还没建分享渠道。 */
  shareUrl: string
  /** 已接入 Studio 服务网关时返回服务 slug。 */
  serviceSlug?: string
  /** 该智能体的预设提示词；选中后替换场景级胶囊。 */
  prompts: readonly { label: string; text: string }[]
}

/**
 * 按 appId 覆盖分享链接，运维改地址不用动代码：
 *
 *   FASTGPT_AGENT_SHARE_LINKS='{"6a9fbda643ba3da4fa8de666":"http://host:3000/chat/share?shareId=abc"}'
 *
 * 值可以是完整 URL，也可以只写 shareId。
 */
function shareLinkOverrides(): Record<string, string> {
  const raw = (process.env.FASTGPT_AGENT_SHARE_LINKS ?? '').trim()
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [appId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = appId.trim()
      if (!id || typeof value !== 'string') continue
      const link = value.trim()
      if (link) out[id] = link
    }
    return out
  } catch {
    return {}
  }
}

/** 分享链接归一成完整 URL：只写了 shareId 的按 FastGPT 的分享路由拼出来。 */
function resolveShareUrl(seed: FastGptAgentSeed, baseUrl: string): string {
  const link = (shareLinkOverrides()[seed.appId] ?? seed.shareId ?? '').trim()
  if (!link) return ''
  if (/^https?:\/\//i.test(link)) return link
  return `${baseUrl}/chat/share?shareId=${encodeURIComponent(link)}`
}

export function fastGptAgentView(seed: FastGptAgentSeed, baseUrl: string): FastGptAgentView {
  return {
    appId: seed.appId,
    sceneId: seed.sceneId,
    sceneLabel: FASTGPT_SCENE_LABELS[seed.sceneId] ?? seed.sceneId,
    name: seed.name,
    short: seed.short,
    desc: seed.desc,
    tint: fastGptTint(seed.sceneId, seed.appId),
    chatUrl: `${baseUrl}/chat?appId=${encodeURIComponent(seed.appId)}`,
    manageUrl: `${baseUrl}/dashboard/agent?appId=${encodeURIComponent(seed.appId)}`,
    shareUrl: resolveShareUrl(seed, baseUrl),
    ...(agentServiceSlug(seed.appId) ? { serviceSlug: agentServiceSlug(seed.appId)! } : {}),
    prompts: FASTGPT_AGENT_PROMPTS[seed.appId] ?? [],
  }
}

export interface FastGptRemoteApp {
  appId: string
  name: string
  intro: string
}

/**
 * 拉 FastGPT 的应用列表（`POST /api/core/app/list`）。
 *
 * 只用来刷新名称/简介；超时或版本对不上就回空数组，调用方继续用内置清单。
 */
export async function fetchFastGptAppList(baseUrl: string, apiKey: string): Promise<FastGptRemoteApp[]> {
  if (!apiKey || typeof fetch !== 'function') return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(`${baseUrl}/api/core/app/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ parentId: null }),
      signal: controller.signal,
    })
    if (!res.ok) return []
    const payload = await res.json() as { data?: unknown }
    const list = Array.isArray(payload?.data) ? payload.data : []
    return list.flatMap((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const id = typeof record._id === 'string' ? record._id : (typeof record.id === 'string' ? record.id : '')
      if (!id) return []
      return [{
        appId: id,
        name: typeof record.name === 'string' ? record.name : '',
        intro: typeof record.intro === 'string' ? record.intro : '',
      }]
    })
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
