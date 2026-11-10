/**
 * Controlled specialist roles for the MedHealthBuddy research agent.
 *
 * This is deliberately a static catalog, not an AgentOS-style emergent
 * specialist factory. A role changes the focus and tool boundary of a
 * delegated task; it cannot install tools, spawn arbitrary agents, or bypass
 * the parent approval/tool policy.
 */
export type MedHealthSpecialistId =
  | 'research-lead'
  | 'literature-scout'
  | 'evidence-reviewer'
  | 'protocol-designer'
  | 'statistician'
  | 'medical-writer'
  | 'data-steward'

export const DEFAULT_MAX_DELEGATION_DEPTH = 2

export interface MedHealthSpecialistDefinition {
  id: MedHealthSpecialistId
  label: string
  labelZh: string
  description: string
  descriptionZh: string
  instructions: string
  /**
   * Tool allowlist for the delegated child. An empty array means no tools.
   * `delegate_task` is intentionally present only on research-lead, which is
   * what makes the hierarchy a controlled two-level tree.
   */
  allowedTools: readonly string[]
}

const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
  'browser_press',
  'browser_get_images',
  'browser_vision',
  'browser_console',
] as const

const COMMON_RESEARCH_TOOLS = [
  'read_file',
  'view_image',
  'skill_view',
  'update_plan',
  'clarify',
] as const

export const MEDHEALTH_SPECIALISTS: readonly MedHealthSpecialistDefinition[] = [
  {
    id: 'research-lead',
    label: 'Research lead',
    labelZh: '研究负责人',
    description: 'Plan a small evidence team, delegate bounded specialist tasks, and merge the findings.',
    descriptionZh: '规划小规模证据团队，拆分任务并汇总结论。',
    instructions: [
      'Act as the lead for a bounded research task.',
      'Break the task into at most three specialist assignments with explicit evidence requirements.',
      'Use delegate_task only for a genuinely separable subproblem; do not delegate the same task repeatedly.',
      'Reconcile disagreements between specialists and return the final synthesis with unresolved uncertainty.',
      'Do not make clinical recommendations; surface decisions that require investigator review.',
    ].join('\n'),
    allowedTools: [
      ...COMMON_RESEARCH_TOOLS,
      ...BROWSER_TOOLS,
      'delegate_task',
    ],
  },
  {
    id: 'literature-scout',
    label: 'Literature scout',
    labelZh: '文献侦察',
    description: 'Find and screen literature, then return a traceable evidence table.',
    descriptionZh: '检索和筛选文献，输出可追溯证据表。',
    instructions: [
      'Focus on search strategy, inclusion/exclusion criteria, and source traceability.',
      'Return a compact evidence table with title, year, study type, population, key finding, limitation, and identifier (DOI/PMID/URL).',
      'Never invent a citation, DOI, PMID, or finding. Mark unverified metadata explicitly.',
      'Do not make clinical recommendations.',
    ].join('\n'),
    allowedTools: [...COMMON_RESEARCH_TOOLS, ...BROWSER_TOOLS],
  },
  {
    id: 'evidence-reviewer',
    label: 'Evidence reviewer',
    labelZh: '证据审查',
    description: 'Critically appraise evidence quality and identify uncertainty.',
    descriptionZh: '审查证据质量、偏倚和不确定性。',
    instructions: [
      'Audit the supplied claims and citations for provenance, consistency, and risk of bias.',
      'Separate direct evidence, indirect evidence, assumptions, and unsupported statements.',
      'Flag contradictions and missing denominators; propose the minimum evidence needed to resolve them.',
      'Do not make clinical recommendations or silently repair missing citations.',
    ].join('\n'),
    allowedTools: [...COMMON_RESEARCH_TOOLS, ...BROWSER_TOOLS],
  },
  {
    id: 'protocol-designer',
    label: 'Protocol designer',
    labelZh: '方案设计',
    description: 'Draft research protocol components for human review.',
    descriptionZh: '起草研究方案组件，标记需人工复核的决策。',
    instructions: [
      'Focus on PICO/PECO, eligibility criteria, endpoints, visit schedule, and operational feasibility.',
      'Label every draft decision as a proposal requiring investigator review.',
      'Call out ethical, regulatory, and data-governance questions rather than deciding them.',
      'Do not produce patient-specific eligibility decisions or treatment advice.',
    ].join('\n'),
    allowedTools: [...COMMON_RESEARCH_TOOLS, 'write_file'],
  },
  {
    id: 'statistician',
    label: 'Statistician',
    labelZh: '统计设计',
    description: 'Design analysis plans and check statistical assumptions.',
    descriptionZh: '设计统计方案、检查假设和敏感性分析。',
    instructions: [
      'Focus on estimands, analysis populations, missing-data handling, sample size, and sensitivity analyses.',
      'State assumptions and the consequences of violating them.',
      'Distinguish pre-specified analyses from exploratory analyses.',
      'Do not claim causality from observational associations without an explicit causal design.',
    ].join('\n'),
    allowedTools: [
      ...COMMON_RESEARCH_TOOLS,
      'write_file',
      'code_exec',
      'script.py',
      'script.mjs',
    ],
  },
  {
    id: 'medical-writer',
    label: 'Medical writer',
    labelZh: '医学写作',
    description: 'Turn verified material into a structured research draft.',
    descriptionZh: '基于已核实材料撰写结构化科研草稿。',
    instructions: [
      'Write only from supplied evidence and clearly mark gaps.',
      'Keep claims proportional to the evidence and preserve citation traceability.',
      'Use a structured scientific style; distinguish results, interpretation, and limitations.',
      'Do not add citations or clinical recommendations that are not present in the source material.',
    ].join('\n'),
    allowedTools: [...COMMON_RESEARCH_TOOLS, 'write_file'],
  },
  {
    id: 'data-steward',
    label: 'Data steward',
    labelZh: '数据治理',
    description: 'Review dataset schema, quality, provenance, and PHI boundaries.',
    descriptionZh: '检查数据 schema、质量、来源和 PHI 边界。',
    instructions: [
      'Focus on schema consistency, missingness, provenance, units, and de-identification.',
      'Identify direct and quasi-identifiers; recommend minimization and access controls.',
      'Keep raw patient data local unless an approved workflow explicitly permits transfer.',
      'Do not infer diagnoses or re-identify individuals.',
    ].join('\n'),
    allowedTools: [
      ...COMMON_RESEARCH_TOOLS,
      'write_file',
      'code_exec',
      'script.py',
      'script.mjs',
      'terminal_exec',
    ],
  },
]

const SPECIALIST_BY_ID = new Map<string, MedHealthSpecialistDefinition>(
  MEDHEALTH_SPECIALISTS.map(item => [item.id, item]),
)

export function getMedHealthSpecialist(id: string | undefined | null): MedHealthSpecialistDefinition | null {
  const key = String(id || '').trim()
  return key ? SPECIALIST_BY_ID.get(key) ?? null : null
}

export function medHealthSpecialistPrompt(id: string | undefined | null): string {
  const specialist = getMedHealthSpecialist(id)
  if (!specialist) return ''
  return [
    `## Specialist role: ${specialist.label}`,
    specialist.instructions,
    'Stay within this role. Return evidence and uncertainty to the parent agent; do not make final clinical decisions.',
  ].join('\n\n')
}

/**
 * A child may delegate only when the run is still below the configured depth
 * limit AND the role's allowlist explicitly includes delegate_task.
 */
export function canDelegateAtDepth(
  depth: number,
  maxDepth: number,
  allowedTools: readonly string[] | undefined,
): boolean {
  if (!Number.isFinite(depth) || !Number.isFinite(maxDepth)) return false
  if (depth === 0) return true
  return depth < Math.max(1, Math.floor(maxDepth))
    && Boolean(allowedTools?.includes('delegate_task'))
}

export function isToolAllowedForRun(
  toolName: string,
  depth: number,
  maxDepth: number,
  allowedTools: readonly string[] | undefined,
): boolean {
  if (allowedTools && !allowedTools.includes(toolName)) return false
  if (toolName !== 'delegate_task') return true
  return canDelegateAtDepth(depth, maxDepth, allowedTools)
}

export function specialistCatalogPrompt(): string {
  return [
    '## Available specialist roles',
    ...MEDHEALTH_SPECIALISTS.map(item => `- ${item.id}: ${item.description}`),
    'Choose a role only when it materially changes the task. Delegation is advisory: the parent agent remains responsible for the final answer.',
  ].join('\n')
}
