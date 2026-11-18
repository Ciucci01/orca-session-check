<p align="center">
  <img src="assets/cover.png" alt="Session Check for Orca: which worktrees still have uncommitted work? Know before you close a session." />
</p>

# Session Check for Orca

**Know which Orca sessions still have open work before you close them.** A sidebar panel lists every local worktree with its uncommitted files, unpushed commits, stash entries and running agent, and gives each one a clear verdict: keep it open, check it first, or close it.

Made by [BroDesigns](https://brodesigns.de). Read-only: it never closes, deletes, commits, stashes, pushes or fetches anything, and never reads file contents.

![The Session Check panel: current session on top, then worktrees grouped by status with colored chips](assets/screenshot-overview.png)

## What you get

- **Current session on top.** The workspace you are in is pinned above the list, whatever filter, search or grouping is set.
- **Uncommitted files first.** A short line tells you how many worktrees have uncommitted files. The list is grouped into *Uncommitted files* (most files on top), *Keep open*, *Check first*, *Can close* and *Not checked*. The last two fold away.
- **One compact card per worktree.** Project and worktree name, branch, and chips such as `14 changed`, `13 unpushed`, `agent working`, `3 untracked`, `1 stash`, `no upstream`, `merged` or `clean`. Red is only used for conflicts and a running merge or rebase, so the panel stays calm.
- **Size and age at a glance.** `+120 -30` lines, the first changed file names, the oldest uncommitted change, the last commit and the last activity Orca saw. Forgotten sessions stand out. Only time stamps are read, never file contents.
- **Details on demand.** Open *Files* to see the first 20 changed files in plain words (`new`, `edited`, `deleted`, `renamed`, `conflict`), plus the subjects of the first three unpushed commits.
- **Search, filter, group.** Search by project, worktree or branch. Filter to uncommitted or closable worktrees. Group by status or by project. Filter and grouping are remembered.
- **Open** jumps to the worktree in Orca. **Hide** only removes a worktree from the list (nothing is closed or deleted, *Show hidden* brings it back).
- **Hiding is safe.** A worktree with open work cannot be hidden, and a hidden one comes back as soon as it gets worse than it was when you hid it.
- **Stays current.** The open panel rescans every 30 seconds (10 to 300, setting) and when agents or workspaces change.

| Group by status | Group by project | Light theme |
|---|---|---|
| ![Grouped by status](assets/screenshot-overview.png) | ![Grouped by project](assets/screenshot-projects.png) | ![Light theme](assets/screenshot-light.png) |

## The verdicts

| Verdict | Meaning |
|---|---|
| **Keep open** | uncommitted or conflicted files, unpushed commits, an agent working or waiting for you, or a merge, rebase, cherry-pick, revert or bisect in progress |
| **Check first** | only untracked files, stash entries, a branch without upstream that has commits outside the base branch, a deleted upstream, a detached HEAD, or submodules (their changes are not looked at) |
| **Can close** | clean, nothing unpushed (or every commit is already in the base branch), and no active agent |
| **Not checked** | folder workspace, remote (SSH) workspace, partial clone, not a git repository, git missing or failing. The reason is shown, nothing is guessed |

When in doubt it is stricter: a worktree is never shown as closable because something could not be read.

Good to know:

- Unpushed and behind counts use the **last known** upstream. Nothing is fetched, so run `git fetch` yourself for fresh numbers.
- "Already in the base branch" compares with `origin/HEAD` (or `origin/main`, `origin/master`, or the base branch you set).
- Git shares one stash between all worktrees, so stash entries are counted per branch.
- Filters such as Git LFS are not run, so LFS files can show up as modified when only their time stamp changed.

## Install

In Orca: Settings, Plugins, add the marketplace, search for **Session Check**, review the access and approve it. Needs Orca 1.4.259 or newer and `git` in your `PATH`.

## Settings

| Setting | Default | |
|---|---|---|
| Base branch | empty | Branch that counts as "already merged", for example `origin/main`. Empty detects it from `origin/HEAD`. |
| Refresh interval | 30 s | How often the open panel rescans. |

## Why "Full access"?

Orca labels every plugin with a worker this way. This plugin:

- reads your workspace list (names, branches, paths, agent status) and gets notified when workspaces or agents change
- uses the **workspace write** permission only for one call, `workspace.open`, when you press **Open**. Orca's wording for that permission is broader (it also covers renaming workspaces and similar), the plugin calls nothing else.
- runs the system tool `git` in your local worktrees with fixed arguments, read-only (`status`, `stash list`, `log`, `diff --shortstat`, `rev-parse`, `symbolic-ref`, `merge-base`, `config` to list names). It never uses a shell, never fetches or pushes, and passes only a short list of environment variables (`PATH`, `HOME`, ...).
- treats every repository as untrusted. A repository's own config can make git start programs, so the plugin switches off `core.fsmonitor`, hooks, `log.showSignature` (gpg) and every network protocol (a partial clone would fetch missing objects on its own), sets `GIT_NO_LAZY_FETCH`, skips partial clones, and empties every `filter.*.clean`, `smudge` and `process` command the repository defines. Tests with malicious repositories prove that these programs do not run, and that they do run when git is called without this protection. An independent security review found three of these cases; they are fixed and tested.
- stops git after 8 seconds or 2 MB of output, runs at most 4 repositories at the same time and checks at most 100 workspaces
- makes no network requests and collects nothing
- reads the time of the last commit and the first unpushed commit subjects (`git log`), the size of your changes (`git diff --shortstat`, with textconv and external diff switched off) and the modification time of changed files (`lstat`, no symlinks followed, no contents)
- stores only the list of worktrees you hid, in the plugin's own storage

## Development

```bash
orca plugin types .       # write the typings to .orca/
orca plugin test .        # unit tests, real temporary git repositories
orca plugin validate .
orca plugin dev watch .   # load into Orca and stream logs
```

The git logic is in `src/git.ts` (pure functions: arguments, parsers, verdict). `src/runner.ts` is the only place that starts git. `src/worker.ts` scans and answers the panel, `src/chips.ts` turns the numbers into chips and groups, `src/panel.tsx` draws it. About 1,000 lines of code in `src/`, plus tests.

## License

MIT, see [LICENSE](LICENSE).
