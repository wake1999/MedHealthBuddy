<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NModal, NRadio, NRadioGroup, NSelect, NUpload, useMessage } from 'naive-ui'
import type { UploadFileInfo } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { SkillTarget } from '@/api/hermes/skills'

const props = defineProps<{
  agents: readonly { label: string; value: SkillTarget }[]
  categories: readonly { label: string; value: string }[]
  importHandler: (files: File[], category: string | undefined, target: SkillTarget) => Promise<{ name?: string }>
  createHandler: (name: string, content: string, category: string, target: SkillTarget) => Promise<void>
}>()

const emit = defineEmits<{ close: []; saved: [] }>()

const { t } = useI18n()
const message = useMessage()
const showModal = ref(true)
const loading = ref(false)
const mode = ref<'install' | 'create'>('install')
const importMode = ref<'zip' | 'folder'>('folder')
const zipFiles = ref<UploadFileInfo[]>([])
const folderFiles = ref<File[]>([])
const folderName = ref('')
const folderInputRef = ref<HTMLInputElement | null>(null)
const agent = ref<SkillTarget>(props.agents[0]?.value || 'ekko')
const category = ref('office')
const skillName = ref('')
const skillContent = ref('')

const hasSelection = computed(() =>
  importMode.value === 'zip' ? zipFiles.value.length > 0 : folderFiles.value.length > 0,
)

const agentOptions = computed(() => props.agents.map(item => ({ label: item.label, value: item.value })))
const categoryOptions = computed(() => {
  const options = [...props.categories]
  if (!options.some(item => item.value === 'misc')) {
    options.unshift({ label: t('skills.addCategoryDefault'), value: 'misc' })
  }
  return options
})

function onImportModeChange() {
  zipFiles.value = []
  folderFiles.value = []
  folderName.value = ''
}

function beforeUpload({ file }: { file: UploadFileInfo }) {
  if (!file.name?.toLowerCase().endsWith('.zip')) {
    message.warning(t('skills.importInvalidFile'))
    return false
  }
  return true
}

function pickFolder() {
  folderInputRef.value?.click()
}

function onFolderSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const list = input.files
  if (!list || list.length === 0) return
  const files: File[] = []
  for (let i = 0; i < list.length; i++) files.push(list[i])
  folderFiles.value = files
  const first = (files[0] as any).webkitRelativePath as string | undefined
  folderName.value = first ? first.split('/')[0] : ''
}

function close() {
  if (loading.value) return
  showModal.value = false
  setTimeout(() => emit('close'), 150)
}

async function save() {
  if (mode.value === 'install') {
    if (!hasSelection.value) {
      message.warning(t('skills.importNoSelection'))
      return
    }
    const files = importMode.value === 'zip'
      ? zipFiles.value.map(item => item.file).filter((file): file is File => Boolean(file))
      : folderFiles.value
    if (files.length === 0) {
      message.error(t('skills.importFailed'))
      return
    }
    loading.value = true
    try {
      const result = await props.importHandler(files, category.value || undefined, agent.value)
      message.success(t('skills.importSuccess') + (result?.name ? `: ${result.name}` : ''))
      emit('saved')
    } catch (error) {
      message.error(t('skills.importFailed') + `: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      loading.value = false
    }
    return
  }

  const name = skillName.value.trim()
  const content = skillContent.value.trim()
  if (!name) {
    message.warning(t('skills.createNameRequired'))
    return
  }
  if (!content) {
    message.warning(t('skills.createContentRequired'))
    return
  }
  loading.value = true
  try {
    await props.createHandler(name, content, category.value || 'misc', agent.value)
    message.success(t('skills.createSuccess'))
    emit('saved')
  } catch (error) {
    message.error(t('skills.createFailed') + `: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('skills.addTitle')"
    :style="{ width: 'min(540px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <div class="form-row">
      <NRadioGroup v-model:value="mode" size="small" :disabled="loading">
        <NRadio value="install">{{ t('skills.addTabInstall') }}</NRadio>
        <NRadio value="create">{{ t('skills.addTabCreate') }}</NRadio>
      </NRadioGroup>
    </div>

    <div class="form-row">
      <label class="field-label">{{ mode === 'create' ? t('skills.addSource') : t('skills.addAgent') }}</label>
      <NSelect v-model:value="agent" :options="agentOptions" :disabled="loading" />
    </div>

    <div class="form-row">
      <label class="field-label">{{ mode === 'create' ? t('skills.addCategory') : t('skills.addTargetCategory') }}</label>
      <NSelect
        v-model:value="category"
        :options="categoryOptions"
        filterable
        tag
        :disabled="loading"
      />
      <p class="hint">{{ t('skills.addCategoryHint') }}</p>
    </div>

    <template v-if="mode === 'install'">
      <div class="form-row">
        <NRadioGroup v-model:value="importMode" size="small" :disabled="loading" @update:value="onImportModeChange">
          <NRadio value="folder">{{ t('skills.importModeFolder') }}</NRadio>
          <NRadio value="zip">{{ t('skills.importModeZip') }}</NRadio>
        </NRadioGroup>
        <p class="hint">{{ importMode === 'zip' ? t('skills.importHintZip') : t('skills.importHintFolder') }}</p>
      </div>
      <div class="form-row">
        <NUpload
          v-if="importMode === 'zip'"
          v-model:file-list="zipFiles"
          :max="1"
          accept=".zip"
          :default-upload="false"
          :disabled="loading"
          @before-upload="beforeUpload"
        >
          <NButton :disabled="loading">{{ t('skills.importSelectFile') }}</NButton>
        </NUpload>
        <div v-else class="folder-picker">
          <input
            ref="folderInputRef"
            type="file"
            webkitdirectory
            multiple
            style="display: none"
            @change="onFolderSelected"
          />
          <NButton :disabled="loading" @click="pickFolder">{{ t('skills.importSelectFolder') }}</NButton>
          <span v-if="folderName" class="folder-info">
            {{ folderName }} ({{ folderFiles.length }} {{ t('skills.importFileCount') }})
          </span>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="form-row">
        <label class="field-label">{{ t('skills.createName') }}</label>
        <NInput v-model:value="skillName" :placeholder="t('skills.createNamePlaceholder')" :disabled="loading" />
      </div>
      <div class="form-row">
        <label class="field-label">{{ t('skills.createContent') }}</label>
        <NInput
          v-model:value="skillContent"
          type="textarea"
          :autosize="{ minRows: 10, maxRows: 18 }"
          :placeholder="t('skills.createContentPlaceholder')"
          :disabled="loading"
        />
        <p class="hint">{{ t('skills.createHint') }}</p>
      </div>
    </template>

    <template #footer>
      <div class="modal-footer">
        <NButton :disabled="loading" @click="close">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="save">{{ t('common.confirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.form-row { margin-bottom: 14px; }
.form-row:last-of-type { margin-bottom: 0; }
.field-label { display: block; font-size: 12px; color: $text-secondary; margin-bottom: 4px; }
.hint { font-size: 12px; color: $text-muted; margin: 6px 0 0; line-height: 1.5; }
.folder-picker { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.folder-info { font-size: 12px; color: $text-secondary; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
