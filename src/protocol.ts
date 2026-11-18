// Panel <-> worker contract, declared once
import type { LanguageSetting, MsgKey } from './i18n'

/** keep = do not close, check = look first, safe = can be closed, unknown = could not be checked */
export type Verdict = 'safe' | 'check' | 'keep' | 'unknown'
export type AgentState = 'working' | 'permission' | 'done' | 'active' | 'inactive'

export type FileEntry = {
  /** Two-letter git status ("M.", ".M", "A.", "UU") or "??" for untracked */
  state: string
  /** Path relative to the worktree, plain text only */
  path: string
}

/** A file that must not be committed, found by its name only (contents are never read) */
export type SensitiveFile = {
  /** Path relative to the top of the worktree, plain text only */
  path: string
  /** secret = key, password or credentials file; junk = folder or file that does not belong in git */
  kind: 'secret' | 'junk'
  /** In the index already (committed or staged), or else a new file git does not ignore */
  tracked: boolean
  /** The rule from the README table, e.g. ".env.*" or "*.pem" */
  rule: string
}

export type Session = {
  /** Orca workspace id */
  id: string
  name: string
  project: string | null
  branch: string | null
  /** The workspace you are in right now */
  current: boolean
  hidden: boolean
  verdict: Verdict
  /** Short reasons for the verdict */
  reasons: string[]
  /** Tracked files with changes, staged or not, conflicts included */
  uncommitted: number
  staged: number
  untracked: number
  conflicts: number
  /** Commits not pushed to the upstream, as last known (nothing is fetched) */
  ahead: number
  behind: number
  upstream: string | null
  /** The upstream is configured but its branch is gone */
  upstreamGone: boolean
  /** Has submodules, their changes are not looked at */
  submodules: boolean
  /** Stash entries made on this branch */
  stash: number
  /** Stash entries in the whole repository (all worktrees share them) */
  stashTotal: number
  /** Every commit is already in the base branch; null when unknown */
  merged: boolean | null
  /** "merge", "rebase", "cherry-pick", "revert" or "bisect" while one runs */
  operation: string | null
  agent: AgentState | null
  /** First changed files, at most 20 */
  files: FileEntry[]
  /** More changed files than listed */
  moreFiles: number
  /** Files that must not be committed, secrets first, at most 10 (empty when the warning is off) */
  sensitive: SensitiveFile[]
  /** All of them, also those beyond the list */
  sensitiveCount: number
  /** Secrets among them, and the secrets that are tracked already */
  sensitiveSecrets: number
  sensitiveTracked: number
  /** Why the worktree could not be checked (verdict unknown), in English */
  error: string | null
  /** The same as a message code the panel translates; null when the text is not a known one */
  errorCode: MsgKey | null
  /** Subjects of the first unpushed commits (at most 3), plain text */
  unpushed: string[]
  /** Lines added and removed in tracked files compared with HEAD, null when unknown */
  added: number | null
  removed: number | null
  /** Age of the oldest uncommitted change to a tracked file (ms), null when unknown */
  dirtySince: number | null
  /** Time of the last commit on HEAD (ms), null without commits or when unknown */
  lastCommitAt: number | null
  /** Last activity Orca saw in this workspace (ms), null when unknown */
  lastActiveAt: number | null
  checkedAt: number
}

export type SessionsState = {
  sessions: Session[]
  /** The host listed more workspaces than the plugin scans */
  truncated: boolean
  updatedAt: number
}

export type Config = {
  /** Base branch override, empty = detect */
  baseBranch: string
  /** Rescan interval of the open panel in seconds, 10 to 300 */
  intervalSeconds: number
  /** Desktop notification when an agent finishes and leaves open work */
  notifyOnAgentDone: boolean
  /** Background rescan for the status bar in seconds, 0 = off, else 30 to 600 */
  backgroundSeconds: number
  /** Language of the panel, the status bar and the notification; auto = Orca's language */
  language: LanguageSetting
  /** Warn about files that must not be committed, by name only */
  warnSensitive: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'sessions.get': { output: SessionsState }
    'sessions.refresh': { output: SessionsState }
    'session.open': { input: { id: string }; output: { ok: true } }
    /** Hiding is refused while the worktree still has open work (verdict keep) */
    'session.hide': { input: { id: string; hidden: boolean }; output: SessionsState }
    'config.get': { output: Config }
    'config.set': { input: Partial<Config>; output: Config }
    /** The panel tells the worker Orca's UI language (BCP-47), the worker has no API for it */
    'ui.locale': { input: { locale: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    'sessions.changed': SessionsState
  }
}
