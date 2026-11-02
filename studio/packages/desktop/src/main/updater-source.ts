import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLegacyUpstreamUrl, resolveUpdateFeed } from './release-sources'

export function desktopUpdateChannel(platform = process.platform, arch = process.arch): string {
  return platform === 'win32' && arch === 'arm64' ? 'latest-arm64' : 'latest'
}

export type DesktopUpdateSource =
  | { channel: 'stable'; url: string; fallbackUrl: string | null }
  | { channel: 'test'; url: string }

export function validateTestUpdateUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error('A test update feed directory URL is required')
  }
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Invalid test update feed URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Test update feeds require HTTPS without credentials, query parameters or fragments')
  }
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase()
  if (path.endsWith('.yml') || path.endsWith('.yaml')) {
    throw new Error('Use the feed directory URL, not the update manifest URL')
  }
  if (isLegacyUpstreamUrl(value.trim())) {
    throw new Error('The production update source cannot be used for test builds')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.href
}

/**
 * Null means this build has no update feed: `MEDHEALTHBUDDY_UPDATE_FEED` is
 * unset and the package metadata selects no test feed, so no update request is
 * made at all. Production feeds are never guessed, which is what used to point
 * this app at the upstream Ekko Studio releases.
 */
export function resolveDesktopUpdateSource(metadata: unknown): DesktopUpdateSource | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid desktop package metadata')
  }
  // Only package metadata can select a test feed. No runtime environment or UI
  // setting can switch a production installation to a test server.
  if (!Object.prototype.hasOwnProperty.call(metadata, 'desktopUpdate')) {
    const feed = resolveUpdateFeed()
    return feed ? { channel: 'stable', url: feed.url, fallbackUrl: feed.fallbackUrl } : null
  }
  const config = (metadata as { desktopUpdate: unknown }).desktopUpdate
  if (!config || typeof config !== 'object' || !('channel' in config) || config.channel !== 'test' || !('url' in config)) {
    throw new Error('Invalid packaged test update configuration; refusing to use production feeds')
  }
  return { channel: 'test', url: validateTestUpdateUrl(config.url) }
}

export function readDesktopUpdateSource(appPath: string): DesktopUpdateSource | null {
  // Read/parse errors deliberately propagate: broken test metadata must not
  // silently turn a test installation back into a production installation.
  return resolveDesktopUpdateSource(JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')))
}
