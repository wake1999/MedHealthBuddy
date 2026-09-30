/**
 * Installing and upgrading DSH and dsh-desktop-link on a server.
 *
 * Everything lands in the user's own home directory — nothing needs root, and
 * nothing outside `$HOME` is touched:
 *
 *   ~/.local/opt/node-v<version>-linux-<arch>/   an official Node.js build
 *   ~/.local/opt/node -> node-v…                  the one in use
 *   ~/.local/opt/node/bin/{dsh,pnpm}              `npm i -g` into that Node
 *   ~/.dsh/dsh-desktop-link-<version>.tgz         the plugin package
 *   ~/.dsh/profiles/<profile>/                    where `dsh plugin add` records it
 *
 * The layout matters to the rest of the app: `resolveDshCommand` looks in
 * `~/.local/opt/node/bin`, and the start wrapper puts dsh's directory first on
 * PATH so `#!/usr/bin/env node` finds this Node rather than a system one.
 *
 * Flow: `inspectCommand` → `parseInspection` → `planInstall` (shown to the
 * user, with every command) → `stepScript` per step, run one at a time.
 * Downloads come from the official sources or their npmmirror copies,
 * whichever the server reaches faster; the Node archive is checked against
 * the release's SHASUMS256.txt before it is unpacked.
 *
 * @module @dsh-ssh/core/install
 */

import { shq } from './remote.js'

/** DSH's engine range is `^22.19.0 || >=24`; new installs get the newest 24.x. */
export const NODE_MAJOR = 24

/** Where each source lives. */
export const SOURCES = Object.freeze({
  official: Object.freeze({ label: '官方源', node: 'https://nodejs.org/dist', registry: 'https://registry.npmjs.org' }),
  mirror: Object.freeze({ label: '国内镜像（npmmirror）', node: 'https://npmmirror.com/mirrors/node', registry: 'https://registry.npmmirror.com' }),
})

/** The package-manager DSH is built with (its `packageManager` field). */
export const PNPM_SPEC = 'pnpm@11'

/** Release channels of the DSH npm package. */
export const DSH_TAGS = Object.freeze(['latest', 'next'])

const NODE_DIR = '"$HOME/.local/opt/node"'
const NODE_BIN = '"$HOME/.local/opt/node/bin"'

/**
 * Whether a Node version satisfies DSH's engine range.
 * @param {string | undefined} version like `v24.21.0`
 */
export function nodeSatisfies(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  if (match === null) return false
  const [major, minor] = [Number(match[1]), Number(match[2])]
  return major >= 24 || (major === 22 && minor >= 19)
}

/**
 * Compare two semver-ish versions (prerelease sorts before its release).
 * @param {string} a
 * @param {string} b
 * @returns {number} <0, 0 or >0
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return x.pre < y.pre ? -1 : 1
}

/**
 * The read-only inspection script. Every fact is one `KEY=value` line.
 * @param {{ remoteProfile: string }} config
 * @param {{ dshTag?: string }} [options]
 */
export function inspectCommand(config, options = {}) {
  const tag = DSH_TAGS.includes(options.dshTag ?? '') ? options.dshTag : 'latest'
  const profile = `"$HOME/.dsh/profiles"/${shq(config.remoteProfile)}`
  const ping = (key, url) =>
    `printf "${key}=%s\\n" "$(curl -s -o /dev/null -m 6 -w "%{http_code} %{time_total}" ${shq(`${url}/-/ping`)} 2>/dev/null || echo fail)"`
  return [
    'set -u',
    'printf "HOME=%s\\n" "$HOME"',
    'printf "ARCH=%s\\n" "$(uname -m)"',
    'printf "OS=%s\\n" "$(uname -s)"',
    ...['curl', 'tar', 'xz', 'sha256sum'].map((c) => `printf "HAS_${c.toUpperCase()}=%s\\n" "$(command -v ${c} >/dev/null 2>&1 && echo yes || echo no)"`),
    // Every node worth considering: the one this installer manages, then PATH's.
    `for n in ${NODE_BIN}/node "$(command -v node 2>/dev/null || true)"; do`,
    '  [ -n "$n" ] && [ -x "$n" ] && printf "NODECAND=%s %s\\n" "$n" "$("$n" --version 2>/dev/null || echo none)"',
    'done',
    `printf "MANAGED_NODE=%s\\n" "$(readlink ${NODE_DIR} 2>/dev/null || true)"`,
    // dsh, found the way a connect finds it.
    'p=""',
    'if command -v dsh >/dev/null 2>&1; then p="$(command -v dsh)"; fi',
    `if [ -z "$p" ]; then for c in ${NODE_BIN}/dsh "$HOME/.local/bin/dsh" "$HOME/.npm-global/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do if [ -x "$c" ]; then p="$c"; break; fi; done; fi`,
    'printf "DSH=%s\\n" "$p"',
    'if [ -n "$p" ]; then printf "DSH_VERSION=%s\\n" "$(PATH="$(dirname "$p"):$PATH" "$p" --version 2>/dev/null | head -n 1)"; fi',
    `printf "PNPM=%s\\n" "$(PATH=${NODE_BIN}:"$PATH" command -v pnpm 2>/dev/null || true)"`,
    `printf "PROFILE=%s\\n" "$([ -f ${profile}/package.json ] && echo yes || echo no)"`,
    `f=${profile}/node_modules/dsh-desktop-link/package.json`,
    'printf "PLUGIN=%s\\n" "$([ -f "$f" ] && sed -n \'s/^[[:space:]]*"version":[[:space:]]*"\\([^"]*\\)".*/\\1/p\' "$f" | head -n 1)"',
    ping('PING_OFFICIAL', SOURCES.official.registry),
    ping('PING_MIRROR', SOURCES.mirror.registry),
    // What the chosen tag currently is, from whichever registry answers.
    `for r in ${shq(SOURCES.mirror.registry)} ${shq(SOURCES.official.registry)}; do`,
    // The abbreviated document, and only its head: dist-tags come first.
    `  v="$(curl -fsS -m 8 -H 'Accept: application/vnd.npm.install-v1+json' "$r/@deepseek-ai%2Fdsh" 2>/dev/null | head -c 4000 | tr ',' '\\n' | grep -o '"${tag}":"[^"]*"' | head -n 1 | cut -d '"' -f 4)"`,
    '  if [ -n "$v" ]; then printf "DSH_AVAILABLE=%s\\n" "$v"; break; fi',
    'done',
  ].join('\n')
}

/**
 * @typedef {object} Inspection
 * @property {string} home
 * @property {string} arch      node's name for it: x64 or arm64 ('' when unsupported)
 * @property {boolean} linux
 * @property {Record<'curl' | 'tar' | 'xz' | 'sha256sum', boolean>} tools
 * @property {{ path: string, version: string } | undefined} node  the best usable Node, if any.
 * @property {boolean} managedNode  whether that Node is the one under ~/.local/opt/node.
 * @property {string} dsh
 * @property {string} dshVersion
 * @property {string} dshAvailable  the version the chosen tag points at, '' if unknown.
 * @property {boolean} dshManaged   whether dsh lives in the managed Node's bin.
 * @property {string} pnpm
 * @property {boolean} profile
 * @property {string} plugin        installed dsh-desktop-link version, '' if none.
 * @property {'official' | 'mirror' | undefined} source  the faster reachable source.
 */

/**
 * @param {string} stdout
 * @returns {Inspection}
 */
export function parseInspection(stdout) {
  const lines = stdout.split(/\r?\n/)
  const one = (key) => {
    const line = lines.find((l) => l.startsWith(`${key}=`))
    return line === undefined ? '' : line.slice(key.length + 1).trim()
  }
  const home = one('HOME')
  const machine = one('ARCH')
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : ''
  const candidates = lines.filter((l) => l.startsWith('NODECAND=')).map((l) => {
    const rest = l.slice('NODECAND='.length).trim()
    const at = rest.lastIndexOf(' ')
    return { path: rest.slice(0, at), version: rest.slice(at + 1) }
  }).filter((c) => nodeSatisfies(c.version))
  const node = candidates[0]
  const managedBin = `${home}/.local/opt/node/bin`
  const ping = (key) => {
    const match = /^(\d{3}) ([\d.]+)$/.exec(one(key))
    return match !== null && match[1].startsWith('2') ? Number(match[2]) : undefined
  }
  const official = ping('PING_OFFICIAL')
  const mirror = ping('PING_MIRROR')
  const source = official === undefined && mirror === undefined ? undefined
    : official === undefined ? 'mirror'
      : mirror === undefined ? 'official'
        : mirror <= official ? 'mirror' : 'official'
  const dsh = one('DSH')
  const dshVersion = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(one('DSH_VERSION'))?.[0] ?? ''
  return {
    home,
    arch,
    linux: one('OS') === 'Linux',
    tools: { curl: one('HAS_CURL') === 'yes', tar: one('HAS_TAR') === 'yes', xz: one('HAS_XZ') === 'yes', sha256sum: one('HAS_SHA256SUM') === 'yes' },
    node,
    managedNode: node !== undefined && node.path === `${managedBin}/node`,
    dsh,
    dshVersion,
    dshAvailable: /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(one('DSH_AVAILABLE')) ? one('DSH_AVAILABLE') : '',
    dshManaged: dsh !== '' && dsh === `${managedBin}/dsh`,
    pnpm: one('PNPM'),
    profile: one('PROFILE') === 'yes',
    plugin: one('PLUGIN'),
    source,
  }
}

/**
 * @typedef {object} InstallStep
 * @property {'node' | 'pnpm' | 'dsh' | 'plugin'} id
 * @property {string} title
 * @property {string} detail   what and why, for the user.
 * @property {string} command  what runs on the server, for the user to read.
 */

/**
 * @typedef {object} InstallPlan
 * @property {InstallStep[]} steps
 * @property {string[]} blockers  reasons nothing can be done (shown instead of steps).
 * @property {string[]} notes     things the user should know.
 */

/**
 * Decide what to do, from what the server has.
 * @param {Inspection} facts
 * @param {{ profile: string, pluginVersion: string, dshTag?: string, sourceOverride?: 'official' | 'mirror' }} options
 * @returns {InstallPlan}
 */
export function planInstall(facts, options) {
  const tag = DSH_TAGS.includes(options.dshTag ?? '') ? /** @type {string} */ (options.dshTag) : 'latest'
  /** @type {InstallStep[]} */
  const steps = []
  /** @type {string[]} */
  const blockers = []
  /** @type {string[]} */
  const notes = []
  const sourceKey = options.sourceOverride ?? facts.source
  const source = sourceKey === undefined ? undefined : SOURCES[sourceKey]

  if (!facts.linux) blockers.push('只支持 Linux 服务器。')
  // Always the managed Node, even when PATH has a usable one: `npm -g` into a
  // system Node would write outside the home directory.
  const needsNode = !facts.managedNode
  if (needsNode) {
    if (facts.arch === '') blockers.push('不支持这台服务器的 CPU 架构（只支持 x86_64 和 aarch64）。')
    for (const tool of /** @type {const} */ (['curl', 'tar', 'xz', 'sha256sum'])) {
      if (!facts.tools[tool]) blockers.push(`服务器上缺少 ${tool}，无法下载安装 Node.js。`)
    }
  }
  if (source === undefined) blockers.push('服务器既连不上官方 npm 源，也连不上国内镜像，无法下载。')
  if (facts.dsh !== '' && !facts.dshManaged) {
    notes.push(`服务器上的 dsh 不是本应用管理的安装（${facts.dsh}），不会去改动它；如需升级请自行处理。`)
  }
  if (blockers.length > 0 || source === undefined) return { steps: [], blockers, notes }

  const bin = '$HOME/.local/opt/node/bin'
  if (needsNode) {
    steps.push({
      id: 'node',
      title: `安装 Node.js ${String(NODE_MAJOR)}`,
      detail: `从${source.label}下载官方 Node.js ${String(NODE_MAJOR)}.x（linux-${facts.arch}），校验 SHA-256 后解压到 ~/.local/opt/。${facts.node === undefined ? '服务器上没有满足 DSH 要求（^22.19 或 ≥24）的 Node。' : `服务器上已有的 ${facts.node.path} 不在家目录里，npm 全局安装会写到家目录之外，所以另装一份。`}系统里原有的 Node 不会被改动。`,
      command: `curl -fsSL ${source.node}/v${String(NODE_MAJOR)}.x.y/node-v…-linux-${facts.arch}.tar.xz → sha256sum -c → tar -xJf → ln -sfn node-v… ~/.local/opt/node`,
    })
  }
  const managedPnpm = facts.pnpm === `${facts.home}/.local/opt/node/bin/pnpm`
  if (needsNode || !managedPnpm) {
    steps.push({
      id: 'pnpm',
      title: '安装 pnpm',
      detail: 'DSH 用 pnpm 管理 profile 里的插件（dsh plugin add）。',
      command: `PATH=${bin}:$PATH npm install -g ${PNPM_SPEC} --registry ${source.registry}`,
    })
  }
  // A dsh this installer does not manage is left alone, and not duplicated.
  const dshMissing = facts.dsh === ''
  const dshOutdated = facts.dshManaged && facts.dshAvailable !== '' && facts.dshVersion !== ''
    && compareVersions(facts.dshAvailable, facts.dshVersion) > 0
  if (dshMissing || dshOutdated) {
    steps.push({
      id: 'dsh',
      title: dshMissing ? `安装 DSH（${tag}${facts.dshAvailable === '' ? '' : `，${facts.dshAvailable}`}）` : `升级 DSH：${facts.dshVersion} → ${facts.dshAvailable}`,
      detail: dshMissing
        ? 'npm 全局安装官方包 @deepseek-ai/dsh，装在上面这个 Node 里，只写你的家目录。'
        : '升级后需要「重启远端」才会用上新版本。',
      command: `PATH=${bin}:$PATH npm install -g @deepseek-ai/dsh@${tag} --registry ${source.registry}`,
    })
  }
  const pluginOutdated = facts.plugin !== '' && compareVersions(options.pluginVersion, facts.plugin) > 0
  if (facts.plugin === '' || pluginOutdated) {
    steps.push({
      id: 'plugin',
      title: facts.plugin === '' ? `安装服务器插件 dsh-desktop-link ${options.pluginVersion}` : `升级服务器插件：${facts.plugin} → ${options.pluginVersion}`,
      detail: `上传插件包到 ~/.dsh/，再用 dsh plugin 装进 profile「${options.profile}」。装好后要启动（或重启）远端才会加载。`,
      command: `dsh plugin --profile ${options.profile} add ~/.dsh/dsh-desktop-link-${options.pluginVersion}.tgz`,
    })
  }
  if (facts.plugin !== '' && !pluginOutdated) notes.push(`服务器插件已是 ${facts.plugin}。`)
  if (facts.dshManaged && !dshOutdated && facts.dshVersion !== '') notes.push(`DSH 已是 ${facts.dshVersion}${facts.dshAvailable === '' ? '' : `（${tag} 渠道最新 ${facts.dshAvailable}）`}。`)
  return { steps, blockers, notes }
}

/**
 * The script for one step. Each is safe to run again: a finished part is
 * detected and skipped, and a half-written download never replaces a good one.
 * @param {InstallStep['id']} id
 * @param {{ profile: string, source: 'official' | 'mirror', arch?: string, dshTag?: string, pluginVersion?: string }} options
 * @returns {{ script: string, timeoutMs: number }}
 */
export function stepScript(id, options) {
  const source = SOURCES[options.source]
  if (source === undefined) throw new Error(`unknown source: ${String(options.source)}`)
  const path = `PATH=${NODE_BIN}:"$PATH"; export PATH`
  switch (id) {
    case 'node': {
      if (options.arch !== 'x64' && options.arch !== 'arm64') throw new Error('unsupported architecture')
      return {
        timeoutMs: 15 * 60_000,
        script: [
          'set -eu',
          'd="$HOME/.local/opt"; mkdir -p "$d"; cd "$d"',
          `base=${shq(source.node)}`,
          `v="$(curl -fsSL -m 60 "$base/index.json" | grep -o '"version":"v${String(NODE_MAJOR)}\\.[0-9]*\\.[0-9]*"' | head -n 1 | cut -d '"' -f 4)"`,
          '[ -n "$v" ] || { echo "could not find a Node.js release to install" >&2; exit 10; }',
          `name="node-$v-linux-${options.arch}"`,
          'echo "Node.js $v"',
          'if [ ! -x "$name/bin/node" ]; then',
          '  curl -fL --retry 2 -m 900 "$base/$v/$name.tar.xz" -o "$name.tar.xz.part"',
          '  curl -fsSL -m 60 "$base/$v/SHASUMS256.txt" -o "$name.sums.part"',
          '  sum="$(grep " $name.tar.xz\\$" "$name.sums.part" | cut -d " " -f 1)"',
          '  [ -n "$sum" ] || { echo "no checksum published for $name" >&2; exit 11; }',
          '  echo "$sum  $name.tar.xz.part" | sha256sum -c - >/dev/null || { echo "checksum mismatch; the download was discarded" >&2; rm -f "$name.tar.xz.part"; exit 12; }',
          '  rm -rf "$name.tmp"; mkdir "$name.tmp"',
          '  tar -xJf "$name.tar.xz.part" -C "$name.tmp"',
          '  mv "$name.tmp/$name" "$name"; rm -rf "$name.tmp" "$name.tar.xz.part" "$name.sums.part"',
          'fi',
          'ln -sfn "$name" node',
          '"$d/node/bin/node" --version',
        ].join('\n'),
      }
    }
    case 'pnpm':
      return {
        timeoutMs: 10 * 60_000,
        script: ['set -eu', path, `npm install -g ${PNPM_SPEC} --registry ${shq(source.registry)} --no-fund --no-audit`, 'pnpm --version'].join('\n'),
      }
    case 'dsh': {
      const tag = DSH_TAGS.includes(options.dshTag ?? '') ? options.dshTag : 'latest'
      return {
        timeoutMs: 20 * 60_000,
        script: [
          'set -eu',
          path,
          `npm install -g @deepseek-ai/dsh@${String(tag)} --registry ${shq(source.registry)} --no-fund --no-audit`,
          // npm 11 no longer runs dependencies' install scripts by default, and
          // they are left off here too. DSH's native modules ship prebuilt; the
          // one thing a skipped script did (dsh-subprocess-local's
          // ensure-spawn-helper) is restoring node-pty's helper's exec bit.
          'root="$(npm root -g)/@deepseek-ai/dsh"',
          'find "$root" -path "*node-pty*" -name spawn-helper -type f -exec chmod 755 {} + 2>/dev/null || true',
          'dsh --version',
        ].join('\n'),
      }
    }
    case 'plugin': {
      const version = options.pluginVersion ?? ''
      if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error('invalid plugin version')
      const file = `"$HOME/.dsh/dsh-desktop-link-${version}.tgz"`
      return {
        timeoutMs: 10 * 60_000,
        // The package arrives base64-encoded on stdin (see `pluginUploadInput`).
        script: [
          'set -eu',
          path,
          'mkdir -p "$HOME/.dsh"',
          `base64 -d > ${file}.part`,
          `mv ${file}.part ${file}`,
          `p="$(command -v dsh || true)"; [ -n "$p" ] || for c in ${NODE_BIN}/dsh "$HOME/.local/bin/dsh"; do [ -x "$c" ] && p="$c" && break; done`,
          '[ -n "$p" ] || { echo "dsh is not installed" >&2; exit 20; }',
          'PATH="$(dirname "$p"):$PATH"',
          `cd "$HOME/.dsh" && "$p" plugin --profile ${shq(options.profile)} add ${file} --registry ${shq(source.registry)}`,
          `v="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$HOME/.dsh/profiles"/${shq(options.profile)}/node_modules/dsh-desktop-link/package.json | head -n 1)"`,
          'echo "dsh-desktop-link $v"',
        ].join('\n'),
      }
    }
    default:
      throw new Error(`unknown step: ${String(id)}`)
  }
}

/**
 * The stdin for the plugin step: the package, base64 in 76-column lines.
 * @param {Buffer} tgz
 */
export function pluginUploadInput(tgz) {
  return `${tgz.toString('base64').replace(/.{76}/g, '$&\n')}\n`
}
