/**
 * Which session events become "a task finished" on the desktop link's feed.
 *
 * The harness publishes every appended session event on `session/event`
 * (upstream packages/core/session). A turn is one run of the agent loop; its
 * `turn/end` event says why it ended. That is the moment worth a desktop
 * notification — but only for the sessions a person started: subagent
 * children end many turns inside one parent turn and would drown it out.
 *
 * Only ids, the title and the end reason leave this module: never message
 * content, which a notification on a shared screen should not show.
 *
 * @module dsh-desktop-link/activity
 */

/** Turn endings the person wants to hear about. A cancel is their own doing. */
const NOTIFY = new Map([
  ['completed', 'completed'],
  ['max-tokens', 'completed'],
  ['error', 'error'],
  ['blocked', 'blocked'],
])

/** Titles are remembered per session; this bounds the memory. */
const MAX_TITLES = 200
/** Longest title passed on. */
const MAX_TITLE = 120

/**
 * @param {(item: Record<string, unknown>) => void} publish the feed's publish.
 * @returns {(session: any, event: any) => void} the `session/event` listener.
 */
export function createActivityWatcher(publish) {
  /** @type {Map<string, string>} */
  const titles = new Map()

  return (session, event) => {
    if (typeof event !== 'object' || event === null) return
    const header = session?.header ?? {}
    const id = typeof session?.id === 'string' ? session.id : typeof header.id === 'string' ? header.id : undefined
    if (id === undefined) return

    if (event.type === 'session/title') {
      const title = event.data?.title
      if (typeof title !== 'string') return
      titles.delete(id)
      titles.set(id, title.trim().slice(0, MAX_TITLE))
      if (titles.size > MAX_TITLES) titles.delete(titles.keys().next().value)
      return
    }
    if (event.type !== 'turn/end') return
    if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) return
    const outcome = NOTIFY.get(event.data?.reason?.kind)
    if (outcome === undefined) return
    publish({
      sessionId: id,
      title: titles.get(id) ?? '',
      outcome,
      at: typeof event.time === 'number' ? event.time : Date.now(),
    })
  }
}
