/**
 * Studio announcements are intentionally disabled: they are upstream product
 * notices (often about updater bugs) and must not interrupt this deployment.
 * Keep the endpoint contract so older clients simply receive an empty list.
 */
export async function fetchStudioAnnouncements(_localeInput: unknown): Promise<unknown> {
  return { ok: true, platform: 'desktop', list: [] }
}
