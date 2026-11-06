/**
 * Unified initializer for all Hermes SQLite stores.
 * Call this once at bootstrap to create/migrate all tables.
 *
 * All table schemas, creation, and migration logic are now centralized
 * in schemas.ts to avoid duplication and ensure consistency.
 */

import { initAllHermesTables } from './schemas'
import { initRbac } from '../../repositories/rbac-store'

export function initAllStores(): void {
  // Initialize all tables with centralized schema definitions and migrations
  initAllHermesTables()
  // RBAC seed/migration must run after its tables exist.
  initRbac()
}
