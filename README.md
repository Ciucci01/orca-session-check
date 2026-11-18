# Session Check for Orca

See at a glance which of your Orca worktrees still have **uncommitted files**. A sidebar panel lists every local worktree with its uncommitted, staged and untracked files, unpushed commits, stash entries and running agent, and gives each one a traffic light: can you close this session, or not?

Made by [BroDesigns](https://brodesigns.de).

## Features

- **Uncommitted files first:** a banner says how many worktrees have uncommitted files, and the list is grouped: *Uncommitted files* (most files on top), *Keep open*, *Check first*, *Can close* and *Not checked*. The last two fold away. Filter buttons show only the uncommitted or only the closable ones.
- **One compact card per worktree:** project and worktree name, colored chips (`14 changed`, `13 unpushed`, `agent working`, `3 untracked`, `1 stash`, `no upstream`, `clean`) and a red border when files are uncommitted.
- **Traffic light per worktree**

| Light | Meaning |
|---|---|
| Keep open (red) | uncommitted or conflicted files, unpushed commits, an agent working or waiting for you, or a merge, rebase, cherry-pick, revert or bisect in progress |
| Check first (yellow) | only untracked files, stash entries, a branch without upstream that has commits outside the base branch, or a detached HEAD |
| Can close (green) | clean, nothing unpushed, or every commit is already in the base branch, and no agent is active |
| Not checked (grey) | folder workspace, remote workspace, not a git repository, git missing or failing: the reason is shown, nothing is guessed |

  When in doubt it is stricter: a worktree is never green because something could not be read. A repository with submodules is at most yellow (their changes are not looked at), and so is a branch whose upstream was deleted. Filters such as Git LFS are not run, so LFS files can show up as modified when only their time stamp changed.
- **Changed files:** open *Files* on a card to see the first 20 changed files with their git status.
- **Current session** is pinned on top of the list, whatever filter, search or grouping is set.
- **Open** jumps to the worktree in Orca. **Hide** only removes a worktree from this list (nothing is closed or deleted, *Show hidden* brings it back). A worktree with open work cannot be hidden, and a hidden one is shown again as soon as it gets worse than it was when you hid it.
- **Age and size:** each card shows the oldest uncommitted change, the last commit and the last activity Orca saw, so forgotten sessions stand out, plus `+120 -30` lines and the first changed file names. Only time stamps are read, never file contents.
- **Unpushed commits** are named (first three subjects) under *Details*. A branch whose commits are already in the base branch shows a green `merged` chip.
- **Search** by project, worktree or branch. Filter and grouping are remembered.
- **Group by** status (default) or by project.
- The open panel rescans every 30 seconds (10 to 300, setting) and when agents or workspaces change.
- Branch stash entries are counted per branch (git shares one stash between all worktrees).
- Unpushed and behind counts use the **last known** upstream. Nothing is fetched, so run `git fetch` yourself if you want fresh numbers. "Already in the base branch" compares with `origin/HEAD` (or `origin/main`, `origin/master`, or the base branch you set).

It only shows. It never closes, deletes, commits, stashes, pushes or fetches anything and does not read file contents.

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

Workspaces on other hosts (SSH) are listed as "not checked", and so are partial clones.

## Install

In Orca: Settings, Plugins, add the marketplace, search for **Session Check**, review the access and approve it. Needs Orca 1.4.259 or newer and `git` in your `PATH`.

## Settings

| Setting | Default | |
|---|---|---|
| Base branch | empty | Branch that counts as "already merged", for example `origin/main`. Empty detects it from `origin/HEAD`. |
| Refresh interval | 30 s | How often the open panel rescans. |

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
