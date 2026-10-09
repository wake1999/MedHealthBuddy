/**
 * Connection manager dialog. Plain DOM, no framework, no build step. It is
 * drawn over the remote DSH (or the home page) and closed with its ×, Esc, or
 * a click on the scrim; closing only hides it.
 *
 * The left column lists the servers (M4); the tabs show one of them: its
 * session, what ssh and the probe found, installing and upgrading DSH there,
 * its settings, and its log. "Add server" selects a blank settings form.
 *
 * State arrives by push (`dshSsh.onState`) and with every action's reply. The
 * settings form is seeded when a server is selected and never overwritten by
 * a push, so a status update can never clobber what the user is typing.
 */
const api = window.dshSsh

const PHASE_LABEL = {
  idle: '未连接',
  connecting: '连接中',
  starting: '启动中',
  stopping: '停止中',
  ready: '已就绪',
  error: '错误',
  stopped: '已断开',
  retrying: '重连中',
}
const BUSY_PHASES = new Set(['connecting', 'starting', 'stopping'])
const FIELDS = ['name', 'target', 'remoteProfile', 'remoteWorkspace', 'remotePort', 'localPort', 'closePolicy']
/** The pseudo-selection for a server not saved yet. */
const NEW = ''

const $ = (id) => document.getElementById(id)
const form = $('form')

/** @type {any} */
let state = null
/**
 * Which action is in flight, per server (NEW for the add form), to disable
 * that server's buttons meanwhile. Per server: stopping one remote takes a
 * while and must not hold up another.
 * @type {Map<string, string>}
 */
const busyBy = new Map()
/** @param {string | null | undefined} id */
const busyFor = (id) => busyBy.get(id ?? NEW) ?? ''
/** The selected server's id, NEW for "add server", or null before the first state. */
/** @type {string | null} */
let selected = null
/** The server the form was last seeded for. */
/** @type {string | null} */
let seededFor = null
let page = 'session'
/** Per connection: the last inspection and the progress of an install. */
/** @type {Map<string, { result?: any, error?: string, steps?: Map<string, { status: string, output: string }>, outcome?: string }>} */
const installs = new Map()

function current() {
  if (selected === null || selected === NEW) return { config: undefined, session: undefined }
  const config = state?.connections?.find((c) => c.id === selected)
  return { config, session: config === undefined ? undefined : state.sessions?.[config.id] }
}

/** Build an element; children may be strings (as text, never HTML) or nodes. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'className') node.className = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

// ------------------------------------------------------------------- pickers

const SVG_NS = 'http://www.w3.org/2000/svg'

/** DSH's one-pixel outline icons (upstream ui-primitives icons). */
function icon(d, size, className) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [key, value] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'stroke-width': 1, 'aria-hidden': 'true' })) {
    svg.setAttribute(key, String(value))
  }
  if (className !== undefined) svg.setAttribute('class', className)
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  path.setAttribute('stroke', 'currentColor')
  svg.append(path)
  return svg
}
const CHEVRON_DOWN = 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6'
const CHECK = 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4'

/** The menu open right now, if any: `{ close(focusSelector) }`. */
let openPicker = null

/**
 * Draw DSH's selector pill and menu for a hidden `<select>`, which keeps the
 * value so the form reads and seeds it as before.
 * @param {HTMLSelectElement} select
 * @returns {() => void} re-reads the select after its value is set in code.
 */
function picker(select) {
  const label = el('span')
  const selector = el('button', { type: 'button', className: 'selector', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, label, icon(CHEVRON_DOWN, 14))
  // Read as "<row title> <current choice>".
  const labelledBy = select.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    label.id = `${select.name || select.id}-choice`
    selector.setAttribute('aria-labelledby', `${labelledBy} ${label.id}`)
  }
  select.after(selector)

  const sync = () => { label.textContent = select.selectedOptions[0]?.textContent ?? '' }

  const open = () => {
    const menu = el('div', { className: 'menu', role: 'menu' })
    const items = [...select.options].map((option) => {
      const chosen = option.value === select.value
      const item = el('button', { type: 'button', className: 'menu-item', role: 'menuitemradio', 'aria-checked': String(chosen) },
        el('span', { className: 'menu-label' }, option.textContent),
        chosen ? icon(CHECK, 14, 'menu-check') : null)
      item.addEventListener('click', () => {
        select.value = option.value
        sync()
        select.dispatchEvent(new Event('change'))
        close(true)
      })
      return item
    })
    menu.append(...items)
    menu.addEventListener('keydown', (event) => {
      const index = items.indexOf(/** @type {any} */ (document.activeElement))
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus()
      } else if (event.key === 'Tab') {
        close(false)
      }
    })
    document.body.append(menu)
    // End-aligned, 4px under the pill (upstream Menu align="end").
    const rect = selector.getBoundingClientRect()
    menu.style.top = `${rect.bottom + 4}px`
    menu.style.right = `${document.documentElement.clientWidth - rect.right}px`
    if (menu.getBoundingClientRect().bottom > window.innerHeight - 12) {
      menu.style.top = `${rect.top - 4 - menu.offsetHeight}px`
    }
    selector.setAttribute('aria-expanded', 'true')
    const onPointer = (event) => {
      if (!menu.contains(event.target) && !selector.contains(event.target)) close(false)
    }
    const onScroll = () => { close(false) }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    function close(focusSelector) {
      if (openPicker !== handle) return
      openPicker = null
      menu.remove()
      selector.setAttribute('aria-expanded', 'false')
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      if (focusSelector) selector.focus({ preventScroll: true })
    }
    const handle = { close }
    openPicker = handle
    ;(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true })
  }

  selector.addEventListener('click', () => {
    if (openPicker !== null) openPicker.close(false)
    else open()
  })
  selector.addEventListener('keydown', (event) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && openPicker === null) {
      event.preventDefault()
      open()
    }
  })
  sync()
  return sync
}

const syncPickers = [...document.querySelectorAll('select.picker-source')].map((select) => picker(select))
const refreshPickers = () => { for (const sync of syncPickers) sync() }

function showNote(kind, text) {
  const note = $('note')
  if (text === '') {
    note.hidden = true
    return
  }
  note.hidden = false
  note.dataset.kind = kind
  note.textContent = text
}

// -------------------------------------------------------------- server list

/** The phase a server's dot shows. */
function phaseOf(session) {
  if (session === undefined) return 'idle'
  return session.retryAt != null ? 'retrying' : session.phase ?? 'idle'
}

function renderServers() {
  const list = $('servers')
  const connections = state?.connections ?? []
  list.replaceChildren(...connections.map((config) => {
    const session = state.sessions?.[config.id]
    const phase = phaseOf(session)
    const cell = el('button', {
      type: 'button',
      className: 'nav-cell server-cell',
      role: 'option',
      'aria-selected': String(config.id === selected),
      title: `${String(config.name)} · ${PHASE_LABEL[phase] ?? phase}`,
    },
    el('span', { className: 'dot', 'data-phase': phase, 'aria-hidden': 'true' }),
    el('span', { className: 'nav-label' }, config.name),
    state.active === config.id ? el('span', { className: 'nav-badge' }, '显示中') : null)
    cell.addEventListener('click', () => { select(config.id) })
    return cell
  }))
  $('btn-add').setAttribute('aria-selected', String(selected === NEW))
}

/** @param {string} id NEW for a new server */
function select(id) {
  if (selected === id) return
  selected = id
  showNote('', '')
  $('save-note').textContent = ''
  seedForm()
  if (id === NEW) showPage('settings')
  render()
}

// ------------------------------------------------------------------ rendering

function render() {
  renderServers()
  const isNew = selected === NEW
  for (const tab of document.querySelectorAll('.tab')) tab.hidden = isNew && tab.dataset.page !== 'settings'
  $('settings-heading').textContent = isNew ? '添加服务器' : '连接设置'
  $('danger-zone').hidden = isNew
  $('btn-save').textContent = isNew ? '添加' : '保存'

  const { config, session } = current()
  const phase = phaseOf(session)
  const busy = busyFor(config?.id ?? selected)
  const isBusy = BUSY_PHASES.has(phase) || busy !== ''
  $('btn-save').disabled = busy !== ''

  $('session-name').textContent = config?.name ?? ''
  const chip = $('chip')
  chip.dataset.phase = phase
  chip.textContent = PHASE_LABEL[phase] ?? phase

  $('destination').textContent = config === undefined
    ? ''
    : `${config.target}${session?.destination ? ` → ${session.destination.text}` : ''} · 本机 127.0.0.1:${session?.localPort ?? config.localPort} → 远端 ${config.remotePort}`
  $('message').textContent = config === undefined
    ? '先在「连接设置」里填写 ssh 别名和远端工作区，保存后即可连接。'
    : session?.message ?? ''

  renderExtra(session, phase)

  const hasConfig = config !== undefined
  const ready = session?.phase === 'ready'
  $('btn-connect').disabled = !hasConfig || isBusy || ready || session?.installing === true
  $('btn-connect').classList.toggle('primary', !ready)
  $('btn-connect').textContent = busy === 'connect' ? '连接中…' : ready ? '已连接' : '连接'
  $('btn-restart').disabled = !hasConfig || isBusy
  $('btn-restart').textContent = busy === 'restart' ? '重启中…' : '重启远端'
  $('btn-stop').disabled = !hasConfig || isBusy
  $('btn-stop').textContent = busy === 'stop' ? '停止中…' : '停止远端'
  $('btn-disconnect').disabled = !hasConfig || busy !== '' || !(ready || phase === 'retrying' || BUSY_PHASES.has(phase) || session?.wanted)
  $('btn-remove').disabled = !hasConfig || busy !== '' || session?.installing === true

  renderFacts(config, session)
  renderInstall(config, session)
  renderLog(session?.log ?? [])
  $('userdata').textContent = state?.userData ?? ''
  $('sandbox-warning').hidden = state?.sandboxDisabled !== true
  $('auto-connect').checked = state?.settings?.autoConnectFirst === true
}

function renderExtra(session, phase) {
  const box = $('session-extra')
  box.replaceChildren()
  if (session === undefined) return
  const lines = []
  if (phase === 'retrying') {
    const seconds = Math.max(0, Math.round((session.retryAt - Date.now()) / 1000))
    lines.push(el('p', { className: 'hint' }, `连接已断开，${seconds} 秒后第 ${session.retryAttempt} 次重连。服务器上的 DSH 通常仍在运行，重连会直接复用它。`))
  }
  if (BUSY_PHASES.has(phase) && phase !== 'stopping') {
    lines.push(el('p', { className: 'hint' }, '首次启动通常要 1–3 分钟：远端把启动链接写进日志前有缓冲。请不要中断。'))
  }
  // "Stop on exit" only survives a crash with the server plugin's lease; say so
  // when that net is missing rather than let the setting promise too much.
  if (session.phase === 'ready' && session.closePolicy === 'stop' && session.link?.status !== 'active' && session.link?.status !== 'checking') {
    lines.push(el('p', { className: 'hint' },
      '退出时会停止远端；但服务器插件未就绪，若本应用被强制结束，远端不会自动停止。'))
  }
  if (session.phase === 'ready' && session.reused) {
    lines.push(el('p', { className: 'hint' }, '复用了服务器上已在运行的 DSH。'))
  }
  if (session.phase === 'error' && /dsh` command was not found/.test(session.message ?? '')) {
    lines.push(el('div', { className: 'banner', 'data-kind': 'warn' }, '服务器上还没有 DSH。到「安装与升级」里检查服务器，一键安装。'))
  }
  if (session.window?.authFailed) {
    lines.push(el('div', { className: 'banner', 'data-kind': 'warn' },
      '远端要求重新登录，但它的日志里没有可用的启动链接（可能不是由本应用启动的）。点「重启远端」换一个新进程即可。'))
  }
  box.append(...lines)
}

/**
 * The server plugin, in words.
 * @param {any} session
 * @returns {{ text: string, ok: boolean | undefined }}
 */
function describeLink(session) {
  const link = session?.link
  if (link === undefined || session.phase !== 'ready') return { text: '连接后显示', ok: undefined }
  switch (link.status) {
    case 'active': {
      const parts = [`已连接（v${String(link.plugin)}）`]
      if (link.tasks) parts.push('任务完成时发系统通知')
      else parts.push('此版本不支持任务通知，请升级插件')
      if (link.leased) parts.push('本应用意外退出后，远端会在 10 分钟内自行停止')
      return { text: parts.join(' · '), ok: true }
    }
    case 'checking':
      return { text: '正在握手…', ok: undefined }
    case 'absent':
      return { text: '未安装 dsh-desktop-link（仅显示模式）；可在「安装与升级」里安装', ok: false }
    case 'incompatible':
      return { text: '版本不兼容（仅显示模式）；可在「安装与升级」里升级', ok: false }
    default:
      return { text: '这个 DSH 不是由本应用启动的，无法集成；重启远端后可启用', ok: undefined }
  }
}

function renderFacts(config, session) {
  const facts = session?.facts ?? null
  const yesNo = (ok, yes, no) => el('span', { className: ok ? 'good' : 'bad' }, ok ? yes : no)
  const row = (term, value) => el('div', { className: 'row' },
    el('div', { className: 'row-text' }, el('div', { className: 'row-title' }, term)),
    el('div', { className: 'row-value' }, value))
  if (config === undefined) {
    $('facts').replaceChildren()
    return
  }
  const destination = session?.destination
  const rows = [
    row('ssh 目标', destination == null
      ? el('span', { className: 'mono' }, `${config.target}（解析中或无法解析）`)
      : el('span', {}, el('span', { className: 'mono' }, destination.text),
        destination.direct ? el('span', { className: 'hint block' }, '~/.ssh/config 里没有这个别名，按主机名直接连接') : null)),
  ]
  if (facts === null) {
    rows.push(row('探测', el('span', { className: 'hint' }, '尚未连接过，连接后显示')))
  } else {
    const ready = session?.phase === 'ready'
    rows.push(
      row('dsh', facts.dsh === '' ? yesNo(false, '', '未找到；可在「安装与升级」里安装') : el('span', { className: 'mono' }, facts.dsh)),
      row('node', facts.nodeVersion === null ? yesNo(false, '', '未找到') : el('span', { className: 'mono' }, facts.nodeVersion)),
      row('工作区', yesNo(facts.workspaceExists, '存在', '不存在')),
      row('profile', facts.profileExists ? yesNo(true, '存在', '') : el('span', { className: 'hint' }, '不存在（web 等内置 profile 首次启动时自动创建）')),
      row('远端端口', ready ? yesNo(true, 'DSH 运行中', '') : facts.listening ? '已被占用（将复用）' : '空闲'),
    )
  }
  const link = describeLink(session)
  rows.push(row('服务器插件', link.ok === undefined ? link.text : yesNo(link.ok, link.text, link.text)))
  $('facts').replaceChildren(...rows)
}

// ----------------------------------------------------------------- install

const STEP_STATUS = { pending: '待执行', running: '执行中…', done: '完成', failed: '失败' }

function renderInstall(config, session) {
  const box = $('install-result')
  const busy = busyFor(config?.id)
  $('btn-inspect').disabled = config === undefined || busy !== '' || session?.installing === true
  $('btn-inspect').textContent = busy === 'inspect' ? '检查中…' : '检查服务器'
  if (config === undefined) {
    box.replaceChildren()
    return
  }
  const record = installs.get(config.id)
  if (record === undefined) {
    box.replaceChildren(el('p', { className: 'empty' }, '点「检查服务器」看看缺什么。检查是只读的，不会改动服务器。'))
    return
  }
  if (record.error !== undefined) {
    box.replaceChildren(el('div', { className: 'banner', 'data-kind': 'error' }, record.error))
    return
  }
  const { facts, plan, source } = record.result
  const sourceName = source === 'official' ? '官方源' : '国内镜像（npmmirror）'
  const row = (term, value) => el('div', { className: 'row' },
    el('div', { className: 'row-text' }, el('div', { className: 'row-title' }, term)),
    el('div', { className: 'row-value' }, value))
  const mono = (text) => el('span', { className: 'mono' }, text)
  const missing = (text) => el('span', { className: 'bad' }, text)
  const nodes = [
    el('h3', { className: 'subheading' }, '服务器现状'),
    el('div', { className: 'rows' },
      row('Node.js', facts.node === undefined ? missing('没有可用的（需要 ^22.19 或 ≥24）') : mono(`${facts.node.version}${facts.managedNode ? '（~/.local/opt/node）' : `（${facts.node.path}）`}`)),
      row('DSH', facts.dsh === '' ? missing('未安装') : mono(`${facts.dshVersion || '未知版本'}${facts.dshManaged ? '' : `（${facts.dsh}）`}`)),
      row('pnpm', facts.pnpm === '' ? missing('未安装') : mono(facts.pnpm)),
      row('服务器插件', facts.plugin === '' ? missing('未安装') : mono(facts.plugin)),
      row('下载源', `${sourceName}${facts.dshAvailable ? ` · DSH 最新 ${facts.dshAvailable}` : ''}`),
    ),
  ]
  for (const blocker of plan.blockers) nodes.push(el('div', { className: 'banner', 'data-kind': 'error' }, blocker))
  for (const note of plan.notes) nodes.push(el('p', { className: 'hint' }, note))

  if (plan.steps.length === 0 && plan.blockers.length === 0) {
    nodes.push(el('div', { className: 'banner', 'data-kind': 'ok' }, '都是最新的，不需要安装。'))
  } else if (plan.steps.length > 0) {
    nodes.push(el('h3', { className: 'subheading' }, '安装计划'))
    const steps = el('ol', { className: 'steps' })
    for (const step of plan.steps) {
      const progress = record.steps?.get(step.id)
      const status = progress?.status ?? 'pending'
      steps.append(el('li', { className: 'step', 'data-status': status },
        el('div', { className: 'step-head' },
          el('span', { className: 'step-title' }, step.title),
          record.steps === undefined ? null : el('span', { className: 'step-status' }, STEP_STATUS[status] ?? status)),
        el('div', { className: 'row-desc' }, step.detail),
        el('code', { className: 'cmd' }, step.command),
        progress?.output ? el('pre', { className: 'step-output' }, progress.output) : null))
    }
    nodes.push(steps)
    const running = session?.installing === true
    if (record.outcome !== undefined) {
      nodes.push(el('div', { className: 'banner', 'data-kind': record.outcome === 'ok' ? 'ok' : 'error' },
        record.outcome === 'ok'
          ? (session?.phase === 'ready'
            ? '安装完成。远端 DSH 正在运行旧版本，「重启远端」后才会用上新装的 DSH 和插件。'
            : '安装完成，现在可以回到「会话」连接了。首次启动会自动创建 profile，约需 1–3 分钟。')
          : '安装在上面标红的步骤失败，之前完成的步骤已保留。看输出排查后，重新「检查服务器」再装即可，已完成的部分会被跳过。'))
    } else {
      const start = el('button', { type: 'button', className: 'btn primary', disabled: running || busy !== '' }, running ? '安装中…' : '开始安装')
      start.addEventListener('click', () => { void startInstall(config, plan) })
      nodes.push(el('div', { className: 'footer' }, el('span', { className: 'hint' }, `共 ${String(plan.steps.length)} 步，Node.js 和 DSH 的下载安装可能要几分钟。`), start))
    }
  }
  box.replaceChildren(...nodes)
}

async function inspect() {
  const { config } = current()
  if (config === undefined) return
  const source = /** @type {HTMLSelectElement} */ ($('source')).value
  const dshTag = /** @type {HTMLSelectElement} */ ($('dsh-tag')).value
  busyBy.set(config.id, 'inspect')
  $('inspect-note').textContent = '正在通过 ssh 检查，约需 10–20 秒…'
  render()
  try {
    const reply = await api.inspect(config.id, { dshTag, source: source === 'auto' ? undefined : source })
    applyState(reply.state)
    installs.set(config.id, reply.ok ? { result: reply.result } : { error: reply.error })
  } finally {
    busyBy.delete(config.id)
    $('inspect-note').textContent = ''
    render()
  }
}

async function startInstall(config, plan) {
  const list = plan.steps.map((s, i) => `${String(i + 1)}. ${s.title}`).join('\n')
  if (!window.confirm(`在「${config.name}」上执行以下步骤？只写你的家目录。\n\n${list}`)) return
  const record = installs.get(config.id)
  if (record === undefined) return
  record.steps = new Map(plan.steps.map((s) => [s.id, { status: 'pending', output: '' }]))
  record.outcome = undefined
  render()
  const reply = await api.install(config.id)
  applyState(reply.state)
  record.outcome = reply.ok && reply.result?.ok ? 'ok' : 'failed'
  if (!reply.ok) {
    const running = [...(record.steps?.values() ?? [])].find((s) => s.status === 'running')
    if (running !== undefined) {
      running.status = 'failed'
      running.output = `${running.output}\n${String(reply.error)}`.trim()
    } else {
      record.error = reply.error
    }
  }
  render()
}

api.onInstallProgress((progress) => {
  const record = installs.get(progress.connection)
  const step = record?.steps?.get(progress.id)
  if (step === undefined) return
  step.status = progress.status
  step.output = progress.output
  render()
})

function renderLog(lines) {
  const pre = $('log')
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24
  pre.textContent = lines.length === 0 ? '（暂无）' : lines.join('\n')
  if (atBottom) pre.scrollTop = pre.scrollHeight
}

/** Fill the form for the selected server, or with defaults for a new one. */
function seedForm() {
  if (state === null || seededFor === selected) return
  seededFor = selected
  const { config } = current()
  const port = state.freePort ?? 3080
  const values = config ?? { remoteProfile: 'web', remotePort: port, localPort: port, closePolicy: 'keep' }
  for (const name of FIELDS) {
    const input = form.elements.namedItem(name)
    if (input !== null) input.value = values[name] === undefined ? '' : String(values[name])
  }
  refreshPickers()
}

function applyState(next) {
  if (next === undefined || next === null) return
  state = next
  const ids = state.connections.map((c) => c.id)
  // First state, or the selected server is gone: pick the one on screen, else the first.
  if (selected === null || (selected !== NEW && !ids.includes(selected))) {
    selected = state.active ?? ids[0] ?? NEW
    seededFor = null
    if (selected === NEW) showPage('settings')
  }
  seedForm()
  render()
}

// -------------------------------------------------------------------- actions

/**
 * Run an action for the selected server. Its outcome note is shown only if
 * that server is still the one on screen when it finishes.
 */
async function run(action, fn) {
  const owner = selected ?? NEW
  busyBy.set(owner, action)
  showNote('', '')
  render()
  try {
    const reply = await fn()
    applyState(reply.state)
    if (!reply.ok && selected === owner) showNote('error', reply.error)
    return reply
  } catch (error) {
    if (selected === owner) showNote('error', error instanceof Error ? error.message : String(error))
    return { ok: false }
  } finally {
    busyBy.delete(owner)
    render()
  }
}

const idOf = () => current().config?.id

$('btn-connect').addEventListener('click', () => {
  void run('connect', () => api.connect(idOf())).then((reply) => {
    const phase = current().session?.phase
    if (reply.ok && phase === 'error') showNote('error', current().session.message)
  })
})
$('btn-disconnect').addEventListener('click', () => { void run('disconnect', () => api.disconnect(idOf())) })
$('btn-restart').addEventListener('click', () => {
  if (!window.confirm('重启服务器上的 DSH？正在运行的任务会被中断；会话数据保留在服务器上。')) return
  void run('restart', () => api.restart(idOf()))
})
$('btn-stop').addEventListener('click', () => {
  if (!window.confirm('停止服务器上的 DSH？正在运行的任务会被中断；会话数据保留在服务器上。')) return
  void run('stop', () => api.stop(idOf()))
})
$('btn-remove').addEventListener('click', () => {
  const { config } = current()
  if (config === undefined) return
  if (!window.confirm(`从列表中删除「${config.name}」？会先断开连接，并清除本机为它保存的登录状态。服务器上的 DSH 和数据不受影响。`)) return
  installs.delete(config.id)
  void run('remove', () => api.remove(config.id))
})
$('auto-connect').addEventListener('change', (event) => {
  void api.saveSettings({ autoConnectFirst: /** @type {HTMLInputElement} */ (event.target).checked }).then((reply) => {
    applyState(reply.state)
  })
})

$('btn-userdata').addEventListener('click', () => { void api.openUserData() })
$('btn-logs').addEventListener('click', () => { void api.openLogs() })
$('btn-export').addEventListener('click', () => {
  void api.exportDiagnostics().then((reply) => {
    if (reply.ok && reply.result?.saved) {
      page === 'session' ? showNote('ok', `诊断信息已保存到 ${reply.result.path}`) : window.alert(`诊断信息已保存到\n${reply.result.path}`)
    } else if (!reply.ok) {
      showNote('error', reply.error)
    }
  })
})
$('btn-inspect').addEventListener('click', () => { void inspect() })
$('btn-add').addEventListener('click', () => { select(NEW) })

$('btn-save').addEventListener('click', () => {
  const isNew = selected === NEW
  const record = { id: isNew ? '' : idOf() ?? '' }
  for (const name of FIELDS) record[name] = form.elements.namedItem(name).value
  void run('save', () => api.save(record)).then((reply) => {
    if (!reply.ok) {
      $('save-note').textContent = ''
      window.alert(reply.error)
      return
    }
    const saved = reply.result
    if (isNew) {
      selected = saved.id
      seededFor = null
      seedForm()
      showPage('session')
      render()
      return
    }
    for (const name of FIELDS) form.elements.namedItem(name).value = String(saved[name])
    refreshPickers()
    $('save-note').textContent = current().session?.phase === 'ready' ? '已保存（连接参数变了会先断开）' : '已保存'
    setTimeout(() => { $('save-note').textContent = '' }, 4000)
  })
})

// ------------------------------------------------------------------ navigation

const tabs = [...document.querySelectorAll('.tab')]

/** @param {string} name */
function showPage(name) {
  page = name
  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.page === name))
  for (const section of document.querySelectorAll('.page')) section.hidden = section.dataset.page !== name
  if (name === 'log') {
    const pre = $('log')
    pre.scrollTop = pre.scrollHeight
  }
}
showPage('session')

tabs.forEach((tab) => {
  tab.addEventListener('click', () => { showPage(tab.dataset.page) })
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const visible = tabs.filter((t) => !t.hidden)
    const index = visible.indexOf(tab)
    const next = visible[(index + (event.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length]
    next.focus()
    showPage(next.dataset.page)
  })
})

// ---------------------------------------------------------------------- closing

const close = () => { void api.close() }
$('btn-close').addEventListener('click', close)
$('scrim').addEventListener('click', close)
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  // Esc closes an open menu first, then the dialog.
  if (openPicker !== null) openPicker.close(true)
  else close()
})

api.onState(applyState)
void api.getState().then((reply) => { applyState(reply.state) })

// The retry countdown needs a clock of its own between pushes.
setInterval(() => {
  if (current().session?.retryAt != null) render()
}, 1000)
