// Pure text for the status bar item and the desktop notification, without I/O.
// Only counts and cleaned workspace names go in, never file names or file contents.
import { cleanPath } from './git'
import { tr, type Lang } from './i18n'

export const BACKGROUND_MIN = 30
export const BACKGROUND_MAX = 600
/** Longest project or worktree name shown in the status bar tooltip and the notification */
export const MAX_LABEL_PART = 40
/** Worktrees named in the tooltip */
export const TOOLTIP_NAMES = 5
// Limits Orca puts on status bar items
const TEXT_MAX = 64
const TOOLTIP_MAX = 256
const BODY_MAX = 200

/** 0 = off, otherwise 30 to 600 seconds; null when the value is not a number */
export function clampBackground(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.round(value)
  return n <= 0 ? 0 : Math.min(BACKGROUND_MAX, Math.max(BACKGROUND_MIN, n))
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** "acme-shop / checkout": names are untrusted, so cleaned and cut */
export function label(project: string | null, name: string): string {
  const n = cut(cleanPath(name), MAX_LABEL_PART)
  const p = project ? cut(cleanPath(project), MAX_LABEL_PART) : null
  return p && p !== n ? `${p} / ${n}` : n
}

export type BarItem = {
  project: string | null
  name: string
  hidden: boolean
  /** Could not be checked (git error, not scanned yet) */
  unknown: boolean
  uncommitted: number
}
export type Bar = { text: string; tone: 'neutral' | 'success' | 'warning'; tooltip: string }

/** Status bar item for the local worktrees; hidden ones do not count, unknown ones are never "ok" */
export function statusBar(items: readonly BarItem[], lang: Lang = 'en'): Bar {
  const shown = items.filter((i) => !i.hidden)
  const unknown = shown.filter((i) => i.unknown).length
  const open = shown.filter((i) => !i.unknown && i.uncommitted > 0).sort((a, b) => b.uncommitted - a.uncommitted)
  if (shown.length > 0 && unknown === shown.length) {
    return { text: tr(lang, 'bar.unknownAll'), tone: 'neutral', tooltip: tr(lang, 'bar.tip.unknownAll') }
  }
  if (open.length > 0) {
    const names = open.slice(0, TOOLTIP_NAMES).map((i) => `${label(i.project, i.name)} (${i.uncommitted})`)
    if (open.length > TOOLTIP_NAMES) names.push(tr(lang, 'bar.tip.more', { n: open.length - TOOLTIP_NAMES }))
    return {
      text: cut(tr(lang, 'bar.open', { n: open.length }), TEXT_MAX),
      tone: 'warning',
      tooltip: cut(tr(lang, 'bar.tip.open', { names: names.join(', ') }), TOOLTIP_MAX)
    }
  }
  if (unknown > 0) {
    return { text: cut(tr(lang, 'bar.unchecked', { n: unknown }), TEXT_MAX), tone: 'neutral', tooltip: cut(tr(lang, 'bar.tip.unchecked', { n: unknown }), TOOLTIP_MAX) }
  }
  return { text: tr(lang, 'bar.ok'), tone: 'success', tooltip: tr(lang, 'bar.tip.ok') }
}

/**
 * "acme-shop / checkout: agent finished, 3 files uncommitted, 1 commit unpushed, 1 sensitive file"; null when there
 * is nothing open. Sensitive files are only added to open work: a secret that is tracked already is no news.
 */
export function agentDoneText(
  s: { project: string | null; name: string; uncommitted: number; untracked: number; ahead: number; sensitiveSecrets?: number },
  lang: Lang = 'en'
): string | null {
  const parts: string[] = []
  if (s.uncommitted > 0) parts.push(tr(lang, 'notify.uncommitted', { n: s.uncommitted }))
  if (s.untracked > 0) parts.push(tr(lang, 'notify.untracked', { n: s.untracked }))
  if (s.ahead > 0) parts.push(tr(lang, 'notify.unpushed', { n: s.ahead }))
  if (parts.length === 0) return null
  const secrets = s.sensitiveSecrets ?? 0
  if (secrets > 0) parts.push(tr(lang, 'notify.sensitive', { n: secrets }))
  return cut(tr(lang, 'notify.done', { label: label(s.project, s.name), parts: parts.join(', ') }), BODY_MAX)
}
