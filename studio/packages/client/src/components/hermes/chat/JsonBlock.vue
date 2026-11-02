<script setup lang="ts">
/**
 * 智能体返回的结构化结果（FastGPT 工作流常常直接回一段 JSON）。
 *
 * 直接丢给 Markdown 渲染会变成一大坨没有换行的文字，这里改成等宽 + 缩进 +
 * 默认折叠：超过 10 行先只看开头，需要时展开，另配一个复制按钮。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { copyToClipboard } from '@/utils/clipboard'

const props = defineProps<{ value: unknown; streaming?: boolean }>()
const { t } = useI18n()

const PREVIEW_LINES = 10
const expanded = ref(false)
const copied = ref(false)

const pretty = computed(() => {
  try {
    return JSON.stringify(props.value, null, 2) ?? ''
  } catch {
    return ''
  }
})
const lines = computed(() => pretty.value.split('\n'))
const truncated = computed(() => lines.value.length > PREVIEW_LINES)
const shown = computed(() => {
  if (expanded.value || !truncated.value) return pretty.value
  return `${lines.value.slice(0, PREVIEW_LINES).join('\n')}\n…`
})

async function copy() {
  try {
    await copyToClipboard(pretty.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1600)
  } catch {
    /* 剪贴板不可用就算了，不影响阅读 */
  }
}
</script>

<template>
  <div class="json-block">
    <div class="json-block-head">
      <span class="json-block-title">{{ t('chat.jsonBlockTitle') }}</span>
      <span class="json-block-meta">{{ t('chat.jsonBlockLines', { count: lines.length }) }}</span>
      <div class="json-block-actions">
        <button v-if="!streaming" type="button" class="json-block-action" @click="copy">
          {{ copied ? t('chat.jsonBlockCopied') : t('chat.jsonBlockCopy') }}
        </button>
        <button v-if="truncated" type="button" class="json-block-action" @click="expanded = !expanded">
          {{ expanded ? t('chat.jsonBlockCollapse') : t('chat.jsonBlockExpand') }}
        </button>
      </div>
    </div>
    <pre class="json-block-body"><code>{{ shown }}</code></pre>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.json-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0;
  border: 1px solid $border-light;
  border-radius: 10px;
  background: rgba(var(--text-primary-rgb), 0.02);
  overflow: hidden;
}

.json-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid $border-light;
  background: rgba(var(--text-primary-rgb), 0.03);
}

.json-block-title {
  color: $text-primary;
  font-size: 12px;
  font-weight: 600;
}

.json-block-meta { color: $text-muted; font-size: 11px; }

.json-block-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-inline-start: auto;
}

.json-block-action {
  padding: 2px 8px;
  border: 1px solid $border-light;
  border-radius: 6px;
  background: transparent;
  color: $text-secondary;
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color $transition-fast, color $transition-fast;

  &:hover { border-color: rgba(var(--accent-primary-rgb), 0.4); color: $accent-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}

.json-block-body {
  margin: 0;
  padding: 10px 12px;
  max-height: 340px;
  overflow: auto;
  color: $text-primary;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
