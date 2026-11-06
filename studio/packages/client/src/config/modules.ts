/**
 * Client-side mirror of the server module registry. Keep keys aligned with
 * `packages/server/src/modules/studio/repositories/module-permissions.ts`.
 */
export interface AppModuleDefinition {
  key: string
  labelKey: string
  routes: readonly string[]
  prefixRoutes?: readonly string[]
  superAdminOnly?: boolean
}

export const APP_MODULES: readonly AppModuleDefinition[] = [
  { key: 'chat', labelKey: 'sidebar.singleChat', routes: ['hermes.chat', 'hermes.session', 'hermes.globalAgent', 'hermes.globalAgentSession'] },
  { key: 'group', labelKey: 'sidebar.groupChat', routes: ['hermes.groupChat'], prefixRoutes: ['hermes.groupChat'] },
  { key: 'research', labelKey: 'sidebar.research', routes: ['hermes.research'] },
  { key: 'workflow', labelKey: 'sidebar.workflow', routes: ['hermes.workflow'] },
  { key: 'history', labelKey: 'sidebar.history', routes: ['hermes.history', 'hermes.historySession'] },
  { key: 'connections', labelKey: 'sidebar.connections', routes: ['hermes.connections', 'hermes.terminal', 'hermes.devices'] },
  { key: 'agents', labelKey: 'sidebar.agentManager', routes: ['hermes.agentManager'], superAdminOnly: true },
  { key: 'skillMarket', labelKey: 'sidebar.skillMarket', routes: ['hermes.skillMarket'] },
  { key: 'promptTemplates', labelKey: 'sidebar.promptTemplates', routes: ['hermes.promptTemplates'] },
  { key: 'models', labelKey: 'sidebar.models', routes: ['hermes.models'] },
  { key: 'usage', labelKey: 'sidebar.usage', routes: ['hermes.usage'] },
  { key: 'logs', labelKey: 'sidebar.logs', routes: ['hermes.logs'] },
  { key: 'performance', labelKey: 'sidebar.performance', routes: ['hermes.performance'], superAdminOnly: true },
  { key: 'skillsUsage', labelKey: 'sidebar.skillsUsage', routes: ['hermes.skillsUsage'] },
  { key: 'browser', labelKey: 'sidebar.browser', routes: ['hermes.browser'] },
  { key: 'theme', labelKey: 'sidebar.theme', routes: ['hermes.theme'] },
  { key: 'petdex', labelKey: 'sidebar.petdex', routes: ['hermes.petdex'] },
  { key: 'profiles', labelKey: 'sidebar.profiles', routes: ['hermes.profiles'], superAdminOnly: true },
]

export const APP_MODULE_KEYS = APP_MODULES.map(module => module.key)

export function isAppModuleKey(value: string): boolean {
  return APP_MODULE_KEYS.includes(value)
}

export function moduleForRoute(routeName: string): string | null {
  const exact = APP_MODULES.find(module => module.routes.includes(routeName))
  if (exact) return exact.key
  const prefixed = APP_MODULES.find(module => module.prefixRoutes?.some(prefix => routeName.startsWith(prefix)))
  return prefixed?.key ?? null
}

export function routeForModule(moduleKey: string): string | null {
  const module = APP_MODULES.find(item => item.key === moduleKey)
  return module?.routes[0] ?? null
}

export function firstAllowedRoute(allowedModules: readonly string[], superAdmin = false): string {
  for (const module of APP_MODULES) {
    if (module.superAdminOnly && !superAdmin) continue
    if (allowedModules.includes(module.key)) return module.routes[0]
  }
  return 'hermes.settings'
}
