<script setup lang="ts">
import { agentMetadata, isNativeCodingAgent, isGlobalOnlyCodingAgent } from '@/utils/agent-catalog'
import PageSidebar from "@/components/layout/PageSidebar.vue"
import { usePageSidebarState } from "@/composables/usePageSidebar"
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { useCodingAgentModels } from '@/composables/useCodingAgentModels'
import PageHeader from '@/components/layout/PageHeader.vue'
import HeaderSidebarToggle from '@/components/layout/HeaderSidebarToggle.vue'
import { AGENT_OPTIONS } from "@/utils/agent-options"
import { setSessionPinned } from "@/api/studio/sessions";
import DshSessionPresetSelect from "@/components/coding-agents/dsh/DshSessionPresetSelect.vue";
import {
  batchDeleteSessions,
  createSessionCategory,
  deleteSessionCategory,
  exportSession,
  fetchSessionCategories,
  renameSession,
  renameSessionCategory,
  setSessionCategory,
  setSessionWorkspace,
  type SessionCategory,
} from "@/api/studio/sessions";
import type { AvailableModelGroup } from "@/api/hermes/system";
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId, type CodingAgentApiMode, type CodingAgentId } from "@/api/coding-agents";
import { nativeCatalogModel, nativeModelLabel, nativeModelFamilies, nativeModelPickerId, nativeModelEffortChoices, selectNativeModelEffort } from "@/utils/native-model-families";
import { agentInstallationState, fetchAgentAvailabilitySnapshot, type AgentAvailabilitySnapshot } from "@/api/agent-status";
import { useChatStore, type Session, type Attachment } from "@/stores/hermes/chat";
import { useAppStore } from "@/stores/hermes/app";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { useFilesStore } from "@/stores/hermes/files";
import { useToolPanelStore } from "@/stores/hermes/tool-panel";
import { useSessionBrowserPrefsStore } from "@/stores/hermes/session-browser-prefs";
import {
  NSpin,
  NButton,
  NDropdown,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NTooltip,
  NPopconfirm,
  NPopover,
  useMessage,
  type DropdownOption,
} from "naive-ui";
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, provide, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/utils/clipboard";
import FolderPicker from "./FolderPicker.vue";
import StarIcon from "@/components/common/StarIcon.vue";
import ChatInput from "./ChatInput.vue";
import NewChatAgentCards from "./NewChatAgentCards.vue";
import {
  PROMPT_TEMPLATE_DOMAINS,
  type PromptTemplateDomainId,
} from '@/utils/hermes/prompt-templates';
import DiscoverAppsPopover from './DiscoverAppsPopover.vue';
import { FALLBACK_CHAT_APPS, resolveChatApps, type ChatAppScene } from '@/data/chat-apps';
import { fetchChatApps, type ChatAppDto } from '@/api/studio/chat-apps';
import {
  FASTGPT_EMBED_BASE,
  fetchFastGptAgentVariables,
  fetchFastGptAgents,
  streamFastGptAgentChat,
  type FastGptAgent,
  type FastGptAgentVariable,
} from '@/api/studio/fastgpt-agents';
import { prepareAgentDeployment, type AgentDeploymentController } from "./agentDeployment.mjs";
import RealtimeVoiceStage from "./RealtimeVoiceStage.vue";
import ConversationMonitorPane from "./ConversationMonitorPane.vue";
import MessageList from "./MessageList.vue";
import SessionListItem from "./SessionListItem.vue";
import ListActionsMenu from "@/components/layout/ListActionsMenu.vue";
import OutlinePanel from "./OutlinePanel.vue";
import TerminalPanel from "./TerminalPanel.vue";
import SubagentStreamPanel from "./SubagentStreamPanel.vue";
import { chatSessionAgentAvatar } from "@/utils/chat-agent-avatar";
import { isHermesSession } from "@/utils/hermes/session-agent";
import { buildSessionCategoryMenuChildren } from "./session-category-menu";
import { buildActiveSessionMenuOptions, buildSessionContextMenuOptions } from "./session-menu-options";
import PageSidebarNav from "@/components/layout/PageSidebarNav.vue";
import PageSidebarFooter from "@/components/layout/PageSidebarFooter.vue";
import { getStoredUserId, isStoredSuperAdmin } from "@/api/client";
import { loadNewChatFormPreferences, saveNewChatFormPreferences } from "@/utils/new-chat-form-preferences";
import { useDefaultWorkspace } from "@/composables/useDefaultWorkspace";
import { profileLabel } from "@/api/hermes/profiles";
import ModelCascader from "@/components/hermes/models/ModelCascader.vue";
import { canScopedCodingAgentUseProvider, usesServerManagedProviderAuth } from "@/utils/codingAgentProviders";
import { OPEN_SUBAGENT_STREAM_EVENT, type OpenSubagentStreamDetail } from "@/utils/hermes/subagent-stream";
import { desktopBridge, hasDesktopBrowserBridge } from "@/utils/desktop-bridge";
import { OPEN_DESKTOP_BROWSER_PANEL_EVENT } from "@/utils/desktop-browser";
import { OPEN_PROMPT_TEMPLATES_PANEL_EVENT } from "@/utils/hermes/prompt-templates";
import {
  createBrowserAnnotationAttachment,
  type BrowserAnnotationSubmission,
} from "@/utils/browser-annotation-submit";

const props = withDefaults(defineProps<{
  standalone?: boolean;
  contentMode?: "chat" | "connections" | "agents" | "models";
  initialComposerText?: string;
  composerPersistDraft?: boolean;
}>(), {
  standalone: false,
  contentMode: "chat",
  initialComposerText: "",
  composerPersistDraft: true,
});

provide('hermesWorkspaceFilePreview', true);

const FilesPanel = defineAsyncComponent(async () => (await import('./FilesPanel.vue')).default);
const ConnectionsPanel = defineAsyncComponent(async () => (await import('@/components/hermes/connections/ConnectionsPanel.vue')).default);
const AgentManagerPanel = defineAsyncComponent(async () => (await import('@/views/hermes/AgentManagerView.vue')).default);
const ModelsPanel = defineAsyncComponent(async () => (await import('@/views/hermes/ModelsView.vue')).default);
const WorkspaceDiffPreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/WorkspaceDiffPreview.vue')).default);
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default);
const DesktopBrowserPanel = defineAsyncComponent(async () => (await import('./DesktopBrowserPanel.vue')).default);
const PromptTemplatesPanel = defineAsyncComponent(async () => (await import('./PromptTemplatesPanel.vue')).default);

const chatStore = useChatStore();

/** The hero's three domains (办公 / 开发 / 设计); they pick which categories the composer lists. */
const activeTemplateDomain = ref<PromptTemplateDomainId>('chat');

function selectTemplateDomain(id: PromptTemplateDomainId) {
  if (activeTemplateDomain.value === id) return;
  activeTemplateDomain.value = id;
}

/* ------------------------------------------------------------ 发现应用 */
/**
 * 选中应用只换首页外观：大标题 / 副标题、场景 chips、输入框占位符、快捷提示词。
 * 不写进会话内容，也不动 agent 与模型 —— 应用要接管发送行为时，改 chat-apps.ts。
 */
const CHAT_APP_STORAGE_KEY = 'hermes.chat.activeApp';
const CHAT_APP_SCENE_STORAGE_KEY = 'hermes.chat.activeAppScene';
const CHAT_APP_RECENT_STORAGE_KEY = 'hermes.chat.recentApps';
const CHAT_APP_RECENT_LIMIT = 6;

function readChatAppPreference(key: string): string {
  try { return localStorage.getItem(key)?.trim() || ''; } catch { return ''; }
}

function writeChatAppPreference(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* 隐私模式下写不进去，只是丢了记忆 */ }
}

function readRecentChatApps(): string[] {
  const raw = readChatAppPreference(CHAT_APP_RECENT_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** 目录：先用内置常量开屏，再换服务端下发那版；接口失败就留着常量。 */
const chatAppDtos = ref<readonly ChatAppDto[]>(FALLBACK_CHAT_APPS);
const chatApps = computed(() => resolveChatApps(chatAppDtos.value, locale.value));

async function loadChatApps() {
  const apps = await fetchChatApps();
  if (apps.length > 0) chatAppDtos.value = apps;
}

onMounted(() => { void loadChatApps(); });

const activeChatAppId = ref(readChatAppPreference(CHAT_APP_STORAGE_KEY));
const activeChatApp = computed(() => chatApps.value.find(app => app.id === activeChatAppId.value) ?? null);
const activeChatSceneId = ref(readChatAppPreference(CHAT_APP_SCENE_STORAGE_KEY));
const activeChatScene = computed<ChatAppScene | null>(() => {
  const app = activeChatApp.value;
  if (!app) return null;
  return app.scenes.find(scene => scene.id === activeChatSceneId.value) ?? app.scenes[0] ?? null;
});
const recentChatAppIds = ref<string[]>(readRecentChatApps());
/** 占位符：场景优先，其次应用默认；没选应用时返回空串，输入框用回原本文案。 */
const newChatPlaceholder = computed(() => {
  const app = activeChatApp.value;
  if (!app) return '';
  const scene = activeChatScene.value;
  return scene ? scene.placeholder : app.placeholder;
});
/** 选中智能体后换成它自己的预设提示词，没选就是场景那组。 */
const newChatQuickPrompts = computed(() => {
  const agentPrompts = activeAgentCard.value?.prompts
  if (agentPrompts && agentPrompts.length > 0) return agentPrompts
  return activeChatScene.value?.quickPrompts ?? []
})

/**
 * 场景智能体卡片：FastGPT 里的应用按场景挂在 BTIT 首页，点卡片开详情，
 * 详情里的主按钮直接跳到 FastGPT 对话页（需先在那个站点登录）。
 */
const fastGptAgents = ref<FastGptAgent[]>([])
const fastGptAgentsLoading = ref(false)
const agentDetail = ref<FastGptAgent | null>(null)
/** 弹窗内嵌的分享页地址；空串表示还停在详情卡上。 */
const agentEmbedUrl = ref('')
/** iframe 重建计数：FastGPT 没有对外刷新接口，换 key 是唯一可靠的重载方式。 */
const agentEmbedFrameKey = ref(0)
const agentEmbedFailed = ref(false)
/** 内嵌页顶部的操作提示条；用户关掉后本次内嵌不再打扰，重新进入时恢复。 */
const agentEmbedTipHidden = ref(false)
/** 选中智能体后，输入框直接发给它，回答落在 Studio 会话里。 */
const activeAgentCard = ref<FastGptAgent | null>(null)
const agentChatBusy = ref(false)
/** 每个 Studio 会话对应一个 FastGPT chatId，多轮上下文留在 FastGPT 侧。 */
const agentChatIds = new Map<string, string>()
/** 选中智能体的运行时变量（record_id / domain …），发送时一并带给 FastGPT。 */
const activeAgentVars = ref<FastGptAgentVariable[]>([])
const activeAgentVarValues = ref<Record<string, string>>({})
/** 聊天框里那个「智能体」选择器的展开状态。 */
const agentPickerOpen = ref(false)

/** 当前场景下的智能体：只跟 chat app 的 scene 走，不再参与「发现应用」的选择。 */
const sceneAgents = computed(() => {
  const app = activeChatApp.value
  const scene = activeChatScene.value
  if (!app || !scene) return []
  return fastGptAgents.value.filter(agent => agent.sceneId === scene.id)
})

/** BTIT cards use the same carousel model as the built-in agent cards. */
const sceneAgentCards = computed(() => sceneAgents.value.map(agent => ({
  value: agent.appId,
  label: agent.short || agent.name,
  initial: (agent.short || agent.name).slice(0, 1),
  tint: agent.tint,
})))
const sceneAgentCardValue = computed(() => activeAgentCard.value?.appId || sceneAgents.value[0]?.appId || '')

function openSceneAgentDetail(appId: string) {
  const agent = sceneAgents.value.find(item => item.appId === appId)
  if (!agent) return
  // Clicking a scene card only opens details. Selecting an agent for the
  // current chat stays in the composer's agent picker.
  openAgentDetail(agent)
}



async function loadFastGptAgents(force = false) {
  if (fastGptAgentsLoading.value) return
  if (!force && fastGptAgents.value.length > 0) return
  fastGptAgentsLoading.value = true
  try {
    fastGptAgents.value = await fetchFastGptAgents('btit')
  } catch {
    /* 拿不到就退回空列表：卡片区会显示空态和重试按钮，而不是整块消失。 */
    fastGptAgents.value = []
  } finally {
    fastGptAgentsLoading.value = false
  }
}

/**
 * 点卡片＝把输入框切到「跟这个智能体对话」：同一张卡再点一次退出。
 * 详情弹层挪到卡片右上角的小按钮上，避免「看说明」和「开始对话」抢同一个手势。
 */
async function toggleAgentCard(agent: FastGptAgent) {
  if (activeAgentCard.value?.appId === agent.appId) {
    activeAgentCard.value = null
    return
  }
  activeAgentCard.value = agent
  activeAgentVars.value = []
  activeAgentVarValues.value = {}
  // 变量定义从分享页元数据里读，一个应用一次；切走之后回来的结果直接丢掉。
  const vars = await fetchFastGptAgentVariables(agent.appId)
  if (activeAgentCard.value?.appId !== agent.appId) return
  activeAgentVars.value = vars
  const initial: Record<string, string> = {}
  for (const item of vars) {
    if (item.defaultValue) initial[item.key] = item.defaultValue
  }
  activeAgentVarValues.value = initial
}

/** 聊天框里的选择器：选中就切入该智能体，点同一张卡不算取消（取消走「退出」）。 */
async function selectAgentFromPicker(agent: FastGptAgent) {
  agentPickerOpen.value = false
  if (activeAgentCard.value?.appId === agent.appId) return
  await toggleAgentCard(agent)
}

function exitAgentChat() {
  activeAgentCard.value = null
}

/** 换场景或退出应用后，原来选中的智能体已不在列表里，顺手退出对话模式。 */
function dropAgentIfOutOfScene(agents: FastGptAgent[]) {
  const current = activeAgentCard.value
  if (!current) return
  if (agents.some(item => item.appId === current.appId)) return
  activeAgentCard.value = null
  activeAgentVars.value = []
  activeAgentVarValues.value = {}
}

/**
 * 智能体对话：不经过 hermes agent 的 run，直接经服务端代理调 FastGPT，
 * 用户消息与流式回答都写进一个新开的 Studio 会话里。
 */
async function submitAgentChat(text: string): Promise<boolean> {
  const agent = activeAgentCard.value
  const content = text.trim()
  if (!agent || !content || agentChatBusy.value) return false
  agentChatBusy.value = true
  try {
    const session = chatStore.newChat({
      profile: newChatProfile.value,
      source: 'builtin_agent',
      agent: 'ekko-agent',
    });
    const target = chatStore.sessions.find(item => item.id === session.id)
    const now = Date.now()
    target?.messages.push(
      { id: `agent-${now}-u`, role: 'user', content, timestamp: now },
      { id: `agent-${now}-a`, role: 'assistant', content: '', timestamp: now + 1 },
    )
    const live = target ? target.messages[target.messages.length - 1] : undefined
    const chatId = agentChatIds.get(session.id) ?? `studio-${session.id}-${now}`
    agentChatIds.set(session.id, chatId)

    closeNewChatPage()
    await router.push({ name: 'hermes.session', params: { sessionId: session.id } })

    try {
      const variables = Object.fromEntries(
        Object.entries(activeAgentVarValues.value)
          .map(([key, value]) => [key, String(value ?? '').trim()] as const)
          .filter(([, value]) => value.length > 0),
      )
      await streamFastGptAgentChat({
        appId: agent.appId,
        chatId,
        messages: [{ role: 'user', content }],
        variables,
        onDelta: (delta) => { if (live) live.content += delta },
      })
      if (live && !live.content.trim()) live.content = t('chat.agentsEmptyReply')
      // 智能体只负责取数/产结构化结果，解读交给当前会话模型：同一会话里再跑一条 run。
      if (live && live.content.trim() && !live.content.startsWith('（')) {
        void chatStore.sendMessage(
          t('chat.agentsHandoffPrompt', { name: agent.short, result: live.content }),
        ).catch(() => {
          message.error(t('chat.agentsChatFailed', { error: 'handoff failed' }))
        })
      }
    } catch (error: any) {
      const detail = error?.message || 'unknown'
      const notice = t('chat.agentsChatFailed', { error: detail })
      if (live) live.content = live.content.trim() ? `${live.content}\n\n${notice}` : notice
      message.error(notice)
    }
    return true
  } finally {
    agentChatBusy.value = false
  }
}

function openAgentDetail(agent: FastGptAgent) {
  agentDetail.value = agent
  agentEmbedUrl.value = ''
  agentEmbedFrameKey.value = 0
  agentEmbedFailed.value = false
  agentEmbedTipHidden.value = false
}

/** 关闭详情/内嵌：几个状态一起收，免得下次打开残留上一页或上一轮的 key。 */
function closeAgentDetail() {
  agentDetail.value = null
  agentEmbedUrl.value = ''
  agentEmbedFrameKey.value = 0
  agentEmbedFailed.value = false
  agentEmbedTipHidden.value = false
}

function handleAgentDrawerToggle(value: boolean) {
  if (!value) closeAgentDetail()
}

/**
 * 分享链接一般指向 FastGPT 本体（:3000，带 `X-Frame-Options: DENY`），iframe 要换到
 * 宿主机上去头反代的同一条路径；没配分享渠道时退回登录态的 `?appId=` 页。
 */
function toAgentEmbedUrl(agent: FastGptAgent): string {
  const raw = agent.shareUrl?.trim() ?? ''
  if (raw) {
    try {
      const url = new URL(raw)
      return `${FASTGPT_EMBED_BASE}${url.pathname}${url.search}`
    } catch {
      /* 不是绝对地址就退回 appId 那条路。 */
    }
  }
  return agent.appId ? `${FASTGPT_EMBED_BASE}/chat?appId=${encodeURIComponent(agent.appId)}` : ''
}

/**
 * 详情弹层里的主按钮：不跳路由，把分享页塞进弹窗里，关掉/返回都还停在当前场景页，
 * 当前对话上下文不丢。真拿不到地址时才退回原来那条路由页。
 */
function openAgentInStudio(agent: FastGptAgent | null) {
  if (!agent) return
  const url = toAgentEmbedUrl(agent)
  if (!url) {
    closeAgentDetail()
    void router.push({
      name: 'hermes.fastgpt',
      query: {
        appId: agent.appId,
        name: agent.name,
        scene: agent.sceneLabel,
        ...(agent.shareUrl ? { share: agent.shareUrl } : {}),
      },
    })
    return
  }
  agentEmbedUrl.value = url
  agentEmbedFailed.value = false
  agentEmbedTipHidden.value = false
  agentEmbedFrameKey.value += 1
}

function reloadAgentEmbed() {
  agentEmbedFailed.value = false
  agentEmbedFrameKey.value += 1
}

/** 内嵌失效时的出口：优先免登录分享链接，其次登录态的对话页。 */
function openAgentExternal() {
  const agent = agentDetail.value
  if (!agent) return
  const url = agent.shareUrl?.trim() || agent.chatUrl
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function openFastGptAgent(agent: FastGptAgent | null, target: 'chat' | 'manage' = 'chat') {
  if (!agent) return
  const url = target === 'chat' ? agent.chatUrl : agent.manageUrl
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * watch 注册时会立刻跑一次 getter 记 oldValue，而 activeChatApp 依赖 locale
 * （useI18n 在 setup 更后面才执行），放在 setup 顶层会撞 TDZ。挂到 mounted 里
 * 注册，此时 i18n 已就绪，且首屏想直接带出卡片也能用 immediate 的那一次求值。
 */
onMounted(() => {
  void loadFastGptAgents()
  // 同上：watch 注册时会先求值一次 getter，放到 mounted 里才不会撞 locale 的 TDZ。
  watch(sceneAgents, agents => dropAgentIfOutOfScene(agents))
});

/** id 传 null 就是退出应用：清掉偏好，首页回到默认的三域切换。 */
function selectChatApp(id: string | null) {
  const app = chatApps.value.find(item => item.id === id) ?? null;
  if (!app) {
    activeChatAppId.value = '';
    activeChatSceneId.value = '';
    writeChatAppPreference(CHAT_APP_STORAGE_KEY, '');
    writeChatAppPreference(CHAT_APP_SCENE_STORAGE_KEY, '');
    return;
  }
  activeChatAppId.value = app.id;
  activeChatSceneId.value = app.scenes[0]?.id ?? '';
  writeChatAppPreference(CHAT_APP_STORAGE_KEY, activeChatAppId.value);
  writeChatAppPreference(CHAT_APP_SCENE_STORAGE_KEY, activeChatSceneId.value);
  recentChatAppIds.value = [app.id, ...recentChatAppIds.value.filter(item => item !== app.id)]
    .slice(0, CHAT_APP_RECENT_LIMIT);
  writeChatAppPreference(CHAT_APP_RECENT_STORAGE_KEY, JSON.stringify(recentChatAppIds.value));
  void nextTick(() => chatInputRef.value?.focusComposer?.());
  /* 在会话里点应用：直接进该应用的新对话页，否则外观的变化根本看不见。 */
  if (!showNewChatPage.value) void openNewChatPage();
}

function selectChatScene(id: string) {
  activeChatSceneId.value = id;
  writeChatAppPreference(CHAT_APP_SCENE_STORAGE_KEY, id);
}
const appStore = useAppStore();
const profilesStore = useProfilesStore();
const filesStore = useFilesStore();
const toolPanelStore = useToolPanelStore();
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore();
const router = useRouter();
const message = useMessage();
const { t, locale } = useI18n();
const isSuperAdmin = computed(() => isStoredSuperAdmin());

const showOutline = ref(false);
const ACTIVE_SESSION_MENU_ID = "active-session-actions-menu";
const showActiveSessionMenu = ref(false);
const activeSessionMenuTriggerRef = ref<InstanceType<typeof NButton> | null>(null);
let activeSessionMenuInitialFocus: "first" | "last" = "first";
let restoreActiveSessionMenuTriggerFocus = false;
const activeSessionSupportsPersistence = computed(() =>
  Boolean(chatStore.activeSession && !chatStore.activeSession.isLocalOnly),
);
const showRealtimeVoice = ref(false);
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null);
const chatInputRef = ref<(InstanceType<typeof ChatInput> & {
  addFiles?: (files: File[]) => void;
  focusComposer?: () => void;
}) | null>(null);
const chatContentWrapperRef = ref<HTMLElement | null>(null);
const chatMainContentRef = ref<HTMLElement | null>(null);
let sessionFadeAnimation: Animation | null = null;
let workspacePreviewRequestSeq = 0;
let workspacePreviewRequestPending = false;
const chatDropCounter = ref(0);
const isChatDropActive = ref(false);
const showToolPanel = ref(false);
const previewOnlyFileOpen = ref(false);
const toolPanelTransitionReady = ref(false);
const activeToolPanel = ref<"files" | "terminal" | "browser" | "prompts">("files");
const desktopBrowserAvailable = hasDesktopBrowserBridge();
const desktopChatWindowAvailable = desktopBridge()?.isDesktop === true
  && typeof desktopBridge()?.openChatWindow === "function";
const selectedSubagent = ref<OpenSubagentStreamDetail | null>(null);
const selectedSubagentStream = computed(() => {
  const selected = selectedSubagent.value;
  return selected ? chatStore.getSubagentStream(selected.sessionId, selected.subagentId) : null;
});
const activeWorkspaceSessionId = computed(() => chatStore.activeSession?.workspace && !chatStore.activeSession.isLocalOnly ? chatStore.activeSession.id : null);
const activePreviewSessionId = computed(() => chatStore.activeSession?.id && !chatStore.activeSession.isLocalOnly ? chatStore.activeSession.id : null);
const activeWorkspacePath = computed(() => chatStore.activeSession?.workspace && !chatStore.activeSession.isLocalOnly ? chatStore.activeSession.workspace : null);
const TOOL_PANEL_MIN_WIDTH = 360;
const TOOL_PANEL_DEFAULT_WIDTH = 560;
const TOOL_PANEL_STORAGE_KEY = "hermes.chat.toolPanelWidth";
const toolPanelWidth = ref(loadToolPanelWidth());
const toolResizeStart = ref<{ x: number; width: number; deltaSign: 1 | -1 } | null>(null);

const currentMode = ref<"chat" | "live">("chat");

// Batch selection mode
const isBatchMode = ref(false);
const selectedSessionKeys = ref<Set<string>>(new Set());
const showBatchDeleteConfirm = ref(false);
const isBatchDeleting = ref(false);

const { expanded: showSessions, isMobile } = usePageSidebarState(!props.standalone)

const hasPageSidebar = computed(
  () => !props.standalone && currentMode.value === "chat" && props.contentMode === "chat",
);
const pageSidebarExpanded = computed(() => hasPageSidebar.value && showSessions.value);
const toolPanelStyle = computed(() => ({
  width: isMobile.value ? "100%" : `min(${toolPanelWidth.value}px, 100%)`,
}));

function openRealtimeVoice() {
  if (!chatStore.activeSessionId) return;
  showRealtimeVoice.value = true;
}

function closeRealtimeVoice() {
  showRealtimeVoice.value = false;
}

function sessionHref(sessionId: string, profile?: string | null) {
  return router.resolve({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href;
}

function openSessionInNewTab(sessionId: string, profile = sessionProfile(sessionId)) {
  if (typeof window === "undefined") return;
  const bridge = desktopBridge();
  if (bridge?.isDesktop && bridge.openChatWindow) {
    void bridge.openChatWindow(sessionId, profile || undefined);
    return;
  }
  window.open(sessionHref(sessionId, profile), "_blank", "noopener,noreferrer");
}

function handleOutlineNavigate(target: { messageId: string; anchorId: string }) {
  messageListRef.value?.scrollToAnchor(target.messageId, target.anchorId);
  if (isMobile.value) showOutline.value = false;
}

function loadToolPanelWidth() {
  if (typeof window === "undefined") return TOOL_PANEL_DEFAULT_WIDTH;
  const saved = Number.parseInt(
    window.localStorage.getItem(TOOL_PANEL_STORAGE_KEY) || "",
    10,
  );
  return Number.isFinite(saved) ? Math.round(saved) : TOOL_PANEL_DEFAULT_WIDTH;
}

function toolPanelMaxWidth() {
  if (typeof window === "undefined") return 1180;
  if (isMobile.value) return window.innerWidth;
  const available = chatContentWrapperRef.value?.clientWidth || window.innerWidth;
  return Math.max(320, Math.min(Math.floor(available * 0.88), available - 120));
}

function clampToolPanelWidth(width: number) {
  const maxWidth = toolPanelMaxWidth();
  const minWidth = Math.min(TOOL_PANEL_MIN_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

function handleToolPanelViewportResize() {
  if (isMobile.value) return;
  toolPanelWidth.value = clampToolPanelWidth(toolPanelWidth.value);
}

function handleToolResizeMove(event: PointerEvent) {
  const start = toolResizeStart.value;
  if (!start) return;
  const delta = (event.clientX - start.x) * start.deltaSign;
  toolPanelWidth.value = clampToolPanelWidth(start.width + delta);
}

function stopToolResize() {
  if (!toolResizeStart.value) return;
  toolResizeStart.value = null;
  window.removeEventListener("pointermove", handleToolResizeMove);
  window.removeEventListener("pointerup", stopToolResize);
  if (!isMobile.value) {
    window.localStorage.setItem(TOOL_PANEL_STORAGE_KEY, String(toolPanelWidth.value));
  }
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
}

function startToolResize(event: PointerEvent) {
  if (isMobile.value) return;
  event.preventDefault();
  toolResizeStart.value = {
    x: event.clientX,
    width: toolPanelWidth.value,
    deltaSign: document.documentElement.dir === "rtl" ? 1 : -1,
  };
  window.addEventListener("pointermove", handleToolResizeMove);
  window.addEventListener("pointerup", stopToolResize);
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
}

function closeToolPanelOverlay(): boolean {
  if (toolPanelStore.workspaceDiff && filesStore.hasUnsavedChanges) {
    message.warning(t("files.unsavedChanges"));
    return false;
  }
  if (toolPanelStore.workspaceDiff && filesStore.editingFile) filesStore.closeEditor();
  workspacePreviewRequestSeq += 1;
  workspacePreviewRequestPending = false;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  selectedSubagent.value = null;
  previewOnlyFileOpen.value = false;
  showToolPanel.value = false;
  return true;
}

function toggleToolPanel() {
  if (showToolPanel.value) {
    closeToolPanelOverlay();
    return;
  }
  showToolPanel.value = true;
}

function handleToolPanelBeforeEnter() {
  toolPanelTransitionReady.value = false;
}

function handleToolPanelAfterEnter() {
  toolPanelTransitionReady.value = true;
}

function handleToolPanelBeforeLeave() {
  toolPanelTransitionReady.value = false;
}

function handleToolPanelLeaveCancelled() {
  toolPanelTransitionReady.value = true;
}

function hasDraggedFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function resetChatDropState() {
  chatDropCounter.value = 0;
  isChatDropActive.value = false;
}

function handleChatDragOver(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleChatDragEnter(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  chatDropCounter.value += 1;
  isChatDropActive.value = true;
}

function handleChatDragLeave(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  chatDropCounter.value -= 1;
  if (chatDropCounter.value <= 0) resetChatDropState();
}

function handleChatDrop(event: DragEvent) {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  const target = event.target instanceof Element ? event.target : null;
  resetChatDropState();
  if (!files.length || target?.closest(".chat-input-area")) return;
  chatInputRef.value?.addFiles?.(files);
}

function handleWorkspaceFileAttach(file: File) {
  chatInputRef.value?.addFiles?.([file]);
}

async function submitBrowserAnnotations(payload: BrowserAnnotationSubmission): Promise<boolean> {
  const attachment = createBrowserAnnotationAttachment(payload);
  await chatStore.sendMessage("", [attachment]);
  return true;
}

async function handleSessionClick(
  sessionId: string,
  options: { preserveCategoryCollapse?: boolean } = {},
) {
  closeNewChatPage();
  if (!options.preserveCategoryCollapse) {
    setCategoryRevealSuppressedSessionId(null);
  }
  chatStore.clearSessionCompletedUnread(sessionId);
  if (isMobile.value) showSessions.value = false;
  await router.push({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId },
  });
  if (chatStore.activeSessionId !== sessionId) {
    await chatStore.switchSession(sessionId);
  }
}

watch(
  pageSidebarExpanded,
  (expanded) => appStore.setPageSidebarExpanded(expanded),
  { immediate: true },
);

function workspacePreviewPath(filePath: string): string | null {
  const workspace = activeWorkspacePath.value?.replace(/\\/g, "/").replace(/\/+$/, "");
  let decodedPath = filePath;
  try {
    decodedPath = decodeURIComponent(filePath);
  } catch {
    // Keep malformed percent sequences unchanged so the server can reject them.
  }
  const normalizedPath = decodedPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedPath || !(normalizedPath.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedPath))) return null;
  if (!workspace) return normalizedPath;
  const ignoreCase = /^[a-zA-Z]:\//.test(workspace);
  const comparableWorkspace = ignoreCase ? workspace.toLowerCase() : workspace;
  const comparablePath = ignoreCase ? normalizedPath.toLowerCase() : normalizedPath;
  if (!comparablePath.startsWith(`${comparableWorkspace}/`)) return normalizedPath;
  return normalizedPath.slice(workspace.length + 1);
}

function handleWorkspaceFilePreviewRequest(event: Event) {
  const customEvent = event as CustomEvent<{
    path?: string
    fileName?: string
    previewOnly?: boolean
    startLine?: number
    endLine?: number
  }>;
  const sessionId = activePreviewSessionId.value;
  const filePath = typeof customEvent.detail?.path === "string" ? customEvent.detail.path : "";
  const previewPath = workspacePreviewPath(filePath);
  if (!sessionId || !previewPath) return;

  customEvent.preventDefault();
  const requestSeq = ++workspacePreviewRequestSeq;
  workspacePreviewRequestPending = true;
  const fileName = customEvent.detail?.fileName || previewPath.split("/").pop() || previewPath;
  const requestedStartLine = customEvent.detail?.startLine;
  const startLine = Number.isInteger(requestedStartLine) && requestedStartLine! > 0
    ? requestedStartLine
    : undefined;
  const requestedEndLine = customEvent.detail?.endLine;
  const endLine = startLine && Number.isInteger(requestedEndLine) && requestedEndLine! >= startLine
    ? requestedEndLine
    : startLine;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  selectedSubagent.value = null;
  const previewOnly = customEvent.detail?.previewOnly === true;
  previewOnlyFileOpen.value = previewOnly;
  if (previewOnly) showToolPanel.value = true;
  void filesStore.openSessionWorkspacePreview(
    sessionId,
    previewPath,
    fileName,
    -1,
    startLine ? { startLine, endLine } : undefined,
  )
    .then(() => {
      if (requestSeq === workspacePreviewRequestSeq) workspacePreviewRequestPending = false;
    })
    .catch((error) => {
      if (requestSeq !== workspacePreviewRequestSeq) return;
      workspacePreviewRequestPending = false;
      previewOnlyFileOpen.value = false;
      if (previewOnly) showToolPanel.value = false;
      message.error(error instanceof Error ? error.message : t("files.previewFailed"));
    });
}

function handleOpenSubagentStreamRequest(event: Event) {
  const customEvent = event as CustomEvent<OpenSubagentStreamDetail>;
  const detail = customEvent.detail;
  if (!detail?.sessionId || !detail.subagentId || detail.sessionId !== chatStore.activeSessionId) return;
  if (toolPanelStore.workspaceDiff && filesStore.hasUnsavedChanges) {
    message.warning(t("files.unsavedChanges"));
    return;
  }
  if (toolPanelStore.workspaceDiff && filesStore.editingFile) filesStore.closeEditor();
  workspacePreviewRequestSeq += 1;
  workspacePreviewRequestPending = false;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  previewOnlyFileOpen.value = false;
  selectedSubagent.value = detail;
  showToolPanel.value = true;
}

function handleOpenPromptTemplatesPanelRequest() {
  workspacePreviewRequestSeq += 1;
  workspacePreviewRequestPending = false;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  previewOnlyFileOpen.value = false;
  selectedSubagent.value = null;
  activeToolPanel.value = "prompts";
  showToolPanel.value = true;
}

function handleOpenDesktopBrowserPanelRequest() {
  if (!desktopBrowserAvailable) return;
  if (toolPanelStore.workspaceDiff && filesStore.hasUnsavedChanges) {
    message.warning(t("files.unsavedChanges"));
    return;
  }
  if (toolPanelStore.workspaceDiff && filesStore.editingFile) filesStore.closeEditor();
  workspacePreviewRequestSeq += 1;
  workspacePreviewRequestPending = false;
  filesStore.closePreview();
  toolPanelStore.closeWorkspaceDiff();
  previewOnlyFileOpen.value = false;
  selectedSubagent.value = null;
  activeToolPanel.value = "browser";
  showToolPanel.value = true;
}

onMounted(() => {



  window.addEventListener("hermes:preview-workspace-file", handleWorkspaceFilePreviewRequest);
  window.addEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest);
  window.addEventListener(OPEN_SUBAGENT_STREAM_EVENT, handleOpenSubagentStreamRequest);
  window.addEventListener(OPEN_PROMPT_TEMPLATES_PANEL_EVENT, handleOpenPromptTemplatesPanelRequest);
  window.addEventListener("resize", handleToolPanelViewportResize);
  window.addEventListener("keydown", handleNewChatEscape);
  handleToolPanelViewportResize();
  if (profilesStore.profiles.length === 0) {
    void profilesStore.fetchProfiles();
  }
  if (!props.standalone) void loadSessionCategories();
});

watch(
  () => chatStore.activeSessionId,
  async (sessionId, previousSessionId) => {
    if (sessionId === previousSessionId || !previousSessionId) return;

    if (filesStore.previewFile || toolPanelStore.workspaceDiff || selectedSubagent.value || previewOnlyFileOpen.value) {
      closeToolPanelOverlay();
    } else {
      workspacePreviewRequestSeq += 1;
      workspacePreviewRequestPending = false;
      filesStore.closePreview();
    }
    if (!sessionId) return;

    await nextTick();
    // A session you just opened should be ready to type in. Without this the
    // composer keeps whatever focus the sidebar click left behind, so the first
    // keystroke goes nowhere.
    chatInputRef.value?.focusComposer?.();

    const surface = chatMainContentRef.value;
    if (!surface || typeof surface.animate !== "function") return;

    sessionFadeAnimation?.cancel();
    sessionFadeAnimation = surface.animate(
      [
        { opacity: 0 },
        { opacity: 1 },
      ],
      {
        duration: 1500,
        easing: "ease",
      },
    );
  },
  { flush: "post" },
);

onUnmounted(() => {
  newChatOptionsLoadSequence++;

  window.removeEventListener("hermes:preview-workspace-file", handleWorkspaceFilePreviewRequest);
  window.removeEventListener(OPEN_DESKTOP_BROWSER_PANEL_EVENT, handleOpenDesktopBrowserPanelRequest);
  window.removeEventListener(OPEN_SUBAGENT_STREAM_EVENT, handleOpenSubagentStreamRequest);
  window.removeEventListener(OPEN_PROMPT_TEMPLATES_PANEL_EVENT, handleOpenPromptTemplatesPanelRequest);
  window.removeEventListener("resize", handleToolPanelViewportResize);
  window.removeEventListener("keydown", handleNewChatEscape);
  stopToolResize();
  sessionFadeAnimation?.cancel();
  workspacePreviewRequestSeq += 1;
  if (workspacePreviewRequestPending || previewOnlyFileOpen.value || filesStore.previewFile?.workspaceSessionId) filesStore.closePreview();
  workspacePreviewRequestPending = false;
  previewOnlyFileOpen.value = false;
  toolPanelStore.closeWorkspaceDiff();
  sessionFadeAnimation = null;
});
watch(showToolPanel, async (visible) => {
  if (!visible || isMobile.value) return;
  await nextTick();
  handleToolPanelViewportResize();
});

watch(
  () => toolPanelStore.workspaceDiff,
  (workspaceDiff) => {
    if (workspaceDiff) {
      workspacePreviewRequestSeq += 1;
      workspacePreviewRequestPending = false;
      filesStore.closePreview();
      selectedSubagent.value = null;
      previewOnlyFileOpen.value = false;
      showToolPanel.value = true;
    }
  },
);

watch(
  () => filesStore.previewFile,
  (previewFile) => {
    if (previewFile) {
      selectedSubagent.value = null;
      activeToolPanel.value = "files";
      showToolPanel.value = true;
    }
  },
);

const showRenameModal = ref(false);
// 删除会话需要二次确认：会话与它的聊天记录会一起从数据库删除，无法恢复。
const showDeleteSessionModal = ref(false);
const deleteSessionId = ref("");
const deleteSessionName = ref("");
const deleteSessionLabel = computed(() => deleteSessionName.value || deleteSessionId.value);
const renameValue = ref("");
const renameSessionId = ref<string | null>(null);
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null);
const sessionProfileFilter = computed(() => chatStore.sessionProfileFilter);
const sessionCategories = ref<SessionCategory[]>([]);
const sessionCategoriesLoading = ref(false);
const sessionCategoriesLoaded = ref(false);
usePageLoadingTask(() => !props.standalone && props.contentMode === 'chat' && !sessionCategoriesLoaded.value);
const sessionCategoriesLoadFailed = ref(false);
const showCreateCategoryModal = ref(false);
const createCategoryValue = ref("");
const createCategorySessionId = ref<string | null>(null);
const createCategoryPendingCategory = ref<SessionCategory | null>(null);
const createCategorySubmitting = ref(false);
const createCategoryInputRef = ref<InstanceType<typeof NInput> | null>(null);
let sessionCategoriesLoadPromise: Promise<void> | null = null;
const COLLAPSED_CATEGORIES_STORAGE_KEY = "hermes_chat_collapsed_categories";
const RECENT_CATEGORY_REVEAL_SUPPRESSION_STORAGE_KEY = "hermes_chat_recent_category_reveal_suppression";
const showRecentCountModal = ref(false);
const recentCountDraft = ref(sessionBrowserPrefsStore.recentCount);

function loadCollapsedCategories(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

const collapsedCategories = ref<Set<string>>(loadCollapsedCategories());

function loadCategoryRevealSuppressedSessionId(): string | null {
  try {
    return sessionStorage.getItem(RECENT_CATEGORY_REVEAL_SUPPRESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

const categoryRevealSuppressedSessionId = ref<string | null>(
  loadCategoryRevealSuppressedSessionId(),
);

function setCategoryRevealSuppressedSessionId(sessionId: string | null) {
  categoryRevealSuppressedSessionId.value = sessionId;
  try {
    if (sessionId) {
      sessionStorage.setItem(RECENT_CATEGORY_REVEAL_SUPPRESSION_STORAGE_KEY, sessionId);
    } else {
      sessionStorage.removeItem(RECENT_CATEGORY_REVEAL_SUPPRESSION_STORAGE_KEY);
    }
  } catch {
    // Keep the in-memory behavior when session storage is unavailable.
  }
}

function persistCollapsedCategories() {
  localStorage.setItem(
    COLLAPSED_CATEGORIES_STORAGE_KEY,
    JSON.stringify([...collapsedCategories.value]),
  );
}

function toggleCategoryGroup(key: string) {
  const next = new Set(collapsedCategories.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedCategories.value = next;
  persistCollapsedCategories();
}
async function handleProfileFilterChange(value: string | null) {
  chatStore.setSessionProfileFilter(value);
  await chatStore.loadSessions(chatStore.sessionProfileFilter);
}

function sortSessionsForSidebar(items: Session[]): Session[] {
  return [...items].sort((a, b) => {
    const aLive = chatStore.isSessionLive(a.id);
    const bLive = chatStore.isSessionLive(b.id);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

const pinnedSessions = computed(() =>
  sortSessionsForSidebar(
    chatStore.sessions.filter((session) =>
      session.isPinned,
    ),
  ),
);

const unpinnedSessions = computed(() =>
  sortSessionsForSidebar(
    chatStore.sessions.filter((session) => !session.isPinned),
  ),
);

/** 侧边栏只有一个「任务」分组：挂了工作空间的会话也在这里。 */
const taskSessions = computed(() => unpinnedSessions.value);

/** 视图（分组 / 列表）与来源筛选（全部 / 云端 / 本地）。 */
const sidebarViewMode = ref<'grouped' | 'flat'>('grouped');
const sessionSourceFilter = ref<'all' | 'cloud' | 'local'>('all');

/** 「云端」＝没挂目录的纯聊天，「本地」＝绑了工作空间的会话。 */
const filteredTaskSessions = computed(() => {
  const filter = sessionSourceFilter.value;
  if (filter === 'cloud') return taskSessions.value.filter((session) => !(session.workspace || '').trim());
  if (filter === 'local') return taskSessions.value.filter((session) => Boolean((session.workspace || '').trim()));
  return taskSessions.value;
});

/** 任务组里再按工作空间分小节：目录名在上、该目录的会话在下。 */
const looseTaskSessions = computed(() =>
  filteredTaskSessions.value.filter((session) => !(session.workspace || '').trim()),
);

/**
 * 工作空间的显示名。
 *
 * 会话目录形如 `...\workspace\默认空间\mvu9jmz57z9vc`，最后一段是会话 id，
 * 直接显示出来就是一串随机字符。这里在最后一段明显是 id 时改用父目录名
 *（「默认空间」），用户看到的是自己认识的名字。
 */
function workspaceDisplayLabel(workspace: string): string {
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || workspace;
  const parent = parts[parts.length - 2] || '';
  if (parent && /^[a-z0-9]{10,}$/i.test(last)) return parent;
  return last;
}

const taskSpaceBuckets = computed(() => {
  // 列表视图把会话平铺，不再分工作空间小节。
  if (sidebarViewMode.value === 'flat') return [];
  // 按「显示名」分桶：同一个工作空间下的多个会话合成一组，而不是每个会话一组。
  const buckets = new Map<string, { label: string; workspace: string; sessions: Session[] }>();
  for (const session of filteredTaskSessions.value) {
    const workspace = (session.workspace || '').trim();
    if (!workspace) continue;
    const label = workspaceDisplayLabel(workspace);
    const bucket = buckets.get(label);
    if (bucket) bucket.sessions.push(session);
    else buckets.set(label, { label, workspace, sessions: [session] });
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, sessions: sortSessionsForSidebar(bucket.sessions) }))
    .sort((a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0));
});

/** 折叠状态、激活会话自动展开都按这个 key 集合走。 */
const sidebarGroups = computed(() => [
  { key: 'tasks', label: t('chat.tasks'), sessions: filteredTaskSessions.value },
]);

/** 每个工作空间的会话是否收起；默认全部展开（对齐参考图默认态）。 */
const collapsedSpaces = ref<Set<string>>(new Set());

function toggleSpaceSessions(workspace: string) {
  const next = new Set(collapsedSpaces.value);
  if (next.has(workspace)) next.delete(workspace);
  else next.add(workspace);
  collapsedSpaces.value = next;
}

const allSpaceSessionsCollapsed = computed(() =>
  taskSpaceBuckets.value.length > 0
  && taskSpaceBuckets.value.every((bucket) => collapsedSpaces.value.has(bucket.workspace)),
);

/** 组标题右侧那个图标：一键展开或收起所有工作空间里的会话。 */
function toggleAllSpaceSessions() {
  collapsedSpaces.value = allSpaceSessionsCollapsed.value
    ? new Set()
    : new Set(taskSpaceBuckets.value.map((bucket) => bucket.workspace));
}

/** 在某个工作空间里新开任务：先切到新建页，再把目录填进去。 */
async function createTaskInWorkspace(workspace: string) {
  await openNewChatPage();
  newChatWorkspace.value = workspace;
}

async function copyWorkspacePath(workspace: string) {
  const ok = await copyToClipboard(workspace);
  if (ok) message.success(t('common.copied'));
}

/** 组标题右侧的「视图」浮层：分组 / 列表，外加来源筛选。 */
const sidebarViewMenuOpen = ref(false);

function setSidebarView(mode: 'grouped' | 'flat') {
  sidebarViewMode.value = mode;
  sidebarViewMenuOpen.value = false;
}

function setSessionSourceFilter(filter: 'all' | 'cloud' | 'local') {
  sessionSourceFilter.value = filter;
  sidebarViewMenuOpen.value = false;
}

/** 工作空间行那个「⋯」的菜单。 */
const workspaceMenuOptions = computed<DropdownOption[]>(() => [
  { key: 'new-task', label: t('chat.workspaceMenuNewTask') },
  { key: 'files', label: t('chat.workspaceMenuFiles') },
  { key: 'copy-path', label: t('chat.copyWorkspacePath') },
]);

function handleWorkspaceMenuSelect(key: string, workspace: string) {
  if (key === 'new-task') {
    void createTaskInWorkspace(workspace);
    return;
  }
  if (key === 'files') {
    showNewChatPage.value = false;
    activeToolPanel.value = 'files';
    showToolPanel.value = true;
    return;
  }
  if (key === 'copy-path') void copyWorkspacePath(workspace);
}

function saveRecentCount() {
  sessionBrowserPrefsStore.setRecentCount(recentCountDraft.value);
  showRecentCountModal.value = false;
}

const activeSessionCategoryKey = computed(() => {
  const session = chatStore.sessions.find((item) => item.id === chatStore.activeSessionId);
  return session?.categoryId == null ? "category-none" : `category-${session.categoryId}`;
});

watch(
  [
    () => sessionCategoriesLoaded.value,
    () => sidebarGroups.value.map((group) => group.key).join("\u0000"),
    () => chatStore.activeSessionId,
    activeSessionCategoryKey,
  ],
  ([loaded, , sessionId, activeKey], [previousLoaded, , previousSessionId, previousActiveKey]) => {
    if (!sessionCategoriesLoaded.value || sidebarGroups.value.length === 0) return;
    const activeSession = chatStore.sessions.find((session) => session.id === chatStore.activeSessionId);
    if (categoryRevealSuppressedSessionId.value === activeSession?.id) return;
    setCategoryRevealSuppressedSessionId(null);
    // Only navigation or a changed category should reveal the active session.
    // Background list refreshes must preserve manually collapsed groups.
    const shouldReveal = loaded !== previousLoaded
      || sessionId !== previousSessionId
      || activeKey !== previousActiveKey;
    if (shouldReveal && collapsedCategories.value.has(activeKey)) {
      collapsedCategories.value = new Set(
        [...collapsedCategories.value].filter((key) => key !== activeKey),
      );
      persistCollapsedCategories();
    }
    if (localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY) !== null) return;
    const expandedKey = sidebarGroups.value.some((group) => group.key === activeKey)
      ? activeKey
      : sidebarGroups.value[0]?.key;
    collapsedCategories.value = new Set(
      sidebarGroups.value.map((group) => group.key).filter((key) => key !== expandedKey),
    );
    persistCollapsedCategories();
  },
  { immediate: true },
);

async function loadSessionCategories() {
  if (sessionCategoriesLoadPromise) return sessionCategoriesLoadPromise;
  sessionCategoriesLoading.value = true;
  sessionCategoriesLoadPromise = (async () => {
    try {
      sessionCategories.value = await fetchSessionCategories();
      sessionCategoriesLoadFailed.value = false;
    } catch {
      sessionCategoriesLoadFailed.value = true;
      message.error(t("chat.categoryLoadFailed"));
    } finally {
      sessionCategoriesLoaded.value = true;
      sessionCategoriesLoading.value = false;
      sessionCategoriesLoadPromise = null;
    }
  })();
  return sessionCategoriesLoadPromise;
}

async function retrySessionCategories() {
  showContextMenu.value = false;
  await loadSessionCategories();
}

const activeSessionTitle = computed(
  () => chatStore.activeSession?.title || t("chat.newChat"),
);

const activeSessionUsesGlobalCodingAgentConfig = computed(() => {
  const session = chatStore.activeSession;
  return session?.codingAgentMode === "global" && Boolean(session.codingAgentId || session.source === "coding_agent");
});

const activeSessionModelLabel = computed(() => {
  const session = chatStore.activeSession;
  if (activeSessionUsesGlobalCodingAgentConfig.value) {
    return nativeModelLabel(activeSessionNativeCatalog.value?.models, session?.model || "", t("codingAgents.nativeModelDefault"));
  }
  if (!session?.model) return t("models.selectModel");
  if (session.provider === "moa") return `MoA · ${session.model}`;
  return appStore.displayModelName(session.model, session.provider);
});

const headerTitle = computed(() =>
  showNewChatPage.value ? t("chat.newChat") : currentMode.value === "live"
    ? t("chat.liveSessions")
    : activeSessionTitle.value,
);

const showNewChatPage = ref(false);
const showNewChatSettings = ref(false);
const showNewChatPresetMode = ref(false);
const newChatComposerRevision = ref(0);
const newChatPreviousToolPanel = ref(false);
const newChatModelLabel = computed(() => isNewChatGlobalCodingAgent.value
  ? nativeModelDisplayName(newChatNativeSelection.value.model)
  : newChatModel.value ? appStore.displayModelName(newChatModel.value, newChatProvider.value)
    : newChatHasNoModels.value ? t("models.noModels") : t("models.selectModel"));

function closeNewChatPage() {
  if (showNewChatPage.value) persistNewChatForm();
  showNewChatPage.value = false;
  if (sessionModelIsDraft.value) {
    showSessionModelPicker.value = false;
    showSessionModelModeModal.value = false;
    pendingSessionModelSwitch.value = null;
    sessionModelIsDraft.value = false;
  }
  if (workspaceIsDraft.value) {
    showWorkspaceModal.value = false;
    workspaceIsDraft.value = false;
  }
  showNewChatSettings.value = false;
  showNewChatPresetMode.value = false;
  newChatOptionsLoadSequence++;
}

function cancelNewChatPage() {
  if (newChatLoading.value) return;
  closeNewChatPage();
  showToolPanel.value = newChatPreviousToolPanel.value;
}

function handleNewChatEscape(event: KeyboardEvent) {
  if (event.key !== "Escape" || !showNewChatPage.value || showSessionModelPicker.value || showSessionModelModeModal.value || showWorkspaceModal.value || showNewChatSettings.value || showNewChatPresetMode.value) return;
  if (event.target instanceof Element && event.target.closest('.n-modal')) return;
  cancelNewChatPage();
}

watch(() => router.currentRoute.value.fullPath, () => closeNewChatPage());
// Agent 卡片已隐藏：新会话固定使用 MedHealthBuddy Agent（AGENT_OPTIONS[0]），
// 不再读取本地保存过的历史选择。
let preferredNewChatAgent: "hermes" | ChatCodingAgentId = AGENT_OPTIONS[0].value;
const newChatAgent = ref<"hermes" | ChatCodingAgentId>(preferredNewChatAgent);
const newChatAgentMode = ref<"global" | "scoped">("scoped");
const newChatProfile = ref<string>("default");
const newChatProvider = ref<string>("");
const newChatModel = ref<string>("");
const newChatCustomModel = ref(false);
const newChatReasoningEffort = ref("");
const newChatNativeSelections = ref<Record<string, { model: string; reasoningEffort: string }>>({});
const newChatBaseUrl = ref<string>("");
const newChatApiKey = ref<string>("");
const newChatApiMode = ref<CodingAgentApiMode>("codex_responses");
const newChatWorkspace = ref("");
const newChatAgentPreset = ref<string>();
const newChatPresetReady = ref(false);
const newChatCategoryId = ref<number | null>(null);
const newChatCategoryCreating = ref(false);
const newChatCategorySelectRevision = ref(0);
const newChatSettingsSelectProps = {
  to: true,
  // Leave room for the trigger and screen edges when a long menu flips upward.
  themeOverrides: { peers: { InternalSelectMenu: { height: "min(300px, calc(50dvh - 40px))" } } },
};
const newChatLoading = ref(false);
const newChatAgentLoading = ref(false);
const newChatModelsLoading = ref(false);
let newChatOptionsLoadSequence = 0;
let restoringNewChatForm = false;

function persistNewChatForm() {
  if (restoringNewChatForm) return;
  saveNewChatFormPreferences(getStoredUserId(), {
    agent: preferredNewChatAgent, mode: newChatAgentMode.value, profile: newChatProfile.value,
    provider: newChatProvider.value, model: newChatModel.value, customModel: newChatCustomModel.value,
    apiMode: newChatApiMode.value, reasoningEffort: newChatReasoningEffort.value,
    workspace: newChatWorkspace.value, categoryId: newChatCategoryId.value,
    agentPreset: newChatAgentPreset.value, baseUrl: newChatBaseUrl.value, apiKey: newChatApiKey.value,
    nativeModels: newChatNativeSelections.value,
  });
}

watch([newChatAgent, newChatAgentMode, newChatProfile, newChatProvider, newChatModel, newChatCustomModel,
  newChatApiMode, newChatReasoningEffort, newChatWorkspace, newChatCategoryId, newChatAgentPreset, newChatBaseUrl, newChatApiKey],
  () => { if (showNewChatPage.value) persistNewChatForm(); }, { flush: "post" });
watch(newChatNativeSelections, () => { if (showNewChatPage.value) persistNewChatForm(); }, { deep: true });

const newChatCategoryOptions = computed(() => [
  { label: t("chat.uncategorized"), value: 0 },
  ...sessionCategories.value.map((category) => ({
    label: category.name,
    value: category.id,
  })),
]);

async function handleNewChatCategoryChange(value: string | number | null) {
  if (value === null || value === 0) {
    newChatCategoryId.value = null;
    return;
  }
  if (typeof value === "number") {
    newChatCategoryId.value = value;
    return;
  }

  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return;
  const existing = sessionCategories.value.find(
    (category) => category.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  if (existing) {
    newChatCategoryId.value = existing.id;
    newChatCategorySelectRevision.value += 1;
    return;
  }

  newChatCategoryCreating.value = true;
  try {
    const category = await createSessionCategory(name);
    if (!sessionCategories.value.some((item) => item.id === category.id)) {
      sessionCategories.value = [...sessionCategories.value, category].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    }
    newChatCategoryId.value = category.id;
    message.success(t("chat.categoryCreated", { name: category.name }));
  } catch (error: any) {
    message.error(error?.message || t("chat.categoryCreateFailed"));
  } finally {
    newChatCategoryCreating.value = false;
    // Clear the string tag retained internally by NSelect after resolving it to a category ID.
    newChatCategorySelectRevision.value += 1;
  }
}

// Directory shortcuts are stored by the authenticated Studio account.
const workspaceComposable = useDefaultWorkspace();
const { defaultWorkspaces, recentWorkspaces } = workspaceComposable;

async function initWorkspaceComposable() {
  try { await workspaceComposable.init(); }
  catch { message.error(t("chat.workspaceSetFailed")); }
}

async function handleToggleWorkspaceFavorite() {
  const path = workspaceValue.value;
  if (!path) return;
  try {
    await workspaceComposable.toggleDefaultWorkspace(path);
  } catch { message.error(t("chat.workspaceSetFailed")); }
}

const isWorkspacePickerFavorite = computed(() => {
  return Boolean(workspaceValue.value && workspaceComposable.isDefaultWorkspace(workspaceValue.value));
});

function getFolderName(path: string | null): string {
  if (!path) return '';
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const last = parts[parts.length - 1] || path;
  const parent = parts[parts.length - 2] || '';
  /*
   * 会话的工作目录形如 `...\workspace\默认空间\mvua16hq33uvh6`，最后一段是
   * 会话 id，显示出来是一串随机字符。这里只在父目录就是「默认空间」时退回
   * 父级名字；用户自己挑的普通目录（D:\projects\foo）仍然显示 foo。
   */
  if ((parent === '默认空间' || parent === 'default') && /^[a-z0-9]{8,}$/i.test(last)) return parent;
  return last;
}

const newChatAgentAvailability = ref<AgentAvailabilitySnapshot | null>(null);
const newChatAgentOptions = computed(() => AGENT_OPTIONS.filter(option =>
  agentInstallationState(newChatAgentAvailability.value, option.value) === "installed",
));

const newChatApiModeOptions = computed(() => [
  { label: t("codingAgents.protocolOpenAiChat"), value: "chat_completions" },
  { label: t("codingAgents.protocolOpenAiResponses"), value: "codex_responses" },
  { label: t("codingAgents.protocolAnthropicMessages"), value: "anthropic_messages" },
]);

function handleNewChatLaunchModeChange(global: boolean) {
  if (!newChatLoading.value) newChatAgentMode.value = global ? "global" : "scoped";
}

function handleNewChatLaunchModeKeydown(event: KeyboardEvent) {
  if (newChatLoading.value || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  handleNewChatLaunchModeChange(event.key === "End" || (event.key !== "Home" && newChatAgentMode.value !== "global"));
  const group = event.currentTarget as HTMLElement;
  nextTick(() => group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
}

function effectiveNewChatMode(
  agent: typeof newChatAgent.value,
  requestedMode: typeof newChatAgentMode.value,
) {
  if (agent === "ekko-agent") return "scoped";
  if (isGlobalOnlyCodingAgent(agent)) return "global";
  return requestedMode;
}

function getModelGroupsForProfile(profile: string) {
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  return profileModels?.groups || [];
}

function isNewChatProviderAllowed(group: AvailableModelGroup) {
  if (group.provider === "moa") return newChatAgent.value === "hermes";
  const mode = effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value);
  if (!(newChatAgent.value !== "hermes" && mode === "scoped")) return true;
  return canScopedCodingAgentUseProvider(newChatAgent.value as ChatCodingAgentId, group.provider);
}

function getSelectableModelGroupsForProfile(profile: string) {
  return getModelGroupsForProfile(profile).filter(isNewChatProviderAllowed);
}

function getDefaultModelForProfile(profile: string) {
  const groups = getSelectableModelGroupsForProfile(profile).map(group => ({
    ...group, models: group.models.filter(model => !group.model_meta?.[model]?.disabled),
  }));
  const activeProfileName = profilesStore.activeProfileName || "default";
  const selectedProvider = appStore.selectedProvider || "";
  const selectedModel = appStore.selectedModel || "";
  const selectedGroup = selectedProvider
    ? groups.find((group) => group.provider === selectedProvider)
    : undefined;
  if (
    profile === activeProfileName &&
    selectedGroup?.models.includes(selectedModel)
  ) {
    return {
      provider: selectedProvider,
      model: selectedModel,
    };
  }
  const profileModels = appStore.profileModelGroups.find(
    (entry) => entry.profile === profile,
  );
  const defaultProvider = profileModels?.default_provider || "";
  const defaultModel = profileModels?.default || "";
  const providerGroup = defaultProvider
    ? groups.find((group) => group.provider === defaultProvider)
    : undefined;
  const fallbackGroup = providerGroup || groups.find((group) => group.models.length > 0);
  return {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models.includes(defaultModel)
      ? defaultModel
      : fallbackGroup?.models[0] || "",
  };
}

const newChatProfileOptions = computed(() =>
  (profilesStore.profiles.length > 0 ? profilesStore.profiles : [{ name: "default" }]).map((profile) => ({
    label: profileLabel(profile),
    value: profile.name,
  })),
);

const selectedNewChatProviderGroup = computed(() =>
  getSelectableModelGroupsForProfile(newChatProfile.value).find((item) => item.provider === newChatProvider.value),
);

const isNewChatCodingAgent = computed(() => newChatAgent.value !== "hermes");
const isNewChatExternalCodingAgent = computed(() => newChatAgent.value === "claude-code" || newChatAgent.value === "codex" || newChatAgent.value === "pi" || newChatAgent.value === "grok" || (newChatAgent.value === "antigravity" || isNativeCodingAgent(newChatAgent.value)) || isGlobalOnlyCodingAgent(newChatAgent.value) || (newChatAgent.value === "opencode" || newChatAgent.value === "dsh"));
const effectiveNewChatAgentMode = computed(() =>
  effectiveNewChatMode(newChatAgent.value, newChatAgentMode.value),
);
const isNewChatGlobalCodingAgent = computed(() =>
  isNewChatCodingAgent.value && effectiveNewChatAgentMode.value === "global",
);
const { catalog: newChatNativeCatalog, loading: newChatNativeModelsLoading, refreshFailed: newChatNativeModelsRefreshFailed, reload: reloadNewChatNativeModels } = useCodingAgentModels(
  () => newChatAgent.value as CodingAgentId,
  () => showNewChatPage.value && isNewChatGlobalCodingAgent.value,
);
const newChatNativeSelection = computed(() => newChatNativeSelections.value[newChatAgent.value] || { model: "", reasoningEffort: "" });
const selectedNewChatNativeModel = computed(() => nativeCatalogModel(newChatNativeCatalog.value?.models, newChatNativeSelection.value.model));
const newChatNativeReasoningEfforts = computed(() => selectedNewChatNativeModel.value?.reasoningEfforts || []);
const newChatNativeEffortChoices = computed(() => nativeModelEffortChoices(newChatNativeCatalog.value?.models, newChatNativeSelection.value.model));
const { catalog: activeSessionNativeCatalog } = useCodingAgentModels(
  () => {
    const id = chatStore.activeSession?.codingAgentId || chatStore.activeSession?.agent || "codex";
    return (agentMetadata(id)?.id || id) as CodingAgentId;
  },
  () => !showNewChatPage.value && activeSessionUsesGlobalCodingAgentConfig.value,
);
const activeSessionNativeReasoningEfforts = computed(() => {
  return nativeCatalogModel(activeSessionNativeCatalog.value?.models, chatStore.activeSession?.model || "")?.reasoningEfforts;
});
const activeSessionNativeEffortChoices = computed(() => nativeModelEffortChoices(activeSessionNativeCatalog.value?.models, chatStore.activeSession?.model || ""));
const newChatComposerReasoningEffort = computed({
  get: () => isNewChatGlobalCodingAgent.value ? newChatNativeSelection.value.reasoningEffort || selectedNewChatNativeModel.value?.reasoningEffort || "" : newChatReasoningEffort.value,
  set: (value: string) => {
    if (isNewChatGlobalCodingAgent.value) newChatNativeSelections.value[newChatAgent.value] = selectNativeModelEffort(newChatNativeCatalog.value?.models, newChatNativeSelection.value.model, value);
    else newChatReasoningEffort.value = value;
  },
});
function nativeModelDisplayName(model: string) {
  return nativeModelLabel(newChatNativeCatalog.value?.models, model, t("codingAgents.nativeModelDefault"));
}
const newChatNativeModelGroups = computed<AvailableModelGroup[]>(() => [{
  provider: `native:${newChatAgent.value}`, label: newChatNativeCatalog.value?.name || newChatAgent.value,
  base_url: "", api_key: "", models: ["", ...new Set(nativeModelFamilies(newChatNativeCatalog.value?.models).map(model => model.id))],
}]);
watch(newChatNativeCatalog, catalog => {
  if (!catalog || !["ready", "empty"].includes(catalog.status)) return;
  const selection = newChatNativeSelection.value;
  if (selection.model && !catalog.models.some(model => model.id === selection.model && !model.hidden)) {
    newChatNativeSelections.value[newChatAgent.value] = { model: "", reasoningEffort: "" };
  } else if (selection.reasoningEffort && selectedNewChatNativeModel.value?.reasoningEfforts
    && !newChatNativeReasoningEfforts.value.includes(selection.reasoningEffort)) {
    newChatNativeSelections.value[newChatAgent.value] = { ...selection, reasoningEffort: "" };
  } else if (selection.model && selectedNewChatNativeModel.value?.modelFamily) {
    newChatNativeSelections.value[newChatAgent.value] = selectNativeModelEffort(catalog.models, selection.model, selection.reasoningEffort || selectedNewChatNativeModel.value.reasoningEffort || "");
  }
});
const newChatDraftConfig = computed(() => ({
  profile: newChatProfile.value,
  provider: isNewChatGlobalCodingAgent.value ? "" : newChatProvider.value,
  model: isNewChatGlobalCodingAgent.value ? newChatNativeSelection.value.model : newChatModel.value,
  codingAgentMode: isNewChatCodingAgent.value ? effectiveNewChatAgentMode.value : undefined,
}));
const newChatModelCatalogKnown = computed(() => appStore.profileModelGroups.some(entry => entry.profile === newChatProfile.value));
function isNewChatModelAvailable(group = selectedNewChatProviderGroup.value) {
  return !!group && !group.model_meta?.[newChatModel.value]?.disabled && (
    group.models.includes(newChatModel.value) || (appStore.customModels[group.provider] || []).includes(newChatModel.value)
    || (newChatCustomModel.value && !!newChatModel.value)
  );
}
const newChatHasNoModels = computed(() => !isNewChatGlobalCodingAgent.value && !newChatModelsLoading.value
  && newChatModelCatalogKnown.value && !isNewChatModelAvailable() && !getSelectableModelGroupsForProfile(newChatProfile.value)
    .some(group => group.models.some(model => !group.model_meta?.[model]?.disabled)
      || (appStore.customModels[group.provider] || []).length > 0));
function openNewChatModelSettings() {
  showSessionModelPicker.value = false;
  void router.push({ name: "hermes.models", query: { modelProfile: newChatProfile.value } });
}

const newChatUsesProviderModel = computed(() => !isNewChatGlobalCodingAgent.value);
const newChatNeedsBaseUrl = computed(() =>
  isNewChatCodingAgent.value && effectiveNewChatAgentMode.value === "scoped" && !selectedNewChatProviderGroup.value?.base_url,
);
const newChatUsesServerAuth = computed(() =>
  usesServerManagedProviderAuth(newChatAgent.value as ChatCodingAgentId, selectedNewChatProviderGroup.value?.provider),
);
const newChatNeedsApiKey = computed(() =>
  isNewChatCodingAgent.value &&
  effectiveNewChatAgentMode.value === "scoped" &&
  !newChatUsesServerAuth.value &&
  !selectedNewChatProviderGroup.value?.api_key,
);
const canConfirmNewChat = computed(() => {
  if (newChatCategoryCreating.value || newChatLoading.value) return false;
  if (newChatCategoryId.value !== null && (sessionCategoriesLoading.value
    || !sessionCategories.value.some(category => category.id === newChatCategoryId.value))) return false;
  if (!newChatAgentOptions.value.some(option => option.value === newChatAgent.value)) return false;
  if (newChatAgent.value === "dsh" && (!newChatAgentPreset.value || !newChatPresetReady.value)) return false;
  if (!profilesStore.profiles.some(profile => profile.name === newChatProfile.value)) return false;
  if (!newChatUsesProviderModel.value) return true;
  if (newChatModelsLoading.value) return false;
  if (!newChatProvider.value || !newChatModel.value || !isNewChatModelAvailable()) return false;
  if (!isNewChatCodingAgent.value) return true;
  if (isNewChatCodingAgent.value && effectiveNewChatAgentMode.value === "scoped" && !newChatApiMode.value) return false;
  if (newChatNeedsBaseUrl.value && !newChatBaseUrl.value.trim()) return false;
  if (newChatNeedsApiKey.value && !newChatApiKey.value.trim()) return false;
  return true;
});

const newChatMissingCredentials = computed(() =>
  !!newChatProvider.value && !!newChatModel.value && ((newChatNeedsBaseUrl.value && !newChatBaseUrl.value.trim())
  || (newChatNeedsApiKey.value && !newChatApiKey.value.trim())),
);

function defaultNewChatApiMode(group?: AvailableModelGroup): CodingAgentApiMode {
  const providerKey = String(group?.provider || newChatProvider.value || "").toLowerCase();
  const baseUrl = String(group?.base_url || newChatBaseUrl.value || "").toLowerCase();
  return normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(providerKey, baseUrl),
  );
}

function syncNewChatApiMode() {
  newChatApiMode.value = defaultNewChatApiMode(selectedNewChatProviderGroup.value);
}

function syncNewChatModelSelection() {
  const defaults = getDefaultModelForProfile(newChatProfile.value);
  newChatProvider.value = defaults.provider;
  newChatModel.value = defaults.model;
  newChatCustomModel.value = false;
  newChatBaseUrl.value = "";
  newChatApiKey.value = "";
  syncNewChatApiMode();
}

function ensureNewChatProviderSelection() {
  if (!newChatUsesProviderModel.value || newChatModelsLoading.value || !newChatModelCatalogKnown.value) return;
  if (isNewChatModelAvailable()) return;
  syncNewChatModelSelection();
}

watch(
  () => [newChatAgent.value, newChatAgentMode.value, newChatProfile.value],
  () => {
    if (!restoringNewChatForm) ensureNewChatProviderSelection();
  },
  { flush: "sync" },
);

function isCurrentNewChatOptionsLoad(sequence: number) {
  return showNewChatPage.value && sequence === newChatOptionsLoadSequence;
}

async function refreshNewChatAgentAvailability(sequence: number) {
  newChatAgentLoading.value = !newChatAgentAvailability.value;
  try {
    const availability = await fetchAgentAvailabilitySnapshot();
    if (!isCurrentNewChatOptionsLoad(sequence)) return;
    newChatAgentAvailability.value = availability;
    newChatAgent.value = newChatAgentOptions.value.find(option => option.value === preferredNewChatAgent)?.value
      || newChatAgentOptions.value[0]?.value || AGENT_OPTIONS[0].value;
  } catch {
    if (isCurrentNewChatOptionsLoad(sequence) && !newChatAgentAvailability.value) {
      message.error(t("codingAgents.loadFailed"));
    }
  } finally {
    if (isCurrentNewChatOptionsLoad(sequence)) newChatAgentLoading.value = false;
  }
}

async function loadNewChatProfiles(sequence: number) {
  if (profilesStore.profiles.length === 0) await profilesStore.fetchProfiles();
  if (!isCurrentNewChatOptionsLoad(sequence)) return;
  if (!profilesStore.profiles.some(profile => profile.name === newChatProfile.value)) {
    newChatProfile.value = profilesStore.activeProfileName || profilesStore.profiles[0]?.name || "default";
  }
  ensureNewChatProviderSelection();
}

async function loadNewChatModels(sequence: number) {
  newChatModelsLoading.value = !newChatModelCatalogKnown.value;
  if (!newChatModelsLoading.value) { ensureNewChatProviderSelection(); return; }
  try {
    await appStore.loadModels();
  } finally {
    if (isCurrentNewChatOptionsLoad(sequence)) {
      newChatModelsLoading.value = false;
      ensureNewChatProviderSelection();
    }
  }
}

async function openNewChatPage() {
  if (newChatLoading.value) return;
  if (props.contentMode !== "chat") await router.push({ name: "hermes.chat" });
  const previousToolPanel = showNewChatPage.value ? newChatPreviousToolPanel.value : showToolPanel.value;
  closeNewChatPage();
  newChatPreviousToolPanel.value = previousToolPanel;
  currentMode.value = "chat";
  showToolPanel.value = false;
  showRealtimeVoice.value = false;
  showOutline.value = false;
  newChatComposerRevision.value++;
  const sequence = ++newChatOptionsLoadSequence;
  isBatchMode.value = false;
  selectedSessionKeys.value.clear();
  showBatchDeleteConfirm.value = false;
  const saved = loadNewChatFormPreferences(getStoredUserId());
  restoringNewChatForm = true;
  preferredNewChatAgent = AGENT_OPTIONS[0].value;
  newChatAgent.value = preferredNewChatAgent;
  newChatAgentMode.value = saved?.mode || "scoped";
  newChatAgentPreset.value = saved?.agentPreset;
  newChatReasoningEffort.value = saved?.reasoningEffort || "";
  newChatNativeSelections.value = saved?.nativeModels || {};
  newChatPresetReady.value = false;
  newChatCategoryId.value = saved?.categoryId ?? null;
  newChatProfile.value = saved?.profile || profilesStore.activeProfileName
    || profilesStore.profiles.find(profile => profile.active)?.name || profilesStore.profiles[0]?.name || "default";
  // 新建会话默认不带工作空间：目录由用户显式挑，避免把上一次的目录带进新会话。
  newChatWorkspace.value = "";
  newChatProvider.value = saved?.provider || "";
  newChatModel.value = saved?.model || "";
  newChatCustomModel.value = saved?.customModel || false;
  newChatBaseUrl.value = saved?.baseUrl || "";
  newChatApiKey.value = saved?.apiKey || "";
  newChatApiMode.value = saved?.apiMode || "chat_completions";
  newChatModelsLoading.value = !newChatModelCatalogKnown.value;
  if (!saved) syncNewChatModelSelection();
  restoringNewChatForm = false;
  if (isMobile.value) showSessions.value = false;
  showNewChatPage.value = true;
  void initWorkspaceComposable();
  void refreshNewChatAgentAvailability(sequence);
  void loadSessionCategories().then(() => {
    if (isCurrentNewChatOptionsLoad(sequence) && !sessionCategoriesLoadFailed.value && newChatCategoryId.value !== null
      && !sessionCategories.value.some(category => category.id === newChatCategoryId.value)) newChatCategoryId.value = null;
  });
  void loadNewChatProfiles(sequence);
  void loadNewChatModels(sequence);
}

function handleNewChatProfileChange(value: string) {
  newChatProfile.value = value;
  syncNewChatModelSelection();
}

async function submitNewChat(text: string, attachments?: Attachment[]): Promise<boolean> {
  // 选中了智能体：这句话是发给它的，不走 hermes agent 的 run 链路。
  if (activeAgentCard.value) return submitAgentChat(text)
  if (!canConfirmNewChat.value || !showNewChatPage.value) return false;
  const sequence = newChatOptionsLoadSequence;
  newChatLoading.value = true;
  let deployment: AgentDeploymentController | null = null;
  try {
    if (newChatAgent.value === "hermes") {
      try {
        const status = await fetchAgentAvailabilitySnapshot();
        if (agentInstallationState(status, "hermes") === "not-installed") {
          // Hermes 只是可选的本地 Runtime。未安装时静默回退到内置 Agent，
          // 不再打断新会话，也不把用户强制带到 Runtime 安装页。
          const fallback = newChatAgentOptions.value.find(option => option.value === "ekko-agent")
            || newChatAgentOptions.value[0];
          if (fallback) {
            newChatAgent.value = fallback.value;
            console.info("Hermes Agent is not installed; using the built-in agent.");
          }
          return false;
        }
      } catch (error) {
        console.warn("Failed to read Hermes Agent availability before creating a chat:", error);
      }
    }

    if (isNewChatExternalCodingAgent.value) {
      try {
        const agentId = newChatAgent.value as CodingAgentId;
        // Reuse the server inventory; probing every CLI's version delays creation.
        const status = await fetchAgentAvailabilitySnapshot();
        if (agentInstallationState(status, agentId) !== "installed") {
          const agentName = newChatAgentOptions.value.find(option => option.value === agentId)?.label || agentId;
          message.warning(t("codingAgents.installRequired", { agent: agentName }));
          showNewChatPage.value = false;
          await router.push({ name: "hermes.agentManager" });
          return false;
        }
      } catch {
        message.error(t("codingAgents.loadFailed"));
        return false;
      }
    }

    if (!isCurrentNewChatOptionsLoad(sequence)) return false;
    const group = selectedNewChatProviderGroup.value;
    const source = newChatAgent.value === "hermes" ? "cli" : newChatAgent.value === "ekko-agent" ? "builtin_agent" : "coding_agent";
    const codingAgentMode = effectiveNewChatAgentMode.value;
    const isGlobalCodingAgent = source === "coding_agent" && codingAgentMode === "global";
    const agent = newChatAgent.value === "codex"
      ? "codex"
      : newChatAgent.value === "claude-code"
        ? "claude"
        : newChatAgent.value === "pi"
          ? "pi"
        : newChatAgent.value === "grok"
          ? "grok"
        : newChatAgent.value === "dsh" ? "dsh" : newChatAgent.value === "opencode"
          ? "opencode"
        : isNativeCodingAgent(newChatAgent.value) ? newChatAgent.value
        : newChatAgent.value === "antigravity" ? "antigravity" : newChatAgent.value === "cursor"
          ? "cursor"
        : newChatAgent.value === "ekko-agent"
          ? "ekko-agent"
        : "hermes";
    deployment = prepareAgentDeployment(chatMainContentRef.value?.querySelector('.agent-card.active'));
    const session = chatStore.newChat({
      profile: newChatProfile.value,
      provider: isGlobalCodingAgent ? undefined : newChatProvider.value,
      model: isGlobalCodingAgent ? newChatNativeSelection.value.model || undefined : newChatModel.value,
      source,
      agent,
      codingAgentId: newChatAgent.value === "hermes" ? undefined : newChatAgent.value,
      codingAgentMode: source === "coding_agent" || source === "builtin_agent" ? codingAgentMode : undefined,
      agentPreset: newChatAgent.value === "dsh" ? newChatAgentPreset.value : undefined,
      workspace: newChatWorkspace.value || null,
      categoryId: newChatCategoryId.value,
      baseUrl: (source === "coding_agent" || source === "builtin_agent") && !isGlobalCodingAgent ? group?.base_url || newChatBaseUrl.value.trim() || undefined : undefined,
      apiKey: (source === "coding_agent" || source === "builtin_agent") && !isGlobalCodingAgent ? group?.api_key || newChatApiKey.value.trim() || undefined : undefined,
      apiMode: isNewChatCodingAgent.value && !isGlobalCodingAgent ? newChatApiMode.value : undefined,
      reasoningEffort: isGlobalCodingAgent ? newChatComposerReasoningEffort.value || undefined
        : newChatProvider.value !== "moa" ? newChatReasoningEffort.value : undefined,
    });
    // Send the first message before changing the route so it belongs to this session.
    void chatStore.sendMessage(text, attachments);
    deployment?.start(session.id);
    closeNewChatPage();
    if (newChatWorkspace.value) {
      void workspaceComposable.recordWorkspaceUsage(newChatWorkspace.value)
        .catch(() => message.error(t("chat.workspaceSetFailed")));
    }

    await router.push({
      name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
      params: { sessionId: session.id },
    });
    showNewChatPage.value = false;
    if (isMobile.value) showSessions.value = false;
    return true;
  } catch (error) {
    deployment?.cancel();
    throw error;
  } finally {
    newChatLoading.value = false;
  }
}

function sessionProfile(sessionId: string): string | null {
  return chatStore.sessions.find((session) => session.id === sessionId)?.profile || null;
}

function buildSessionUrl(sessionId: string, profile?: string | null): string {
  const href = router.resolve({
    name: chatStore.runtimeMode === "global_agent" ? "hermes.globalAgentSession" : "hermes.session",
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href;
  return `${window.location.origin}${window.location.pathname}${href}`;
}

async function copySessionLink(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(buildSessionUrl(sessionId, sessionProfile(sessionId)));
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

async function copySessionId(id?: string) {
  const sessionId = id || chatStore.activeSessionId;
  if (sessionId) {
    const ok = await copyToClipboard(sessionId);
    if (ok) message.success(t("common.copied"));
    else message.error(t("common.copied") + " ✗");
  }
}

const activeSessionMenuOptions = computed<DropdownOption[]>(() => buildActiveSessionMenuOptions({
  outline: t("chat.outlineTitle"),
  rename: t("chat.rename"),
  open: t(desktopChatWindowAvailable
    ? "chat.openSessionInNewWindow"
    : "chat.openSessionInNewTab"),
  copyId: t("chat.copySessionId"),
}, {
  canRename: activeSessionSupportsPersistence.value,
  canOpen: activeSessionSupportsPersistence.value,
}));

function activeSessionMenuProps() {
  return {
    id: ACTIVE_SESSION_MENU_ID,
    role: "menu",
    "aria-label": t("chat.sessionActions"),
  };
}

function activeSessionMenuNodeProps(option: DropdownOption) {
  return {
    id: `${ACTIVE_SESSION_MENU_ID}-${String(option.key || "item")}`,
    role: "menuitem",
    tabindex: -1,
    "aria-disabled": option.disabled ? "true" as const : undefined,
  };
}

function activeSessionMenuItems(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  const menu = document.getElementById(ACTIVE_SESSION_MENU_ID);
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function focusActiveSessionMenuItem(position: number | "first" | "last") {
  const items = activeSessionMenuItems();
  if (items.length === 0) return;
  const index = position === "first"
    ? 0
    : position === "last"
      ? items.length - 1
      : (position + items.length) % items.length;
  items[index]?.focus({ preventScroll: true });
}

function focusActiveSessionMenuTrigger() {
  const element = activeSessionMenuTriggerRef.value?.$el as HTMLElement | undefined;
  element?.focus({ preventScroll: true });
}

function focusAdjacentToActiveSessionMenuTrigger(backwards: boolean) {
  if (typeof document === "undefined") return;
  const trigger = activeSessionMenuTriggerRef.value?.$el as HTMLElement | undefined;
  if (!trigger) return;
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    if (element.closest(`#${ACTIVE_SESSION_MENU_ID}`) || element.closest('[inert]')) return false;
    if (element.tabIndex < 0 || element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  const triggerIndex = candidates.indexOf(trigger);
  if (triggerIndex < 0) return;
  const target = candidates[triggerIndex + (backwards ? -1 : 1)];
  target?.focus({ preventScroll: true });
}

function handleActiveSessionMenuTriggerKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  event.stopPropagation();
  activeSessionMenuInitialFocus = event.key === "ArrowUp" ? "last" : "first";
  showActiveSessionMenu.value = true;
}

function handleActiveSessionMenuKeydown(event: KeyboardEvent) {
  const items = activeSessionMenuItems();
  const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="menuitem"]');
  const currentIndex = current ? items.indexOf(current) : -1;

  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") focusActiveSessionMenuItem("first");
    else if (event.key === "End") focusActiveSessionMenuItem("last");
    else if (event.key === "ArrowDown") focusActiveSessionMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
    else focusActiveSessionMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
    return;
  }

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    current?.querySelector<HTMLElement>(".n-dropdown-option-body")?.click();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    restoreActiveSessionMenuTriggerFocus = true;
    showActiveSessionMenu.value = false;
  } else if (event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    const backwards = event.shiftKey;
    restoreActiveSessionMenuTriggerFocus = false;
    showActiveSessionMenu.value = false;
    void nextTick().then(() => focusAdjacentToActiveSessionMenuTrigger(backwards));
  }
}

watch(showActiveSessionMenu, async (visible, wasVisible) => {
  if (visible) {
    restoreActiveSessionMenuTriggerFocus = false;
    await nextTick();
    focusActiveSessionMenuItem(activeSessionMenuInitialFocus);
    activeSessionMenuInitialFocus = "first";
    return;
  }
  if (!wasVisible || !restoreActiveSessionMenuTriggerFocus) return;
  restoreActiveSessionMenuTriggerFocus = false;
  await nextTick();
  focusActiveSessionMenuTrigger();
});

function openRenameSession(sessionId: string) {
  const session = chatStore.sessions.find((item) => item.id === sessionId)
    || (chatStore.activeSession?.id === sessionId ? chatStore.activeSession : null);
  renameSessionId.value = sessionId;
  renameValue.value = session?.title || "";
  showRenameModal.value = true;
  nextTick(() => {
    renameInputRef.value?.focus();
  });
}

function handleActiveSessionMenuSelect(key: string) {
  const sessionId = chatStore.activeSessionId;
  if (!sessionId) return;
  restoreActiveSessionMenuTriggerFocus = key !== "rename";
  if (key === "outline") {
    showOutline.value = !showOutline.value;
  } else if (key === "rename") {
    if (!activeSessionSupportsPersistence.value) return;
    openRenameSession(sessionId);
  } else if (key === "open-link") {
    if (!activeSessionSupportsPersistence.value) return;
    openSessionInNewTab(sessionId, chatStore.activeSession?.profile || null);
  } else if (key === "copy-id") {
    void copySessionId(sessionId);
  }
}

async function handleDeleteSession(id: string) {
  const ok = await chatStore.deleteSession(id);
  if (!ok) {
    message.error(t("common.deleteFailed"));
    return;
  }
  message.success(t("chat.sessionDeleted"));
}

function toggleBatchMode() {
  if (isBatchDeleting.value) return;
  isBatchMode.value = !isBatchMode.value;
  if (!isBatchMode.value) {
    selectedSessionKeys.value.clear();
    showBatchDeleteConfirm.value = false;
  }
}

function sessionSelectionKey(session: Pick<Session, "id" | "profile">): string {
  return `${session.profile || "default"}\u0000${session.id}`;
}

function toggleSessionSelection(session: Session) {
  if (isBatchDeleting.value) return;
  const key = sessionSelectionKey(session);
  if (selectedSessionKeys.value.has(key)) {
    selectedSessionKeys.value.delete(key);
  } else {
    selectedSessionKeys.value.add(key);
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
  if (selectedSessionKeys.value.size === 0) {
    showBatchDeleteConfirm.value = false;
  }
}

function isSessionSelected(session: Session): boolean {
  return selectedSessionKeys.value.has(sessionSelectionKey(session));
}

async function handleBatchDelete() {
  if (selectedSessionKeys.value.size === 0 || isBatchDeleting.value) return;

  const sessionsByKey = new Map(chatStore.sessions.map((session) => [sessionSelectionKey(session), session]));
  const targets = Array.from(selectedSessionKeys.value)
    .map((key) => sessionsByKey.get(key))
    .filter((session): session is Session => Boolean(session))
    .map((session) => ({ id: session.id, profile: session.profile || null }));
  if (targets.length === 0) return;
  isBatchDeleting.value = true;
  try {
    const result = await batchDeleteSessions(targets);
    if (result.deleted > 0) {
      // Remove deleted sessions from local store (without calling API again)
      // Use loadSessions to refresh from server instead of manual filtering
      await chatStore.loadSessions(chatStore.sessionProfileFilter);

      message.success(t("chat.batchDeleteSuccess", { count: result.deleted }));
      if (result.failed > 0) {
        message.warning(t("chat.batchDeletePartial", { failed: result.failed }));
      }
    } else {
      message.error(t("chat.batchDeleteFailed"));
    }
  } catch (err: any) {
    message.error(t("chat.batchDeleteFailed"));
  } finally {
    isBatchDeleting.value = false;
    showBatchDeleteConfirm.value = false;
    isBatchMode.value = false;
    selectedSessionKeys.value.clear();
  }
}

function handleBatchDeleteConfirm() {
  void handleBatchDelete();
  return false;
}

function selectAllSessions() {
  if (isBatchDeleting.value) return;
  selectedSessionKeys.value.clear();
  for (const session of chatStore.sessions) {
    if (session.id !== chatStore.activeSessionId) {
      selectedSessionKeys.value.add(sessionSelectionKey(session));
    }
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value);
}

const selectedCount = computed(() => selectedSessionKeys.value.size);
const canSelectAll = computed(() => {
  return chatStore.sessions.some(s => s.id !== chatStore.activeSessionId);
});

const contextSessionId = ref<string | null>(null);
const contextSessionPinned = computed(() =>
  contextSessionId.value
    ? Boolean(contextSession.value?.isPinned)
    : false,
);
const contextSession = computed(() =>
  contextSessionId.value
    ? chatStore.sessions.find((session) => session.id === contextSessionId.value) || null
    : null,
);

const showCategoryContextMenu = ref(false);
const categoryContextMenuX = ref(0);
const categoryContextMenuY = ref(0);
const categoryContextId = ref<number | null>(null);
const categoryContextName = computed(() =>
  sessionCategories.value.find((item) => item.id === categoryContextId.value)?.name || "",
);
const categoryContextMenuOptions = computed<DropdownOption[]>(() => [
  { label: t("chat.renameCategory"), key: "rename" },
  { label: t("chat.deleteCategory"), key: "delete" },
]);
const showRenameCategoryModal = ref(false);
const renameCategoryValue = ref("");
const showDeleteCategoryModal = ref(false);

function handleCategoryContextMenuSelect(key: string) {
  showCategoryContextMenu.value = false;
  const category = sessionCategories.value.find((item) => item.id === categoryContextId.value);
  if (!category) return;
  if (key === "rename") {
    renameCategoryValue.value = category.name;
    showRenameCategoryModal.value = true;
  } else if (key === "delete") {
    showDeleteCategoryModal.value = true;
  }
}

async function handleRenameCategoryConfirm() {
  const categoryId = categoryContextId.value;
  const name = renameCategoryValue.value.trim().replace(/\s+/g, " ");
  if (!categoryId || !name) return false;
  try {
    const category = await renameSessionCategory(categoryId, name);
    sessionCategories.value = sessionCategories.value
      .map((item) => item.id === category.id ? category : item)
      .sort((a, b) => a.name.localeCompare(b.name));
    message.success(t("chat.categoryRenamed"));
    showRenameCategoryModal.value = false;
  } catch (error: any) {
    message.error(error?.message || t("chat.categoryRenameFailed"));
    return false;
  }
}

async function handleDeleteSessionConfirm() {
  const sessionId = deleteSessionId.value;
  if (!sessionId) return false;
  const session = chatStore.sessions.find((item) => item.id === sessionId) || null;
  try {
    const ok = await chatStore.deleteSession(sessionId);
    if (!ok) {
      message.error(t("chat.deleteSessionFailed"));
      return false;
    }
  } catch (error: any) {
    message.error(error?.message || t("chat.deleteSessionFailed"));
    return false;
  }
  if (session) {
    selectedSessionKeys.value.delete(sessionSelectionKey(session));
    selectedSessionKeys.value = new Set(selectedSessionKeys.value);
  }
  message.success(t("chat.sessionDeleted"));
  showDeleteSessionModal.value = false;
  // 最后一个会话被删掉后没有活动会话了：回到「新建对话」，而不是停在一片空白上。
  if (!chatStore.activeSession) {
    void openNewChatPage();
  }
  return true;
}

async function handleDeleteCategoryConfirm() {
  const categoryId = categoryContextId.value;
  if (!categoryId) return false;
  try {
    await deleteSessionCategory(categoryId);
    sessionCategories.value = sessionCategories.value.filter((item) => item.id !== categoryId);
    for (const session of chatStore.sessions) {
      if (session.categoryId === categoryId) session.categoryId = null;
    }
    const collapsedKey = `category-${categoryId}`;
    if (collapsedCategories.value.has(collapsedKey)) {
      collapsedCategories.value = new Set(
        [...collapsedCategories.value].filter((key) => key !== collapsedKey),
      );
      persistCollapsedCategories();
    }
    message.success(t("chat.categoryDeleted"));
    showDeleteCategoryModal.value = false;
  } catch (error: any) {
    message.error(error?.message || t("chat.categoryDeleteFailed"));
    return false;
  }
}

const canSetContextSessionModel = computed(() =>
  contextSession.value?.source === "cli" ||
  contextSession.value?.source === "builtin_agent" ||
  (contextSession.value?.source === "coding_agent" && contextSession.value?.codingAgentMode !== "global"),
);

const contextMenuOptions = computed(() => buildSessionContextMenuOptions({
  pinned: contextSessionPinned.value,
  includeArchive: contextSession.value?.source !== "global_agent",
  includeModel: canSetContextSessionModel.value,
  categoryChildren: buildSessionCategoryMenuChildren({
    categories: sessionCategories.value,
    currentCategoryId: contextSession.value?.categoryId,
    createCategoryLabel: t("chat.createCategory"),
    uncategorizedLabel: t("chat.uncategorized"),
    loadFailedLabel: t("chat.categoryLoadFailed"),
    retryLabel: t("common.retry"),
    loadFailed: sessionCategoriesLoadFailed.value,
    loading: sessionCategoriesLoading.value,
  }),
  labels: {
    pin: t("chat.pin"),
    unpin: t("chat.unpin"),
    rename: t("chat.rename"),
    archive: t("chat.archiveSession"),
    workspace: t("chat.setWorkspace"),
    model: t("chat.setModel"),
    category: t("chat.moveToCategory"),
    export: t("chat.export"),
    exportFull: t("chat.exportFull"),
    exportCompressed: t("chat.exportCompressed"),
    open: t(desktopChatWindowAvailable
      ? "chat.openSessionInNewWindow"
      : "chat.openSessionInNewTab"),
    copyLink: t("chat.copySessionLink"),
    copyId: t("chat.copySessionId"),
    delete: t("chat.deleteSession"),
  },
}).map(option => option.key === "pin"
  ? { ...option, disabled: Boolean(contextSession.value?.isLocalOnly) }
  : option));
function contextMenuProps(option: DropdownOption | undefined) {
  return option?.key === "category" ? { style: "max-height: 60vh" } : {};
}

const contextMenuCategoriesKey = computed(() => [
  sessionCategoriesLoadFailed.value ? "failed" : "ready",
  sessionCategoriesLoading.value ? "loading" : "idle",
  ...sessionCategories.value.map(category => `${category.id}:${category.name}`),
].join("|"));

function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault();
  showCategoryContextMenu.value = false;
  contextSessionId.value = sessionId;
  showContextMenu.value = true;
  contextMenuX.value = e.clientX;
  contextMenuY.value = e.clientY;
}

const showContextMenu = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

function parseExportKey(key: string): { mode: 'full' | 'compressed'; ext: 'json' | 'txt' } | null {
  if (key === 'export-full-json') return { mode: 'full', ext: 'json' }
  if (key === 'export-full-txt') return { mode: 'full', ext: 'txt' }
  if (key === 'export-compressed-json') return { mode: 'compressed', ext: 'json' }
  if (key === 'export-compressed-txt') return { mode: 'compressed', ext: 'txt' }
  return null
}

async function handleContextMenuSelect(key: string) {
  showContextMenu.value = false;
  if (!contextSessionId.value) return;
  if (key === "category:retry") {
    await retrySessionCategories();
    return;
  }
  if (key === "category:create") {
    if (sessionCategoriesLoading.value) return;
    createCategorySessionId.value = contextSessionId.value;
    createCategoryPendingCategory.value = null;
    createCategoryValue.value = "";
    showCreateCategoryModal.value = true;
    nextTick(() => {
      createCategoryInputRef.value?.focus();
    });
    return;
  }
  if (key === "pin") {
    const session = contextSession.value;
    if (!session || session.isLocalOnly) return;
    try {
      const result = await setSessionPinned(session.id, !session.isPinned);
      session.isPinned = result.is_pinned;
    } catch (error: any) {
      message.error(error?.message || t("common.saveFailed"));
    }
    return;
  }
  if (key.startsWith("category:")) {
    const session = contextSession.value;
    if (!session) return;
    const rawCategoryId = key.slice("category:".length);
    const categoryId = rawCategoryId === "none" ? null : Number(rawCategoryId);
    if (categoryId !== null && !Number.isSafeInteger(categoryId)) return;
    if ((session.categoryId ?? null) === categoryId) return;
    try {
      if (!session.isLocalOnly) await setSessionCategory(session.id, categoryId);
    } catch (error: any) {
      message.error(error?.message || t("chat.categoryUpdateFailed"));
      return;
    }
    session.categoryId = categoryId;
    message.success(t("chat.categoryUpdated"));
    return;
  }
  if (key === "copy-link") {
    copySessionLink(contextSessionId.value);
  } else if (key === "copy-id") {
    copySessionId(contextSessionId.value);
  } else if (key === "open-link") {
    openSessionInNewTab(contextSessionId.value, contextSession.value?.profile || null);
  } else if (key === "archive") {
    const archivedSession = contextSession.value;
    const ok = await chatStore.archiveSession(contextSessionId.value);
    if (ok) {
      if (archivedSession) {
        selectedSessionKeys.value.delete(sessionSelectionKey(archivedSession));
        selectedSessionKeys.value = new Set(selectedSessionKeys.value);
      }
      message.success(t("chat.sessionArchived"));
    } else {
      message.error(t("chat.archiveSessionFailed"));
    }
  } else if (key === "delete") {
    const target = contextSession.value;
    deleteSessionId.value = contextSessionId.value;
    deleteSessionName.value = target?.title || "";
    showDeleteSessionModal.value = true;
  } else if (parseExportKey(key)) {
    const { mode, ext } = parseExportKey(key)!;
    const loadingMsg = mode === "compressed" ? message.loading(t("chat.exportCompressing"), { duration: 0 }) : null;
    try {
      await exportSession(contextSessionId.value, mode, ext);
      loadingMsg?.destroy();
      message.success(t("chat.exportSuccess"));
    } catch {
      loadingMsg?.destroy();
      message.error(t("chat.exportFailed"));
    }
  } else if (key === "workspace") {
    workspaceIsDraft.value = false;
    const session = chatStore.sessions.find(
      (s) => s.id === contextSessionId.value,
    );
    workspaceSessionId.value = contextSessionId.value;
    workspaceValue.value = session?.workspace || "";
    showWorkspaceModal.value = true;
    void initWorkspaceComposable();
  } else if (key === "model") {
    await openSessionModelPicker(contextSessionId.value);
  } else if (key === "rename") {
    openRenameSession(contextSessionId.value);
  }
}

async function handleCreateCategoryConfirm() {
  if (createCategorySubmitting.value) return false;
  const sessionId = createCategorySessionId.value;
  const session = chatStore.sessions.find((item) => item.id === sessionId);
  const name = createCategoryValue.value.trim().replace(/\s+/g, " ");
  if (!sessionId || !session || !name) return false;

  createCategorySubmitting.value = true;
  let category: SessionCategory | undefined = createCategoryPendingCategory.value || undefined;
  let created = Boolean(createCategoryPendingCategory.value);
  try {
    try {
      if (!category) {
        category = sessionCategories.value.find(
          (item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        );
      }
      if (!category) {
        const createdCategory = await createSessionCategory(name);
        category = createdCategory;
        created = true;
        if (!sessionCategories.value.some((item) => item.id === createdCategory.id)) {
          sessionCategories.value = [...sessionCategories.value, createdCategory].sort((a, b) =>
            a.name.localeCompare(b.name),
          );
        }
      }
    } catch (error: any) {
      message.error(error?.message || t("chat.categoryCreateFailed"));
      return false;
    }

    try {
      if (!session.isLocalOnly) await setSessionCategory(session.id, category.id);
    } catch (error: any) {
      if (created) {
        createCategoryPendingCategory.value = category;
        createCategoryValue.value = category.name;
      }
      message.error(created
        ? t("chat.categoryCreatedMoveFailed", { name: category.name })
        : error?.message || t("chat.categoryUpdateFailed"));
      return false;
    }

    session.categoryId = category.id;
    if (chatStore.activeSession?.id === session.id) {
      chatStore.activeSession.categoryId = category.id;
    }
    message.success(created
      ? t("chat.categoryCreatedAndMoved", { name: category.name })
      : t("chat.categoryUpdated"));
    createCategoryPendingCategory.value = null;
    showCreateCategoryModal.value = false;
    createCategorySessionId.value = null;
  } finally {
    createCategorySubmitting.value = false;
  }
}

function handleCreateCategoryEnter(event: KeyboardEvent) {
  if (event.isComposing) return;
  void handleCreateCategoryConfirm();
}

watch(showCreateCategoryModal, (visible) => {
  if (visible) return;
  createCategoryPendingCategory.value = null;
  createCategorySessionId.value = null;
  createCategoryValue.value = "";
});

function handleClickOutside() {
  showContextMenu.value = false;
}

async function handleRenameConfirm() {
  if (!renameSessionId.value || !renameValue.value.trim()) return;
  const ok = await renameSession(
    renameSessionId.value,
    renameValue.value.trim(),
  );
  if (ok) {
    const session = chatStore.sessions.find(
      (s) => s.id === renameSessionId.value,
    );
    if (session) session.title = renameValue.value.trim();
    if (chatStore.activeSession?.id === renameSessionId.value) {
      chatStore.activeSession.title = renameValue.value.trim();
    }
    message.success(t("chat.renamed"));
  } else {
    message.error(t("chat.renameFailed"));
  }
  showRenameModal.value = false;
}

const showWorkspaceModal = ref(false);
const workspaceValue = ref("");
const workspaceSessionId = ref<string | null>(null);
const workspaceIsDraft = ref(false);

function openNewChatWorkspace() {
  if (newChatLoading.value) return;
  workspaceIsDraft.value = true;
  workspaceSessionId.value = null;
  workspaceValue.value = newChatWorkspace.value;
  showWorkspaceModal.value = true;
  void initWorkspaceComposable();
}

function openActiveSessionWorkspace() {
  const session = chatStore.activeSession;
  if (!session?.id) return;
  workspaceIsDraft.value = false;
  workspaceSessionId.value = session.id;
  workspaceValue.value = session.workspace || "";
  showWorkspaceModal.value = true;
  void initWorkspaceComposable();
}

async function handleWorkspaceConfirm() {
  if (workspaceIsDraft.value) {
    if (!showNewChatPage.value || newChatLoading.value) return false;
    newChatWorkspace.value = workspaceValue.value;
    if (workspaceValue.value) {
      void workspaceComposable.recordWorkspaceUsage(workspaceValue.value)
        .catch(() => message.error(t("chat.workspaceSetFailed")));
    }
    showWorkspaceModal.value = false;
    workspaceIsDraft.value = false;
    return;
  }
  if (!workspaceSessionId.value) return;
  const ok = await setSessionWorkspace(
    workspaceSessionId.value,
    workspaceValue.value || null,
  );
  if (ok) {
    const session = chatStore.sessions.find(
      (s) => s.id === workspaceSessionId.value,
    );
    if (session) session.workspace = workspaceValue.value || null;
    if (chatStore.activeSession?.id === workspaceSessionId.value) {
      chatStore.activeSession.workspace = workspaceValue.value || null;
    }
    message.success(t("chat.workspaceSet"));
  } else {
    message.error(t("chat.workspaceSetFailed"));
  }
  showWorkspaceModal.value = false;
}

const showSessionModelPicker = ref(false);
const showSessionModelModeModal = ref(false);
const sessionModelSessionId = ref<string | null>(null);
const sessionModelIsDraft = ref(false);
const sessionModelTrigger = ref<HTMLElement | null>(null);
const sessionModelValue = ref("");
const sessionModelProvider = ref("");
const sessionModelApiMode = ref<CodingAgentApiMode>("codex_responses");
const pendingSessionModelSwitch = ref<{ model: string; provider: string } | null>(null);
const sessionModelSwitching = ref(false);

const sessionModelProfile = computed<string | null>(() => {
  if (sessionModelIsDraft.value) return newChatProfile.value;
  const session = chatStore.sessions.find((s) => s.id === sessionModelSessionId.value);
  return session?.profile || null;
});

const sessionModelSession = computed<Pick<Session, 'profile' | 'provider' | 'model' | 'source' | 'codingAgentId' | 'codingAgentMode' | 'apiMode' | 'agent'> | undefined>(() => {
  if (sessionModelIsDraft.value) return {
    profile: newChatProfile.value,
    provider: newChatProvider.value,
    model: newChatModel.value,
    agent: newChatAgent.value === 'claude-code' ? 'claude' : newChatAgent.value,
    source: isNewChatCodingAgent.value ? 'coding_agent' : 'cli',
    codingAgentId: isNewChatCodingAgent.value ? newChatAgent.value as ChatCodingAgentId : undefined,
    codingAgentMode: effectiveNewChatAgentMode.value,
    apiMode: newChatApiMode.value,
  };
  return chatStore.sessions.find((s) => s.id === sessionModelSessionId.value) ||
    (chatStore.activeSession?.id === sessionModelSessionId.value ? chatStore.activeSession : undefined);
});

const isSessionModelScopedCodingAgent = computed(() =>
  (sessionModelSession.value?.source === "coding_agent" || sessionModelSession.value?.source === "builtin_agent") &&
  sessionModelSession.value?.codingAgentMode !== "global",
);
const sessionModelCodingAgentId = computed<ChatCodingAgentId | undefined>(() =>
  sessionModelSession.value?.codingAgentId ||
  (sessionModelSession.value?.agent === "claude"
    ? "claude-code"
      : sessionModelSession.value?.agent === "codex"
        ? "codex"
      : sessionModelSession.value?.agent === "pi"
        ? "pi"
      : sessionModelSession.value?.agent === "grok"
        ? "grok"
      : sessionModelSession.value?.agent === "dsh" ? "dsh" : sessionModelSession.value?.agent === "opencode"
        ? "opencode"
      : isNativeCodingAgent(sessionModelSession.value?.agent) ? sessionModelSession.value?.agent
      : sessionModelSession.value?.agent === "antigravity" ? "antigravity" : sessionModelSession.value?.agent === "cursor"
        ? "cursor"
      : sessionModelSession.value?.agent === "ekko-agent"
        ? "ekko-agent"
        : undefined),
);
const isSessionModelHermes = computed(() =>
  isHermesSession(sessionModelSession.value),
);

const sessionModelAllGroups = computed(() =>
  sessionModelProfile.value
    ? getModelGroupsForProfile(sessionModelProfile.value).filter((group) => (
        group.provider === "moa"
          ? isSessionModelHermes.value
          : (!isSessionModelScopedCodingAgent.value ||
            !sessionModelCodingAgentId.value ||
            canScopedCodingAgentUseProvider(sessionModelCodingAgentId.value, group.provider))
      ))
    : [],
);

const sessionModelBaseGroups = computed(() =>
  sessionModelAllGroups.value.filter((group) => group.provider !== "moa"),
);

const sessionMoaGroup = computed(() =>
  sessionModelAllGroups.value.find((group) => group.provider === "moa"),
);

const sessionCanUseMoa = computed(() =>
  isSessionModelHermes.value && Boolean(sessionMoaGroup.value?.models.length),
);

async function openSessionModelPicker(sessionId: string | null, event?: MouseEvent) {
  sessionModelTrigger.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const isDraft = sessionId === null;
  const draftSequence = newChatOptionsLoadSequence;
  if (isDraft && (!showNewChatPage.value || newChatLoading.value)) return;
  if (isDraft && isNewChatGlobalCodingAgent.value) {
    sessionModelSessionId.value = null;
    sessionModelIsDraft.value = true;
    sessionModelValue.value = nativeModelPickerId(newChatNativeCatalog.value?.models, newChatNativeSelection.value.model);
    sessionModelProvider.value = `native:${newChatAgent.value}`;
    showSessionModelPicker.value = true;
    return;
  }
  const requestedSession =
    chatStore.sessions.find((s) => s.id === sessionId) ||
    (chatStore.activeSession?.id === sessionId ? chatStore.activeSession : undefined);
  if (
    requestedSession?.codingAgentMode === "global" &&
    Boolean(requestedSession.codingAgentId || requestedSession.source === "coding_agent")
  ) return;
  if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) {
    await appStore.loadModels();
  }
  if (isDraft && !isCurrentNewChatOptionsLoad(draftSequence)) return;
  sessionModelSessionId.value = sessionId;
  sessionModelIsDraft.value = isDraft;
  const session = sessionModelSession.value;
  const groups = sessionModelBaseGroups.value;
  const providerGroup = session?.provider
    ? groups.find((group) => group.provider === session.provider)
    : undefined;
  const fallbackGroup = providerGroup || groups.find((group) => group.models.length > 0);
  const defaults = {
    provider: fallbackGroup?.provider || "",
    model: fallbackGroup?.models.includes(session?.model || "")
      ? session?.model || ""
      : fallbackGroup?.models[0] || "",
  };
  const usesMoa = session?.provider === "moa" && sessionCanUseMoa.value;
  sessionModelValue.value = usesMoa
    ? session?.model || ""
    : providerGroup ? session?.model || defaults.model || "" : defaults.model || "";
  sessionModelProvider.value = usesMoa
    ? "moa"
    : providerGroup ? session?.provider || "" : defaults.provider || "";
  pendingSessionModelSwitch.value = null;
  showSessionModelModeModal.value = false;
  showSessionModelPicker.value = true;
}

function handleHeaderModelClick(event: MouseEvent) {
  if (activeSessionUsesGlobalCodingAgentConfig.value) return;
  const sessionId = chatStore.activeSession?.id;
  if (!sessionId) {
    openNewChatPage();
    return;
  }
  openSessionModelPicker(sessionId, event);
}

function defaultSessionModelApiMode(provider: string): CodingAgentApiMode {
  const group = sessionModelBaseGroups.value.find((item) => item.provider === provider);
  const providerKey = String(group?.provider || provider || "").toLowerCase();
  const baseUrl = String(group?.base_url || "").toLowerCase();
  return normalizeCodingAgentApiMode(
    group?.api_mode,
    inferCodingAgentApiMode(providerKey, baseUrl),
  );
}

async function applySessionModelSwitch(model: string, provider: string, apiMode?: CodingAgentApiMode) {
  if (sessionModelSwitching.value) return;
  if (sessionModelIsDraft.value) {
    if (!showNewChatPage.value || newChatLoading.value) return;
    if (isNewChatGlobalCodingAgent.value) {
      if (model && !newChatNativeCatalog.value?.models.some(entry => entry.id === model && !entry.hidden)) return;
      const sameFamily = model === nativeModelPickerId(newChatNativeCatalog.value?.models, newChatNativeSelection.value.model);
      newChatNativeSelections.value[newChatAgent.value] = model && sameFamily
        ? selectNativeModelEffort(newChatNativeCatalog.value?.models, model, newChatComposerReasoningEffort.value)
        : { model, reasoningEffort: model ? nativeCatalogModel(newChatNativeCatalog.value?.models, model)?.reasoningEffort || "" : "" };
      showSessionModelPicker.value = false;
      return;
    }
    if (newChatProvider.value !== provider) {
      newChatBaseUrl.value = "";
      newChatApiKey.value = "";
    }
    newChatProvider.value = provider;
    newChatModel.value = model;
    newChatCustomModel.value = !selectedNewChatProviderGroup.value?.models.includes(model);
    syncNewChatApiMode();
    if (apiMode) newChatApiMode.value = apiMode;
    pendingSessionModelSwitch.value = null;
    showSessionModelModeModal.value = false;
    showSessionModelPicker.value = false;
    return;
  }
  if (!sessionModelSessionId.value) return;
  sessionModelSwitching.value = true;
  try {
    const ok = await chatStore.switchSessionModel(model, provider, sessionModelSessionId.value, apiMode);
    if (ok) {
      sessionModelValue.value = model;
      sessionModelProvider.value = provider;
      if (apiMode) sessionModelApiMode.value = apiMode;
      pendingSessionModelSwitch.value = null;
      showSessionModelModeModal.value = false;
      showSessionModelPicker.value = false;
      message.success(t("chat.modelSet"));
    } else {
      message.error(t("chat.modelSetFailed"));
    }
  } finally {
    sessionModelSwitching.value = false;
  }
}

async function selectSessionModel(model: string, provider: string) {
  const meta = sessionModelBaseGroups.value.find((group) => group.provider === provider)?.model_meta?.[model];
  if (meta?.disabled || (!sessionModelSessionId.value && !sessionModelIsDraft.value) || sessionModelSwitching.value) return;
  if (isSessionModelScopedCodingAgent.value) {
    pendingSessionModelSwitch.value = { model, provider };
    sessionModelApiMode.value = sessionModelSession.value?.provider === provider && sessionModelSession.value.apiMode
      ? normalizeCodingAgentApiMode(sessionModelSession.value.apiMode, defaultSessionModelApiMode(provider))
      : defaultSessionModelApiMode(provider);
    showSessionModelModeModal.value = true;
    return;
  }
  await applySessionModelSwitch(model, provider);
}

async function selectSessionMoaPreset(preset: string) {
  if (!preset || sessionModelSwitching.value) return;
  await applySessionModelSwitch(preset, "moa");
}

async function confirmSessionModelMode() {
  const pending = pendingSessionModelSwitch.value;
  if (!pending) return;
  await applySessionModelSwitch(pending.model, pending.provider, sessionModelApiMode.value);
}

function cancelSessionModelMode() {
  if (sessionModelSwitching.value) return;
  pendingSessionModelSwitch.value = null;
  showSessionModelModeModal.value = false;
}

function handleSessionModelSelect(selection: { model: string; provider: string }) {
  if (selection.provider === 'moa') void selectSessionMoaPreset(selection.model);
  else void selectSessionModel(selection.model, selection.provider);
}
</script>

<template>
  <div class="chat-panel" :class="{ 'chat-panel--standalone': standalone }">
    <PageSidebar>
    <aside
      v-if="hasPageSidebar"
      class="session-list"
      :class="{ collapsed: !showSessions, 'session-list--navigation': contentMode !== 'chat' }"
    >
      <div v-if="showSessions" class="page-sidebar-top">
        <PageSidebarNav
          :active="contentMode === 'connections' ? 'connections' : contentMode === 'agents' ? 'agents' : contentMode === 'models' ? 'models' : chatStore.runtimeMode === 'global_agent' ? 'global' : 'chat'"
          :primary-label="t('chat.newTask')"
          @primary="openNewChatPage"
        >
          <template #actions>
            <ListActionsMenu
              v-if="contentMode === 'chat'"
              :label="t('chat.sessionListActions')"
              :profiles="profilesStore.profiles"
              :profile="sessionProfileFilter"
              :loading="profilesStore.loading"
              :batch-mode="isBatchMode"
              @filter="handleProfileFilterChange"
              @batch="toggleBatchMode"
            />
            <button
              v-if="isMobile"
              class="session-close-btn"
              type="button"
              :aria-label="t('common.close')"
              @click="showSessions = false"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="m18 6-12 12M6 6l12 12" />
              </svg>
            </button>
          </template>
        </PageSidebarNav>
        <div v-if="contentMode === 'chat'" class="sidebar-discover-apps">
          <DiscoverAppsPopover
            :apps="chatApps"
            :active-id="activeChatAppId"
            :recent-ids="recentChatAppIds"
            @select="selectChatApp"
          />
        </div>
        <div v-if="contentMode === 'chat' && isBatchMode" class="session-list-toolbar">
          <span class="session-selection-count" role="status">{{ t('chat.selectedSessions', { count: selectedCount }) }}</span>
          <div class="session-list-actions">
            <NButton
              v-if="isBatchMode"
              quaternary
              size="tiny"
              @click="selectAllSessions"
              :disabled="!canSelectAll || isBatchDeleting"
              :title="t('chat.selectAll')"
              :aria-label="t('chat.selectAll')"
            >
              <template #icon>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </template>
            </NButton>
            <NPopconfirm
              v-if="isBatchMode && selectedCount > 0"
              v-model:show="showBatchDeleteConfirm"
              :positive-button-props="{ loading: isBatchDeleting, disabled: isBatchDeleting }"
              :negative-button-props="{ disabled: isBatchDeleting }"
              @positive-click="handleBatchDeleteConfirm"
            >
              <template #trigger>
                <NButton quaternary size="tiny" :title="t('common.delete')" :aria-label="t('common.delete')" :loading="isBatchDeleting" :disabled="isBatchDeleting">
                  <template #icon>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t('chat.confirmBatchDelete', { count: selectedCount }) }}
            </NPopconfirm>
            <NButton
              v-if="isBatchMode"
              quaternary
              size="tiny"
              @click="toggleBatchMode"
              :disabled="isBatchDeleting"
              :title="t('common.cancel')"
              :aria-label="t('common.cancel')"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="m18 6-12 12M6 6l12 12" />
                </svg>
              </template>
            </NButton>
          </div>
        </div>
      </div>
      <div v-if="contentMode === 'chat' && showSessions" class="session-items">
        <div
          v-if="chatStore.isLoadingSessions && chatStore.sessions.length === 0"
          class="session-loading"
        >
          <NSpin size="small" :description="t('common.loading')" />
        </div>
        <div v-else-if="chatStore.sessions.length === 0" class="session-empty">
          {{ t("chat.noSessions") }}
        </div>

        <template v-if="pinnedSessions.length > 0">
          <div class="session-group-header session-group-header--static">
            <span class="session-group-label">{{ t("chat.pinned") }}</span>
            <span class="session-group-count">{{ pinnedSessions.length }}</span>
          </div>
          <SessionListItem
            v-for="s in pinnedSessions"
            :key="`pinned-${s.id}`"
            :session="s"
            :active="!showNewChatPage && s.id === chatStore.activeSessionId"
            :pinned="true"
            :can-delete="
              s.id !== chatStore.activeSessionId ||
              chatStore.sessions.length > 1
            "
            :streaming="chatStore.isSessionWorking(s.id)"
            :completed-unread="chatStore.isSessionCompletedUnread(s.id)"
            :selectable="isBatchMode"
            :selected="isSessionSelected(s)"
            :show-profile="true"
            :to="sessionHref(s.id)"
            :intercept-modified-navigation="desktopChatWindowAvailable"
            @select="handleSessionClick(s.id)"
            @open-new="openSessionInNewTab(s.id, s.profile || null)"
            @contextmenu="handleContextMenu($event, s.id)"
            @menu="handleContextMenu($event, s.id)"
            @delete="handleDeleteSession(s.id)"
            @toggle-select="toggleSessionSelection(s)"
          />
        </template>

        <div class="session-group-header" @click="toggleCategoryGroup('tasks')">
          <span class="session-group-label">{{ t('chat.tasks') }}</span>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="group-chevron"
            :class="{ collapsed: collapsedCategories.has('tasks') }"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <button
            type="button"
            class="session-group-fold"
            :title="allSpaceSessionsCollapsed ? t('chat.expandAllSpaces') : t('chat.collapseAllSpaces')"
            :aria-label="allSpaceSessionsCollapsed ? t('chat.expandAllSpaces') : t('chat.collapseAllSpaces')"
            :aria-pressed="!allSpaceSessionsCollapsed"
            :disabled="taskSpaceBuckets.length === 0"
            @click.stop="toggleAllSpaceSessions"
          >
            <!-- 会话正展开：点一下收起来（箭头朝内） -->
            <svg v-if="!allSpaceSessionsCollapsed" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true">
              <path d="M4 9h4V4M20 9h-4V4M4 15h4v5M20 15h-4v5" />
            </svg>
            <!-- 已经收起：点一下全展开（箭头朝外） -->
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
            </svg>
          </button>
          <NPopover
            v-model:show="sidebarViewMenuOpen"
            trigger="click"
            placement="bottom-end"
            :show-arrow="false"
            content-style="padding: 0;"
          >
            <template #trigger>
              <button
                type="button"
                class="session-group-fold session-group-fold--view"
                :title="t('chat.sidebarView')"
                :aria-label="t('chat.sidebarView')"
                @click.stop
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 6h10M4 12h16M4 18h13" />
                </svg>
              </button>
            </template>
            <div class="sidebar-view-menu">
              <p class="sidebar-view-section">{{ t('chat.viewSection') }}</p>
              <button type="button" class="sidebar-view-item"
                :class="{ 'is-active': sidebarViewMode === 'grouped' }" @click="setSidebarView('grouped')">
                <svg class="sidebar-view-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <path d="M4 6h4M4 12h4M4 18h4M12 6h8M12 12h8M12 18h8" />
                </svg>
                <span class="sidebar-view-item-label">{{ t('chat.viewGrouped') }}</span>
                <svg v-if="sidebarViewMode === 'grouped'" class="sidebar-view-check" width="14" height="14"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </button>
              <button type="button" class="sidebar-view-item"
                :class="{ 'is-active': sidebarViewMode === 'flat' }" @click="setSidebarView('flat')">
                <svg class="sidebar-view-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                <span class="sidebar-view-item-label">{{ t('chat.viewFlat') }}</span>
                <svg v-if="sidebarViewMode === 'flat'" class="sidebar-view-check" width="14" height="14"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </button>
              <div class="sidebar-view-divider"></div>
              <p class="sidebar-view-section">{{ t('chat.filterSection') }}</p>
              <button type="button" class="sidebar-view-item"
                :class="{ 'is-active': sessionSourceFilter === 'all' }" @click="setSessionSourceFilter('all')">
                <svg class="sidebar-view-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <rect x="4" y="4" width="6" height="6" rx="1.4" />
                  <rect x="14" y="4" width="6" height="6" rx="1.4" />
                  <rect x="4" y="14" width="6" height="6" rx="1.4" />
                  <rect x="14" y="14" width="6" height="6" rx="1.4" />
                </svg>
                <span class="sidebar-view-item-label">{{ t('chat.filterAll') }}</span>
                <svg v-if="sessionSourceFilter === 'all'" class="sidebar-view-check" width="14" height="14"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </button>
              <button type="button" class="sidebar-view-item"
                :class="{ 'is-active': sessionSourceFilter === 'cloud' }" @click="setSessionSourceFilter('cloud')">
                <svg class="sidebar-view-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <path d="M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 17.5 18z" />
                </svg>
                <span class="sidebar-view-item-label">{{ t('chat.filterCloud') }}</span>
                <svg v-if="sessionSourceFilter === 'cloud'" class="sidebar-view-check" width="14" height="14"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </button>
              <button type="button" class="sidebar-view-item"
                :class="{ 'is-active': sessionSourceFilter === 'local' }" @click="setSessionSourceFilter('local')">
                <svg class="sidebar-view-item-icon" width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <span class="sidebar-view-item-label">{{ t('chat.filterLocal') }}</span>
                <svg v-if="sessionSourceFilter === 'local'" class="sidebar-view-check" width="14" height="14"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </button>
            </div>
          </NPopover>
        </div>
        <template v-if="!collapsedCategories.has('tasks')">
            <SessionListItem
              v-for="s in (sidebarViewMode === 'flat' ? filteredTaskSessions : looseTaskSessions)"
              :key="s.id"
              :session="s"
              :active="!showNewChatPage && s.id === chatStore.activeSessionId"
              :pinned="false"
              :can-delete="s.id !== chatStore.activeSessionId || chatStore.sessions.length > 1"
              :streaming="chatStore.isSessionWorking(s.id)"
              :completed-unread="chatStore.isSessionCompletedUnread(s.id)"
              :selectable="isBatchMode"
              :selected="isSessionSelected(s)"
              :show-profile="false"
              :to="sessionHref(s.id)"
              :intercept-modified-navigation="desktopChatWindowAvailable"
              @select="handleSessionClick(s.id)"
              @open-new="openSessionInNewTab(s.id, s.profile || null)"
              @contextmenu="handleContextMenu($event, s.id)"
              @menu="handleContextMenu($event, s.id)"
              @delete="handleDeleteSession(s.id)"
              @toggle-select="toggleSessionSelection(s)"
            />
            <template v-for="bucket in taskSpaceBuckets" :key="bucket.workspace">
              <div class="session-task-space" :title="bucket.workspace">
                <button
                  type="button"
                  class="session-task-space-toggle"
                  :aria-expanded="!collapsedSpaces.has(bucket.workspace)"
                  :aria-label="bucket.label"
                  @click="toggleSpaceSessions(bucket.workspace)"
                >
                  <!-- 静默时是文件夹，悬停/聚焦时同位置换成可折叠的箭头 -->
                  <svg class="space-icon space-icon--folder" width="15" height="15" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
                    stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <svg class="space-icon space-icon--chevron group-chevron"
                    :class="{ collapsed: collapsedSpaces.has(bucket.workspace) }" width="12" height="12"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <span class="session-task-space-name">{{ bucket.label }}</span>
                <span class="session-task-space-actions">
                  <NDropdown
                    trigger="click"
                    placement="bottom-end"
                    :options="workspaceMenuOptions"
                    @select="key => handleWorkspaceMenuSelect(String(key), bucket.workspace)"
                  >
                    <button
                      type="button"
                      class="session-task-space-action"
                      :title="t('chat.more')"
                      :aria-label="t('chat.more')"
                      @click.stop
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="19" cy="12" r="1.6" />
                      </svg>
                    </button>
                  </NDropdown>
                  <button
                    type="button"
                    class="session-task-space-action"
                    :title="t('chat.newTaskInWorkspace')"
                    :aria-label="t('chat.newTaskInWorkspace')"
                    @click.stop="createTaskInWorkspace(bucket.workspace)"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M20 11.5a7.5 7.5 0 0 1-10.6 6.8L4.5 20l1.7-4.9A7.5 7.5 0 1 1 20 11.5Z" />
                      <path d="M12 8.6v5.8M9.1 11.5h5.8" />
                    </svg>
                  </button>
                </span>
              </div>
              <template v-if="!collapsedSpaces.has(bucket.workspace)">
                <SessionListItem
                  v-for="s in bucket.sessions"
                  :key="s.id"
                  :session="s"
                  :active="!showNewChatPage && s.id === chatStore.activeSessionId"
                  :pinned="false"
                  :indent="true"
                  :can-delete="s.id !== chatStore.activeSessionId || chatStore.sessions.length > 1"
                  :streaming="chatStore.isSessionWorking(s.id)"
                  :completed-unread="chatStore.isSessionCompletedUnread(s.id)"
                  :selectable="isBatchMode"
                  :selected="isSessionSelected(s)"
                  :show-profile="false"
                  :to="sessionHref(s.id)"
                  :intercept-modified-navigation="desktopChatWindowAvailable"
                  @select="handleSessionClick(s.id)"
                  @open-new="openSessionInNewTab(s.id, s.profile || null)"
                  @contextmenu="handleContextMenu($event, s.id)"
                  @menu="handleContextMenu($event, s.id)"
                  @delete="handleDeleteSession(s.id)"
                  @toggle-select="toggleSessionSelection(s)"
                />
              </template>
            </template>
            <button v-if="taskSessions.length > 4" type="button" class="session-group-collapse"
              @click="toggleCategoryGroup('tasks')">
              {{ t('chat.collapseGroup') }}
            </button>
        </template>

        <div
          v-if="sessionCategoriesLoadFailed"
          class="session-category-load-error"
          role="alert"
        >
          <span>{{ t("chat.categoryLoadFailed") }}</span>
          <button
            type="button"
            :disabled="sessionCategoriesLoading"
            @click="retrySessionCategories"
          >
            {{ t("common.retry") }}
          </button>
        </div>

      </div>
      <PageSidebarFooter v-if="showSessions" />
    </aside>
    </PageSidebar>

    <NDropdown
      :key="contextMenuCategoriesKey"
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      scrollable
      :menu-props="contextMenuProps"
      :show="showContextMenu"
      @select="handleContextMenuSelect"
      @clickoutside="handleClickOutside"
    />

    <NModal v-model:show="showNewChatSettings">
      <div class="new-chat-settings-panel" role="dialog" aria-modal="true" :aria-label="t('chat.newChatSettings')">
        <header class="new-chat-settings-header">
          <h2>{{ t('chat.newChatSettings') }}</h2>
          <NButton quaternary circle size="small" :aria-label="t('common.close')" @click="showNewChatSettings = false">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </NButton>
        </header>
        <div class="new-chat-settings-body" :inert="newChatLoading || undefined">
          <!-- Float menus outside the modal panel so its overflow cannot clip them. -->
          <div class="new-chat-settings-group">
            <label class="new-chat-field">
              <span class="new-chat-label">{{ t("sidebar.profiles") }}</span>
              <NSelect
                v-bind="newChatSettingsSelectProps"
                :value="newChatProfile"
                :options="newChatProfileOptions"
                :loading="profilesStore.loading && profilesStore.profiles.length === 0"
                @update:value="handleNewChatProfileChange"
              />
            </label>
            <label class="new-chat-field">
              <span class="new-chat-label">{{ t("chat.category") }}</span>
              <NSelect
                v-bind="newChatSettingsSelectProps"
                :key="newChatCategorySelectRevision"
                :value="newChatCategoryId ?? 0"
                :options="newChatCategoryOptions"
                :placeholder="t('chat.categoryPlaceholder')"
                :loading="sessionCategoriesLoading || newChatCategoryCreating"
                :disabled="newChatLoading || sessionCategoriesLoading || newChatCategoryCreating"
                filterable
                tag
                @update:value="handleNewChatCategoryChange"
              />
              <span class="new-chat-field-hint">{{ t("chat.categoryCreateHint") }}</span>
            </label>
          </div>
          <div v-if="(isNewChatCodingAgent && effectiveNewChatAgentMode === 'scoped') || newChatNeedsBaseUrl || newChatNeedsApiKey" class="new-chat-settings-group">
            <label v-if="isNewChatCodingAgent && effectiveNewChatAgentMode === 'scoped'" class="new-chat-field">
              <span class="new-chat-label">{{ t("codingAgents.protocolScope") }}</span>
              <NSelect
                v-bind="newChatSettingsSelectProps"
                v-model:value="newChatApiMode"
                :options="newChatApiModeOptions"
                :disabled="newChatLoading"
              />
            </label>
            <label v-if="newChatNeedsBaseUrl" class="new-chat-field">
              <span class="new-chat-label">{{ t("models.baseUrl") }}</span>
              <NInput
                v-model:value="newChatBaseUrl"
                :placeholder="t('models.baseUrlPlaceholder')"
              />
            </label>
            <label v-if="newChatNeedsApiKey" class="new-chat-field">
              <span class="new-chat-label">{{ t("models.apiKey") }}</span>
              <NInput
                v-model:value="newChatApiKey"
                type="password"
                show-password-on="click"
                :placeholder="t('models.apiKeyPlaceholder')"
              />
            </label>
          </div>
        </div>
      </div>
    </NModal>

    <NModal
      v-model:show="showRecentCountModal"
      preset="dialog"
      :title="t('chat.recentCount')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      @positive-click="saveRecentCount"
    >
      <NInputNumber v-model:value="recentCountDraft" :min="1" :max="100" />
    </NModal>

    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="categoryContextMenuX"
      :y="categoryContextMenuY"
      :options="categoryContextMenuOptions"
      :show="showCategoryContextMenu"
      @select="handleCategoryContextMenuSelect"
      @clickoutside="showCategoryContextMenu = false"
    />

    <NModal
      v-model:show="showCreateCategoryModal"
      preset="dialog"
      :title="t('chat.createCategory')"
      :positive-text="createCategoryPendingCategory ? t('common.retry') : t('common.create')"
      :negative-text="t('common.cancel')"
      :positive-button-props="{
        loading: createCategorySubmitting,
        disabled: createCategorySubmitting || (!createCategoryPendingCategory && !createCategoryValue.trim()),
      }"
      :negative-button-props="{ disabled: createCategorySubmitting }"
      :mask-closable="!createCategorySubmitting"
      :close-on-esc="!createCategorySubmitting"
      :closable="!createCategorySubmitting"
      @positive-click="handleCreateCategoryConfirm"
    >
      <NInput
        ref="createCategoryInputRef"
        v-model:value="createCategoryValue"
        :placeholder="t('chat.enterCategoryName')"
        :maxlength="40"
        :disabled="createCategorySubmitting"
        :readonly="Boolean(createCategoryPendingCategory)"
        @keydown.enter="handleCreateCategoryEnter"
      />
    </NModal>

    <NModal
      v-model:show="showRenameCategoryModal"
      preset="dialog"
      :title="t('chat.renameCategory')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      @positive-click="handleRenameCategoryConfirm"
    >
      <NInput
        v-model:value="renameCategoryValue"
        :placeholder="t('chat.enterCategoryName')"
        :maxlength="40"
        @keydown.enter="handleRenameCategoryConfirm"
      />
    </NModal>

    <NModal
      v-model:show="showDeleteCategoryModal"
      preset="dialog"
      type="warning"
      :title="t('chat.deleteCategory')"
      :positive-text="t('common.delete')"
      :negative-text="t('common.cancel')"
      @positive-click="handleDeleteCategoryConfirm"
    >
      {{ t('chat.confirmDeleteCategory', { name: categoryContextName }) }}
    </NModal>

    <NModal
      v-model:show="showDeleteSessionModal"
      preset="dialog"
      type="warning"
      :title="t('chat.deleteSession')"
      :positive-text="t('common.delete')"
      :negative-text="t('common.cancel')"
      @positive-click="handleDeleteSessionConfirm"
    >
      {{ t('chat.deleteSessionConfirm', { name: deleteSessionLabel }) }}
    </NModal>

    <NModal
      v-model:show="showRenameModal"
      preset="dialog"
      :title="t('chat.renameSession')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      @positive-click="handleRenameConfirm"
    >
      <NInput
        ref="renameInputRef"
        v-model:value="renameValue"
        :placeholder="t('chat.enterNewTitle')"
      />
    </NModal>

    <NModal
      v-model:show="showWorkspaceModal"
      preset="dialog"
      :title="t('chat.setWorkspaceTitle')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      style="width: var(--studio-workspace-picker-width)"
      @positive-click="handleWorkspaceConfirm"
    >
      <div class="workspace-picker-content">
        <div v-if="defaultWorkspaces.length" class="default-workspace-chips">
          <span class="default-workspace-label">{{ t('chat.favoriteWorkspaces') }}:</span>
          <NButton v-for="path in defaultWorkspaces" :key="path" size="tiny" :title="path"
            :type="workspaceValue === path ? 'primary' : 'default'" @click="workspaceValue = path">
            {{ getFolderName(path) }}
          </NButton>
        </div>
        <FolderPicker v-model="workspaceValue" show-favorite :favorite="isWorkspacePickerFavorite" :favorite-disabled="!workspaceValue"
          :favorite-title="isWorkspacePickerFavorite ? t('chat.workspaceUnfavorite') : t('chat.workspaceFavorite')"
          @toggle-favorite="handleToggleWorkspaceFavorite" />
        <div v-if="recentWorkspaces.length" class="recent-workspaces">
          <span class="recent-workspaces-label">{{ t('chat.workspaceRecent') }}:</span>
          <div class="recent-workspaces-chips">
            <NButton v-for="entry in recentWorkspaces" :key="entry.path" size="tiny" :title="entry.path"
              :type="workspaceValue === entry.path ? 'primary' : 'default'" @click="workspaceValue = entry.path">
              <template v-if="workspaceComposable.isDefaultWorkspace(entry.path)" #icon><StarIcon filled width="14" height="14" /></template>
              {{ getFolderName(entry.path) }}
            </NButton>
          </div>
        </div>
      </div>
    </NModal>

    <ModelCascader
      v-model:show="showSessionModelPicker"
      :groups="sessionModelIsDraft && isNewChatGlobalCodingAgent ? newChatNativeModelGroups : sessionModelAllGroups"
      :custom-models="sessionModelIsDraft && isNewChatGlobalCodingAgent ? {} : undefined"
      :display-name="sessionModelIsDraft && isNewChatGlobalCodingAgent ? nativeModelDisplayName : undefined"
      :allow-moa="isSessionModelHermes"
      :provider="sessionModelProvider"
      :model="sessionModelValue"
      :trigger-element="sessionModelTrigger"
      :title="t('chat.setModelTitle')"
      :loading="sessionModelSwitching"
      :close-on-select="false"
      @select="handleSessionModelSelect"
    >
      <template #empty>
        <NButton v-if="sessionModelIsDraft" size="small" quaternary @click="openNewChatModelSettings">{{ t('models.noProviderPromptAction') }}</NButton>
      </template>
      <template v-if="sessionModelIsDraft && isNewChatGlobalCodingAgent" #footer>
        <div class="native-model-catalog-status" :aria-busy="newChatNativeModelsLoading">
          <span v-if="newChatNativeModelsLoading && !newChatNativeCatalog">{{ t('common.loading') }}</span>
          <span v-else-if="newChatNativeModelsRefreshFailed && newChatNativeCatalog && ['ready', 'empty'].includes(newChatNativeCatalog.status)">{{ t('codingAgents.nativeModelsRefreshFailed') }}</span>
          <span v-else-if="!newChatNativeModelsLoading && (!newChatNativeCatalog || !['ready', 'empty'].includes(newChatNativeCatalog.status))">{{ t('codingAgents.nativeModelsFailed') }}</span>
          <span v-else-if="newChatNativeCatalog?.status === 'empty'">{{ t('models.noModels') }}</span>
          <NButton size="small" quaternary :aria-label="t('codingAgents.refresh')" :loading="newChatNativeModelsLoading" :disabled="newChatNativeModelsLoading" @click="reloadNewChatNativeModels(true)">{{ t('codingAgents.refresh') }}</NButton>
        </div>
      </template>
    </ModelCascader>

    <NModal
      v-model:show="showSessionModelModeModal"
      preset="dialog"
      :title="t('codingAgents.protocolScope')"
      :mask-closable="!sessionModelSwitching"
      :close-on-esc="!sessionModelSwitching"
      :closable="!sessionModelSwitching"
      style="width: min(420px, calc(100vw - 32px))"
    >
      <NSelect
        v-model:value="sessionModelApiMode"
        :options="newChatApiModeOptions"
        :disabled="sessionModelSwitching"
      />
      <template #action>
        <NButton size="small" :disabled="sessionModelSwitching" @click="cancelSessionModelMode">
          {{ t('common.cancel') }}
        </NButton>
        <NButton size="small" type="primary" :loading="sessionModelSwitching" @click="confirmSessionModelMode">
          {{ sessionModelSwitching ? t('chat.modelSwitching') : t('common.confirm') }}
        </NButton>
      </template>
    </NModal>



    <div
      class="chat-main"
      :class="{ 'chat-main--sidebar-collapsed': !pageSidebarExpanded }"
    >
      <ConnectionsPanel
        v-if="contentMode === 'connections'"
      />
      <AgentManagerPanel
        v-else-if="contentMode === 'agents'"
      />
      <ModelsPanel
        v-else-if="contentMode === 'models'"
      />
      <template v-else>
      <PageHeader>
      <header v-if="!standalone" class="chat-header">
        <div class="header-left">
          <HeaderSidebarToggle
            v-if="currentMode === 'chat'"
            class="header-sidebar-toggle"
            :expanded="showSessions"
            @toggle="showSessions = !showSessions"
          />
          <span class="header-session-title" dir="auto">{{ headerTitle }}</span>
        </div>
        <div class="header-actions">
          <NButton
            v-if="!showNewChatPage && chatStore.activeSession?.workspace"
            class="header-workspace-button"
            quaternary
            size="small"
            circle
            :title="chatStore.activeSession.workspace"
            :aria-label="t('chat.setWorkspace')"
            @click="openActiveSessionWorkspace"
          >
            <template #icon>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </template>
          </NButton>
          <!-- chat/live mode toggle hidden -->
          <template v-if="currentMode === 'chat' && !showNewChatPage">
            <NTooltip v-if="isSuperAdmin" trigger="hover">
              <template #trigger>
                <NButton
                  class="header-tool-toggle"
                  :class="{ active: showToolPanel }"
                  quaternary
                  size="small"
                  :aria-label="t('chat.sidePanel')"
                  :aria-expanded="showToolPanel"
                  aria-controls="chat-tool-panel"
                  @click="toggleToolPanel"
                  circle
                >
                  <template #icon>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <line x1="15" y1="3" x2="15" y2="21" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ desktopBrowserAvailable ? `${t("drawer.files")} / ${t("drawer.terminal")} / ${t("browser.title")}` : `${t("drawer.files")} / ${t("drawer.terminal")}` }}
            </NTooltip>
            <NDropdown
              v-model:show="showActiveSessionMenu"
              trigger="click"
              placement="bottom-end"
              :keyboard="false"
              :menu-props="activeSessionMenuProps"
              :node-props="activeSessionMenuNodeProps"
              :options="activeSessionMenuOptions"
              :show-arrow="true"
              @select="handleActiveSessionMenuSelect"
              @keydown="handleActiveSessionMenuKeydown"
            >
              <NTooltip trigger="hover" :disabled="showActiveSessionMenu">
                <template #trigger>
                  <NButton
                    ref="activeSessionMenuTriggerRef"
                    class="header-session-menu-trigger"
                    quaternary
                    size="small"
                    :disabled="!chatStore.activeSessionId"
                    :aria-label="t('chat.sessionActions')"
                    :aria-expanded="showActiveSessionMenu"
                    aria-controls="active-session-actions-menu"
                    aria-haspopup="menu"
                    @keydown="handleActiveSessionMenuTriggerKeydown"
                    circle
                  >
                    <template #icon>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="19" cy="12" r="1.6" />
                      </svg>
                    </template>
                  </NButton>
                </template>
                {{ t("chat.sessionActions") }}
              </NTooltip>
            </NDropdown>
          </template>
        </div>
      </header>
      </PageHeader>

      <template v-if="currentMode === 'chat'">
        <div
          ref="chatContentWrapperRef"
          class="chat-content-wrapper"
          :class="{ 'chat-content-wrapper--drop-active': isChatDropActive }"
          @dragover="handleChatDragOver"
          @dragenter="handleChatDragEnter"
          @dragleave="handleChatDragLeave"
          @drop="handleChatDrop"
        >
          <div ref="chatMainContentRef" class="chat-main-content" data-agent-deployment-surface
            :data-agent-deployment-session="chatStore.activeSessionId || ''"
            :data-agent-deployment-active="currentMode === 'chat' && !showNewChatPage"
            :data-agent-deployment-status-session="chatStore.activeSessionId || ''"
            :data-agent-deployment-status="chatStore.isLoadingMessages ? 'pending' : chatStore.isRunActive ? 'working' : 'settled'">
            <section v-if="showNewChatPage" class="new-chat-page" :class="{ 'has-agents': sceneAgents.length > 0 }"
              :aria-label="t('chat.newChat')">
              <div v-if="standalone" class="new-chat-app-entry">
                <DiscoverAppsPopover
                  :apps="chatApps"
                  :active-id="activeChatAppId"
                  :recent-ids="recentChatAppIds"
                  @select="selectChatApp"
                />
              </div>
              <div class="new-chat-intro">
                <template v-if="activeChatApp">
                  <h1 class="new-chat-app-title">{{ activeChatApp.heroTitle }}</h1>
                  <p v-if="activeChatApp.heroSubtitle" class="new-chat-app-subtitle">{{ activeChatApp.heroSubtitle }}</p>
                  <div class="new-chat-domains" role="tablist" :aria-label="activeChatApp.name">
                    <button
                      v-for="scene in activeChatApp.scenes"
                      :key="scene.id"
                      type="button"
                      role="tab"
                      class="new-chat-domain"
                      :class="{ 'new-chat-domain-active': activeChatSceneId === scene.id }"
                      :aria-selected="activeChatSceneId === scene.id"
                      @click="selectChatScene(scene.id)"
                    >
                      <span>{{ scene.label }}</span>
                    </button>
                  </div>
                </template>
                <div v-else class="new-chat-domains" role="tablist">
                  <button
                    v-for="domain in PROMPT_TEMPLATE_DOMAINS"
                    :key="domain.id"
                    type="button"
                    role="tab"
                    class="new-chat-domain"
                    :class="{ 'new-chat-domain-active': activeTemplateDomain === domain.id }"
                    :aria-selected="activeTemplateDomain === domain.id"
                    @click="selectTemplateDomain(domain.id)"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <template v-if="domain.id === 'chat'">
                        <path d="M12 3a9 9 0 1 0 0 18h1.2a2.1 2.1 0 0 0 0-4.2h-.6a1.8 1.8 0 0 1 0-3.6H15A6 6 0 0 0 12 3Z" />
                        <circle cx="8.2" cy="9.2" r="1" fill="currentColor" stroke="none" />
                        <circle cx="12" cy="7.4" r="1" fill="currentColor" stroke="none" />
                        <circle cx="15.6" cy="9.6" r="1" fill="currentColor" stroke="none" />
                      </template>
                      <template v-else>
                        <path d="M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8z" />
                        <path d="M18.6 15.6l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z" />
                      </template>
                    </svg>
                    <span>{{ t(domain.labelKey) }}</span>
                  </button>
                </div>
              </div>
                <div v-if="activeChatApp && activeChatScene" class="new-chat-agents" :aria-label="t('chat.agentsTitle')">
                  <div v-if="fastGptAgentsLoading && sceneAgents.length === 0" class="new-chat-agents-track" aria-hidden="true">
                    <span v-for="index in 4" :key="index" class="new-chat-agent-skeleton"></span>
                  </div>
                  <div v-else-if="sceneAgents.length > 0" class="new-chat-agent-showcase">
                    <NewChatAgentCards
                      :items="sceneAgentCards"
                      :value="sceneAgentCardValue"
                      @card-click="openSceneAgentDetail"
                    />
                  </div>
                  <p v-else class="new-chat-agents-empty">{{ t('chat.agentsEmpty') }}</p>
                </div>

              <div class="new-chat-compose">
                <div class="new-chat-config-bar">
                  <div class="new-chat-config-actions">
                    <NButton quaternary size="small" class="new-chat-config-icon new-chat-config-icon--labelled"
                      :class="{ 'is-selected': Boolean(newChatWorkspace) }" :disabled="newChatLoading"
                      :title="newChatWorkspace || t('chat.chooseWorkspace')"
                      :aria-label="newChatWorkspace
                        ? `${t('chat.chooseWorkspace')}: ${newChatWorkspace}`
                        : t('chat.chooseWorkspace')"
                      :aria-expanded="showWorkspaceModal && workspaceIsDraft" @click="openNewChatWorkspace">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                      <span class="new-chat-config-label">{{
                        newChatWorkspace ? getFolderName(newChatWorkspace) : t('chat.chooseWorkspace') }}</span>
                    </NButton>
                    <button v-if="newChatWorkspace && !newChatLoading" type="button" class="new-chat-workspace-clear"
                      :aria-label="t('chat.clearWorkspace')" :title="t('chat.clearWorkspace')"
                      @click="newChatWorkspace = ''">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                    <DshSessionPresetSelect v-if="newChatAgent === 'dsh'" v-model="newChatAgentPreset" v-model:show="showNewChatPresetMode"
                      compact :disabled="newChatLoading" @valid="newChatPresetReady = $event" />
                    <NButton quaternary circle size="small" class="new-chat-config-icon" :disabled="newChatLoading" :title="t('chat.newChatSettings')"
                      :aria-label="t('chat.newChatSettings')" :aria-expanded="showNewChatSettings" @click="showNewChatSettings = true">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="var(--bg-card)"/><circle cx="15" cy="17" r="2" fill="var(--bg-card)"/></svg>
                    </NButton>
                    <div v-if="isNewChatExternalCodingAgent && !isGlobalOnlyCodingAgent(newChatAgent)"
                      class="new-chat-launch-toggle" role="radiogroup" :aria-label="t('codingAgents.launchModeScope')"
                      @keydown="handleNewChatLaunchModeKeydown">
                      <button type="button" role="radio" :aria-checked="newChatAgentMode === 'scoped'"
                        :tabindex="newChatAgentMode === 'scoped' ? 0 : -1" :disabled="newChatLoading"
                        :title="t('codingAgents.launchModeScoped')" @click="handleNewChatLaunchModeChange(false)">
                        {{ t('codingAgents.modelScope') }}
                      </button>
                      <button type="button" role="radio" :aria-checked="newChatAgentMode === 'global'"
                        :tabindex="newChatAgentMode === 'global' ? 0 : -1" :disabled="newChatLoading"
                        :title="t('codingAgents.launchModeGlobal')" @click="handleNewChatLaunchModeChange(true)">
                        {{ t('codingAgents.launchModeGlobalShort') }}
                      </button>
                    </div>
                  </div>
                </div>
                <div v-if="activeAgentCard" class="new-chat-agent-banner" role="status">
                  <span class="new-chat-agent-banner-icon" :style="{ background: activeAgentCard.tint }" aria-hidden="true">{{
                    activeAgentCard.short.slice(0, 1) }}</span>
                  <span class="new-chat-agent-banner-text">
                    {{ t('chat.agentsComposerActive', { name: activeAgentCard.short }) }}
                  </span>
                  <span class="new-chat-agent-banner-hint">{{ t('chat.agentsComposerHint') }}</span>
                  <button type="button" class="new-chat-agent-banner-exit" @click="exitAgentChat">
                    {{ t('chat.agentsComposerExit') }}
                  </button>
                </div>
                <div v-if="activeAgentCard && activeAgentVars.length" class="new-chat-agent-vars">
                  <label v-for="item in activeAgentVars" :key="item.key" class="new-chat-agent-var">
                    <span class="new-chat-agent-var-label">
                      {{ item.label || item.key }}<em v-if="item.required" class="new-chat-agent-var-req">*</em>
                    </span>
                    <input v-model="activeAgentVarValues[item.key]" type="text" class="new-chat-agent-var-input"
                      :placeholder="item.description || item.key" spellcheck="false" />
                  </label>
                </div>
                <ChatInput :key="newChatComposerRevision" ref="chatInputRef" draft
                  :send-disabled="activeAgentCard ? agentChatBusy : !canConfirmNewChat"
                  :template-domain="activeTemplateDomain"
                  :placeholder="activeAgentCard
                    ? t('chat.agentsComposerPlaceholder', { name: activeAgentCard.short })
                    : newChatPlaceholder"
                  :quick-prompts="newChatQuickPrompts"
                  :draft-config="newChatDraftConfig" v-model:reasoning-effort="newChatComposerReasoningEffort"
                  :native-reasoning-efforts="isNewChatGlobalCodingAgent ? newChatNativeReasoningEfforts : undefined"
                  :native-effort-choices="isNewChatGlobalCodingAgent ? newChatNativeEffortChoices : undefined"
                  :submit="submitNewChat" :model-label="newChatModelLabel" :model-disabled="newChatLoading || (!isNewChatGlobalCodingAgent && newChatModelsLoading)"
                  :model-expanded="showSessionModelPicker && sessionModelIsDraft"
                  :persist-draft="false" :initial-text="initialComposerText" @model-click="openSessionModelPicker(null, $event)">
                  <template #toolbar-agents>
                    <NPopover v-if="sceneAgents.length > 0" v-model:show="agentPickerOpen" trigger="click"
                      placement="top-start" :show-arrow="false">
                      <template #trigger>
                        <button type="button" class="agent-picker-trigger"
                          :class="{ 'is-active': Boolean(activeAgentCard) }"
                          :aria-label="t('chat.agentsPicker')" :aria-expanded="agentPickerOpen">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="4" y="8" width="16" height="12" rx="3" />
                            <path d="M12 8V5M9 14h.01M15 14h.01M9.5 17h5" />
                          </svg>
                          <span class="agent-picker-trigger-label">
                            {{ activeAgentCard ? activeAgentCard.short : t('chat.agentsPicker') }}
                          </span>
                          <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </button>
                      </template>
                      <div class="agent-picker">
                        <div class="agent-picker-head">
                          <span class="agent-picker-title">{{ t('chat.agentsPickerTitle') }}</span>
                          <span class="agent-picker-count">{{ sceneAgents.length }}</span>
                        </div>
                        <div class="agent-picker-list">
                          <button v-for="agent in sceneAgents" :key="agent.appId" type="button"
                            class="agent-picker-item" :class="{ 'is-active': activeAgentCard?.appId === agent.appId }"
                            :title="agent.name" @click="selectAgentFromPicker(agent)">
                            <span class="agent-picker-icon" :style="{ background: agent.tint }" aria-hidden="true">{{
                              agent.short.slice(0, 1) }}</span>
                            <span class="agent-picker-text">
                              <span class="agent-picker-name">{{ agent.short }}</span>
                              <span class="agent-picker-desc">{{ agent.desc }}</span>
                            </span>
                          </button>
                          <p v-if="sceneAgents.length === 0" class="agent-picker-empty">{{ t('chat.agentsEmpty') }}</p>
                        </div>
                        <button v-if="activeAgentCard" type="button" class="agent-picker-clear"
                          @click="exitAgentChat(); agentPickerOpen = false">
                          {{ t('chat.agentsPickerClear') }}
                        </button>
                      </div>
                    </NPopover>
                  </template>
                </ChatInput>
                <button v-if="newChatHasNoModels" type="button" class="new-chat-config-hint" @click="openNewChatModelSettings">
                  {{ t('models.noModels') }} · {{ t('models.noProviderPromptAction') }}
                </button>
                <button v-else-if="newChatMissingCredentials" type="button" class="new-chat-config-hint" @click="showNewChatSettings = true">
                  {{ t('chat.newChatCredentialsHint') }}
                </button>
                <NModal :show="agentDetail !== null" :auto-focus="false" :mask-closable="true"
                  @update:show="handleAgentDrawerToggle">
                  <div v-if="agentDetail" class="agent-sheet" :class="{ 'is-embed': agentEmbedUrl }" role="dialog" aria-modal="true">
                    <!-- 分享页直接嵌在弹窗里：不跳路由，关掉/返回都还停在当前场景页。 -->
                    <template v-if="agentEmbedUrl">
                      <div class="agent-embed-bar">
                        <button type="button" class="agent-embed-back" @click="agentEmbedUrl = ''">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M15 5l-7 7 7 7" />
                          </svg>
                          {{ t('chat.agentsBack') }}
                        </button>
                        <span class="agent-embed-name">{{ agentDetail.name }}</span>
                        <div class="agent-embed-actions">
                          <button type="button" class="agent-embed-action" :title="t('chat.agentsReload')"
                            :aria-label="t('chat.agentsReload')" @click="reloadAgentEmbed">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="M20 11a8 8 0 1 0-2.4 6.2" />
                              <path d="M20 5v6h-6" />
                            </svg>
                          </button>
                          <button type="button" class="agent-embed-action" @click="openAgentExternal">
                            {{ t('chat.agentsOpenExternal') }}
                          </button>
                          <button type="button" class="agent-embed-close" :aria-label="t('common.close')"
                            @click="closeAgentDetail">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                              stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="M6 6l12 12M18 6L6 18" />
                            </svg>
                          </button>
                        </div>
                      </div>
                      <div v-if="!agentEmbedTipHidden" class="agent-embed-tip" role="note">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 11v5M12 7.6v.6" />
                        </svg>
                        <span class="agent-embed-tip-text">{{ t('chat.agentsEmbedTip') }}</span>
                        <button type="button" class="agent-embed-tip-close" :aria-label="t('common.close')"
                          :title="t('common.close')" @click="agentEmbedTipHidden = true">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M6 6l12 12M18 6L6 18" />
                          </svg>
                        </button>
                      </div>
                      <iframe
                        v-if="!agentEmbedFailed"
                        :key="agentEmbedFrameKey"
                        class="agent-embed-frame"
                        :src="agentEmbedUrl"
                        :title="agentDetail.name"
                        allow="microphone; camera; clipboard-read; clipboard-write; fullscreen"
                        referrerpolicy="no-referrer"
                        @error="agentEmbedFailed = true"
                      />
                      <div v-else class="agent-embed-fallback">
                        <p>{{ t('chat.agentsEmbedFailed') }}</p>
                        <NButton size="small" type="primary" @click="openAgentExternal">
                          {{ t('chat.agentsOpenExternal') }}
                        </NButton>
                      </div>
                    </template>
                    <template v-else>
                      <button type="button" class="agent-sheet-close" :aria-label="t('common.close')"
                        @click="closeAgentDetail">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>

                      <div class="agent-sheet-head">
                        <span class="agent-sheet-icon" :style="{ background: agentDetail.tint }" aria-hidden="true">{{
                          agentDetail.short.slice(0, 1) }}</span>
                        <div class="agent-sheet-heading">
                          <h3 class="agent-sheet-title">{{ agentDetail.name }}</h3>
                          <span class="agent-sheet-scene">{{ agentDetail.sceneLabel }}</span>
                        </div>
                      </div>

                      <p class="agent-sheet-desc">{{ agentDetail.desc }}</p>

                      <div v-if="activeChatScene && activeChatScene.quickPrompts.length" class="agent-sheet-suggest">
                        <p class="agent-sheet-subtitle">{{ t('chat.agentsSuggest') }}</p>
                        <div class="agent-sheet-pills">
                          <span v-for="prompt in activeChatScene.quickPrompts" :key="prompt.label"
                            class="agent-sheet-pill">
                            {{ prompt.label }}
                          </span>
                        </div>
                      </div>

                      <div class="agent-sheet-meta">
                        <span class="agent-sheet-meta-item">
                          <span class="agent-sheet-meta-label">{{ t('chat.agentsSource') }}</span>FastGPT
                        </span>
                        <span class="agent-sheet-meta-item">
                          <span class="agent-sheet-meta-label">{{ t('chat.agentsAppId') }}</span>
                          <code>{{ agentDetail.appId }}</code>
                        </span>
                      </div>

                      <div class="agent-sheet-actions">
                        <NButton type="primary" size="large" class="agent-sheet-primary"
                          @click="openAgentInStudio(agentDetail)">
                          {{ t('chat.agentsOpen') }}
                        </NButton>
                        <NButton quaternary size="large" @click="openFastGptAgent(agentDetail)">
                          {{ t('chat.agentsOpenExternal') }}
                        </NButton>
                      </div>
                    </template>
                  </div>
                </NModal>
              </div>
            </section>
            <template v-else>
            <MessageList
              ref="messageListRef"
              :approval-portal-to-body="showRealtimeVoice"
              scroll-scope="chat"
            />
            <ChatInput
              ref="chatInputRef"
              :template-domain="activeTemplateDomain"
              :model-label="activeSessionModelLabel"
              :model-disabled="activeSessionUsesGlobalCodingAgentConfig"
              :native-reasoning-efforts="activeSessionUsesGlobalCodingAgentConfig ? activeSessionNativeReasoningEfforts : undefined"
              :native-effort-choices="activeSessionUsesGlobalCodingAgentConfig ? activeSessionNativeEffortChoices : undefined"
              :model-expanded="showSessionModelPicker && !sessionModelIsDraft && sessionModelSessionId === chatStore.activeSessionId"
              :initial-text="initialComposerText"
              :persist-draft="composerPersistDraft"
              @model-click="handleHeaderModelClick"
              @voice-click="openRealtimeVoice"
            />
            </template>
          </div>
          <OutlinePanel
            v-if="showOutline"
            :messages="chatStore.messages"
            @navigate="handleOutlineNavigate"
          />
          <Transition
            name="tool-panel"
            @before-enter="handleToolPanelBeforeEnter"
            @after-enter="handleToolPanelAfterEnter"
            @before-leave="handleToolPanelBeforeLeave"
            @leave-cancelled="handleToolPanelLeaveCancelled"
          >
            <aside
              v-if="showToolPanel"
              id="chat-tool-panel"
              class="chat-tool-panel"
              role="region"
              :aria-label="t('chat.sidePanel')"
              :style="toolPanelStyle"
            >
              <div
                class="chat-tool-resize-handle"
                @pointerdown="startToolResize"
              />
              <div class="chat-tool-panel-inner">
                <WorkspaceDiffPreview
                  v-if="toolPanelStore.workspaceDiff"
                  :custom-close="closeToolPanelOverlay"
                />
                <SubagentStreamPanel
                  v-else-if="selectedSubagent"
                  :agent="chatSessionAgentAvatar(chatStore.activeSession)"
                  :stream="selectedSubagentStream"
                  @close="closeToolPanelOverlay"
                />
                <template v-else-if="previewOnlyFileOpen">
                  <FilePreview
                    v-if="filesStore.previewFile"
                    :custom-close="closeToolPanelOverlay"
                  />
                  <div v-else class="chat-file-preview-loading">
                    <NSpin size="small" />
                  </div>
                </template>
                <template v-else>
                  <div class="chat-tool-tabs" role="tablist">
                    <button
                      class="chat-tool-tab"
                      :class="{ active: activeToolPanel === 'files' }"
                      type="button"
                      role="tab"
                      :title="t('drawer.files')"
                      :aria-label="t('drawer.files')"
                      :aria-selected="activeToolPanel === 'files'"
                      @click="activeToolPanel = 'files'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
                      </svg>
                    </button>
                    <button
                      class="chat-tool-tab"
                      :class="{ active: activeToolPanel === 'terminal' }"
                      type="button"
                      role="tab"
                      :title="t('drawer.terminal')"
                      :aria-label="t('drawer.terminal')"
                      :aria-selected="activeToolPanel === 'terminal'"
                      @click="activeToolPanel = 'terminal'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="m7 9 3 3-3 3M13 15h4" />
                      </svg>
                    </button>
                    <button
                      v-if="desktopBrowserAvailable"
                      class="chat-tool-tab"
                      :class="{ active: activeToolPanel === 'browser' }"
                      type="button"
                      role="tab"
                      :title="t('browser.title')"
                      :aria-label="t('browser.title')"
                      :aria-selected="activeToolPanel === 'browser'"
                      @click="activeToolPanel = 'browser'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="M3 9h18" />
                        <circle cx="6.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                        <circle cx="9.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />
                      </svg>
                    </button>
                    <button
                      v-if="isSuperAdmin"
                      class="chat-tool-tab"
                      :class="{ active: activeToolPanel === 'prompts' }"
                      type="button"
                      role="tab"
                      :title="t('promptTemplates.title')"
                      :aria-label="t('promptTemplates.title')"
                      :aria-selected="activeToolPanel === 'prompts'"
                      @click="activeToolPanel = 'prompts'"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9L20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13" />
                        <path d="M14 4v5.5h5.5M8 13h8M8 16.5h5" />
                      </svg>
                    </button>
                  </div>
                  <div class="chat-tool-content">
                    <FilesPanel
                      v-show="activeToolPanel === 'files'"
                      :workspace-session-id="activeWorkspaceSessionId"
                      :workspace="activeWorkspacePath"
                      @attach="handleWorkspaceFileAttach"
                    />
                    <TerminalPanel
                      v-show="activeToolPanel === 'terminal'"
                      :visible="showToolPanel && activeToolPanel === 'terminal'"
                    />
                    <DesktopBrowserPanel
                      v-if="desktopBrowserAvailable && activeToolPanel === 'browser'"
                      :visible="toolPanelTransitionReady"
                      :submit="submitBrowserAnnotations"
                    />
                    <PromptTemplatesPanel
                      v-if="isSuperAdmin"
                      v-show="activeToolPanel === 'prompts'"
                    />
                  </div>
                </template>
              </div>
            </aside>
          </Transition>
        </div>
      </template>
      <ConversationMonitorPane
        v-else
        :human-only="sessionBrowserPrefsStore.humanOnly"
      />
      </template>
    </div>
    <Teleport to="body">
      <RealtimeVoiceStage
        v-if="showRealtimeVoice"
        @close="closeRealtimeVoice"
      />
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.native-model-catalog-status {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 14px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  > span { flex: 1; }
}

.chat-panel {
  display: flex;
  height: 100%;
  position: relative;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  background-color: $bg-card;
}

.session-list {
  width: $sidebar-width;
  min-height: 0;
  align-self: stretch;
  margin: 0;
  background: $bg-sidebar-surface;
  border-inline-end: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition:
    width $transition-normal,
    opacity $transition-normal;
  overflow: hidden;

  &--navigation .page-sidebar-top {
    flex: 1;
    overflow-y: auto;
  }

  &.collapsed {
    width: 0;
    margin-inline-start: 0;
    margin-inline-end: 0;
    border: none;
    box-shadow: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    height: auto;
    margin: 0;
    z-index: 120;
    width: $sidebar-width;

    &.collapsed {
      transform: translateX(-100%);
      opacity: 0;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .session-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 110;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.page-sidebar-top {
  flex-shrink: 0;
  padding: 12px;
}

.page-sidebar-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.page-sidebar-tab {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  svg {
    flex-shrink: 0;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }
}

.session-list-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  justify-content: space-between;
}

.session-selection-count {
  min-width: 0;
  font-size: 12px;
  color: $text-secondary;
}

.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;

  .n-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    min-height: 22px;
  }
}

.session-close-btn {
  display: inline-flex;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;
  height: 22px;
  min-height: 22px;
  align-items: center;
  justify-content: center;

  &:hover {
    background: rgba($accent-primary, 0.06);
  }
}

.session-list-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  line-height: 22px;
}

.conversation-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  margin-top: 8px;
  padding: 2px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.05);
}

.conversation-switch-tab {
  min-width: 0;
  height: 28px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    color: $text-primary;
  }

  &.active {
    background: $bg-card;
    color: $text-primary;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
}

.new-chat-settings-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(400px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  overflow: hidden;
  border: 1px solid $border-light;
  border-radius: 16px;
  background: $bg-card;
  color: $text-primary;
  box-shadow: 0 16px 60px #00000024;
}
.new-chat-settings-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  border-bottom: 1px solid $border-light;
  h2 { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
}
.new-chat-settings-body {
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.new-chat-settings-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
  & + & { margin-top: 16px; padding-top: 16px; border-top: 1px solid $border-light; }
}

// 页面两侧各留 12px，里面所有块（标题、卡片、输入框）都撑满这条内宽。
.new-chat-page {
  flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  justify-content: space-between; padding: clamp(12px, 2vh, 24px) 12px 2px;
}
// 首屏不再有标题行，这一块只负责把三域切换居中。
.new-chat-intro {
  flex: none; text-align: center; margin: clamp(64px, 12vh, 140px) 0 0; padding: 0 20px;
}
// 「发现应用」入口贴在首页左上角；选中应用后 intro 换成应用自己的标题与场景。
.new-chat-app-entry { flex: none; display: flex; justify-content: flex-start; padding: 0 2px; }
// 侧栏「新建对话」下面一行：跟 .page-sidebar-tab 同一套语言（无边框、透明底、hover 上色）。
.sidebar-discover-apps {
  margin-top: 4px;

  :deep(.discover-apps) { display: flex; width: 100%; }
  :deep(.discover-apps-trigger) {
    width: 100%; height: 36px; padding: 0 10px; gap: 8px;
    border: 0; border-radius: $radius-sm; background: transparent;
    color: $text-primary; justify-content: flex-start; font-size: 14px;
  }
  :deep(.discover-apps-trigger:hover),
  :deep(.discover-apps-trigger-open) {
    border: 0; color: $text-primary; background: rgba(var(--text-primary-rgb), 0.06);
  }
  :deep(.discover-apps-trigger > svg:first-child) { width: 17px; height: 17px; }
  :deep(.discover-apps-chevron) { width: 12px; height: 12px; margin-left: auto; opacity: 0.55; }
}
// ── 场景智能体卡片（FastGPT）：一屏 4 张，超出横向滚动 ────────────────────
.new-chat-agents {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 4px;
  padding-top: 0;
  border-top: 0;
}

.new-chat-agents-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}
.new-chat-agents-title { color: $text-primary; font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }

/* 数量做成一枚胶囊：紧跟在标题后面，比灰色的「N 个智能体」好扫。 */
.new-chat-agents-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 19px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.new-chat-agents-hint { margin-left: auto; color: $text-muted; font-size: 11.5px; }

.new-chat-agents-retry {
  margin-left: auto;
  height: 22px;
  padding: 0 9px;
  border: 1px solid $border-light;
  border-radius: 999px;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  cursor: pointer;
  transition: color $transition-fast, border-color $transition-fast, background $transition-fast;

  &:hover {
    color: $accent-primary;
    border-color: rgba(var(--accent-primary-rgb), 0.42);
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

/* 卡片带：宽屏一屏 3 张，滚动条隐掉，翻页交给两侧按钮。 */
.new-chat-agents-viewport {
  position: relative;
  min-width: 0;
}

/* Reuse the existing holographic agent-card carousel at scene scale. */
.new-chat-agent-showcase {
  height: clamp(250px, 34vh, 330px);
  min-width: 0;
}

.new-chat-agents-track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: calc((100% - 36px) / 4);
  gap: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 2px 6px;
  scroll-behavior: smooth;
  scroll-snap-type: x proximity;
  scroll-padding: 2px;
  scrollbar-width: none;
  text-align: start;

  &::-webkit-scrollbar { display: none; }
}

/* 两侧翻页按钮：贴在卡片边缘浮起，滚到头自动藏起来。 */
.new-chat-agents-pager {
  position: absolute;
  top: 50%;
  z-index: 3;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid $border-light;
  border-radius: 10px;
  background: $bg-card;
  color: $text-secondary;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
  transition: color $transition-fast, border-color $transition-fast, box-shadow $transition-fast;

  &.is-prev { left: -8px; }
  &.is-next { right: -8px; }

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.45);
    color: $text-primary;
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.16);
  }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.new-chat-agent-skeleton {
  min-height: 92px;
  border: 1px solid $border-light;
  border-radius: 14px;
  background: linear-gradient(100deg, rgba(var(--text-primary-rgb), 0.035) 25%, rgba(var(--text-primary-rgb), 0.075) 42%, rgba(var(--text-primary-rgb), 0.035) 60%);
  background-size: 220% 100%;
  animation: new-chat-agent-shimmer 1.5s ease-in-out infinite;
}
@keyframes new-chat-agent-shimmer {
  from { background-position: 130% 0; }
  to { background-position: -30% 0; }
}

/* 卡片：整块是热区 = 选中该智能体对话；右上角小按钮才进详情弹层。 */
.new-chat-agent {
  position: relative;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  column-gap: 10px;
  row-gap: 5px;
  align-items: start;
  min-width: 0;
  min-height: 0;
  /* Standard ID card: 85.6mm x 54mm = 1.586:1. */
  aspect-ratio: 1.586 / 1;
  padding: 13px;
  border: 1px solid $border-light;
  border-radius: 14px;
  background: $bg-card;
  color: inherit;
  text-align: start;
  scroll-snap-align: start;
  transition: border-color $transition-fast, box-shadow $transition-fast, transform $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.38);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.07);
    transform: translateY(-2px);
  }
  &:active { transform: translateY(0); box-shadow: 0 3px 8px rgba(0, 0, 0, 0.05); }
}

/* 选中态：整卡描边加粗 + 淡蓝底，和输入框上方的「正在对话」条呼应。 */
.new-chat-agent.is-active {
  border-color: rgba(var(--accent-primary-rgb), 0.55);
  background: rgba(var(--accent-primary-rgb), 0.07);
  box-shadow: 0 6px 18px rgba(var(--accent-primary-rgb), 0.14);
}

/* 右上角的详情入口：不抢主热区，悬停卡片才明显。 */
.new-chat-agent-info {
  position: relative;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  justify-self: end;
  width: 22px;
  height: 22px;
  margin: -2px -2px 0 0;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: $text-muted;
  opacity: 0.55;
  cursor: pointer;
  transition: opacity $transition-fast, background $transition-fast, color $transition-fast;

  &:hover { opacity: 1; background: rgba(var(--text-primary-rgb), 0.08); color: $text-primary; }
  &:focus-visible { opacity: 1; outline: 2px solid $accent-primary; outline-offset: 1px; }
}

.new-chat-agent:hover .new-chat-agent-info { opacity: 1; }

.new-chat-agent.is-active .new-chat-agent-info { color: $accent-primary; opacity: 1; }

/* 输入框上方的对话指示条：谁在接消息、怎么退出，一眼看清。 */
.new-chat-agent-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
  padding: 7px 10px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.28);
  border-radius: 10px;
  background: rgba(var(--accent-primary-rgb), 0.07);
  font-size: 12.5px;
  line-height: 1.5;
}

.new-chat-agent-banner-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

.new-chat-agent-banner-text {
  flex: none;
  color: $text-primary;
  font-weight: 600;
}

.new-chat-agent-banner-hint {
  overflow: hidden;
  min-width: 0;
  color: $text-secondary;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.new-chat-agent-banner-exit {
  flex: none;
  margin-inline-start: auto;
  padding: 2px 9px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.35);
  border-radius: 7px;
  background: transparent;
  color: $accent-primary;
  font-size: 12px;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--accent-primary-rgb), 0.12); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}

/* 智能体运行时变量：这类应用靠 record_id 这种参数取数，不填就只能报错。 */
.new-chat-agent-vars {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin: -2px 0 8px;
  padding: 8px 10px;
  border: 1px dashed rgba(var(--accent-primary-rgb), 0.3);
  border-radius: 10px;
  background: rgba(var(--text-primary-rgb), 0.02);
}

.new-chat-agent-var {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 190px;
  min-width: 0;
}

.new-chat-agent-var-label { flex: none; color: $text-secondary; font-size: 12px; }

.new-chat-agent-var-req { margin-inline-start: 2px; color: $accent-primary; font-style: normal; }

.new-chat-agent-var-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid $border-light;
  border-radius: 7px;
  background: $bg-card;
  color: $text-primary;
  font: inherit;
  font-size: 12.5px;
  outline: none;

  &::placeholder { color: $text-muted; }
  &:focus { border-color: rgba(var(--accent-primary-rgb), 0.5); }
}

/* 输入框工具栏里的智能体选择器：不占额外一行，和「设置 / 模型」同一排。 */
.agent-picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 26px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast, border-color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.07); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }

  &.is-active {
    border-color: rgba(var(--accent-primary-rgb), 0.4);
    background: rgba(var(--accent-primary-rgb), 0.09);
    color: $accent-primary;
  }
}

.agent-picker-trigger-label {
  overflow: hidden;
  max-width: 110px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 320px;
  max-width: calc(100vw - 32px);
}

.agent-picker-head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 4px; }

.agent-picker-title { color: $text-primary; font-size: 12.5px; font-weight: 600; }

.agent-picker-count {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(var(--text-primary-rgb), 0.06);
  color: $text-muted;
  font-size: 11px;
  line-height: 17px;
}

.agent-picker-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 300px;
  overflow-y: auto;
}

.agent-picker-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
  transition: background $transition-fast, border-color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.05); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }

  &.is-active {
    border-color: rgba(var(--accent-primary-rgb), 0.45);
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.agent-picker-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
}

.agent-picker-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.agent-picker-name { color: $text-primary; font-size: 12.5px; font-weight: 600; line-height: 1.35; }
.agent-picker-desc {
  overflow: hidden;
  color: $text-secondary;
  font-size: 11px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-picker-empty { margin: 0; padding: 10px 4px; color: $text-muted; font-size: 12px; text-align: center; }

.agent-picker-clear {
  align-self: flex-start;
  padding: 3px 10px;
  border: 1px solid $border-light;
  border-radius: 7px;
  background: transparent;
  color: $text-secondary;
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color $transition-fast, color $transition-fast;

  &:hover { border-color: rgba(var(--accent-primary-rgb), 0.4); color: $accent-primary; }
}

/* 铺满整卡的透明按钮：结构上比嵌套 button 合法，点击区域也最大。 */
.new-chat-agent-hit {
  position: absolute;
  inset: 0;
  z-index: 1;
  padding: 0;
  border: 0;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;

  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}

/* 图标用场景色实底 + 一圈内高光；文字层不吃点击，交给下面的热区。 */
.new-chat-agent-icon {
  position: relative;
  z-index: 2;
  grid-row: 1 / span 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  pointer-events: none;
}

.new-chat-agent-text {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  grid-column: 2;
  pointer-events: none;
}

/* 标题用短名（编排调度、认证…），不再被「数据采集-」前缀挤到省略号。 */
.new-chat-agent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}

.new-chat-agent-desc {
  color: $text-secondary;
  font-size: 11.5px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}


.new-chat-agents-empty {
  margin: 0;
  padding: 22px 14px;
  border: 1px dashed $border-light;
  border-radius: 14px;
  color: $text-muted;
  font-size: 12.5px;
  text-align: center;
}

@media (max-width: 1180px) {
  .new-chat-agents-track { grid-auto-columns: calc((100% - 24px) / 3); }
}

/* 详情：居中一张卡（不用贴边抽屉），图标 + 标题 + 场景，下面是简介、建议与元信息。 */
.agent-sheet {
  position: relative;
  width: 520px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  padding: 26px 26px 22px;
  border-radius: 18px;
  background: $bg-card;
  box-shadow: 0 28px 64px rgba(0, 0, 0, 0.22);
  color: $text-primary;
  text-align: start;
}

/* 内嵌分享页时卡片撑成面板：工具栏定高，iframe 吃掉剩余高度，滚动交给页面自己。 */
.agent-sheet.is-embed {
  display: flex;
  flex-direction: column;
  width: min(1180px, calc(100vw - 32px));
  height: calc(100vh - 72px);
  max-height: calc(100vh - 72px);
  overflow: hidden;
  padding: 0;
  border-radius: 16px;
}

.agent-embed-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  height: 52px;
  padding: 0 12px;
  border-bottom: 1px solid $border-light;
}

.agent-embed-back,
.agent-embed-action,
.agent-embed-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: none;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: $text-secondary;
  font-size: 12.5px;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.07); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.agent-embed-back { padding: 0 10px 0 8px; font-size: 13px; }
.agent-embed-close { width: 30px; padding: 0; }

.agent-embed-name {
  overflow: hidden;
  min-width: 0;
  color: $text-primary;
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-embed-actions { display: flex; align-items: center; gap: 6px; flex: none; margin-inline-start: auto; }

/* 内嵌页顶部的操作说明：FastGPT 的变量型应用填完变量提交后还要再发一句才会跑。 */
.agent-embed-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: none;
  padding: 8px 10px 8px 12px;
  border-bottom: 1px solid $border-light;
  background: rgba(var(--accent-primary-rgb), 0.06);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.55;
}

.agent-embed-tip > svg { flex: none; margin-top: 2px; color: $accent-primary; }

.agent-embed-tip-text { flex: 1; min-width: 0; }

.agent-embed-tip-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  margin: -2px -2px 0 0;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.08); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}

.agent-embed-frame {
  display: block;
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: $bg-primary;
}

.agent-embed-fallback {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1;
  min-height: 0;
  padding: 24px;
  color: $text-secondary;
  font-size: 13px;
  text-align: center;
}

.agent-embed-fallback p { margin: 0; }

.agent-sheet-close {
  position: absolute;
  top: 14px;
  right: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.08); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}

.agent-sheet-head { display: flex; align-items: center; gap: 14px; padding-right: 32px; }

.agent-sheet-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  color: #ffffff;
  font-size: 20px;
  font-weight: 600;
  line-height: 1;
}

.agent-sheet-heading { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.agent-sheet-title { margin: 0; color: $text-primary; font-size: 17px; font-weight: 600; line-height: 1.35; }
.agent-sheet-scene {
  align-self: flex-start;
  padding: 1px 10px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
  font-size: 11.5px;
  line-height: 19px;
}

.agent-sheet-desc { margin: 16px 0 0; color: $text-secondary; font-size: 13px; line-height: 1.75; }

.agent-sheet-suggest { margin-top: 20px; }
.agent-sheet-subtitle { margin: 0 0 10px; color: $text-primary; font-size: 12.5px; font-weight: 600; }
.agent-sheet-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.agent-sheet-pill {
  padding: 5px 12px;
  border: 1px solid $border-light;
  border-radius: 999px;
  background: rgba(var(--text-primary-rgb), 0.02);
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.5;
}

.agent-sheet-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid $border-light;
  color: $text-secondary;
  font-size: 12px;
}

.agent-sheet-meta-item { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; }
.agent-sheet-meta-label { color: $text-muted; }
.agent-sheet-meta-item code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }

.agent-sheet-actions { display: flex; align-items: center; gap: 10px; margin-top: 22px; }
.agent-sheet-primary { flex: 1; }

// 挂了智能体卡片的首页：hero 与输入框都收一档，让卡片落在首屏内。
.new-chat-page.has-agents .new-chat-intro { margin-top: clamp(24px, 6vh, 76px); }
.new-chat-page.has-agents .new-chat-compose { margin-top: clamp(16px, 6vh, 64px); }

@media (max-width: $breakpoint-mobile) {
  .new-chat-agents-track { grid-auto-columns: 78%; }
}

.new-chat-app-title {
  margin: 0; color: $text-primary; font-size: clamp(21px, 2vw, 28px); line-height: 1.3;
  font-weight: 650; letter-spacing: -0.01em;
}
.new-chat-app-subtitle { margin: 10px 0 0; color: $text-secondary; font-size: 13.5px; line-height: 1.6; }
.new-chat-app-title + .new-chat-domains,
.new-chat-app-subtitle + .new-chat-domains { margin-top: 18px; }
/* The domain switch at the top of the new-chat page: a track with a raised active pill. */
.new-chat-domains {
  display: inline-flex; align-items: center; gap: 2px; margin-top: 0; padding: 3px;
  border-radius: 999px; background: rgba(var(--text-primary-rgb), .045);
}
.new-chat-domain {
  flex: 1 0 auto; justify-content: center; min-width: 132px;
  display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 18px;
  border: 0; border-radius: 999px; background: transparent; color: $text-secondary;
  font: inherit; font-size: 13.5px; line-height: 1; white-space: nowrap; cursor: pointer;
  transition: background-color .15s, color .15s, box-shadow .15s;
  &:hover { color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
}
.new-chat-domain-active,
.new-chat-domain-active:hover {
  background: $bg-card; color: $text-primary;
  box-shadow: 0 1px 4px #00000014, inset 0 0 0 1px rgba(var(--text-primary-rgb), .1);
}
// 卡片尺寸上限跟随视口宽度（16vw），宽屏下等比放大；<=1100px 时仍是 176px。
.new-chat-page > :deep(.agent-cards) {
  flex: 1; min-height: 0; max-height: calc(max(176px, 16vw) * 1.4 + 84px); margin: 16px 0 0;
}
// 输入框撑满页面内宽（页面的 12px 内边距就是两侧留白）。
// 宽屏下不靠封顶收窄，而是让卡片随宽度等比放大，和窗口下保持同一套比例。
.new-chat-compose { flex: none; margin: clamp(24px, 18vh, 200px) 0 clamp(2px, 0.5vh, 6px); }
.new-chat-config-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-start; gap: 6px 12px; margin-bottom: 8px; }
.new-chat-config-actions { display: flex; justify-content: flex-start; align-items: center; gap: 8px; max-width: 100%; }
.new-chat-config-icon { width: 28px; height: 28px; padding: 0; }
// 带文字的那一枚（选择工作空间）：宽度随内容，图标与文字之间留缝
.new-chat-config-icon--labelled { width: auto; padding: 0 8px; gap: 6px; }
.new-chat-config-label { font-size: 12px; line-height: 18px; white-space: nowrap; }

// 选中工作空间后按钮点亮，显示的是目录名而不是「选择工作空间」
.new-chat-config-icon.is-selected {
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
}

.new-chat-workspace-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-inline-start: -6px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.08); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}
.new-chat-launch-toggle {
  display: inline-flex; flex: none; gap: 2px; margin: 0 2px; padding: 2px;
  border-radius: 8px; background: rgba(var(--text-primary-rgb), .045);
  button {
    min-width: 44px; height: 24px; padding: 0 9px; border: 0; border-radius: 6px;
    background: transparent; color: $text-secondary; font: inherit; font-size: 12px; line-height: 20px;
    white-space: nowrap; cursor: pointer; transition: background-color .15s, color .15s, box-shadow .15s;
    &[aria-checked="true"] {
      background: $bg-card; color: $text-primary;
      box-shadow: 0 1px 4px #00000014, inset 0 0 0 1px rgba(var(--text-primary-rgb), .1);
    }
    &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
    &:disabled { cursor: default; opacity: .45; }
  }
}
.new-chat-compose :deep(.chat-input-area) { padding: 0; border-top: 0; background: transparent; }
.new-chat-config-hint { display: block; margin: 10px auto 0; padding: 0; border: 0; background: transparent; color: $text-secondary; font: inherit; font-size: 12px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.workspace-picker-content { display: flex; flex-direction: column; gap: 12px; max-height: 65vh; overflow-y: auto; }
.workspace-picker-content :deep(.n-button__content) { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: $breakpoint-mobile) {
  .new-chat-page { justify-content: flex-start; padding: 16px 0; }
  .new-chat-intro {
    margin-top: auto;
    padding: 0 24px;
    h1 { margin-bottom: 6px; font-size: clamp(19px, 5.1vw, 24px); line-height: 1.35; }
    p { font-size: 12px; line-height: 1.5; }
  }
  .new-chat-page > :deep(.agent-cards) { flex: none; max-height: none; }
  .new-chat-compose { width: calc(100% - 32px); margin: 8px auto auto; }
  .new-chat-config-bar { flex-wrap: wrap; gap: 6px; }
  .new-chat-config-actions { width: 100%; }
}
@media (max-width: $breakpoint-mobile) and (max-height: 640px) {
  .new-chat-page { padding: 8px 0; }
}

.new-chat-field {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 8px;
  :deep(.n-base-selection), :deep(.n-input) { border-radius: 8px; }
}

.new-chat-label {
  font-size: 12px;
  color: $text-secondary;
  font-weight: 500;
}

.new-chat-field-hint {
  font-size: 11px;
  line-height: 1.5;
  color: $text-muted;
}

.session-group-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 12px 8px 6px;
  cursor: pointer;
  user-select: none;
}

.session-group-header--static,
.session-group-header--recent {
  cursor: default;
}

.session-group-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}

.group-chevron {
  flex-shrink: 0;
  color: $text-muted;
  transition: transform 0.15s ease;
  transform: rotate(0deg);

  &.collapsed {
    transform: rotate(-90deg);
  }
}

/* 组标题右侧的折叠开关：参考图里就是两个安静的小图标。 */
.session-group-fold {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-inline-start: auto;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.07); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}

.session-group-label {
  font-size: 13px;
  font-weight: 600;
  color: $text-secondary;
  letter-spacing: 0;
  text-transform: none;
}

/* 任务列表里的小节标题：工作空间目录在上，该目录的会话在下。 */
/* 与下面的会话行同高同圆角：两行胶囊叠在一起时高度必须一致。 */
.session-task-space {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  margin: 8px 0 1px;
  padding: 0 6px 0 6px;
  border-radius: 8px;
  color: $text-secondary;
  font-size: 13px;
  font-weight: 500;

  &:hover { background: rgba(var(--text-primary-rgb), 0.04); }

  svg {
    flex: none;
    color: $text-muted;
  }
}

.session-task-space-name {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-task-space-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;

  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}

/* 同一个位置叠两个图标：平时文件夹，悬停换成折叠箭头。 */
.space-icon {
  position: absolute;
  inset: 0;
  margin: auto;
  transition: opacity $transition-fast;
}

.space-icon--chevron {
  opacity: 0;
  transition: opacity $transition-fast, transform 0.15s ease;
}

.session-task-space:hover .space-icon--folder,
.session-task-space:focus-within .space-icon--folder { opacity: 0; }

.session-task-space:hover .space-icon--chevron,
.session-task-space:focus-within .space-icon--chevron { opacity: 1; }

/* 第二个图标（视图菜单）紧挨着第一个，不抢 auto 间距。 */
.session-group-fold--view { margin-inline-start: 2px; }

.session-group-fold:disabled { opacity: 0.4; cursor: default; }

/* 视图/筛选浮层：小标题 + 图标项 + 右侧勾选，对齐参考图的层级。 */
.sidebar-view-menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 216px;
  padding: 6px;
}

.sidebar-view-section {
  margin: 0;
  padding: 8px 8px 4px;
  color: $text-muted;
  font-size: 11px;
  font-weight: 600;
}

.sidebar-view-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  font-size: 13px;
  text-align: start;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.06); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }

  &.is-active {
    color: $text-primary;
    font-weight: 500;
  }
}

.sidebar-view-item-icon { flex: none; color: $text-muted; }

.sidebar-view-item.is-active .sidebar-view-item-icon { color: $text-secondary; }

.sidebar-view-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-view-check { flex: none; color: $accent-primary; }

.sidebar-view-divider {
  height: 1px;
  margin: 4px 2px;
  background: $border-light;
}

/* 工作空间行的两个小操作：悬停才出现，不吃走整行点击。 */
.session-task-space-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-inline-start: auto;
  opacity: 0;
  transition: opacity $transition-fast;
}

.session-task-space:hover .session-task-space-actions,
.session-task-space:focus-within .session-task-space-actions {
  opacity: 1;
}

.session-task-space-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.08); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}

/* 分组底部那行「收起」：参考里就是一行灰字，不用按钮边框。 */
.session-group-collapse {
  align-self: flex-start;
  margin: 2px 0 4px;
  padding: 4px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: $text-muted;
  font-size: 12px;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.05); color: $text-secondary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
}

/* 空间分组：外层一个静态总标题，每个工作空间一条可折叠的小标题。 */
.session-space { display: flex; flex-direction: column; }

.session-space-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px 4px 16px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: $text-secondary;
  font-size: 12px;
  text-align: start;
  cursor: pointer;
  transition: background $transition-fast, color $transition-fast;

  &:hover { background: rgba(var(--text-primary-rgb), 0.05); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}

.session-space-name {
  overflow: hidden;
  min-width: 0;
  color: inherit;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-group-config {
  margin-inline-start: auto;
  border: 0;
  background: transparent;
  color: $text-muted;
  cursor: pointer;
  padding: 0 2px;
}

.session-group-count {
  font-size: 12px;
  color: $text-muted;
  font-weight: 400;
}

.session-category-menu-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  margin-inline-start: auto;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background: $bg-secondary;
    color: $text-primary;
  }
}

.session-category-load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 10px 8px;
  padding: 7px 8px;
  border: 1px solid rgba(var(--error-rgb), 0.25);
  border-radius: 6px;
  background: rgba(var(--error-rgb), 0.06);
  color: var(--error);
  font-size: 11px;

  button {
    flex: 0 0 auto;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
  }

  button:disabled {
    cursor: default;
    opacity: 0.55;
  }
}

.session-items {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 12px;
}

.session-loading,
.session-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  margin: 10px 10px 10px 0;
  background: $bg-main-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);

  &--sidebar-collapsed {
    margin-inline-start: 10px;
  }

  @media (max-width: $breakpoint-mobile) {
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
}

.chat-content-wrapper {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
  min-width: 0;
  max-width: 100%;
}

.chat-content-wrapper--drop-active::after {
  content: "";
  position: absolute;
  inset: 12px;
  z-index: 30;
  pointer-events: none;
  border: 2px dashed var(--accent-info);
  border-radius: 8px;
  background: rgba(var(--accent-info-rgb), 0.05);
}

.chat-main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background-color: $bg-main-surface;
  animation: chat-surface-fade-in 1.5s ease both;
}

@keyframes chat-surface-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-session-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-badge {
  font-size: 10px;
  color: $text-muted;
  background: rgba($text-muted, 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

:global(#active-session-actions-menu [role="menuitem"]:focus-visible > .n-dropdown-option-body) {
  outline: 2px solid var(--accent-primary);
  outline-offset: -2px;
}

.chat-mode-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-inline-end: 4px;
}

@media (max-width: $breakpoint-mobile) {
  .chat-header {
    padding: calc(16px + env(safe-area-inset-top, 0px)) 12px 16px 52px;
  }

  .header-sidebar-toggle {
    display: none;
  }

  .header-session-title {
    font-size: 14px;
  }

}

.header-tool-toggle.active {
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb), 0.1);
}

.chat-tool-panel {
  position: relative;
  flex: 0 0 auto;
  min-width: 320px;
  max-width: 100%;
  max-inline-size: 100%;
  box-sizing: border-box;
  background: $bg-card;
  border-inline-start: 1px solid $border-color;
  display: flex;
  min-height: 0;
  overflow: visible;
}

.tool-panel-enter-active,
.tool-panel-leave-active {
  overflow: hidden;
  pointer-events: none;
  will-change: width, min-width, opacity;
  transition:
    width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    min-width 0.25s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.16s ease,
    border-color 0.16s ease;
}

.tool-panel-enter-from,
.tool-panel-leave-to {
  width: 0 !important;
  min-width: 0;
  opacity: 0;
  border-inline-start-color: transparent;
}

.chat-tool-resize-handle {
  position: absolute;
  inset-inline-start: -7px;
  top: 0;
  bottom: 0;
  width: 14px;
  cursor: col-resize;
  z-index: 20;

  &::after {
    content: "";
    position: absolute;
    inset-inline-start: 6px;
    top: 0;
    bottom: 0;
    width: 1px;
    background:
      linear-gradient($border-color, $border-color) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient($border-color, $border-color) bottom / 1px calc(50% - 26px) no-repeat;
    transition: background $transition-fast;
    z-index: 1;
  }

  &::before {
    content: "";
    position: absolute;
    inset-inline-start: 1px;
    top: 50%;
    width: 12px;
    height: 38px;
    transform: translateY(-50%);
    border-radius: 6px;
    background:
      linear-gradient($text-muted, $text-muted) center 12px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 19px / 6px 1px no-repeat,
      linear-gradient($text-muted, $text-muted) center 26px / 6px 1px no-repeat,
      $bg-card;
    border: 1px solid $border-color;
    opacity: 0.9;
    transition: all $transition-fast;
    z-index: 2;
  }

  &:hover::after {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) top / 1px calc(50% - 26px) no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) bottom / 1px calc(50% - 26px) no-repeat;
  }

  &:hover::before {
    background:
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 12px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 19px / 6px 1px no-repeat,
      linear-gradient(var(--accent-primary), var(--accent-primary)) center 26px / 6px 1px no-repeat,
      $bg-card;
    border-color: var(--accent-primary);
    opacity: 1;
  }
}

.chat-tool-panel-inner {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: $bg-main-surface;
}

.chat-file-preview-loading {
  flex: 1;
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
}

.chat-tool-tabs {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  order: 2;
  width: 48px;
  height: 100%;
  gap: 4px;
  padding: 8px 6px;
  border-inline-start: 1px solid $border-color;
  background: $bg-sidebar-surface;
  box-sizing: border-box;
}

.chat-tool-tab {
  position: relative;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: all $transition-fast;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.12);

    &::after {
      content: "";
      position: absolute;
      right: -6px;
      top: 9px;
      bottom: 9px;
      width: 2px;
      border-radius: 2px 0 0 2px;
      background: var(--accent-primary);
    }
  }
}

.chat-tool-content {
  order: 1;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: $bg-main-surface;
}

.chat-tool-content > * {
  height: 100%;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .chat-tool-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 70;
    left: 0;
    width: 100% !important;
    max-width: 100vw !important;
    max-inline-size: 100vw;
    min-width: 0;
    box-sizing: border-box;
    border-inline-start: none;
    box-shadow: none;
  }

  .chat-tool-resize-handle {
    display: none;
  }

  .tool-panel-enter-active,
  .tool-panel-leave-active {
    transition:
      transform 0.25s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.16s ease;
  }

  .tool-panel-enter-from,
  .tool-panel-leave-to {
    width: 100% !important;
    transform: translateX(100%);
  }

  .tool-panel-enter-from:dir(rtl),
  .tool-panel-leave-to:dir(rtl) {
    transform: translateX(-100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool-panel-enter-active,
  .tool-panel-leave-active {
    transition-duration: 0.01ms;
  }
}

/* ── Default Workspace Feature ─────────────────────────────────── */

.default-workspace-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  min-width: 0;
  margin-bottom: 8px;
}

.default-workspace-label {
  font-size: 13px;
  color: var(--n-text-color-3);
  flex-shrink: 0;
}

.recent-workspaces {
  margin-top: 8px;
}

.recent-workspaces-label {
  display: block;
  font-size: 11px;
  color: $text-muted;
  margin-bottom: 4px;
}

.recent-workspaces-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

</style>