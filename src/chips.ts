// Short labels for a row of the panel, derived from the numbers of a session (pure, no panel code)
import { errorText, tr, type Lang, type MsgKey } from './i18n'
import type { PullRequest, Session } from './protocol'

/** Red is kept for what is really wrong (conflict, merge or rebase running, a secret). Open work is calm: blue and amber. */
export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type Chip = { text: string; tone: ChipTone }

/** Group of the list a session belongs to; the order is the order on screen */
export type Group = 'dirty' | 'keep' | 'check' | 'safe' | 'unknown'
export const GROUPS: readonly Group[] = ['dirty', 'keep', 'check', 'safe', 'unknown']
const GROUP_KEY: Record<Group, MsgKey> = {
  dirty: 'group.dirty',
  keep: 'group.keep',
  check: 'group.check',
  safe: 'group.safe',
  unknown: 'group.unknown'
}
export function groupTitle(group: Group, lang: Lang = 'en'): string {
  return tr(lang, GROUP_KEY[group] ?? 'group.unknown')
}

export function groupOf(s: Pick<Session, 'uncommitted' | 'verdict'>): Group {
  if (s.uncommitted > 0) return 'dirty'
  return s.verdict
}

/** The things worth a glance, red first. A clean worktree gets one green "clean" chip. */
export function chips(s: Session, lang: Lang = 'en'): Chip[] {
  const out: Chip[] = []
  const add = (key: MsgKey, tone: ChipTone, params?: Record<string, string | number>) => out.push({ text: tr(lang, key, params), tone })
  if (s.uncommitted > 0) add('chip.changed', 'accent', { n: s.uncommitted })
  if (s.conflicts > 0) add('chip.conflicts', 'danger', { n: s.conflicts })
  if (s.ahead > 0 && s.merged !== true) add('chip.unpushed', 'warning', { n: s.ahead })
  if (s.agent === 'working') add('chip.agentWorking', 'accent')
  if (s.agent === 'permission') add('chip.agentWaits', 'warning')
  // The operation is one of git's fixed names (merge, rebase, ...), inserted as text
  if (s.operation) add('chip.operation', 'danger', { op: s.operation })
  // A file named like a secret is the one thing that is red without being a git operation
  const tracked = s.sensitiveTracked ?? 0
  const loose = (s.sensitiveSecrets ?? 0) - tracked
  if (loose > 0) add('chip.sensitive', 'danger', { n: loose })
  if (tracked > 0) add('chip.secretInRepo', 'warning', { n: tracked })
  if ((s.sensitiveCount ?? 0) > (s.sensitiveSecrets ?? 0)) add('chip.junk', 'warning')
  if (s.untracked > 0) add('chip.untracked', 'neutral', { n: s.untracked })
  if (s.stash > 0) add('chip.stash', 'neutral', { n: s.stash })
  // Why a worktree without upstream or with local commits can still be closed
  if (!s.error && s.merged === true && (s.ahead > 0 || !s.upstream || s.upstreamGone) && s.uncommitted === 0) add('chip.merged', 'success')
  if (!s.error) {
    const detached = s.branch === null
    if (detached && s.merged !== true) add('chip.detached', 'neutral')
    else if (!detached && s.upstreamGone && s.merged !== true) add('chip.upstreamGone', 'warning')
    else if (!detached && !s.upstream && s.merged !== true) add('chip.noUpstream', 'neutral')
    if (s.submodules) add('chip.submodules', 'neutral')
    if (s.behind > 0) add('chip.behind', 'neutral', { n: s.behind })
  }
  if (s.error) out.push({ text: s.errorCode ? tr(lang, s.errorCode) : errorText(lang, s.error), tone: 'neutral' })
  else if (s.reasons.includes('agent status unknown')) add('chip.agentUnknown', 'neutral')
  if (out.length === 0) add('chip.clean', 'success')
  // After "clean": a pull request says nothing about the files, a clean worktree keeps its green chip
  if (s.pr) add(PR_CHIP[s.pr.state][0], PR_CHIP[s.pr.state][1], { n: s.pr.number })
  return out
}

const PR_CHIP: Record<PullRequest['state'], [MsgKey, ChipTone]> = {
  open: ['chip.prOpen', 'accent'],
  draft: ['chip.prDraft', 'neutral'],
  merged: ['chip.prMerged', 'success'],
  closed: ['chip.prClosed', 'neutral']
}

/** Git's two-letter code (X = index, Y = worktree) as a word: "??" is a new file, ".M" an edited one */
export function stateLabel(code: string, lang: Lang = 'en'): string {
  if (code === '??') return tr(lang, 'file.new')
  if (code.length !== 2) return code
  const [x, y] = code
  if (x === 'U' || y === 'U' || code === 'AA' || code === 'DD') return tr(lang, 'file.conflict')
  const word = (c: string): string => {
    const key: MsgKey | null = c === 'M' ? 'file.edited' : c === 'A' ? 'file.added' : c === 'D' ? 'file.deleted' : c === 'R' ? 'file.renamed' : c === 'C' ? 'file.copied' : c === 'T' ? 'file.typeChanged' : null
    return key ? tr(lang, key) : ''
  }
  const staged = word(x)
  const open = word(y)
  if (staged && open) return tr(lang, 'file.stagedAndOpen', { what: staged, open })
  if (staged) return tr(lang, 'file.staged', { what: staged })
  return open || code
}
