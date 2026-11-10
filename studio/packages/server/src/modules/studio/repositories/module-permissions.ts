import { getDb } from '../infrastructure/database'
import { USER_MODULE_PERMISSIONS_TABLE } from '../infrastructure/database/schemas'

/**
 * The module registry is deliberately server-owned so a client cannot invent
 * a key and the account list always reports the same ordered module set.
 */
export const USER_MODULES = [
  'chat',
  'group',
  'research',
  'workflow',
  'history',
  'connections',
  'agents',
  'skillMarket',
  'experts',
  'promptTemplates',
  'models',
  'usage',
  'logs',
  'performance',
  'skillsUsage',
  'browser',
  'theme',
  'petdex',
  'profiles',
] as const

export type UserModule = (typeof USER_MODULES)[number]

const MODULE_SET = new Set<string>(USER_MODULES)

export function isUserModule(value: unknown): value is UserModule {
  return typeof value === 'string' && MODULE_SET.has(value)
}

export function normalizeModules(value: unknown): UserModule[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => String(item || '').trim()).filter(isUserModule))] as UserModule[]
}

export interface UserModulePermission {
  module_key: UserModule
  allowed: number
  updated_at: number
}

/**
 * A user with no rows is treated as unrestricted. This preserves access for
 * accounts created before module permissions existed. An explicit all-denied
 * row set still returns an empty list.
 */
export function getAllowedModulesForUser(userId: number, role: string): UserModule[] {
  if (role === 'super_admin') return [...USER_MODULES]
  const db = getDb()
  if (!db) return [...USER_MODULES]
  const rows = db.prepare(
    `SELECT module_key, allowed FROM ${USER_MODULE_PERMISSIONS_TABLE} WHERE user_id = ?`,
  ).all(userId) as Array<{ module_key: string; allowed: number }>
  if (rows.length === 0) return [...USER_MODULES]
  const allowed = new Set(rows.filter(row => row.allowed === 1).map(row => row.module_key))
  return USER_MODULES.filter(key => allowed.has(key))
}

export function replaceUserModulePermissions(userId: number, allowedModules: UserModule[]): UserModulePermission[] {
  const db = getDb()
  if (!db) return []
  const allowed = new Set(allowedModules)
  const now = Date.now()
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${USER_MODULE_PERMISSIONS_TABLE} WHERE user_id = ?`).run(userId)
    const stmt = db.prepare(
      `INSERT INTO ${USER_MODULE_PERMISSIONS_TABLE} (user_id, module_key, allowed, updated_at) VALUES (?, ?, ?, ?)`,
    )
    for (const key of USER_MODULES) {
      stmt.run(userId, key, allowed.has(key) ? 1 : 0, now)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return db.prepare(
    `SELECT module_key, allowed, updated_at FROM ${USER_MODULE_PERMISSIONS_TABLE} WHERE user_id = ? ORDER BY module_key`,
  ).all(userId) as unknown as UserModulePermission[]
}

export function deleteUserModulePermissions(userId: number): void {
  const db = getDb()
  if (!db) return
  db.prepare(`DELETE FROM ${USER_MODULE_PERMISSIONS_TABLE} WHERE user_id = ?`).run(userId)
}
