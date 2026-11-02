/**
 * Where a MedHealthBuddy build fetches its own releases and runtime assets.
 *
 * The upstream Ekko Studio hosts are deliberately *not* used as defaults: they
 * serve Ekko artefacts, so auto-updating from them (or downloading their
 * runtime) would replace this build with a differently branded app. Nothing is
 * fetched unless a build opts in, either through the packaged `desktopUpdate`
 * metadata (test channel, see updater-source.ts) or the environment:
 *
 *   MEDHEALTHBUDDY_UPDATE_FEED            generic feed directory for auto-update
 *   MEDHEALTHBUDDY_UPDATE_FALLBACK_FEED   optional second feed, tried on failure
 *   MEDHEALTHBUDDY_RUNTIME_BASE_URL       runtime asset base URL; may contain
 *                                         {tag} and {asset} placeholders
 *   MEDHEALTHBUDDY_RUNTIME_REPO           GitHub owner/repo for runtime assets
 *
 * The legacy HERMES_DESKTOP_RUNTIME_* names keep working for existing
 * automation, but values pointing at the upstream project are refused.
 */

const UPDATE_FEED_ENV = 'MEDHEALTHBUDDY_UPDATE_FEED'
const UPDATE_FALLBACK_FEED_ENV = 'MEDHEALTHBUDDY_UPDATE_FALLBACK_FEED'
const RUNTIME_BASE_URL_ENV = 'MEDHEALTHBUDDY_RUNTIME_BASE_URL'
const RUNTIME_REPO_ENV = 'MEDHEALTHBUDDY_RUNTIME_REPO'
const LEGACY_RUNTIME_BASE_URL_ENV = 'HERMES_DESKTOP_RUNTIME_BASE_URL'
const LEGACY_RUNTIME_REPO_ENV = 'HERMES_DESKTOP_RUNTIME_REPO'

const LEGACY_HOST = 'download.ekkolearnai.com'
const LEGACY_GITHUB_OWNER = 'ekkolearnai'
const LEGACY_GITHUB_REPO = 'ekko-studio'
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * True for a URL that serves the upstream Ekko Studio releases (the CDN, or the
 * project's own release assets). The project's dedicated update-test repository
 * is not a production release host and stays allowed.
 */
export function isLegacyUpstreamUrl(value: string): boolean {
  const probe = value.trim().replace(/\{[a-z]+\}/gi, 'x')
  let url: URL
  try {
    url = new URL(probe)
  } catch {
    return false
  }
  if (url.hostname.toLowerCase() === LEGACY_HOST) return true
  if (url.hostname.toLowerCase() !== 'github.com') return false
  const path = url.pathname.toLowerCase()
  return path === `/${LEGACY_GITHUB_OWNER}/${LEGACY_GITHUB_REPO}`
    || path.startsWith(`/${LEGACY_GITHUB_OWNER}/${LEGACY_GITHUB_REPO}/`)
}

/** True for the upstream project's own `owner/repo`. */
export function isLegacyUpstreamRepo(value: string): boolean {
  return value.trim().toLowerCase() === `${LEGACY_GITHUB_OWNER}/${LEGACY_GITHUB_REPO}`
}

function readUrl(name: string): string | null {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw.replace(/\{[a-z]+\}/gi, 'x'))
  } catch {
    console.warn(`[release] ${name} is not a URL: ${raw}`)
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    console.warn(`[release] ${name} must be an http(s) URL: ${raw}`)
    return null
  }
  if (isLegacyUpstreamUrl(raw)) {
    console.warn(`[release] ${name} points at the upstream Ekko Studio project and is ignored: ${raw}`)
    return null
  }
  return raw
}

function readRepo(name: string): string | null {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  if (!REPO_PATTERN.test(raw)) {
    console.warn(`[release] ${name} must look like "owner/repo": ${raw}`)
    return null
  }
  if (isLegacyUpstreamRepo(raw)) {
    console.warn(`[release] ${name} points at the upstream Ekko Studio project and is ignored: ${raw}`)
    return null
  }
  return raw
}

/**
 * The auto-update feed a build configured for itself, or null when it has none
 * (the default), in which case no update request is ever made.
 */
export function resolveUpdateFeed(): { url: string; fallbackUrl: string | null } | null {
  const url = readUrl(UPDATE_FEED_ENV)
  if (!url) return null
  return {
    url: url.replace(/\/+$/, ''),
    fallbackUrl: readUrl(UPDATE_FALLBACK_FEED_ENV),
  }
}

/** Base URL for runtime archives, or null when on-demand runtime downloads are off. */
export function resolveRuntimeBaseUrl(): string | null {
  return readUrl(RUNTIME_BASE_URL_ENV) ?? readUrl(LEGACY_RUNTIME_BASE_URL_ENV)
}

/** GitHub `owner/repo` hosting runtime archives, or null when that source is off. */
export function resolveRuntimeRepo(): string | null {
  return readRepo(RUNTIME_REPO_ENV) ?? readRepo(LEGACY_RUNTIME_REPO_ENV)
}
