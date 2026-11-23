// The only place that starts gh (the GitHub CLI) and the plugin's only use of the network, off unless the person turns
// on "Show pull requests". gh runs outside the worktree and gets the repository with --repo, so the repository's
// config never reaches it; the remotes are read with the same protected git call as everything else.
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { runGit } from './runner'
import type { PullRequest } from './protocol'

export const GH_TIMEOUT_MS = 10_000
const GH_MAX_BUFFER = 256 * 1024
const PR_LIMIT = 20
/** The program that is started; tests point it at a fake */
export const GH = { command: 'gh' }

// GitHub owner and repository names
const NAME = /^[A-Za-z0-9._-]{1,100}$/
// A branch name as it goes to gh: what git allows, no spaces or control characters
const BRANCH = /^[^\0-\x20\x7f]{1,255}$/
// gh's own order when no default repository was chosen with `gh repo set-default`
const BASE_ORDER = ['upstream', 'github', 'origin']
const CONFIG_KEYS = '^(remote\\..*\\.(url|gh-resolved)|branch\\..*\\.(remote|merge))$'

type Repo = { owner: string; name: string }
export type Target = { repo: string; headOwner: string; head: string }

/** Owner and name of a github.com remote URL; null for any other host or an odd name */
// shortcut: github.com only, GitHub Enterprise hosts would need their host in --repo; add it when someone asks
export function parseGithubUrl(url: string): Repo | null {
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2]) || m[2] === '.' || m[2] === '..') return null
  return { owner: m[1], name: m[2] }
}

/** `git config -z --get-regexp`: "key\nvalue\0" per entry; the last value of a key wins, as in git */
export function parseConfig(out: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of out.split('\0')) {
    const i = entry.indexOf('\n')
    if (i > 0) map.set(entry.slice(0, i), entry.slice(i + 1))
  }
  return map
}

/**
 * Where gh itself looks for the pull request of `branch`: in the remote chosen with `gh repo set-default`, else in
 * upstream, github or origin, opened under the branch's name from the remote it tracks, or from origin. Null off github.com.
 */
export function targetOf(config: ReadonlyMap<string, string>, branch: string): Target | null {
  // A branch made from origin/main tracks main: that says nothing about where the branch itself is pushed
  const tracksItself = config.get(`branch.${branch}.merge`) === `refs/heads/${branch}`
  const remote = (tracksItself ? config.get(`branch.${branch}.remote`) : undefined) ?? 'origin'
  const pushed = parseGithubUrl(config.get(`remote.${remote}.url`) ?? '')
  if (!pushed || !BRANCH.test(branch)) return null
  const remotes = [...config.keys()].filter((k) => k.startsWith('remote.') && k.endsWith('.url')).map((k) => k.slice(7, -4))
  const chosen = remotes.find((n) => config.get(`remote.${n}.gh-resolved`) === 'base') ?? BASE_ORDER.find((n) => remotes.includes(n)) ?? remote
  const base = parseGithubUrl(config.get(`remote.${chosen}.url`) ?? '')
  return base ? { repo: `${base.owner}/${base.name}`, headOwner: pushed.owner, head: branch } : null
}

type GhRow = { number?: unknown; state?: unknown; isDraft?: unknown; headRepositoryOwner?: { login?: unknown } | null }

/** The pull request in gh's JSON, opened by `headOwner`: an open one first, else the newest (gh lists newest first) */
export function pickPullRequest(json: string, headOwner: string): PullRequest | null {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const owner = headOwner.toLowerCase()
  const own = (rows as GhRow[]).filter(
    (r) => typeof r?.number === 'number' && Number.isSafeInteger(r.number) && r.number > 0 && typeof r.headRepositoryOwner?.login === 'string' && r.headRepositoryOwner.login.toLowerCase() === owner
  )
  const r = own.find((x) => x.state === 'OPEN') ?? own[0]
  if (!r) return null
  const state = r.state === 'OPEN' ? (r.isDraft === true ? 'draft' : 'open') : r.state === 'MERGED' ? 'merged' : r.state === 'CLOSED' ? 'closed' : null
  return state ? { number: r.number as number, state } : null
}

/** Only what gh needs to find its login (config file or system keyring) and the network; no prompts, no update check */
export function ghEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' }
  const keys = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
  ]
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'string') env[key] = v
  }
  return env
}

function runGh(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(GH.command, args, { cwd: tmpdir(), env: ghEnv(), timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: 'utf8', windowsHide: true }, (err: Error | null, stdout: string) => {
      if (!err) return resolve(stdout)
      const e = err as Error & { killed?: boolean; code?: number | string }
      if (e.code === 'ENOENT') return reject(new Error('gh is not installed'))
      if (e.killed) return reject(new Error('gh timed out'))
      // gh exits with 4 when it needs a login
      if (e.code === 4) return reject(new Error('gh is not logged in'))
      reject(new Error('gh failed'))
    })
  })
}

/** The pull request of `branch` in the worktree at `path`; null when it has none or its remotes are not on github.com */
export async function lookupPullRequest(path: string, branch: string): Promise<{ pr: PullRequest | null } | { error: string }> {
  try {
    const cfg = await runGit(path, [], ['config', '-z', '--get-regexp', CONFIG_KEYS])
    // Exit 1: no remote or branch configured
    const target = cfg.code === 0 ? targetOf(parseConfig(cfg.stdout), branch) : null
    if (!target) return { pr: null }
    const out = await runGh(['pr', 'list', `--repo=github.com/${target.repo}`, `--head=${target.head}`, '--state=all', '--json=number,state,isDraft,headRepositoryOwner', `--limit=${PR_LIMIT}`])
    return { pr: pickPullRequest(out, target.headOwner) }
  } catch (e) {
    return { error: e instanceof Error && e.message.startsWith('gh ') ? e.message : 'git failed' }
  }
}
