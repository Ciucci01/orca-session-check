// Short labels for a row of the panel, derived from the numbers of a session (pure, no panel code)
import type { Session } from './protocol'

/** Red is kept for what is really wrong (conflict, merge or rebase running). Open work is calm: blue and amber. */
export type ChipTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type Chip = { text: string; tone: ChipTone }

/** Group of the list a session belongs to; the order is the order on screen */
export type Group = 'dirty' | 'keep' | 'check' | 'safe' | 'unknown'
export const GROUPS: readonly Group[] = ['dirty', 'keep', 'check', 'safe', 'unknown']
export const GROUP_TITLE: Record<Group, string> = {
  dirty: 'Uncommitted files',
  keep: 'Keep open',
  check: 'Check first',
  safe: 'Can close',
  unknown: 'Not checked'
}

export function groupOf(s: Pick<Session, 'uncommitted' | 'verdict'>): Group {
  if (s.uncommitted > 0) return 'dirty'
  return s.verdict
}

/** The things worth a glance, red first. A clean worktree gets one green "clean" chip. */
export function chips(s: Session): Chip[] {
  const out: Chip[] = []
  if (s.uncommitted > 0) out.push({ text: `${s.uncommitted} changed`, tone: 'accent' })
  if (s.conflicts > 0) out.push({ text: `${s.conflicts} ${s.conflicts === 1 ? 'conflict' : 'conflicts'}`, tone: 'danger' })
  if (s.ahead > 0 && s.merged !== true) out.push({ text: `${s.ahead} unpushed`, tone: 'warning' })
  if (s.agent === 'working') out.push({ text: 'agent working', tone: 'accent' })
  if (s.agent === 'permission') out.push({ text: 'agent waits', tone: 'warning' })
  if (s.operation) out.push({ text: s.operation, tone: 'danger' })
  if (s.untracked > 0) out.push({ text: `${s.untracked} untracked`, tone: 'neutral' })
  if (s.stash > 0) out.push({ text: `${s.stash} stash`, tone: 'neutral' })
  // Why a worktree without upstream or with local commits can still be closed
  if (!s.error && s.merged === true && (s.ahead > 0 || !s.upstream || s.upstreamGone) && s.uncommitted === 0) out.push({ text: 'merged', tone: 'success' })
  if (!s.error) {
    const detached = s.branch === null
    if (detached && s.merged !== true) out.push({ text: 'detached', tone: 'neutral' })
    else if (!detached && s.upstreamGone && s.merged !== true) out.push({ text: 'upstream gone', tone: 'warning' })
    else if (!detached && !s.upstream && s.merged !== true) out.push({ text: 'no upstream', tone: 'neutral' })
    if (s.submodules) out.push({ text: 'submodules not checked', tone: 'neutral' })
    if (s.behind > 0) out.push({ text: `${s.behind} behind`, tone: 'neutral' })
  }
  if (s.error) out.push({ text: s.error, tone: 'neutral' })
  else if (s.reasons.includes('agent status unknown')) out.push({ text: 'agent unknown', tone: 'neutral' })
  if (out.length === 0) out.push({ text: 'clean', tone: 'success' })
  return out
}

/** Git's two-letter code (X = index, Y = worktree) as a word: "??" is a new file, ".M" an edited one */
export function stateLabel(code: string): string {
  if (code === '??') return 'new'
  if (code.length !== 2) return code
  const [x, y] = code
  if (x === 'U' || y === 'U' || code === 'AA' || code === 'DD') return 'conflict'
  const word = (c: string) => (c === 'M' ? 'edited' : c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === 'R' ? 'renamed' : c === 'C' ? 'copied' : c === 'T' ? 'type changed' : '')
  const staged = word(x)
  const open = word(y)
  if (staged && open) return `${staged}, staged + ${open}`
  if (staged) return `${staged}, staged`
  return open || code
}
