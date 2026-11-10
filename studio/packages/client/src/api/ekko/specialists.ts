import { request } from '@/api/client'

export interface AgentSpecialist {
  id: string
  label: string
  labelZh: string
  description: string
  descriptionZh: string
  allowedTools: string[]
  canDelegate: boolean
  preferredModel?: string
}

export interface AgentSpecialistCatalog {
  maxDelegationDepth: number
  specialists: AgentSpecialist[]
}

export async function fetchAgentSpecialists(): Promise<AgentSpecialistCatalog> {
  return request<AgentSpecialistCatalog>('/api/ekko/agent/specialists')
}
