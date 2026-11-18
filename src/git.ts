// Pure git logic: arguments, parsers and the verdict. No I/O, so it is fully testable.
import type { AgentState, FileEntry, SensitiveFile, Verdict } from './protocol'
import { classify } from './sensitive'

export const MAX_FILES = 20
export const MAX_PATH_LENGTH = 300
/** Tracked changes whose time stamp is read (age of the oldest change) */
export const MAX_STAT_PATHS = 200
export const MAX_SUBJECTS = 3
/** Files that must not be committed, listed per worktree */
export const MAX_SENSITIVE = 10
const MAX_SUBJECT_LENGTH = 100

/**
 * Flags for every git call. A repository is not trusted: its config can start programs
 * (core.fsmonitor), so this plugin switches that off. filter.<name>.clean/smudge/process
 * cannot be switched off with a fixed flag, see `filterOverrides`.
 */
export const GIT_FLAGS: readonly string[] = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.untrackedCache=false',
  // .gitattributes of the worktree must not pick a filter (see GIT_ATTR_SOURCE in gitEnv)
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'status.showUntrackedFiles=normal',
  // A signature check starts gpg.program of the repository (log, stash list)
  '-c', 'log.showSignature=false',
  // A partial clone fetches missing objects by itself: that starts uploadpack or ssh commands and is network
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ssh.allow=never',
  '-c', 'protocol.git.allow=never',
  '-c', 'protocol.http.allow=never',
  '-c', 'protocol.https.allow=never',
  '-c', 'protocol.ext.allow=never'
]

/** Arguments of `git config` that list the names of all filter drivers (reads only) */
export const FILTER_LIST_ARGS: readonly string[] = [
  'config', '-z', '--name-only', '--get-regexp',
  '^(filter\\..*\\.(clean|smudge|process)|extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$'
]

const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/i
// The key goes into `-c key=`: no "=", no control characters, no spaces
const SAFE_KEY = /^[\x21-\x3c\x3e-\x7e]+$/

const PARTIAL_KEY = /^(extensions\.partialclone|remote\..+\.(promisor|partialclonefilter))$/i

export type FilterOverrides = {
  /** A partial clone (missing objects are fetched on demand): such a repository is not scanned */
  partial: boolean
  /** `-c` pairs that empty every filter command and the "required" flag */
  args: string[]
  /** A driver name that cannot be passed safely: the repository must not be scanned */
  unsafe: boolean
}

/** Turns the output of FILTER_LIST_ARGS into `-c filter.x.clean=` style overrides */
export function filterOverrides(listOutput: string): FilterOverrides {
  const drivers = new Set<string>()
  let unsafe = false
  let partial = false
  for (const key of listOutput.split(/[\0\n]/)) {
    if (!key) continue
    if (PARTIAL_KEY.test(key)) partial = true
    const m = FILTER_KEY.exec(key)
    if (!m) continue
    if (!SAFE_KEY.test(key)) {
      unsafe = true
      continue
    }
    drivers.add(m[1])
  }
  const args: string[] = []
  for (const name of drivers) {
    for (const part of ['clean', 'smudge', 'process']) args.push('-c', `filter.${name}.${part}=`)
    args.push('-c', `filter.${name}.required=false`)
  }
  return { args, unsafe, partial }
}

/** Full argument list for one git call in `path` */
export function gitArgs(path: string, overrides: readonly string[], sub: readonly string[]): string[] {
  return [...GIT_FLAGS, ...overrides, '-C', path, ...sub]
}

/** A workspace path must be absolute, plain and must not look like an option */
export function isSafePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length < 4096 && path.startsWith('/') && !path.includes('\0')
}

/** A ref given by the person (setting) before it goes to git */
export function isSafeRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..')
}

export const STATUS_ARGS: readonly string[] = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']

export type StatusInfo = {
  oid: string | null
  head: string | null
  detached: boolean
  upstream: string | null
  hasAheadBehind: boolean
  /** An upstream is configured but its branch is gone (no ahead/behind): the commits may exist only here */
  upstreamGone: boolean
  ahead: number
  behind: number
  uncommitted: number
  staged: number
  untracked: number
  conflicts: number
  files: FileEntry[]
  moreFiles: number
  /** Paths of tracked changes that still exist in the worktree (for their time stamps) */
  statPaths: string[]
  /** Every entry whose name must not be committed, from all of the output (not only the listed files), raw paths */
  findings: SensitiveFile[]
}

/** Control and bidi characters in a name (a new line is legal in git) must not reach the panel as layout or spoof it */
// Built from a string: a literal line separator inside a regex literal is a syntax error
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]', 'g')

export function cleanPath(path: string): string {
  const flat = path.replace(CONTROL_CHARS, '?')
  return flat.length > MAX_PATH_LENGTH ? `${flat.slice(0, MAX_PATH_LENGTH)}…` : flat
}

/** Parses `git status --porcelain=v2 --branch -z` */
export function parseStatus(out: string): StatusInfo {
  const info: StatusInfo = {
    oid: null, head: null, detached: false, upstream: null, hasAheadBehind: false, upstreamGone: false, ahead: 0, behind: 0,
    uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, files: [], moreFiles: 0, statPaths: [], findings: []
  }
  const parts = out.split('\0')
  const addFile = (state: string, path: string) => {
    // Names are judged before the list is cut; a deleted file is gone from the worktree, that is the fix
    if (!state.includes('D')) {
      const untracked = state === '??'
      const m = classify(path, { untracked })
      if (m) info.findings.push({ path, kind: m.kind, rule: m.rule, tracked: !untracked })
    }
    if (info.files.length < MAX_FILES) info.files.push({ state, path: cleanPath(path) })
    else info.moreFiles++
  }
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') info.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') {
        info.detached = value === '(detached)'
        info.head = info.detached ? null : value
      } else if (key === 'branch.upstream') info.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          info.hasAheadBehind = true
          info.ahead = Number(m[1])
          info.behind = Number(m[2])
        }
      }
    } else if (line.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const f = splitFields(line, 8)
      if (!f) continue
      track(info, f.fields[1])
      addFile(f.fields[1], f.rest)
      addStat(info, f.fields[1], f.rest)
    } else if (line.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const f = splitFields(line, 9)
      if (!f) continue
      i++ // the original path is the next entry
      track(info, f.fields[1])
      addFile(f.fields[1], f.rest)
      addStat(info, f.fields[1], f.rest)
    } else if (line.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = splitFields(line, 10)
      if (!f) continue
      info.uncommitted++
      info.conflicts++
      addFile(f.fields[1], f.rest)
    } else if (line.startsWith('? ')) {
      info.untracked++
      addFile('??', line.slice(2))
    }
  }
  info.upstreamGone = info.upstream !== null && !info.hasAheadBehind
  return info
}

function splitFields(line: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = []
  let pos = 0
  for (let n = 0; n < count; n++) {
    const next = line.indexOf(' ', pos)
    if (next < 0) return null
    fields.push(line.slice(pos, next))
    pos = next + 1
  }
  return { fields, rest: line.slice(pos) }
}

/** Only a path that stays inside the worktree and still exists (not deleted) is read later */
function addStat(info: StatusInfo, xy: string, path: string): void {
  if (xy.includes('D') || info.statPaths.length >= MAX_STAT_PATHS) return
  if (!path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) return
  info.statPaths.push(path)
}

function track(info: StatusInfo, xy: string): void {
  info.uncommitted++
  if (xy[0] && xy[0] !== '.') info.staged++
}

/**
 * Parses `git ls-files --stage -z` ("<mode> <object> <stage>\t<path>"): whether a gitlink (submodule) is in the
 * index, and the tracked files whose name is a secret. Junk is not reported for tracked files.
 */
export function parseIndex(out: string): { gitlinks: boolean; gitmodules: boolean; secrets: SensitiveFile[] } {
  let gitlinks = false
  let gitmodules = false
  const seen = new Set<string>()
  const secrets: SensitiveFile[] = []
  for (const entry of out.split('\0')) {
    if (!entry) continue
    if (entry.startsWith('160000 ')) gitlinks = true
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const path = entry.slice(tab + 1)
    if (path === '.gitmodules') gitmodules = true
    const m = classify(path)
    // A conflict lists one path up to three times (stages 1 to 3)
    if (m?.kind !== 'secret' || seen.has(path)) continue
    seen.add(path)
    secrets.push({ path, kind: 'secret', rule: m.rule, tracked: true })
  }
  return { gitlinks, gitmodules, secrets }
}

export type SensitiveSummary = { sensitive: SensitiveFile[]; sensitiveCount: number; sensitiveSecrets: number; sensitiveTracked: number }

const sensitiveRank = (f: SensitiveFile) => (f.kind === 'secret' ? (f.tracked ? 0 : 1) : 2)

/** One entry per path, tracked secrets first, then new secrets, then junk; the list is cut, the counts are not */
export function summarizeSensitive(findings: readonly SensitiveFile[]): SensitiveSummary {
  const byPath = new Map<string, SensitiveFile>()
  for (const f of findings) {
    const prev = byPath.get(f.path)
    if (!prev || sensitiveRank(f) < sensitiveRank(prev)) byPath.set(f.path, f)
  }
  const all = [...byPath.values()].sort((a, b) => sensitiveRank(a) - sensitiveRank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  let secrets = 0
  let tracked = 0
  for (const f of all) {
    if (f.kind !== 'secret') continue
    secrets++
    if (f.tracked) tracked++
  }
  return {
    sensitive: all.slice(0, MAX_SENSITIVE).map((f) => ({ path: cleanPath(f.path), kind: f.kind, tracked: f.tracked, rule: f.rule })),
    sensitiveCount: all.length,
    sensitiveSecrets: secrets,
    sensitiveTracked: tracked
  }
}

/** `git log -1 --format=%ct`: seconds since the epoch to milliseconds, null for anything else */
export function parseCommitTime(out: string): number | null {
  const m = /^(\d{1,12})\s*$/.exec(out)
  return m ? Number(m[1]) * 1000 : null
}

/** `git diff --shortstat HEAD`: " 3 files changed, 120 insertions(+), 30 deletions(-)" */
export function parseShortstat(out: string): { added: number; removed: number } | null {
  const text = out.trim()
  if (!text) return { added: 0, removed: 0 }
  if (!/^\d+ files? changed/.test(text)) return null
  const add = /(\d+) insertions?\(\+\)/.exec(text)
  const del = /(\d+) deletions?\(-\)/.exec(text)
  return { added: add ? Number(add[1]) : 0, removed: del ? Number(del[1]) : 0 }
}

/** Commit subjects (NUL separated) as short plain text */
export function parseSubjects(out: string): string[] {
  const list: string[] = []
  for (const raw of out.split('\0')) {
    const subject = cleanPath(raw.trim()).slice(0, MAX_SUBJECT_LENGTH)
    if (subject) list.push(subject)
    if (list.length >= MAX_SUBJECTS) break
  }
  return list
}

/** The upstream name from git goes into a revision range: only plain ref names */
export function isSafeUpstream(ref: unknown): ref is string {
  return typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..')
}

export type StashCounts = { total: number; byBranch: Map<string, number> }

/** Parses `git stash list --format=%gs` ("WIP on <branch>: ...", "On <branch>: <message>") */
export function parseStash(out: string): StashCounts {
  const byBranch = new Map<string, number>()
  let total = 0
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    total++
    const m = /^(?:WIP on|On) (.+?): /.exec(line)
    if (m) byBranch.set(m[1], (byBranch.get(m[1]) ?? 0) + 1)
  }
  return { total, byBranch }
}

/** Marker files in the git dir (a worktree has its own) that tell an operation is running */
export function operationFrom(entries: readonly string[]): string | null {
  const has = (n: string) => entries.includes(n)
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  if (has('BISECT_LOG')) return 'bisect'
  return null
}

/**
 * Base branch candidates as full ref names, the first that exists wins. A short name like
 * `origin/main` can also be a local branch or a tag, and git prefers those: a branch named
 * "origin/main" on HEAD would make everything look merged. So only full refs/remotes names.
 */
export function baseCandidates(setting: string, originHead: string | null): string[] {
  const out: string[] = []
  // Only remote-tracking refs: a local branch moves with your own commits (a local main that is not pushed
  // would make everything look merged)
  if (isSafeRef(setting)) {
    if (setting.startsWith('refs/remotes/')) out.push(setting)
    else if (!setting.startsWith('refs/')) out.push(`refs/remotes/${setting}`)
  }
  if (originHead && /^refs\/remotes\/[A-Za-z0-9._/-]+$/.test(originHead) && !originHead.includes('..')) out.push(originHead)
  out.push('refs/remotes/origin/main', 'refs/remotes/origin/master')
  return [...new Set(out)]
}

export type VerdictInput = {
  uncommitted: number
  staged: number
  untracked: number
  conflicts: number
  ahead: number
  upstream: string | null
  detached: boolean
  stash: number
  merged: boolean | null
  operation: string | null
  agent: AgentState | null
  /** Agent status could not be read (the host truncated it) */
  agentUnknown?: boolean
  /** The upstream branch is gone */
  upstreamGone?: boolean
  /** The repository has submodules, their changes are not looked at */
  submodules?: boolean
  /** Files named like secrets (keys, .env, ...), and how many of them are tracked already */
  secrets?: number
  trackedSecrets?: number
  /** Files that do not belong in git (node_modules, .DS_Store, new archives) */
  junk?: number
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The traffic light. When in doubt, stricter: better yellow or red than green too early. */
export function verdict(i: VerdictInput): { verdict: Verdict; reasons: string[] } {
  const keep: string[] = []
  const check: string[] = []
  if (i.uncommitted > 0) keep.push(`${i.uncommitted} uncommitted`)
  if (i.conflicts > 0) keep.push(plural(i.conflicts, 'conflict'))
  if (i.ahead > 0 && i.merged !== true) keep.push(`${i.ahead} unpushed`)
  if (i.agent === 'working') keep.push('agent working')
  if (i.agent === 'permission') keep.push('agent waits for you')
  if (i.operation) keep.push(`${i.operation} in progress`)
  // A secret that could still go into a commit keeps the session open. One that is tracked already needs a look,
  // but closing the session loses nothing (and a committed test certificate must not block the list for ever)
  const tracked = Math.max(0, i.trackedSecrets ?? 0)
  const loose = Math.max(0, (i.secrets ?? 0) - tracked)
  if (loose > 0) keep.push(`${plural(loose, 'sensitive file')} not ignored`)
  if (tracked > 0) check.push(`${plural(tracked, 'secret')} in repo`)
  if (i.untracked > 0) check.push(`${i.untracked} untracked`)
  if (i.stash > 0) check.push(plural(i.stash, 'stash entry', 'stash entries'))
  if (!i.upstream && !i.detached && i.merged !== true) {
    const what = i.upstreamGone ? 'upstream branch is gone' : 'no upstream'
    check.push(i.merged === false ? `${what}, has commits outside the base branch` : `${what}, base branch unknown`)
  }
  if (i.submodules) check.push('submodules not checked')
  if ((i.junk ?? 0) > 0) check.push(plural(i.junk ?? 0, 'junk file'))
  // Commits on a detached HEAD that no base branch holds are reachable only through the reflog
  if (i.detached && i.merged === false) keep.push('detached HEAD with commits outside the base branch')
  else if (i.detached && i.merged !== true) check.push('detached HEAD')
  if (i.agentUnknown) check.push('agent status unknown')
  if (keep.length) return { verdict: 'keep', reasons: [...keep, ...check] }
  if (check.length) return { verdict: 'check', reasons: check }
  return { verdict: 'safe', reasons: ['clean, nothing unpushed'] }
}

/** How worrying a verdict is: a hidden worktree comes back when this gets higher than it was when hidden */
export function verdictRank(v: Verdict): number {
  return v === 'keep' ? 2 : v === 'safe' ? 0 : 1
}

const RANK: Record<Verdict, number> = { keep: 0, check: 1, safe: 2, unknown: 3 }

/** Order of the list: worktrees with uncommitted files first (most files on top), then by verdict, then by name */
export function compareSessions(
  a: { uncommitted: number; verdict: Verdict; name: string },
  b: { uncommitted: number; verdict: Verdict; name: string }
): number {
  return (
    Number(b.uncommitted > 0) - Number(a.uncommitted > 0) ||
    b.uncommitted - a.uncommitted ||
    RANK[a.verdict] - RANK[b.verdict] ||
    a.name.localeCompare(b.name)
  )
}
