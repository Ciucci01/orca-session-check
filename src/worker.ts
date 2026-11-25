// Worker: lists the Orca workspaces, reads the git state of each one (read-only, no network),
// answers the panel, keeps the status bar item current and notifies when an agent leaves open work
import type { OrcaWorkerApi, PluginEvents } from 'orca/worker'
import { cleanPath, compareSessions, isSafePath, verdict as rate, verdictRank } from './git'
import { mapLimit, MAX_PARALLEL, scanRepo, type RepoFailure, type RepoState } from './runner'
import { errorKey, languageSetting, resolveLang, tr, type Lang } from './i18n'
import { agentDoneText, clampBackground, statusBar, type BarItem } from './summary'
import type { AgentState, Config, Session, SessionsState, Verdict } from './protocol'

const MAX_WORKSPACES = 100
const MAX_HIDDEN = 500
// Agent panes and finished agents remembered at most (events name panes, not workspaces)
const MAX_PANES = 500
const LOCAL_HOST = 'local'
const INTERVAL_MIN = 10
const INTERVAL_MAX = 300
const STATUS_ITEM = 'sessions'
/** Timings; tests shorten them */
export const TUNING = {
  /** Pause between two scans that events or the background timer asked for */
  eventGapMs: 2000,
  /** A workspace is not read again on account of events or the background timer within this time */
  minRescanMs: 15_000,
  /** First background scan after the start, so the status bar fills without the panel */
  startDelayMs: 3000,
  /** Length of one configured second (background refresh) */
  secondMs: 1000,
  /** At most one notification per worktree in this time */
  notifyGapMs: 10 * 60_000
}
/** The system locale, the worker's last guess at the language when the panel never said one; tests replace it */
export const LOCALE = { system: (): string => Intl.DateTimeFormat().resolvedOptions().locale }
// Orca's UI locale as BCP-47 ("de-DE", "es-419")
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,6}$/
const CONFIG_DEFAULTS: Config = { baseBranch: '', intervalSeconds: 30, notifyOnAgentDone: true, backgroundSeconds: 120, language: 'auto', warnSensitive: true }
type EventState = PluginEvents['agent.status.changed']['state']

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
  let stopped = false
  let lastSignature = ''
  let lastBar = ''
  const checked = new Map<string, Checked>()
  // Hidden worktrees and the verdict they had when they were hidden
  const hidden = new Map<string, Verdict>()
  // What the next event-driven scan should read again: everything and/or single workspaces
  let queuedAll = false
  const queuedIds = new Set<string>()
  let draining = false
  let lastEventScan = 0
  let gapTimer: ReturnType<typeof setTimeout> | undefined
  // The one background timer: first scan after the start, then every backgroundSeconds
  let bgTimer: ReturnType<typeof setTimeout> | undefined
  let backgroundSeconds = CONFIG_DEFAULTS.backgroundSeconds
  let inFlight: Promise<SessionsState> | null = null
  // A running targeted scan did not read every repository: a full refresh must not share it
  let inFlightTargeted = false
  // Last agent state per pane, to see working -> done
  const paneStates = new Map<string, EventState>()
  // Workspaces whose agent finished, with the time: notified after a scan that started later
  const finished = new Map<string, number>()
  const notifiedAt = new Map<string, number>()
  // Language: the setting and the UI locale the panel last told (the worker has no locale API)
  let language = CONFIG_DEFAULTS.language
  // Off: no file is reported as sensitive and the verdict does not look at names
  let warnSensitive = CONFIG_DEFAULTS.warnSensitive
  let uiLocale: string | null = null
  const lang = (): Lang => {
    if (uiLocale !== null) return resolveLang(language, uiLocale)
    let system: unknown = null
    try {
      system = LOCALE.system()
    } catch {
      system = null
    }
    return resolveLang(language, system)
  }

  async function getConfig(): Promise<Config> {
    const out = { ...CONFIG_DEFAULTS }
    const base = await orca.settings.get('baseBranch')
    if (typeof base === 'string') out.baseBranch = base.trim()
    const sec = await orca.settings.get('intervalSeconds')
    if (typeof sec === 'number' && Number.isFinite(sec)) out.intervalSeconds = Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(sec)))
    const notify = await orca.settings.get('notifyOnAgentDone')
    if (typeof notify === 'boolean') out.notifyOnAgentDone = notify
    const bg = clampBackground(await orca.settings.get('backgroundSeconds'))
    if (bg !== null) out.backgroundSeconds = bg
    out.language = languageSetting(await orca.settings.get('language'))
    const warn = await orca.settings.get('warnSensitive')
    if (typeof warn === 'boolean') out.warnSensitive = warn
    backgroundSeconds = out.backgroundSeconds
    language = out.language
    warnSensitive = out.warnSensitive
    return out
  }

  const isLocalWorktree = (r: Row) => r.kind === 'worktree' && (r.hostId === null || r.hostId === LOCAL_HOST) && isSafePath(r.path)

  const noSensitive = { sensitive: [], sensitiveCount: 0, sensitiveSecrets: 0, sensitiveTracked: 0 }

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
    const empty = { uncommitted: 0, staged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: null, upstreamGone: false, submodules: false, stash: 0, stashTotal: 0, merged: null, operation: null, mainWorktree: false, files: [], moreFiles: 0, lastCommitAt: null, unpushed: [], added: null, removed: null, dirtySince: null, ...noSensitive }
    const failed = (error: string): Session => {
      // An agent at work is a reason to keep the session even when git could not be read
      const busy = agent === 'working' || agent === 'permission'
      return { ...base, ...empty, verdict: busy ? 'keep' : 'unknown', reasons: busy ? ['agent working', error] : [error], error, errorCode: errorKey(error) }
    }
    if (r.kind !== 'worktree') return failed('folder workspace, not checked')
    if (!isLocalWorktree(r)) return failed(r.hostId === null || r.hostId === LOCAL_HOST ? 'invalid path' : 'remote workspace, not checked')
    if (!c) return failed('not checked yet')
    if (isFailure(c.result)) return failed(c.result.error)
    const s = c.result
    const sens = warnSensitive
      ? { sensitive: s.sensitive, sensitiveCount: s.sensitiveCount, sensitiveSecrets: s.sensitiveSecrets, sensitiveTracked: s.sensitiveTracked }
      : noSensitive
    const v = rate({
      uncommitted: s.uncommitted, staged: s.staged, untracked: s.untracked, conflicts: s.conflicts,
      ahead: s.ahead, upstream: s.upstreamGone ? null : s.upstream, upstreamGone: s.upstreamGone, submodules: s.submodules, detached: s.detached, stash: s.stash, merged: s.merged,
      operation: s.operation, agent, agentUnknown,
      secrets: sens.sensitiveSecrets, trackedSecrets: sens.sensitiveTracked, junk: sens.sensitiveCount - sens.sensitiveSecrets
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
      mainWorktree: s.mainWorktree,
      files: s.files,
      moreFiles: s.moreFiles,
      lastCommitAt: s.lastCommitAt,
      unpushed: s.unpushed,
      added: s.added,
      removed: s.removed,
      dirtySince: s.dirtySince,
      ...sens,
      verdict: v.verdict,
      reasons: v.reasons,
      error: null,
      errorCode: null
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
    if (scannedOnce) updateBar(state.sessions)
    return state
  }

  /** Status bar: the same sessions and verdicts as the panel, local worktrees only (folders and remote ones are never checked) */
  function updateBar(sessions: readonly Session[]): void {
    const local = new Set(rows.filter((r) => r.kind === 'worktree' && (r.hostId === null || r.hostId === LOCAL_HOST)).map((r) => r.id))
    const items: BarItem[] = sessions
      .filter((s) => local.has(s.id))
      .map((s) => ({ project: s.project, name: s.name, hidden: s.hidden, unknown: s.error !== null, uncommitted: s.uncommitted }))
    setBar(statusBar(items, lang()))
  }
  function setBar(bar: { text: string; tone: 'neutral' | 'success' | 'warning'; tooltip: string }): void {
    const signature = JSON.stringify(bar)
    if (stopped || signature === lastBar) return
    lastBar = signature
    void orca.host.call('statusBar.update', { id: STATUS_ITEM, ...bar }).catch((e) => {
      lastBar = ''
      orca.log(`status bar failed: ${String(e)}`)
    })
  }

  /** Notifies for the workspaces whose agent finished before this scan read them again */
  async function notifyFinished(cfg: Config): Promise<void> {
    const now = Date.now()
    for (const [id, at] of [...finished]) {
      const row = rows.find((r) => r.id === id)
      if (!row || !isLocalWorktree(row)) {
        // Not in the list (any more) or never read: nothing to tell
        if (row || !truncated) finished.delete(id)
        continue
      }
      const c = checked.get(id)
      if (!c || c.at < at) {
        // Read a moment before the agent finished: read it again once it is due
        enqueue(id)
        continue
      }
      finished.delete(id)
      if (!cfg.notifyOnAgentDone || hidden.has(id)) continue
      const last = notifiedAt.get(id)
      if (last !== undefined && now - last < TUNING.notifyGapMs) continue
      const s = sessionOf(row)
      if (s.error !== null) continue
      const body = agentDoneText({ ...s, sensitiveSecrets: Math.max(0, s.sensitiveSecrets - s.sensitiveTracked) }, lang())
      if (!body) continue // clean worktree
      notifiedAt.set(id, now)
      for (const [k, t] of notifiedAt) if (now - t >= TUNING.notifyGapMs) notifiedAt.delete(k)
      await orca.host.call('notifications.show', { title: 'Session Check', body }).catch((e) => orca.log(`notify failed: ${String(e)}`))
    }
  }

  async function loadRows(): Promise<void> {
    const res = await orca.host.call('workspace.list', { includeStatus: true }).catch(() => null)
    if (!res) throw new Error(tr('en', 'err.listFailed'))
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

  /**
   * One scan at a time. `only` limits the git reads to those workspaces (the others keep their last result).
   * `minAgeMs` skips workspaces read more recently than that (event and background scans), new ones are always read.
   */
  async function scan(only?: ReadonlySet<string>, minAgeMs = 0): Promise<SessionsState> {
    const partial = only !== undefined || minAgeMs > 0
    // A panel refresh shares the running scan. A partial scan waits for it and then runs, so its workspaces are not lost.
    while (inFlight) {
      if (!partial && !inFlightTargeted) return inFlight
      await inFlight.catch(() => undefined)
    }
    const run = (async () => {
      try {
        try {
          await loadRows()
        } catch (e) {
          if (!scannedOnce) setBar({ text: tr(lang(), 'bar.unknownAll'), tone: 'neutral', tooltip: tr(lang(), 'bar.tip.listFailed') })
          throw e
        }
        const cfg = await getConfig()
        const now = Date.now()
        const due = (r: Row) => {
          const c = checked.get(r.id)
          return !c || ((!only || only.has(r.id)) && now - c.at >= minAgeMs)
        }
        const todo = rows.filter((r) => isLocalWorktree(r) && due(r))
        await mapLimit(todo, MAX_PARALLEL, async (r) => {
          if (stopped) return
          checked.set(r.id, { at: Date.now(), result: await scanRepo(r.path, cfg.baseBranch) })
        })
        scannedOnce = true
        await resurface()
        const state = publish()
        await notifyFinished(cfg)
        return state
      } finally {
        inFlight = null
      }
    })()
    inFlight = run
    inFlightTargeted = partial
    return await run
  }

  /** Event and background rescans: coalesced, one after the other, `null` = every workspace */
  function enqueue(id: string | null): void {
    if (stopped) return
    if (id === null) queuedAll = true
    else queuedIds.add(id)
    if (!draining) void drain()
  }
  const pause = (ms: number) => new Promise<void>((resolve) => (gapTimer = setTimeout(resolve, ms)))
  async function drain(): Promise<void> {
    draining = true
    try {
      while ((queuedAll || queuedIds.size > 0) && !stopped) {
        // Events can come in storms (every agent step): scans they ask for keep a distance
        const wait = lastEventScan + TUNING.eventGapMs - Date.now()
        if (wait > 0) await pause(wait)
        if (stopped) break
        // A workspace read a moment ago waits for its turn instead of being read again
        const now = Date.now()
        const due = new Set<string>()
        let next = Infinity
        for (const id of queuedIds) {
          const c = checked.get(id)
          const at = c ? c.at + TUNING.minRescanMs : 0
          if (at <= now) due.add(id)
          else next = Math.min(next, at)
        }
        for (const id of due) queuedIds.delete(id)
        const all = queuedAll
        queuedAll = false
        if (!all && due.size === 0) {
          await pause(next - now)
          continue
        }
        lastEventScan = now
        // "all" reads every workspace that is due, the queued ones included
        await scan(all ? undefined : due, TUNING.minRescanMs).catch((e) => orca.log(`rescan failed: ${String(e)}`))
      }
    } finally {
      draining = false
    }
  }

  /** The one background timer; it only queues a scan, so it never runs next to another one */
  function armBackground(delayMs: number): void {
    if (bgTimer) clearTimeout(bgTimer)
    bgTimer = undefined
    if (stopped) return
    bgTimer = setTimeout(() => {
      bgTimer = undefined
      if (stopped) return
      // A scan that is queued or running already brings the status bar up to date
      if (!draining && !inFlight) enqueue(null)
      if (backgroundSeconds > 0) armBackground(backgroundSeconds * TUNING.secondMs)
    }, delayMs)
  }
  function rearmBackground(): void {
    if (stopped) return
    if (backgroundSeconds > 0) armBackground(backgroundSeconds * TUNING.secondMs)
    else if (bgTimer) {
      clearTimeout(bgTimer)
      bgTimer = undefined
    }
  }

  /** The status bar in the language that holds now (it only goes out when its text changed) */
  function relabel(): void {
    if (scannedOnce && !stopped) updateBar(snapshot().sessions)
  }

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
    if (typeof id !== 'string' || !rows.some((r) => r.id === id)) throw new Error(tr('en', 'err.unknownWorkspace'))
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
    // The status bar fills shortly after the start, also when the panel is never opened
    if (!stopped) armBackground(TUNING.startDelayMs)
  })()

  orca.panels.handle('sessions.get', async () => {
    await ready
    return scannedOnce ? snapshot() : scan()
  })
  orca.panels.handle('sessions.refresh', async () => {
    await ready
    return scan()
  })
  orca.panels.handle('session.open', async (input) => {
    const id = known(input?.id)
    await orca.host.call('workspace.open', { workspaceId: id }).catch(() => {
      throw new Error(tr('en', 'err.openFailed'))
    })
    return { ok: true as const }
  })
  orca.panels.handle('session.hide', async (input) => {
    const id = known(input?.id)
    if (typeof input.hidden !== 'boolean') throw new Error(tr('en', 'err.invalidRequest'))
    if (input.hidden) {
      const row = rows.find((r) => r.id === id)
      const verdict = row ? sessionOf(row).verdict : 'unknown'
      if (verdict === 'keep') throw new Error(tr('en', 'err.cannotHide'))
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
    if (typeof input?.notifyOnAgentDone === 'boolean') await orca.settings.set('notifyOnAgentDone', input.notifyOnAgentDone)
    const bg = clampBackground(input?.backgroundSeconds)
    if (bg !== null) await orca.settings.set('backgroundSeconds', bg)
    // Only a known value is stored; anything else leaves the setting as it is
    if (typeof input?.language === 'string' && languageSetting(input.language) === input.language) await orca.settings.set('language', input.language)
    if (typeof input?.warnSensitive === 'boolean') await orca.settings.set('warnSensitive', input.warnSensitive)
    const before = backgroundSeconds
    const warnBefore = warnSensitive
    const cfg = await getConfig()
    if (cfg.backgroundSeconds !== before) rearmBackground()
    if (cfg.warnSensitive !== warnBefore) await rerate()
    relabel()
    return cfg
  })
  orca.panels.handle('ui.locale', async (input) => {
    const locale = input?.locale
    if (typeof locale !== 'string' || locale.length > 64 || !LOCALE_PATTERN.test(locale)) throw new Error(tr('en', 'err.invalidRequest'))
    await ready
    uiLocale = locale
    relabel()
    return { ok: true as const }
  })
  /** The warning switched on or off: the verdicts change without reading git again */
  async function rerate(): Promise<void> {
    if (!scannedOnce || stopped) return
    await resurface()
    publish()
  }

  // A change in Orca's Settings takes effect without a restart
  const settingsWatch = orca.settings.onDidChange((change) => {
    if (change.key !== 'backgroundSeconds' && change.key !== 'language' && change.key !== 'warnSensitive') return
    const before = backgroundSeconds
    const warnBefore = warnSensitive
    void getConfig()
      .then(async (cfg) => {
        if (cfg.backgroundSeconds !== before) rearmBackground()
        if (cfg.warnSensitive !== warnBefore) await rerate()
        relabel()
      })
      .catch(() => undefined)
  })

  orca.events.on('workspace.changed', async (e) => {
    await ready
    resolveCurrent(e.context)
    publish()
  })
  orca.events.on('workspace.created', (e) => {
    enqueue(e.workspaceListId ?? null)
  })
  orca.events.on('workspace.removed', () => {
    enqueue(null)
  })
  orca.events.on('agent.status.changed', (e) => {
    // workspaceListId is the id workspace.list uses; without it, read everything again
    const id = e.workspaceListId ?? e.workspaceId
    const before = paneStates.get(e.paneKey)
    paneStates.delete(e.paneKey)
    paneStates.set(e.paneKey, e.state)
    if (paneStates.size > MAX_PANES) paneStates.delete(paneStates.keys().next().value as string)
    // Finished: the agent worked or asked for permission and is done now
    if (id && e.state === 'done' && (before === 'working' || before === 'blocked')) {
      finished.delete(id)
      finished.set(id, Date.now())
      if (finished.size > MAX_PANES) finished.delete(finished.keys().next().value as string)
    }
    enqueue(id && rows.some((r) => r.id === id) ? id : null)
  })

  orca.commands.register('refresh', async () => {
    await ready
    const s = await scan()
    return tr(lang(), 'command.refreshed', { n: s.sessions.length })
  })

  cleanup = () => {
    stopped = true
    queuedAll = false
    queuedIds.clear()
    if (gapTimer) clearTimeout(gapTimer)
    if (bgTimer) clearTimeout(bgTimer)
    bgTimer = undefined
    settingsWatch.dispose()
  }
}

let cleanup: (() => void) | undefined

export function deactivate(): void {
  cleanup?.()
}
