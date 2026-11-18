// Worker: lists the Orca workspaces, reads the git state of each one (read-only, no network)
// and answers the panel
import type { OrcaWorkerApi } from 'orca/worker'
import { cleanPath, compareSessions, isSafePath, verdict as rate, verdictRank } from './git'
import { mapLimit, MAX_PARALLEL, scanRepo, type RepoFailure, type RepoState } from './runner'
import type { AgentState, Config, Session, SessionsState, Verdict } from './protocol'

const MAX_WORKSPACES = 100
const MAX_HIDDEN = 500
const LOCAL_HOST = 'local'
const INTERVAL_MIN = 10
const INTERVAL_MAX = 300
/** Test hook: the pause between two scans that events asked for */
export const TUNING = { eventGapMs: 2000 }
const CONFIG_DEFAULTS: Config = { baseBranch: '', intervalSeconds: 30 }

type Row = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  project?: string | null
  path: string
  branch: string | null
  hostId: string | null
  status?: { state: AgentState; lastActivityAt?: number | null }
}
type Checked = { at: number; result: RepoState | RepoFailure }

function isFailure(r: RepoState | RepoFailure): r is RepoFailure {
  return 'error' in r
}

export default function activate(orca: OrcaWorkerApi): void {
  let rows: Row[] = []
  let truncated = false
  let statusTruncated = false
  let scannedOnce = false
  let currentId: string | null = null
  let lastPanelSeen = 0
  let intervalMs = CONFIG_DEFAULTS.intervalSeconds * 1000
  let stopped = false
  let lastSignature = ''
  const checked = new Map<string, Checked>()
  // Hidden worktrees and the verdict they had when they were hidden
  const hidden = new Map<string, Verdict>()
  // Which workspaces the next event-driven scan should read again (null = all)
  let queued: Set<string> | 'all' | null = null
  let draining = false
  let lastEventScan = 0
  let gapTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<SessionsState> | null = null
  // A running targeted scan did not read every repository: a full refresh must not share it
  let inFlightTargeted = false

  async function getConfig(): Promise<Config> {
    const out = { ...CONFIG_DEFAULTS }
    const base = await orca.settings.get('baseBranch')
    if (typeof base === 'string') out.baseBranch = base.trim()
    const sec = await orca.settings.get('intervalSeconds')
    if (typeof sec === 'number' && Number.isFinite(sec)) out.intervalSeconds = Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(sec)))
    intervalMs = out.intervalSeconds * 1000
    return out
  }

  const isLocalWorktree = (r: Row) => r.kind === 'worktree' && (r.hostId === null || r.hostId === LOCAL_HOST) && isSafePath(r.path)

  function sessionOf(r: Row): Session {
    const c = checked.get(r.id)
    const agent = r.status?.state ?? null
    const agentUnknown = statusTruncated && !r.status
    const base = {
      id: r.id,
      name: cleanPath(r.name),
      project: r.project ? cleanPath(r.project) : null,
      branch: r.branch ? cleanPath(r.branch.replace(/^refs\/heads\//, '')) : null,
      current: r.id === currentId,
      hidden: hidden.has(r.id),
      agent,
      lastActiveAt: r.status?.lastActivityAt ?? null,
      checkedAt: c?.at ?? 0
    }
    const empty = { uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: null, upstreamGone: false, submodules: false, stash: 0, stashTotal: 0, merged: null, operation: null, files: [], moreFiles: 0, lastCommitAt: null, unpushed: [], added: null, removed: null, dirtySince: null }
    const failed = (error: string): Session => {
      // An agent at work is a reason to keep the session even when git could not be read
      const busy = agent === 'working' || agent === 'permission'
      return { ...base, ...empty, verdict: busy ? 'keep' : 'unknown', reasons: busy ? ['agent working', error] : [error], error }
    }
    if (r.kind !== 'worktree') return failed('folder workspace, not checked')
    if (!isLocalWorktree(r)) return failed(r.hostId === null || r.hostId === LOCAL_HOST ? 'invalid path' : 'remote workspace, not checked')
    if (!c) return failed('not checked yet')
    if (isFailure(c.result)) return failed(c.result.error)
    const s = c.result
    const v = rate({
      uncommitted: s.uncommitted, staged: s.staged, untracked: s.untracked, conflicts: s.conflicts,
      ahead: s.ahead, upstream: s.upstreamGone ? null : s.upstream, upstreamGone: s.upstreamGone, submodules: s.submodules, detached: s.detached, stash: s.stash, merged: s.merged,
      operation: s.operation, agent, agentUnknown
    })
    return {
      ...base,
      uncommitted: s.uncommitted,
      staged: s.staged,
      untracked: s.untracked,
      conflicts: s.conflicts,
      ahead: s.ahead,
      behind: s.behind,
      upstream: s.upstream ? cleanPath(s.upstream) : null,
      upstreamGone: s.upstreamGone,
      submodules: s.submodules,
      stash: s.stash,
      stashTotal: s.stashTotal,
      merged: s.merged,
      operation: s.operation,
      files: s.files,
      moreFiles: s.moreFiles,
      lastCommitAt: s.lastCommitAt,
      unpushed: s.unpushed,
      added: s.added,
      removed: s.removed,
      dirtySince: s.dirtySince,
      verdict: v.verdict,
      reasons: v.reasons,
      error: null
    }
  }

  function snapshot(): SessionsState {
    const sessions = rows.map(sessionOf).sort(compareSessions)
    return { sessions, truncated, updatedAt: Date.now() }
  }

  function publish(force = false): SessionsState {
    const state = snapshot()
    if (stopped) return state
    // checkedAt changes with every scan, it must not count as a change
    const signature = JSON.stringify(state.sessions.map((s) => ({ ...s, checkedAt: 0 })))
    if (force || signature !== lastSignature) {
      lastSignature = signature
      orca.panels.post('sessions.changed', state)
    }
    return state
  }

  async function loadRows(): Promise<void> {
    const res = await orca.host.call('workspace.list', { includeStatus: true }).catch(() => null)
    if (!res) throw new Error('Could not list the workspaces')
    rows = res.workspaces.slice(0, MAX_WORKSPACES) as Row[]
    truncated = res.truncated || res.workspaces.length > MAX_WORKSPACES
    statusTruncated = res.statusTruncated === true
    const ids = new Set(rows.map((r) => r.id))
    for (const id of [...checked.keys()]) if (!ids.has(id)) checked.delete(id)
    // A cut or empty list says nothing about the workspaces that are missing from it: keep what is hidden
    let pruned = false
    if (!truncated && rows.length > 0) for (const id of [...hidden.keys()]) if (!ids.has(id)) pruned = hidden.delete(id) || pruned
    if (pruned) await saveHidden()
  }

  /** A hidden worktree that got worse than it was when hidden is shown again: hiding must not hide risk */
  async function resurface(): Promise<void> {
    let changed = false
    for (const r of rows) {
      const at = hidden.get(r.id)
      if (at !== undefined && verdictRank(sessionOf(r).verdict) > verdictRank(at)) changed = hidden.delete(r.id) || changed
    }
    if (changed) await saveHidden()
  }

  /** One scan at a time. `only` limits the git reads to those workspaces (the others keep their last result). */
  async function scan(only?: ReadonlySet<string>): Promise<SessionsState> {
    // A panel refresh shares the running scan. A targeted scan waits for it and then runs, so its workspaces are not lost.
    while (inFlight) {
      if (!only && !inFlightTargeted) return inFlight
      await inFlight.catch(() => undefined)
    }
    const run = (async () => {
      try {
        await loadRows()
        const cfg = await getConfig()
        const todo = rows.filter((r) => isLocalWorktree(r) && (!only || only.has(r.id) || !checked.has(r.id)))
        await mapLimit(todo, MAX_PARALLEL, async (r) => {
          if (stopped) return
          checked.set(r.id, { at: Date.now(), result: await scanRepo(r.path, cfg.baseBranch) })
        })
        scannedOnce = true
        await resurface()
        return publish()
      } finally {
        inFlight = null
      }
    })()
    inFlight = run
    inFlightTargeted = only !== undefined
    return await run
  }

  /** Event-driven rescans: coalesced, one after the other */
  function enqueue(id: string | null): void {
    if (stopped) return
    if (id === null || queued === 'all') queued = 'all'
    else {
      const set = queued ?? new Set<string>()
      set.add(id)
      queued = set
    }
    if (!draining) void drain()
  }
  async function drain(): Promise<void> {
    draining = true
    try {
      while (queued && !stopped) {
        // Events can come in storms (every agent step): scans they ask for keep a distance
        const wait = lastEventScan + TUNING.eventGapMs - Date.now()
        if (wait > 0) await new Promise<void>((resolve) => (gapTimer = setTimeout(resolve, wait)))
        if (stopped) break
        const q = queued
        queued = null
        lastEventScan = Date.now()
        // Targeted scans of "all" (id unknown) ask for everything
        await scan(q === 'all' ? undefined : q).catch((e) => orca.log(`rescan failed: ${String(e)}`))
      }
    } finally {
      draining = false
    }
  }
  const panelOpen = () => Date.now() - lastPanelSeen < Math.max(intervalMs * 3, 90_000)

  type FocusContext = { workspaceId?: string; branch: string; displayName: string } | null
  function resolveCurrent(ctx: FocusContext): void {
    let id: string | null = null
    if (ctx) {
      const branchOf = (b: string | null | undefined) => (b ?? '').replace(/^refs\/heads\//, '')
      if (ctx.workspaceId && rows.some((x) => x.id === ctx.workspaceId)) id = ctx.workspaceId
      else {
        const hits = rows.filter((x) => x.name === ctx.displayName && branchOf(x.branch) === branchOf(ctx.branch))
        if (hits.length === 1) id = hits[0].id
      }
    }
    currentId = id
  }

  async function saveHidden(): Promise<void> {
    await orca.storage.set('hidden', Object.fromEntries([...hidden].slice(-MAX_HIDDEN)))
  }

  const known = (id: unknown): string => {
    if (typeof id !== 'string' || !rows.some((r) => r.id === id)) throw new Error('Unknown workspace')
    return id
  }

  const ready = (async () => {
    const saved = await orca.storage.get('hidden').catch(() => null)
    // An older list of ids counts as hidden while safe, so any change brings the worktree back
    if (Array.isArray(saved)) {
      for (const id of saved) if (typeof id === 'string') hidden.set(id, 'safe')
    } else if (saved && typeof saved === 'object') {
      for (const [id, v] of Object.entries(saved)) if (v === 'safe' || v === 'check' || v === 'unknown' || v === 'keep') hidden.set(id, v)
    }
    await getConfig().catch(() => CONFIG_DEFAULTS)
  })()

  orca.panels.handle('sessions.get', async () => {
    await ready
    lastPanelSeen = Date.now()
    return scannedOnce ? snapshot() : scan()
  })
  orca.panels.handle('sessions.refresh', async () => {
    await ready
    lastPanelSeen = Date.now()
    return scan()
  })
  orca.panels.handle('session.open', async (input) => {
    const id = known(input?.id)
    await orca.host.call('workspace.open', { workspaceId: id }).catch(() => {
      throw new Error('Could not open the workspace')
    })
    return { ok: true as const }
  })
  orca.panels.handle('session.hide', async (input) => {
    const id = known(input?.id)
    if (typeof input.hidden !== 'boolean') throw new Error('Invalid request')
    if (input.hidden) {
      const row = rows.find((r) => r.id === id)
      const verdict = row ? sessionOf(row).verdict : 'unknown'
      if (verdict === 'keep') throw new Error('This worktree still has open work and cannot be hidden')
      hidden.set(id, verdict)
    } else hidden.delete(id)
    await saveHidden()
    return publish(true)
  })
  orca.panels.handle('config.get', async () => {
    await ready
    return getConfig()
  })
  orca.panels.handle('config.set', async (input) => {
    if (typeof input?.baseBranch === 'string') await orca.settings.set('baseBranch', input.baseBranch.trim().slice(0, 200))
    if (typeof input?.intervalSeconds === 'number' && Number.isFinite(input.intervalSeconds)) {
      await orca.settings.set('intervalSeconds', Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(input.intervalSeconds))))
    }
    return getConfig()
  })

  orca.events.on('workspace.changed', async (e) => {
    await ready
    resolveCurrent(e.context)
    publish()
  })
  orca.events.on('workspace.created', () => {
    if (panelOpen()) enqueue(null)
  })
  orca.events.on('workspace.removed', () => {
    if (panelOpen()) enqueue(null)
  })
  orca.events.on('agent.status.changed', (e) => {
    if (!panelOpen()) return
    // workspaceListId is the id workspace.list uses; without it, read everything again
    const id = e.workspaceListId ?? e.workspaceId
    enqueue(id && rows.some((r) => r.id === id) ? id : null)
  })

  orca.commands.register('refresh', async () => {
    await ready
    const s = await scan()
    return `${s.sessions.length} worktrees`
  })

  cleanup = () => {
    stopped = true
    queued = null
    if (gapTimer) clearTimeout(gapTimer)
  }
}

let cleanup: (() => void) | undefined

export function deactivate(): void {
  cleanup?.()
}
