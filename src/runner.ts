// The only place that starts git: execFile with fixed arguments, never a shell
import { execFile } from 'node:child_process'
import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  baseCandidates,
  isSafeUpstream,
  MAX_SUBJECTS,
  parseShortstat,
  parseSubjects,
  FILTER_LIST_ARGS,
  filterOverrides,
  gitArgs,
  isSafePath,
  operationFrom,
  parseCommitTime,
  parseStash,
  parseStatus,
  STATUS_ARGS,
  type StatusInfo
} from './git'

export const GIT_TIMEOUT_MS = 8000
export const GIT_MAX_BUFFER = 2 * 1024 * 1024
export const MAX_PARALLEL = 4

export type GitResult = { code: number; stdout: string }

/** Why a git call did not run to the end: shown as a fixed text, never the raw git message */
export class GitError extends Error {
  constructor(readonly reason: 'missing' | 'timeout' | 'too-large' | 'failed', message: string) {
    super(message)
  }
}

/** Only what git needs. Nothing else of the environment (GIT_EXTERNAL_DIFF, GIT_PAGER, GIT_DIR, GIT_SSH, ...) is passed on. */
export function gitEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    // git 2.44 and newer: never fetch missing objects by itself (older ones rely on the protocol flags)
    GIT_NO_LAZY_FETCH: '1',
    // git 2.40 and newer: read attributes from the empty tree, not from the worktree or the index. A checkout
    // during a scan could otherwise bring a .gitattributes that names a filter the override list did not know.
    GIT_ATTR_SOURCE: '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  }
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SystemRoot']) {
    const v = source[key]
    if (typeof v === 'string') env[key] = v
  }
  return env
}

/** Runs git with the fixed flags. Exit codes other than 0 come back, they are not errors (merge-base uses them). */
export function runGit(path: string, overrides: readonly string[], sub: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    if (!isSafePath(path)) return reject(new GitError('failed', 'invalid path'))
    execFile(
      'git',
      gitArgs(path, overrides, sub),
      { env: gitEnv(), timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8', windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (!err) return resolve({ code: 0, stdout })
        const e = err as Error & { killed?: boolean; code?: number | string }
        if (e.code === 'ENOENT') return reject(new GitError('missing', 'git not found'))
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new GitError('too-large', 'output too large'))
        if (e.killed) return reject(new GitError('timeout', 'timed out'))
        if (typeof e.code === 'number') return resolve({ code: e.code, stdout: String(stdout ?? '') })
        reject(new GitError('failed', 'git failed'))
      }
    )
  })
}

/** At most `limit` jobs at the same time, results in the order of the input */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(lanes)
  return out
}

export type RepoState = StatusInfo & {
  stash: number
  stashTotal: number
  operation: string | null
  lastCommitAt: number | null
  unpushed: string[]
  added: number | null
  removed: number | null
  dirtySince: number | null
  /** The repository has submodules (.gitmodules): their changes are not looked at */
  submodules: boolean
  /** HEAD is in the base branch; null when there is none or it could not be told */
  merged: boolean | null
}

export type RepoFailure = { error: string }

/** Reads the state of one worktree. Read-only, no network. */
export async function scanRepo(path: string, baseSetting: string): Promise<RepoState | RepoFailure> {
  try {
    if (!isSafePath(path)) return { error: 'invalid path' }
    const st = await stat(path).catch(() => null)
    if (!st || !st.isDirectory()) return { error: 'folder not found' }

    // Filter drivers of the repository must not run (see GIT_FLAGS)
    const list = await runGit(path, [], FILTER_LIST_ARGS)
    const filters = filterOverrides(list.stdout)
    if (filters.unsafe) return { error: 'repository config not safe to read' }
    if (filters.partial) return { error: 'partial clone, not checked' }
    const o = filters.args

    const status = await runGit(path, o, STATUS_ARGS)
    if (status.code !== 0) return { error: await failureText(path, o) }
    const info = parseStatus(status.stdout)

    const stashList = await runGit(path, o, ['stash', 'list', '--format=%gs'])
    if (stashList.code !== 0) return { error: 'git stash list failed' }
    const stash = parseStash(stashList.stdout)
    const dir = (await runGit(path, o, ['rev-parse', '--absolute-git-dir'])).stdout.trim()
    const operation = dir.startsWith('/') ? operationFrom(await readdir(dir).catch(() => [])) : null

    const lastCommitAt = info.oid ? parseCommitTime((await runGit(path, o, ['log', '-1', '--format=%ct', 'HEAD'])).stdout) : null

    // What is in the open work: size, age of the oldest change, the first unpushed commits
    let added: number | null = null
    let removed: number | null = null
    let dirtySince: number | null = null
    if (info.oid && info.uncommitted > 0) {
      const short = parseShortstat((await runGit(path, o, ['diff', '--no-textconv', '--no-ext-diff', '--ignore-submodules=dirty', '--shortstat', 'HEAD'])).stdout)
      added = short?.added ?? null
      removed = short?.removed ?? null
      // the paths of status are relative to the top of the worktree, which can be above the workspace folder
      const top = (await runGit(path, o, ['rev-parse', '--show-toplevel'])).stdout.trim()
      dirtySince = await oldestChange(top.startsWith('/') ? top : path, info.statPaths)
    }
    let unpushed: string[] = []
    if (info.oid && info.ahead > 0 && isSafeUpstream(info.upstream)) {
      const log = await runGit(path, o, ['log', `-${MAX_SUBJECTS}`, '--format=%s%x00', `${info.upstream}..HEAD`])
      if (log.code === 0) unpushed = parseSubjects(log.stdout)
    }

    // Merged is only needed when something might be unpushed or there is no upstream
    let merged: boolean | null = null
    if (!info.oid) merged = true // no commit yet: nothing to lose
    else if (info.ahead > 0 || !info.upstream || info.upstreamGone || info.detached) merged = await isMerged(path, o, baseSetting)

    return {
      ...info,
      stash: info.head ? (stash.byBranch.get(info.head) ?? 0) : 0,
      stashTotal: stash.total,
      operation,
      lastCommitAt,
      unpushed,
      added,
      removed,
      dirtySince,
      submodules: await hasSubmodules(path, o),
      merged
    }
  } catch (e) {
    if (e instanceof GitError) {
      if (e.reason === 'missing') return { error: 'git is not installed' }
      if (e.reason === 'timeout') return { error: 'git timed out' }
      if (e.reason === 'too-large') return { error: 'git output too large' }
    }
    return { error: 'git failed' }
  }
}

/** A submodule is a gitlink (mode 160000) in the index or a .gitmodules file; a repository too big to list counts as having one */
async function hasSubmodules(path: string, o: readonly string[]): Promise<boolean> {
  const top = (await runGit(path, o, ['rev-parse', '--show-toplevel'])).stdout.trim()
  const root = top.startsWith('/') ? top : path
  if (await stat(join(root, '.gitmodules')).then(() => true, () => false)) return true
  try {
    const files = await runGit(path, o, ['ls-files', '--stage', '-z'])
    if (files.code !== 0) return true
    return files.stdout.split('\0').some((entry) => entry.startsWith('160000 '))
  } catch (e) {
    if (e instanceof GitError && e.reason === 'too-large') return true
    throw e
  }
}

/** The oldest time stamp of the given files (symlinks are not followed, nothing is read) */
async function oldestChange(root: string, paths: readonly string[]): Promise<number | null> {
  const times = await mapLimit(paths, 16, async (p) => (await lstat(join(root, p)).then((s: { mtimeMs: number }) => s.mtimeMs, () => null)))
  const known = times.filter((t): t is number => t !== null)
  return known.length ? Math.round(Math.min(...known)) : null
}

async function failureText(path: string, overrides: readonly string[]): Promise<string> {
  const probe = await runGit(path, overrides, ['rev-parse', '--is-inside-work-tree']).catch(() => null)
  if (probe && probe.code === 0) return 'git status failed'
  return 'not a git repository (or git refused it)'
}

/** Is HEAD already in the base branch? Null when no base branch exists or git cannot tell. */
async function isMerged(path: string, o: readonly string[], baseSetting: string): Promise<boolean | null> {
  const head = await runGit(path, o, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
  const originHead = head.code === 0 ? head.stdout.trim() : null
  for (const ref of baseCandidates(baseSetting, originHead)) {
    const exists = await runGit(path, o, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
    if (exists.code !== 0) continue
    const r = await runGit(path, o, ['merge-base', '--is-ancestor', 'HEAD', ref])
    if (r.code === 0) return true
    if (r.code === 1) return false
    return null // 128 or other: not a "no"
  }
  return null
}
