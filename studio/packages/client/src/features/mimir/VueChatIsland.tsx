import { useEffect, useRef } from 'react'
import { createApp, defineComponent, h, type App as VueApp } from 'vue'
import { getActivePinia } from 'pinia'
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  darkTheme,
} from 'naive-ui'
import ChatPanel from '@/components/hermes/chat/ChatPanel.vue'
import router from '@/router'
import { i18nReady } from '@/i18n'

interface VueChatIslandProps {
  readonly paperTitle: string
  readonly selection?: { readonly text: string; readonly page: number } | null
  readonly prepareSession?: () => Promise<void>
}

/**
 * 在阅读器里挂载「完整单聊」，而不是另写一套简化消息列表。
 *
 * 共享主应用的 Pinia / i18n / router，所以 ChatPanel 与单聊读取同一个
 * activeSession、同一份消息与运行状态。standalone 模式只隐藏会话列表和
 * 顶部页面 header，消息、输入、附件、工具调用等全部保留。
 */
export function VueChatIsland({ paperTitle, selection, prepareSession }: VueChatIslandProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    let app: VueApp | null = null

    const initialText = selection
      ? `关于《${paperTitle}》第 ${selection.page} 页的这段原文：\n\n${selection.text}\n\n请围绕这段内容回答；回答时请注明出处页码。`
      : ''

    const ChatRoot = defineComponent({
      setup() {
        return () => h(
          NConfigProvider,
          {
            theme: document.documentElement.classList.contains('dark') ? darkTheme : null,
            // ChatPanel 根节点是 height:100%；provider 若保持 auto 高度，
            // 100% 会退化成内容高度（实测 2918px），输入区被推到视口之外。
            style: { height: '100%', minHeight: '0', display: 'flex', flexDirection: 'column' },
          },
          {
            default: () => h(NMessageProvider, null, {
              default: () => h(NDialogProvider, null, {
                default: () => h(NNotificationProvider, null, {
                  default: () => h(ChatPanel, {
                    standalone: true,
                    contentMode: 'chat',
                    initialComposerText: initialText,
                    composerPersistDraft: true,
                  }),
                }),
              }),
            }),
          },
        )
      },
    })

    void (async () => {
      try {
        await prepareSession?.()
        const i18n = await i18nReady
        if (cancelled || !hostRef.current) return
        app = createApp(ChatRoot)
        const pinia = getActivePinia()
        if (pinia) app.use(pinia)
        app.use(i18n)
        app.use(router)
        app.mount(hostRef.current)
      } catch (error) {
        console.error('[reader-chat] failed to mount the full chat panel', error)
      }
    })()

    return () => {
      cancelled = true
      app?.unmount()
      app = null
    }
  }, [paperTitle, prepareSession, selection?.page, selection?.text])

  return (
    <div
      ref={(element) => { hostRef.current = element as HTMLDivElement | null }}
      style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}
    />
  )
}
