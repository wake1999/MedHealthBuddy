<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { NButton, NCheckbox, NCheckboxGroup, NDataTable, NForm, NFormItem, NInput, NModal, NPopconfirm, NTag, useMessage, type DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  createRole,
  deleteRole,
  fetchRoles,
  updateRole,
  type PermissionRecord,
  type RoleSummary,
} from '@/api/studio/auth'
import { APP_MODULES } from '@/config/modules'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const roles = ref<RoleSummary[]>([])
const permissions = ref<PermissionRecord[]>([])
const showModal = ref(false)
const editing = ref<RoleSummary | null>(null)
const selectedPermissions = ref<string[]>([])
const form = reactive({
  name: '',
  description: '',
})

const moduleLabels = computed<Record<string, string>>(() => {
  const labels: Record<string, string> = {
    accounts: t('roles.modules.accounts'),
    roles: t('roles.modules.roles'),
    system: t('roles.modules.system'),
  }
  for (const module of APP_MODULES) labels[module.key] = t(module.labelKey)
  return labels
})

const permissionGroups = computed(() => {
  const groups = new Map<string, { key: string; label: string; items: PermissionRecord[] }>()
  for (const permission of permissions.value) {
    const key = permission.module_key || 'system'
    const current = groups.get(key)
    if (current) current.items.push(permission)
    else groups.set(key, { key, label: moduleLabels.value[key] || key, items: [permission] })
  }
  return [...groups.values()]
})

function actionLabel(action: string): string {
  return t(`roles.actions.${action}`)
}

function permissionLabel(permission: PermissionRecord): string {
  if (permission.module_key && permission.action === 'view') {
    return moduleLabels.value[permission.module_key] || permission.code
  }
  return `${moduleLabels.value[permission.module_key] || permission.resource} · ${actionLabel(permission.action)}`
}

async function loadRoles() {
  loading.value = true
  try {
    const result = await fetchRoles()
    roles.value = result.roles
    permissions.value = result.permissions
  } catch (error: any) {
    message.error(error.message || t('roles.loadFailed'))
  } finally {
    loading.value = false
  }
}

function resetForm() {
  editing.value = null
  form.name = ''
  form.description = ''
  selectedPermissions.value = []
}

function openCreate() {
  resetForm()
  showModal.value = true
}

function openEdit(role: RoleSummary) {
  if (role.key === 'super_admin') {
    message.warning(t('roles.superAdminLocked'))
    return
  }
  editing.value = role
  form.name = role.name
  form.description = role.description
  selectedPermissions.value = [...role.permissions]
  showModal.value = true
}

async function submit() {
  if (form.name.trim().length < 2) {
    message.error(t('roles.nameTooShort'))
    return
  }
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      permissions: selectedPermissions.value,
    }
    if (editing.value) await updateRole(editing.value.id, payload)
    else await createRole(payload)
    showModal.value = false
    resetForm()
    await loadRoles()
    message.success(t('roles.saved'))
  } catch (error: any) {
    message.error(error.message || t('roles.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function remove(role: RoleSummary) {
  saving.value = true
  try {
    await deleteRole(role.id)
    await loadRoles()
    message.success(t('roles.deleted'))
  } catch (error: any) {
    message.error(error.message || t('roles.deleteFailed'))
  } finally {
    saving.value = false
  }
}

const columns = computed<DataTableColumns<RoleSummary>>(() => [
  { title: t('roles.name'), key: 'name', minWidth: 160 },
  {
    title: t('roles.permissions'),
    key: 'permissions',
    minWidth: 120,
    render: row => h(NTag, { size: 'small', bordered: false }, { default: () => `${row.permissions.length}` }),
  },
  {
    title: t('roles.users'),
    key: 'userCount',
    width: 90,
    render: row => String(row.userCount),
  },
  {
    title: t('roles.type'),
    key: 'built_in',
    width: 110,
    render: row => h(NTag, { size: 'small', type: row.built_in ? 'warning' : 'default' }, {
      default: () => row.built_in ? t('roles.builtIn') : t('roles.custom'),
    }),
  },
  {
    title: t('common.edit'),
    key: 'actions',
    width: 180,
    fixed: 'right',
    render: row => h('div', { class: 'role-actions' }, [
      h(NButton, {
        size: 'small',
        disabled: row.key === 'super_admin',
        onClick: () => openEdit(row),
      }, { default: () => t('common.edit') }),
      h(NPopconfirm, {
        disabled: row.built_in === 1,
        onPositiveClick: () => remove(row),
      }, {
        trigger: () => h(NButton, {
          size: 'small',
          type: 'error',
          ghost: true,
          disabled: row.built_in === 1 || row.userCount > 0 || saving.value,
        }, { default: () => t('common.delete') }),
        default: () => t('roles.deleteConfirm'),
      }),
    ]),
  },
])

onMounted(loadRoles)
</script>

<template>
  <div class="roles-settings">
    <div class="toolbar">
      <div>
        <h3 class="section-title">{{ t('roles.title') }}</h3>
        <p class="section-desc">{{ t('roles.description') }}</p>
      </div>
      <NButton type="primary" @click="openCreate">{{ t('roles.create') }}</NButton>
    </div>

    <NDataTable
      :columns="columns"
      :data="roles"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      :scroll-x="900"
      size="small"
    />

    <NModal
      v-model:show="showModal"
      preset="dialog"
      :title="editing ? t('roles.edit') : t('roles.create')"
      style="width: min(760px, calc(100vw - 32px))"
    >
      <NForm label-placement="top">
        <div class="role-form-row">
          <NFormItem :label="t('roles.name')">
            <NInput v-model:value="form.name" :placeholder="t('roles.namePlaceholder')" />
          </NFormItem>
        </div>
        <NFormItem :label="t('roles.descriptionLabel')">
          <NInput v-model:value="form.description" type="textarea" :rows="2" />
        </NFormItem>
        <NFormItem :label="t('roles.permissions')">
          <NCheckboxGroup v-model:value="selectedPermissions">
            <div class="permission-groups">
              <section v-for="group in permissionGroups" :key="group.key" class="permission-group">
                <h4>{{ group.label }}</h4>
                <div class="permission-grid">
                  <NCheckbox
                    v-for="permission in group.items"
                    :key="permission.code"
                    :value="permission.code"
                    :label="permissionLabel(permission)"
                  />
                </div>
              </section>
            </div>
          </NCheckboxGroup>
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showModal = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="submit">{{ t('common.save') }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.roles-settings {
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
  color: $text-primary;
  font-size: 16px;
  font-weight: 600;
}

.section-desc {
  margin: 0;
  color: $text-muted;
  font-size: 13px;
}

.role-actions {
  display: flex;
  gap: 8px;
}

.role-form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.permission-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 420px;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--n-border-color, #e5e7eb);
  border-radius: 9px;
}

.permission-group h4 {
  margin: 0 0 6px;
  color: $text-primary;
  font-size: 12px;
}

.permission-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px 14px;
}
</style>
