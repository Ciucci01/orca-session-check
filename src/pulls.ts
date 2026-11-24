// The only place that starts gh (GitHub CLI) or glab (GitLab CLI), and the plugin's only use of the network, off
// unless the person turns on "Show pull requests". Both run outside the worktree, in the system temp folder, and get
// the repository with --repo, so the repository's config never reaches them; the remotes are read with the same
// protected git call as everything else.
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { runGit } from './runner'
import type { PullRequest } from './protocol'

export const CLI_TIMEOUT_MS = 10_000
const CLI_MAX_BUFFER = 1024 * 1024
const LIMIT = 20
/** The programs that are started; tests point them at fakes */
export const CLI = { gh: 'gh', glab: 'glab' }

// Host names, and owner, group and repository names (GitLab nests groups)
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const NAME = /^[A-Za-z0-9._-]{1,100}$/
// A branch name as it goes to gh or glab: what git allows, no spaces or control characters
const BRANCH = /^[^\0-\x20\x7f]{1,255}$/
// gh's own order when no default repository was chosen with `gh repo set-default`
const BASE_ORDER = ['upstream', 'github', 'origin']
const CONFIG_KEYS = '^(remote\\..*\\.(url|gh-resolved)|branch\\..*\\.(remote|merge))$'

export type Forge = PullRequest['forge']
export type Remote = { host: string; path: string }
export type Target = { forge: Forge; host: string; repo: string; head: string; headRepo: string }

/** Host and project path of a remote URL (scp-like, ssh:// or https://), null for anything odd; the port is dropped */
export function parseRemote(url: string): Remote | null {
  const m = /^(?:https:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/|ssh:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/|[^@/\s]+@([^/:\s]+):)(.+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!m) return null
  const host = (m[1] ?? m[2] ?? m[3]).toLowerCase()
  const parts = m[4].split('/')
  if (!HOST.test(host) || parts.length < 2 || !parts.every((p) => NAME.test(p) && p !== '.' && p !== '..')) return null
  return { host, path: parts.join('/') }
}

/** github.com goes to gh, a host with a "gitlab" label (gitlab.com, gitlab.acme.test) to glab, any other to neither */
// shortcut: GitLab is told by its host name and GitHub Enterprise is not supported; add a host list when someone asks
export function forgeOf(r: Remote): Forge | null {
  if (r.host === 'github.com') return r.path.split('/').length === 2 ? 'github' : null
  return r.host.split('.').includes('gitlab') ? 'gitlab' : null
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
 * upstream, github or origin, opened under the branch's name from the remote it tracks, or from origin.
 * Null when the two remotes are not on the same GitHub or GitLab host.
 */
export function targetOf(config: ReadonlyMap<string, string>, branch: string): Target | null {
  // A branch made from origin/main tracks main: that says nothing about where the branch itself is pushed
  const tracksItself = config.get(`branch.${branch}.merge`) === `refs/heads/${branch}`
  const remote = (tracksItself ? config.get(`branch.${branch}.remote`) : undefined) ?? 'origin'
  const pushed = parseRemote(config.get(`remote.${remote}.url`) ?? '')
  if (!pushed || !BRANCH.test(branch)) return null
  const remotes = [...config.keys()].filter((k) => k.startsWith('remote.') && k.endsWith('.url')).map((k) => k.slice(7, -4))
  const chosen = remotes.find((n) => config.get(`remote.${n}.gh-resolved`) === 'base') ?? BASE_ORDER.find((n) => remotes.includes(n)) ?? remote
  const base = parseRemote(config.get(`remote.${chosen}.url`) ?? '')
  const forge = base && base.host === pushed.host ? forgeOf(base) : null
  return forge && base ? { forge, host: base.host, repo: base.path, head: branch, headRepo: pushed.path } : null
}

type Row = { number: number; state: string; draft: boolean; sha: string | null }

/**
 * An open one first, else the newest merged or closed one whose last commit is the branch's HEAD (both CLIs list the
 * newest first): a branch that moved on since, like develop after a release, is not called merged
 */
function pick(rows: readonly Row[], forge: Forge, oid: string | null): PullRequest | null {
  const r = rows.find((x) => x.state === 'open') ?? rows.find((x) => oid !== null && x.sha === oid)
  if (!r) return null
  const state = r.state === 'open' ? (r.draft ? 'draft' : 'open') : r.state === 'merged' ? 'merged' : r.state === 'closed' ? 'closed' : null
  return state ? { forge, number: r.number, state } : null
}

function parseList(json: string): Record<string, unknown>[] | null {
  try {
    const rows: unknown = JSON.parse(json)
    return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null) : null
  } catch {
    return null
  }
}
const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const sha = (s: unknown): string | null => (typeof s === 'string' && /^[0-9a-f]{40,64}$/.test(s) ? s : null)

/** gh's JSON: only pull requests opened from `headOwner` (a branch of the same name in someone's fork does not count) */
export function pickGithub(json: string, headOwner: string, oid: string | null): PullRequest | null {
  const owner = headOwner.toLowerCase()
  const rows: Row[] = []
  for (const r of parseList(json) ?? []) {
    const login = (r.headRepositoryOwner as { login?: unknown } | null | undefined)?.login
    if (!isNumber(r.number) || typeof login !== 'string' || login.toLowerCase() !== owner) continue
    // gh says OPEN, MERGED, CLOSED
    rows.push({ number: r.number, state: String(r.state).toLowerCase(), draft: r.isDraft === true, sha: sha(r.headRefOid) })
  }
  return pick(rows, 'github', oid)
}

/** glab's JSON: merge requests from the same project, or from a fork when the branch is pushed to one */
export function pickGitlab(json: string, fromFork: boolean, oid: string | null): PullRequest | null {
  const rows: Row[] = []
  for (const r of parseList(json) ?? []) {
    if (!isNumber(r.iid) || !isNumber(r.source_project_id) || !isNumber(r.target_project_id)) continue
    if ((r.source_project_id !== r.target_project_id) !== fromFork) continue
    // GitLab says opened, merged, closed or locked (a locked one is closed for good)
    const state = r.state === 'opened' ? 'open' : r.state === 'locked' ? 'closed' : String(r.state)
    rows.push({ number: r.iid, state, draft: r.draft === true, sha: sha(r.sha) })
  }
  return pick(rows, 'gitlab', oid)
}

/**
 * Only what gh and glab need to find their login (config file or system keyring) and the network; no prompts,
 * no update check, no telemetry. GITLAB_TOKEN stays out: glab would send it to whatever host it asks, and that host
 * comes from the repository.
 */
export function cliEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1',
    GLAB_NO_PROMPT: '1', GLAB_CHECK_UPDATE: 'false', GLAB_SEND_TELEMETRY: 'false'
  }
  const keys = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GLAB_CONFIG_DIR',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
  ]
  for (const key of keys) {
    const v = source[key]
    if (typeof v === 'string') env[key] = v
  }
  return env
}

function runCli(name: 'gh' | 'glab', args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(CLI[name], args, { cwd: tmpdir(), env: cliEnv(), timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, encoding: 'utf8', windowsHide: true }, (err: Error | null, stdout: string) => {
      if (!err) return resolve(stdout)
      const e = err as Error & { killed?: boolean; code?: number | string }
      if (e.code === 'ENOENT') return reject(new Error(`${name} is not installed`))
      if (e.killed) return reject(new Error(`${name} timed out`))
      // gh exits with 4 when it needs a login
      if (name === 'gh' && e.code === 4) return reject(new Error('gh is not logged in'))
      reject(new Error(`${name} failed`))
    })
  })
}

/**
 * The pull or merge request of `branch` (HEAD at `oid`) in the worktree at `path`; null when it has none or its remotes
 * are elsewhere
 */
export async function lookupPullRequest(path: string, branch: string, oid: string | null): Promise<{ pr: PullRequest | null } | { error: string }> {
  try {
    const cfg = await runGit(path, [], ['config', '-z', '--get-regexp', CONFIG_KEYS])
    // Exit 1: no remote or branch configured
    const t = cfg.code === 0 ? targetOf(parseConfig(cfg.stdout), branch) : null
    if (!t) return { pr: null }
    if (t.forge === 'github') {
      const out = await runCli('gh', ['pr', 'list', `--repo=github.com/${t.repo}`, `--head=${t.head}`, '--state=all', '--json=number,state,isDraft,headRepositoryOwner,headRefOid', `--limit=${LIMIT}`])
      return { pr: pickGithub(out, t.headRepo.split('/')[0], oid) }
    }
    // The GitLab host comes from the repository's config: it is only asked when glab is logged in there (a local read)
    // shortcut: a login only by GITLAB_TOKEN is not supported (no user in glab's config, and the token is not passed on)
    if (!(await runCli('glab', ['config', 'get', `--host=${t.host}`, 'user'])).trim()) return { pr: null }
    // The full URL: "host/group/project" could be read as a group path on glab's default host
    const out = await runCli('glab', ['mr', 'list', `--repo=https://${t.host}/${t.repo}`, `--source-branch=${t.head}`, '--all', '--output=json', `--per-page=${LIMIT}`])
    return { pr: pickGitlab(out, t.headRepo !== t.repo, oid) }
  } catch (e) {
    return { error: e instanceof Error && /^(gh|glab) /.test(e.message) ? e.message : 'git failed' }
  }
}
