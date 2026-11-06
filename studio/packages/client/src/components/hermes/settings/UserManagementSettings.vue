<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { NButton, NDataTable, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSpace, NTag, useMessage, type DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  createManagedUser,
  deleteManagedUser,
  fetchManagedUsers,
  fetchRoles,
  updateManagedUser,
  updateManagedUserRoles,
  type ManagedUser,
  type RoleSummary,
  type UserStatus,
} from '@/api/studio/auth'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const users = ref<ManagedUser[]>([])
const profiles = ref<string[]>([])
const roles = ref<RoleSummary[]>([])
const showModal = ref(false)
const editingUser = ref<ManagedUser | null>(null)
const roleModal = ref(false)
const roleTarget = ref<ManagedUser | null>(null)
const roleDraftId = ref<number | null>(null)
const roleSaving = ref(false)

const form = reactive({
  username: '',
  password: '',
  roleId: null as number | null,
  status: 'active' as UserStatus,
  profiles: [] as string[],
})

const roleOptions = computed(() => roles.value.map(role => ({ label: role.name, value: role.id })))
const assignRoleOptions = computed(() => roles.value
  .filter(role => role.key !== 'super_admin')
  .map(role => ({ label: role.name, value: role.id })))
const selectedRole = computed(() => roles.value.find(role => role.id === form.roleId) || null)

function defaultRoleId(): number | null {
  return roles.value.find(role => role.key === 'admin')?.id ?? roles.value[0]?.id ?? null
}

function legacyRoleFor(role: RoleSummary | null): 'super_admin' | 'admin' | 'viewer' {
  if (role?.key === 'super_admin') return 'super_admin'
  if (role?.key === 'viewer') return 'viewer'
  return 'admin'
}

const statusOptions = computed(() => [
  { label: t('users.status.active'), value: 'active' },
  { label: t('users.status.disabled'), value: 'disabled' },
])

const profileOptions = computed(() => profiles.value.map(profile => ({ label: profile, value: profile })))

async function refreshRoles() {
  try {
    const res = await fetchRoles()
    roles.value = res.roles
  } catch {
    // Keep the last known list; the save path will surface an actionable error.
  }
}

async function openRoles(user: ManagedUser) {
  if (user.role === 'super_admin') {
    message.warning(t('users.superAdminRolesLocked'))
    return
  }
  await refreshRoles()
  roleTarget.value = user
  roleDraftId.value = user.roles?.[0]?.id ?? roles.value.find(role => role.key === user.role)?.id ?? defaultRoleId()
  roleModal.value = true
}

async function saveRoles() {
  if (!roleTarget.value) return
  if (roleDraftId.value === null) {
    message.error(t('users.roleRequired'))
    return
  }
  const selected = roles.value.find(role => role.id === roleDraftId.value)
  if (!selected) {
    message.error(t('users.roleRequired'))
    return
  }
  roleSaving.value = true
  try {
    await updateManagedUser(roleTarget.value.id, { role: legacyRoleFor(selected) })
    const res = await updateManagedUserRoles(roleTarget.value.id, [selected.id])
    users.value = res.users
    profiles.value = res.profiles
    roles.value = res.roles
    roleModal.value = false
    message.success(t('users.rolesSaved'))
  } catch (err: any) {
    message.error(err.message || t('users.rolesSaveFailed'))
  } finally {
    roleSaving.value = false
  }
}

function resetForm() {
  editingUser.value = null
  form.username = ''
  form.password = ''
  form.roleId = defaultRoleId()
  form.status = 'active'
  form.profiles = []
}

async function loadUsers() {
  loading.value = true
  try {
    const res = await fetchManagedUsers()
    users.value = res.users
    profiles.value = res.profiles
    roles.value = res.roles || []
  } catch (err: any) {
    message.error(err.message || t('users.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function openCreate() {
  await refreshRoles()
  resetForm()
  showModal.value = true
}

async function openEdit(user: ManagedUser) {
  await refreshRoles()
  editingUser.value = user
  form.username = user.username
  form.password = ''
  form.roleId = user.roles?.[0]?.id ?? roles.value.find(role => role.key === user.role)?.id ?? defaultRoleId()
  form.status = user.status
  form.profiles = [...user.profiles]
  showModal.value = true
}

async function submit() {
  if (form.username.trim().length < 2) {
    message.error(t('login.usernameTooShort'))
    return
  }
  if (!editingUser.value && form.password.length < 6) {
    message.error(t('login.passwordTooShort'))
    return
  }
  if (form.password && form.password.length < 6) {
    message.error(t('login.passwordTooShort'))
    return
  }

  saving.value = true
  try {
    const selected = selectedRole.value
    if (!selected) {
      message.error(t('users.roleRequired'))
      return
    }
    const legacyRole = legacyRoleFor(selected)
    const base = {
      username: form.username.trim(),
      status: form.status,
      profiles: selected.key === 'super_admin' ? [] : form.profiles,
      defaultProfile: form.profiles[0] || null,
    }
    let res
    if (editingUser.value) {
      const updated = await updateManagedUser(editingUser.value.id, {
        ...base,
        password: form.password || undefined,
        role: legacyRole,
      })
      res = await updateManagedUserRoles(editingUser.value.id, [selected.id])
      if (!res.users.length) res = updated
    } else {
      const created = await createManagedUser({ ...base, role: legacyRole, password: form.password })
      const newUser = created.users.find(user => user.username === base.username)
      res = newUser
        ? await updateManagedUserRoles(newUser.id, [selected.id])
        : created
    }
    users.value = res.users
    profiles.value = res.profiles
    roles.value = res.roles
    showModal.value = false
    resetForm()
    message.success(t('common.saved'))
  } catch (err: any) {
    message.error(err.message || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function setStatus(user: ManagedUser, status: UserStatus) {
  saving.value = true
  try {
    const res = await updateManagedUser(user.id, { status })
    users.value = res.users
    profiles.value = res.profiles
    message.success(t('common.saved'))
  } catch (err: any) {
    message.error(err.message || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function removeUser(user: ManagedUser) {
  saving.value = true
  try {
    const res = await deleteManagedUser(user.id)
    users.value = res.users
    profiles.value = res.profiles
    message.success(t('common.saved'))
  } catch (err: any) {
    message.error(err.message || t('common.deleteFailed'))
  } finally {
    saving.value = false
  }
}

function formatTime(value: number | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

const columns = computed<DataTableColumns<ManagedUser>>(() => [
  {
    title: t('users.username'),
    key: 'username',
    minWidth: 140,
  },
  {
    title: t('users.role'),
    key: 'role',
    width: 130,
    render: (row) => {
      const primaryRole = row.roles?.[0]?.name
      const fallback = row.role === 'super_admin'
        ? t('users.roles.superAdmin')
        : row.role === 'viewer'
          ? t('users.roles.viewer')
          : t('users.roles.admin')
      return h(NTag, { size: 'small', type: row.role === 'super_admin' ? 'warning' : 'default' }, {
        default: () => primaryRole || fallback,
      })
    },
  },
  {
    title: t('users.statusLabel'),
    key: 'status',
    width: 110,
    render: (row) => h(NTag, { size: 'small', type: row.status === 'active' ? 'success' : 'error' }, {
      default: () => row.status === 'active' ? t('users.status.active') : t('users.status.disabled'),
    }),
  },
  {
    title: t('users.profiles'),
    key: 'profiles',
    minWidth: 200,
    render: (row) => row.role === 'super_admin'
      ? h('span', { class: 'muted' }, t('users.allProfiles'))
      : h(NSpace, { size: 4 }, {
        default: () => row.profiles.length
          ? row.profiles.map(profile => h(NTag, { size: 'small', bordered: false }, { default: () => profile }))
          : h('span', { class: 'muted' }, t('users.noProfiles')),
      }),
  },
  {
    title: t('users.lastLogin'),
    key: 'last_login_at',
    minWidth: 170,
    render: (row) => formatTime(row.last_login_at),
  },
  {
    title: t('common.edit'),
    key: 'actions',
    width: 360,
    fixed: 'right',
    render: (row) => h(NSpace, { size: 8 }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => t('common.edit') }),
        h(NButton, {
          size: 'small',
          disabled: row.role === 'super_admin',
          onClick: () => openRoles(row),
        }, { default: () => t('users.assignRoles') }),
        h(NButton, {
          size: 'small',
          type: row.status === 'active' ? 'warning' : 'primary',
          ghost: true,
          loading: saving.value,
          onClick: () => setStatus(row, row.status === 'active' ? 'disabled' : 'active'),
        }, { default: () => row.status === 'active' ? t('users.disable') : t('users.enable') }),
        h(NPopconfirm, { onPositiveClick: () => removeUser(row) }, {
          trigger: () => h(NButton, { size: 'small', type: 'error', ghost: true, loading: saving.value }, { default: () => t('common.delete') }),
          default: () => t('users.deleteConfirm'),
        }),
      ],
    }),
  },
])

onMounted(loadUsers)
</script>

<template>
  <div class="user-management">
    <div class="toolbar">
      <div>
        <h3 class="section-title">{{ t('users.title') }}</h3>
        <p class="section-desc">{{ t('users.description') }}</p>
      </div>
      <NButton type="primary" @click="openCreate">{{ t('users.create') }}</NButton>
    </div>

    <NDataTable
      :columns="columns"
      :data="users"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      :scroll-x="1320"
      size="small"
    />

    <NModal v-model:show="showModal" preset="dialog" :title="editingUser ? t('users.edit') : t('users.create')">
      <NForm label-placement="top">
        <NFormItem :label="t('users.username')">
          <NInput v-model:value="form.username" :placeholder="t('login.usernamePlaceholder')" />
        </NFormItem>
        <NFormItem :label="editingUser ? t('users.newPasswordOptional') : t('login.newPassword')">
          <NInput v-model:value="form.password" type="password" show-password-on="click" :placeholder="t('login.passwordPlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('users.role')">
          <NSelect v-model:value="form.roleId" :options="roleOptions" :placeholder="t('users.rolePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('users.statusLabel')">
          <NSelect v-model:value="form.status" :options="statusOptions" />
        </NFormItem>
        <NFormItem v-if="selectedRole?.key !== 'super_admin'" :label="t('users.profiles')">
          <NSelect
            v-model:value="form.profiles"
            multiple
            filterable
            :options="profileOptions"
            :placeholder="t('users.profilesPlaceholder')"
          />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showModal = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="submit">{{ t('common.save') }}</NButton>
      </template>
    </NModal>

        <NModal
      v-model:show="roleModal"
      preset="dialog"
      :title="t('users.assignRoles')"
      style="width: min(560px, calc(100vw - 32px))"
    >
      <div class="role-modal">
        <p class="role-hint">
          {{ t('users.assignRolesHint', { username: roleTarget?.username || '' }) }}
        </p>
        <NSelect
          v-model:value="roleDraftId"
          :options="assignRoleOptions"
          :placeholder="t('users.rolePlaceholder')"
        />
      </div>
      <template #action>
        <NButton @click="roleModal = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="roleSaving" @click="saveRoles">{{ t('common.save') }}</NButton>
      </template>
    </NModal>

  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.user-management {
  padding: 8px 0;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.section-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
}

.section-desc {
  margin: 0;
  font-size: 13px;
  color: $text-muted;
}

:deep(.muted) {
  color: $text-muted;
}

.role-modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.role-hint {
  margin: 0;
  color: $text-muted;
  font-size: 13px;
  line-height: 1.6;
}


</style>
