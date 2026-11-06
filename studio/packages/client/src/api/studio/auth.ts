import { request } from '../client'
import type { UserThemeSettings } from './theme'

export interface AuthStatus {
  hasPasswordLogin: boolean
  hasUsers?: boolean
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status')
  if (!res.ok) throw new Error('Failed to fetch auth status')
  return res.json()
}

export interface LoginResponse {
  token: string
  userId: number
  theme: UserThemeSettings
}

export async function loginWithPassword(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err: any = new Error(data.error || 'Login failed')
    err.status = res.status
    throw err
  }
  const data = await res.json()
  return data as LoginResponse
}

export interface CurrentUser {
  id: number
  username: string
  role: UserRole
  status: UserStatus
  created_at: number
  updated_at: number
  last_login_at: number | null
  avatar?: string
  roles: string[]
  permissions: string[]
  allowedModules: string[]
  requiresCredentialChange?: boolean
}

export interface UserAvatar {
  type: 'image' | 'default'
  dataUrl?: string
  seed?: string
}

export async function fetchCurrentUser(): Promise<CurrentUser> {
  const res = await request<{ user: CurrentUser }>('/api/auth/me')
  return res.user
}

export async function fetchMyAvatar(): Promise<UserAvatar | null> {
  const res = await request<{ avatar: string }>('/api/auth/avatar')
  if (!res.avatar) return null
  try {
    const parsed = JSON.parse(res.avatar) as UserAvatar
    if (parsed && (parsed.type === 'image' || parsed.type === 'default')) return parsed
    return null
  } catch {
    return null
  }
}

export async function updateMyAvatar(avatar: UserAvatar): Promise<void> {
  const payload = JSON.stringify(avatar)
  await request('/api/auth/avatar', {
    method: 'PUT',
    body: JSON.stringify({ avatar: payload }),
  })
}

export async function resetMyAvatar(): Promise<void> {
  await request('/api/auth/avatar', {
    method: 'PUT',
    body: JSON.stringify({ avatar: { type: 'default' } }),
  })
}

export async function setupPassword(username: string, password: string): Promise<void> {
  return request('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

export async function changeUsername(currentPassword: string, newUsername: string): Promise<void> {
  return request('/api/auth/change-username', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newUsername }),
  })
}

export async function removePassword(): Promise<void> {
  return request('/api/auth/password', {
    method: 'DELETE',
  })
}

export type UserRole = 'super_admin' | 'admin'
export type UserStatus = 'active' | 'disabled'

export interface RoleSummary {
  id: number
  key: string
  name: string
  description: string
  built_in: number
  permissions: string[]
  userCount: number
  created_at: number
  updated_at: number
}

export interface PermissionRecord {
  code: string
  module_key: string
  resource: string
  action: string
  name: string
  description: string
  sort: number
}

export interface ManagedUser {
  id: number
  username: string
  role: UserRole
  status: UserStatus
  profiles: string[]
  default_profile: string | null
  allowedModules: string[]
  roles: RoleSummary[]
  created_at: number
  updated_at: number
  last_login_at: number | null
}

export interface ManagedUsersResponse {
  users: ManagedUser[]
  profiles: string[]
  roles: RoleSummary[]
  permissions: PermissionRecord[]
}

export async function fetchManagedUsers(): Promise<ManagedUsersResponse> {
  return request<ManagedUsersResponse>('/api/auth/users')
}

export async function createManagedUser(input: {
  username: string
  password: string
  role: UserRole
  status: UserStatus
  profiles: string[]
  defaultProfile?: string | null
}): Promise<ManagedUsersResponse> {
  const res = await request<{ users: ManagedUser[] }>('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  const current = await fetchManagedUsers()
  return { ...current, users: res.users }
}

export async function updateManagedUser(id: number, input: {
  username?: string
  password?: string
  role?: UserRole
  status?: UserStatus
  profiles?: string[]
  defaultProfile?: string | null
}): Promise<ManagedUsersResponse> {
  const res = await request<{ users: ManagedUser[] }>(`/api/auth/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
  const current = await fetchManagedUsers()
  return { ...current, users: res.users }
}

export async function updateManagedUserRoles(id: number, roleIds: number[]): Promise<ManagedUsersResponse> {
  const res = await request<{ users: ManagedUser[]; roles: RoleSummary[]; permissions: PermissionRecord[] }>(
    `/api/auth/users/${id}/roles`,
    { method: 'PUT', body: JSON.stringify({ roleIds }) },
  )
  const current = await fetchManagedUsers()
  return { ...current, users: res.users, roles: res.roles, permissions: res.permissions }
}

export async function fetchRoles(): Promise<{ roles: RoleSummary[]; permissions: PermissionRecord[] }> {
  return request('/api/auth/roles')
}

export async function createRole(input: { name: string; description: string; permissions: string[] }): Promise<void> {
  await request('/api/auth/roles', { method: 'POST', body: JSON.stringify(input) })
}

export async function updateRole(id: number, input: { name: string; description: string; permissions?: string[] }): Promise<void> {
  await request(`/api/auth/roles/${id}`, { method: 'PUT', body: JSON.stringify(input) })
}

export async function replaceRolePermissions(id: number, permissions: string[]): Promise<void> {
  await request(`/api/auth/roles/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) })
}

export async function deleteRole(id: number): Promise<void> {
  await request(`/api/auth/roles/${id}`, { method: 'DELETE' })
}

export async function deleteManagedUser(id: number): Promise<ManagedUsersResponse> {
  const res = await request<{ users: ManagedUser[] }>(`/api/auth/users/${id}`, {
    method: 'DELETE',
  })
  const current = await fetchManagedUsers()
  return { ...current, users: res.users }
}

export interface LockedIp {
  ip: string
  type: 'password' | 'token' | 'pairing'
  failures: number
  lockedUntil: number
}

export async function fetchLockedIps(): Promise<LockedIp[]> {
  const res = await request<{ locks: LockedIp[] }>('/api/auth/locked-ips')
  return res.locks
}

export async function unlockSpecificIp(ip: string): Promise<void> {
  return request(`/api/auth/locked-ips?ip=${encodeURIComponent(ip)}`, {
    method: 'DELETE',
  })
}

export async function unlockAllIps(): Promise<number> {
  const res = await request<{ count: number }>('/api/auth/locked-ips', {
    method: 'DELETE',
  })
  return res.count
}
