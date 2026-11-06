import Router from '@koa/router'
import * as ctrl from '../controllers/auth'
import { requirePermission, requireSuperAdmin } from '../middleware/auth'

// Public routes (no auth required)
export const authPublicRoutes = new Router()
authPublicRoutes.get('/api/auth/status', ctrl.authStatus)
authPublicRoutes.post('/api/auth/login', ctrl.login)
authPublicRoutes.post('/api/auth/app-login', ctrl.appLogin)
authPublicRoutes.post('/api/auth/mcu-login', ctrl.microcontrollerLogin)

// Protected routes (auth required)
export const authProtectedRoutes = new Router()
authProtectedRoutes.post('/api/auth/setup', ctrl.setupPassword)
authProtectedRoutes.get('/api/auth/me', ctrl.currentUser)
authProtectedRoutes.post('/api/auth/change-password', ctrl.changePassword)
authProtectedRoutes.post('/api/auth/change-username', ctrl.changeUsername)
authProtectedRoutes.get('/api/auth/avatar', ctrl.getMyAvatar)
authProtectedRoutes.put('/api/auth/avatar', ctrl.updateMyAvatar)
authProtectedRoutes.delete('/api/auth/password', ctrl.removePassword)
authProtectedRoutes.get('/api/auth/users', requireSuperAdmin, ctrl.listManagedUsers)
authProtectedRoutes.post('/api/auth/users', requireSuperAdmin, ctrl.createManagedUser)
authProtectedRoutes.put('/api/auth/users/:id', requireSuperAdmin, ctrl.updateManagedUser)
authProtectedRoutes.delete('/api/auth/users/:id', requireSuperAdmin, ctrl.deleteManagedUser)
authProtectedRoutes.put('/api/auth/users/:id/roles', requirePermission('account.role:assign'), ctrl.replaceUserRolesHandler)

authProtectedRoutes.get('/api/auth/roles', requirePermission('account.role:view'), ctrl.listRolesHandler)
authProtectedRoutes.post('/api/auth/roles', requirePermission('account.role:create'), ctrl.createRoleHandler)
authProtectedRoutes.put('/api/auth/roles/:id', requirePermission('account.role:edit'), ctrl.updateRoleHandler)
authProtectedRoutes.put('/api/auth/roles/:id/permissions', requirePermission('account.role:edit'), ctrl.replaceRolePermissionsHandler)
authProtectedRoutes.delete('/api/auth/roles/:id', requirePermission('account.role:delete'), ctrl.deleteRoleHandler)
authProtectedRoutes.get('/api/auth/locked-ips', ctrl.listLockedIps)
authProtectedRoutes.delete('/api/auth/locked-ips', ctrl.unlockIpHandler)
