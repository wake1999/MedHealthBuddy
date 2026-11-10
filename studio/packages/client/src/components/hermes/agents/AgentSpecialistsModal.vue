<script setup lang="ts">
import { ref, watch } from 'vue'
import { NAlert, NModal, NSpin, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchAgentSpecialists, type AgentSpecialistCatalog } from '@/api/ekko/specialists'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()
const { t, locale } = useI18n()

const loading = ref(false)
const failed = ref(false)
const catalog = ref<AgentSpecialistCatalog>({ maxDelegationDepth: 2, specialists: [] })

async function load() {
  loading.value = true
  failed.value = false
  try {
    catalog.value = await fetchAgentSpecialists()
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

watch(() => props.show, visible => {
  if (visible) void load()
})
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="agent-specialists-modal"
    style="width: min(760px, calc(100vw - 32px))"
    :title="t('agentManager.specialistsTitle')"
    @update:show="value => emit('update:show', value)"
  >
    <p class="agent-specialists-hint">{{ t('agentManager.specialistsHint') }}</p>

    <NSpin :show="loading">
      <NAlert v-if="failed" type="error" :bordered="false">
        {{ t('agentManager.specialistsFailed') }}
      </NAlert>
      <div v-else class="agent-specialists-list">
        <article v-for="specialist in catalog.specialists" :key="specialist.id" class="specialist-row">
          <div class="specialist-head">
            <div>
              <strong class="specialist-name">
                {{ locale.startsWith('zh') ? specialist.labelZh : specialist.label }}
              </strong>
              <code class="specialist-id">{{ specialist.id }}</code>
            </div>
            <NTag :type="specialist.canDelegate ? 'warning' : 'default'" size="small" :bordered="false">
              {{ specialist.canDelegate
                ? t('agentManager.specialistsCanDelegate')
                : t('agentManager.specialistsNoDelegate') }}
            </NTag>
          </div>
          <p class="specialist-desc">
            {{ locale.startsWith('zh') ? specialist.descriptionZh : specialist.description }}
          </p>
          <div class="specialist-tools">
            <span class="specialist-tools-label">{{ t('agentManager.specialistsTools') }}</span>
            <NTag
              v-for="tool in specialist.allowedTools"
              :key="tool"
              size="tiny"
              :bordered="false"
              class="specialist-tool"
            >
              {{ tool }}
            </NTag>
          </div>
        </article>
      </div>
    </NSpin>

    <p class="agent-specialists-depth">
      {{ t('agentManager.specialistsMaxDepth', { depth: catalog.maxDelegationDepth }) }}
    </p>
  </NModal>
</template>

<style scoped lang="scss">
.agent-specialists-hint {
  margin: 0 0 14px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.agent-specialists-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 58vh;
  overflow-y: auto;
}

.specialist-row {
  padding: 12px 14px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: var(--bg-elevated);
}

.specialist-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.specialist-name {
  display: block;
  color: var(--text-primary);
  font-size: 14px;
}

.specialist-id {
  display: block;
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 11px;
}

.specialist-desc {
  margin: 7px 0 9px;
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}

.specialist-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.specialist-tools-label {
  margin-right: 3px;
  color: var(--text-muted);
  font-size: 11px;
}

.specialist-tool {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.agent-specialists-depth {
  margin: 14px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
