<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NDrawer, NDrawerContent, NSwitch, NTag, useMessage } from 'naive-ui'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import {
  fetchAgentSpecialists,
  setAgentSpecialistEnabled,
  type AgentSpecialist,
} from '@/api/ekko/specialists'
import { useChatStore } from '@/stores/hermes/chat'

const AiHelpChatPanel = defineAsyncComponent(async () => (await import('@/components/hermes/chat/ChatPanel.vue')).default)

const { t, locale } = useI18n()
const message = useMessage()
const chatStore = useChatStore()

const loading = ref(true)
const failed = ref(false)
const specialists = ref<AgentSpecialist[]>([])
const toggling = ref<Record<string, boolean>>({})
const chatDrawerVisible = ref(false)
const chatPrompt = ref('')

const enabledCount = computed(() => specialists.value.filter(item => item.enabled).length)

async function load() {
  loading.value = true
  failed.value = false
  try {
    const catalog = await fetchAgentSpecialists()
    specialists.value = catalog.specialists
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

async function toggle(specialist: AgentSpecialist, enabled: boolean) {
  if (toggling.value[specialist.id]) return
  toggling.value = { ...toggling.value, [specialist.id]: true }
  try {
    await setAgentSpecialistEnabled(specialist.id, enabled)
    specialist.enabled = enabled
    message.success(enabled
      ? t('experts.enabledToast', { name: specialist.labelZh })
      : t('experts.disabledToast', { name: specialist.labelZh }))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    toggling.value = { ...toggling.value, [specialist.id]: false }
  }
}

function useSpecialist(specialist: AgentSpecialist) {
  if (!specialist.enabled) return
  chatStore.newChat({
    source: 'builtin_agent',
    agent: 'ekko-agent',
    codingAgentId: 'ekko-agent',
    codingAgentMode: 'scoped',
  })
  chatPrompt.value = t('experts.usePrompt', {
    name: specialist.labelZh,
    role: specialist.id,
  })
  chatDrawerVisible.value = true
}

function label(specialist: AgentSpecialist) {
  return locale.value.startsWith('zh') ? specialist.labelZh : specialist.label
}

function description(specialist: AgentSpecialist) {
  return locale.value.startsWith('zh') ? specialist.descriptionZh : specialist.description
}

onMounted(load)
</script>

<template>
  <PageLoading :show="loading" class="experts-view">
    <PageHeader>
      <header class="page-header experts-header">
        <div>
          <h2 class="header-title">{{ t('experts.title') }}</h2>
        </div>
        <span class="experts-count">{{ t('experts.enabledCount', { enabled: enabledCount, total: specialists.length }) }}</span>
      </header>
    </PageHeader>

    <div class="experts-body">
      <p class="experts-intro">{{ t('experts.subtitle') }}</p>
      <NAlert v-if="failed" type="error" :bordered="false">{{ t('experts.loadFailed') }}</NAlert>
      <div v-else class="experts-grid">
        <article
          v-for="specialist in specialists"
          :key="specialist.id"
          class="expert-card"
          :class="{ 'is-disabled': !specialist.enabled }"
        >
          <div class="expert-card-head">
            <div class="expert-identity">
              <div class="expert-avatar">{{ specialist.labelZh.slice(0, 1) }}</div>
              <div>
                <h3>{{ label(specialist) }}</h3>
                <code>{{ specialist.id }}</code>
              </div>
            </div>
            <NTag :type="specialist.enabled ? 'success' : 'default'" size="small" :bordered="false">
              {{ specialist.enabled ? t('experts.enabled') : t('experts.disabled') }}
            </NTag>
          </div>

          <p class="expert-desc">{{ description(specialist) }}</p>

          <div class="expert-meta">
            <span>{{ t('agentManager.specialistsTools') }}</span>
            <NTag v-for="tool in specialist.allowedTools" :key="tool" size="tiny" :bordered="false">
              {{ tool }}
            </NTag>
          </div>

          <div v-if="specialist.preferredModel" class="expert-model">
            {{ t('agentManager.specialistsModel') }}: <code>{{ specialist.preferredModel }}</code>
          </div>

          <div class="expert-actions">
            <div class="expert-toggle">
              <span>{{ specialist.enabled ? t('experts.available') : t('experts.unavailable') }}</span>
              <NSwitch
                :value="specialist.enabled"
                :loading="Boolean(toggling[specialist.id])"
                @update:value="value => toggle(specialist, value)"
              />
            </div>
            <NButton
              size="small"
              type="primary"
              secondary
              :disabled="!specialist.enabled"
              @click="useSpecialist(specialist)"
            >
              {{ t('experts.use') }}
            </NButton>
          </div>
        </article>
      </div>
    </div>

    <NDrawer v-model:show="chatDrawerVisible" placement="right" width="var(--studio-drawer-width)" class="agent-ai-help-drawer">
      <NDrawerContent :title="t('experts.chatTitle')" closable body-content-style="padding: 0; overflow: hidden;">
        <AiHelpChatPanel
          v-if="chatDrawerVisible"
          standalone
          :initial-composer-text="chatPrompt"
          :composer-persist-draft="false"
        />
      </NDrawerContent>
    </NDrawer>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.experts-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.experts-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.experts-intro {
  max-width: 1280px;
  margin: 0 0 14px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.experts-count {
  flex: none;
  color: var(--text-secondary);
  font-size: 12px;
}

.experts-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 22px 28px;
}

.experts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  max-width: 1280px;
}

.expert-card {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 15px;
  border: 1px solid var(--border-light);
  border-radius: 12px;
  background: var(--bg-elevated);

  &.is-disabled {
    opacity: 0.62;
    border-style: dashed;
  }
}

.expert-card-head,
.expert-identity,
.expert-actions,
.expert-toggle {
  display: flex;
  align-items: center;
}

.expert-card-head {
  justify-content: space-between;
  gap: 12px;
}

.expert-identity {
  gap: 10px;
  min-width: 0;
}

.expert-avatar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: var(--accent-primary);
  font-weight: 700;
}

.expert-identity h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 14px;
}

.expert-identity code {
  display: block;
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
}

.expert-desc {
  margin: 0;
  min-height: 34px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}

.expert-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: 11px;
}

.expert-model {
  color: var(--text-muted);
  font-size: 11px;
}

.expert-actions {
  justify-content: space-between;
  gap: 12px;
  margin-top: auto;
  padding-top: 4px;
}

.expert-toggle {
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
