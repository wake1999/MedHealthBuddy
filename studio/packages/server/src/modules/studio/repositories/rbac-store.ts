import { getDb } from '../infrastructure/database'
import {
  PERMISSIONS_TABLE,
  ROLE_PERMISSIONS_TABLE,
  ROLES_TABLE,
  USER_MODULE_PERMISSIONS_TABLE,
  USER_ROLES_TABLE,
  USERS_TABLE,
} from '../infrastructure/database/schemas'
import { USER_MODULES } from './module-permissions'

export interface PermissionRecord {
  code: string
  module_key: string
  resource: string
  action: string
  name: string
  description: string
  sort: number
}

export interface RoleRecord {
  id: number
  key: string
  name: string
  description: string
  built_in: number
  created_at: number
  updated_at: number
}

export interface RoleSummary extends RoleRecord {
  permissions: string[]
  userCount: number
}

const CORE_PERMISSIONS: Array<Omit<PermissionRecord, 'sort'>> = [
  { code: 'account.user:view', module_key: 'accounts', resource: 'account.user', action: 'view', name: '查看账户', description: '' },
  { code: 'account.user:create', module_key: 'accounts', resource: 'account.user', action: 'create', name: '创建账户', description: '' },
  { code: 'account.user:edit', module_key: 'accounts', resource: 'account.user', action: 'edit', name: '编辑账户', description: '' },
  { code: 'account.user:disable', module_key: 'accounts', resource: 'account.user', action: 'disable', name: '禁用账户', description: '' },
  { code: 'account.user:delete', module_key: 'accounts', resource: 'account.user', action: 'delete', name: '删除账户', description: '' },
  { code: 'account.role:view', module_key: 'roles', resource: 'account.role', action: 'view', name: '查看角色', description: '' },
  { code: 'account.role:create', module_key: 'roles', resource: 'account.role', action: 'create', name: '创建角色', description: '' },
  { code: 'account.role:edit', module_key: 'roles', resource: 'account.role', action: 'edit', name: '编辑角色', description: '' },
  { code: 'account.role:delete', module_key: 'roles', resource: 'account.role', action: 'delete', name: '删除角色', description: '' },
  { code: 'account.role:assign', module_key: 'roles', resource: 'account.role', action: 'assign', name: '分配角色', description: '' },
  { code: 'research.paper:view', module_key: 'research', resource: 'research.paper', action: 'view', name: '查看论文', description: '' },
  { code: 'research.paper:edit', module_key: 'research', resource: 'research.paper', action: 'edit', name: '编辑论文', description: '' },
  { code: 'research.paper:delete', module_key: 'research', resource: 'research.paper', action: 'delete', name: '删除论文', description: '' },
  { code: 'research.run:view', module_key: 'research', resource: 'research.run', action: 'view', name: '查看运行', description: '' },
  { code: 'research.run:execute', module_key: 'research', resource: 'research.run', action: 'execute', name: '执行运行', description: '' },
  { code: 'research.run:approve', module_key: 'research', resource: 'research.run', action: 'approve', name: '审批运行', description: '' },
  { code: 'research.evidence:view', module_key: 'research', resource: 'research.evidence', action: 'view', name: '查看证据', description: '' },
  { code: 'research.evidence:approve', module_key: 'research', resource: 'research.evidence', action: 'approve', name: '审批证据', description: '' },
  { code: 'system.server:view', module_key: 'system', resource: 'system.server', action: 'view', name: '查看服务器', description: '' },
  { code: 'system.server:manage', module_key: 'system', resource: 'system.server', action: 'manage', name: '管理服务器', description: '' },
  { code: 'system.model:view', module_key: 'system', resource: 'system.model', action: 'view', name: '查看模型', description: '' },
  { code: 'system.model:configure', module_key: 'system', resource: 'system.model', action: 'configure', name: '配置模型', description: '' },
]

export const MODULE_PERMISSIONS: PermissionRecord[] = USER_MODULES.map((key, index) => ({
  code: `module.${key}:view`,
  module_key: key,
  resource: `module.${key}`,
  action: 'view',
  name: `访问 ${key}`,
  description: '',
  sort: index,
}))

export const ALL_PERMISSIONS: PermissionRecord[] = [
  ...MODULE_PERMISSIONS,
  ...CORE_PERMISSIONS.map((permission, index) => ({ ...permission, sort: 1000 + index })),
]

export const VIEW_PERMISSION_CODES = ALL_PERMISSIONS
  .filter(permission => permission.action === 'view')
  .map(permission => permission.code)

let rbacSeeded = false

function now(): number {
  return Date.now()
}

function ensureRbac(): void {
  if (!rbacSeeded) initRbac()
}

export function listPermissions(): PermissionRecord[] {
  ensureRbac()
  const db = getDb()
  if (!db) return []
  return db.prepare(
    `SELECT code, module_key, resource, action, name, description, sort FROM ${PERMISSIONS_TABLE} ORDER BY sort, code`,
  ).all() as unknown as PermissionRecord[]
}

export function listRoles(): RoleSummary[] {
  ensureRbac()
  const db = getDb()
  if (!db) return []
  const roles = db.prepare(`SELECT * FROM ${ROLES_TABLE} ORDER BY built_in DESC, id ASC`).all() as unknown as RoleRecord[]
  return roles.map(role => {
    const permissions = db.prepare(
      `SELECT permission_code FROM ${ROLE_PERMISSIONS_TABLE} WHERE role_id = ? ORDER BY permission_code`,
    ).all(role.id) as Array<{ permission_code: string }>
    const count = db.prepare(
      `SELECT COUNT(*) AS count FROM ${USER_ROLES_TABLE} WHERE role_id = ?`,
    ).get(role.id) as { count?: number } | undefined
    return {
      ...role,
      permissions: permissions.map(row => row.permission_code),
      userCount: Number(count?.count || 0),
    }
  })
}

export function getRole(roleId: number): RoleSummary | null {
  return listRoles().find(role => role.id === roleId) || null
}

export function getUserRoleKeys(userId: number): string[] {
  ensureRbac()
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(
    `SELECT r.key FROM ${USER_ROLES_TABLE} ur JOIN ${ROLES_TABLE} r ON r.id = ur.role_id WHERE ur.user_id = ?`,
  ).all(userId) as Array<{ key: string }>
  return rows.map(row => row.key)
}

export function getUserRoles(userId: number): RoleSummary[] {
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(
    `SELECT role_id FROM ${USER_ROLES_TABLE} WHERE user_id = ?`,
  ).all(userId) as Array<{ role_id: number }>
  const ids = new Set(rows.map(row => row.role_id))
  return listRoles().filter(role => ids.has(role.id))
}

export function getUserPermissions(userId: number, legacyRole: string): string[] {
  ensureRbac()
  if (legacyRole === 'super_admin') return ALL_PERMISSIONS.map(permission => permission.code)
  const roles = getUserRoles(userId)
  if (roles.some(role => role.key === 'super_admin')) return ALL_PERMISSIONS.map(permission => permission.code)
  const granted = new Set(roles.flatMap(role => role.permissions))
  return ALL_PERMISSIONS.map(permission => permission.code).filter(code => granted.has(code))
}

export function getAllowedModulesFromPermissions(permissions: readonly string[]): string[] {
  return USER_MODULES.filter(key => permissions.includes(`module.${key}:view`))
}

function insertRole(key: string, name: string, description: string, builtIn: boolean): number {
  const db = getDb()
  if (!db) throw new Error('database_unavailable')
  const timestamp = now()
  db.prepare(
    `INSERT OR IGNORE INTO ${ROLES_TABLE} (key, name, description, built_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(key, name, description, builtIn ? 1 : 0, timestamp, timestamp)
  const row = db.prepare(`SELECT id FROM ${ROLES_TABLE} WHERE key = ?`).get(key) as { id: number } | undefined
  return row?.id || 0
}

export function replaceRolePermissions(roleId: number, permissionCodes: string[]): RoleSummary | null {
  const db = getDb()
  if (!db) return null
  const valid = new Set(ALL_PERMISSIONS.map(permission => permission.code))
  const codes = [...new Set(permissionCodes.filter(code => valid.has(code)))]
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${ROLE_PERMISSIONS_TABLE} WHERE role_id = ?`).run(roleId)
    const stmt = db.prepare(
      `INSERT INTO ${ROLE_PERMISSIONS_TABLE} (role_id, permission_code, scope) VALUES (?, ?, 'all')`,
    )
    for (const code of codes) stmt.run(roleId, code)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return getRole(roleId)
}

export function replaceUserRoles(userId: number, roleIds: number[]): RoleSummary[] {
  const db = getDb()
  if (!db) return []
  const valid = new Set(listRoles().map(role => role.id))
  const ids = [...new Set(roleIds.filter(id => valid.has(id)))]
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${USER_ROLES_TABLE} WHERE user_id = ?`).run(userId)
    const stmt = db.prepare(`INSERT INTO ${USER_ROLES_TABLE} (user_id, role_id, created_at) VALUES (?, ?, ?)`)
    for (const roleId of ids) stmt.run(userId, roleId, now())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return getUserRoles(userId)
}

export function assignBuiltInRole(userId: number, legacyRole: string): void {
  ensureRbac()
  const db = getDb()
  if (!db) return
  const key = legacyRole === 'super_admin' ? 'super_admin' : 'admin'
  const role = db.prepare(`SELECT id FROM ${ROLES_TABLE} WHERE key = ?`).get(key) as { id: number } | undefined
  if (role) replaceUserRoles(userId, [role.id])
}

export interface RoleInput {
  name: string
  description?: string
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'role'
}

export function createRole(input: RoleInput, permissionCodes: string[] = []): RoleSummary {
  const db = getDb()
  if (!db) throw new Error('database_unavailable')
  const name = input.name.trim()
  if (name.length < 2) throw new Error('role_name_too_short')
  const base = slugify(name)
  let key = base
  let suffix = 2
  while (db.prepare(`SELECT 1 FROM ${ROLES_TABLE} WHERE key = ?`).get(key)) {
    key = `${base}_${suffix}`
    suffix += 1
  }
  const id = insertRole(key, name, input.description?.trim() || '', false)
  if (permissionCodes.length > 0) replaceRolePermissions(id, permissionCodes)
  const role = getRole(id)
  if (!role) throw new Error('role_create_failed')
  return role
}

export function updateRole(roleId: number, input: RoleInput, permissionCodes?: string[]): RoleSummary | null {
  const db = getDb()
  if (!db) return null
  const role = db.prepare(`SELECT * FROM ${ROLES_TABLE} WHERE id = ?`).get(roleId) as RoleRecord | undefined
  if (!role) return null
  if (role.built_in === 1) throw new Error('role_built_in_locked')
  const name = input.name.trim()
  if (name.length < 2) throw new Error('role_name_too_short')
  db.prepare(`UPDATE ${ROLES_TABLE} SET name = ?, description = ?, updated_at = ? WHERE id = ?`)
    .run(name, input.description?.trim() || '', now(), roleId)
  if (permissionCodes !== undefined) replaceRolePermissions(roleId, permissionCodes)
  return getRole(roleId)
}

export function deleteRole(roleId: number): void {
  const db = getDb()
  if (!db) throw new Error('database_unavailable')
  const role = db.prepare(`SELECT * FROM ${ROLES_TABLE} WHERE id = ?`).get(roleId) as RoleRecord | undefined
  if (!role) throw new Error('role_not_found')
  if (role.built_in === 1) throw new Error('role_built_in_locked')
  const count = db.prepare(`SELECT COUNT(*) AS count FROM ${USER_ROLES_TABLE} WHERE role_id = ?`).get(roleId) as { count?: number } | undefined
  if (Number(count?.count || 0) > 0) throw new Error('role_in_use')
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${ROLE_PERMISSIONS_TABLE} WHERE role_id = ?`).run(roleId)
    db.prepare(`DELETE FROM ${ROLES_TABLE} WHERE id = ?`).run(roleId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Seed built-in roles/permissions and migrate users. Idempotent: safe on every
 * startup and in in-memory tests after initAllHermesTables().
 */
export function initRbac(): void {
  const db = getDb()
  if (!db) return
  rbacSeeded = true
  db.exec('BEGIN')
  try {
    for (const permission of ALL_PERMISSIONS) {
      db.prepare(
        `INSERT OR IGNORE INTO ${PERMISSIONS_TABLE} (code, module_key, resource, action, name, description, sort) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(permission.code, permission.module_key, permission.resource, permission.action, permission.name, permission.description, permission.sort)
    }
    const allCodes = ALL_PERMISSIONS.map(permission => permission.code)
    const viewCodes = VIEW_PERMISSION_CODES
    const superId = insertRole('super_admin', '超级管理员', '拥有全部权限', true)
    const adminId = insertRole('admin', '管理员', '拥有全部业务权限', true)
    const viewerId = insertRole('viewer', '只读用户', '仅查看权限', true)
    for (const [roleId, codes] of [[adminId, allCodes], [viewerId, viewCodes]] as const) {
      for (const code of codes) {
        db.prepare(
          `INSERT OR IGNORE INTO ${ROLE_PERMISSIONS_TABLE} (role_id, permission_code, scope) VALUES (?, ?, 'all')`,
        ).run(roleId, code)
      }
    }
    // Keep built-in super_admin empty; getUserPermissions() bypasses it.

    const users = db.prepare(`SELECT id, username, role FROM ${USERS_TABLE} ORDER BY id`).all() as Array<{ id: number; username: string; role: string }>
    for (const user of users) {
      const assigned = db.prepare(`SELECT COUNT(*) AS count FROM ${USER_ROLES_TABLE} WHERE user_id = ?`).get(user.id) as { count?: number } | undefined
      if (Number(assigned?.count || 0) > 0) continue
      let roleId = user.role === 'super_admin' ? superId : adminId
      const rows = db.prepare(
        `SELECT module_key, allowed FROM ${USER_MODULE_PERMISSIONS_TABLE} WHERE user_id = ?`,
      ).all(user.id) as Array<{ module_key: string; allowed: number }>
      if (user.role !== 'super_admin' && rows.length > 0) {
        const allowed = rows.filter(row => row.allowed === 1).map(row => row.module_key)
        if (allowed.length < USER_MODULES.length) {
          const legacyKey = `legacy_${user.id}`
          const legacyId = insertRole(legacyKey, `${user.username}（旧模块权限）`, '从 user_module_permissions 迁移', false)
          for (const moduleKey of allowed) {
            db.prepare(
              `INSERT OR IGNORE INTO ${ROLE_PERMISSIONS_TABLE} (role_id, permission_code, scope) VALUES (?, ?, 'all')`,
            ).run(legacyId, `module.${moduleKey}:view`)
          }
          roleId = legacyId
        }
      }
      db.prepare(`INSERT OR IGNORE INTO ${USER_ROLES_TABLE} (user_id, role_id, created_at) VALUES (?, ?, ?)`)
        .run(user.id, roleId, now())
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
