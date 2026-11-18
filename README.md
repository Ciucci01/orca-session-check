# Session Check for Orca: know which sessions still have open work

An [Orca](https://github.com/stablyai/orca) plugin that shows, for every local worktree, its **uncommitted files, unpushed commits, stash entries and running agent**, and tells you which sessions you can close and which you should keep open.

![Session Check for Orca: which worktrees still have uncommitted work? Know before you close a session.](assets/cover.png)

## Why

After a day with several agents you have a dozen worktrees open and no idea which of them still hold work that exists nowhere else. Closing the wrong one loses it. Session Check reads the git state of every worktree and shows you the facts, so you can close the clean ones and finish the others.

## What you get

- **Current session on top:** the workspace you are in is pinned above the list, whatever filter or search is set.
- **Uncommitted files first:** a short line says how many worktrees have uncommitted files, and the list is grouped into *Uncommitted files* (most files on top), *Keep open*, *Check first*, *Can close* and *Not checked*.
- **One compact card per worktree:** project, branch and chips such as `14 changed`, `13 unpushed`, `agent working`, `3 untracked`, `1 stash`, `merged` or `clean`. Red is only for conflicts and a running merge or rebase, so the panel stays calm.
- **Size and age at a glance:** `+120 -30` lines, the first changed files, the oldest uncommitted change, the last commit and the last activity Orca saw. Forgotten sessions stand out.
- **Details on demand:** the first 20 changed files in plain words (`new`, `edited`, `deleted`, `renamed`, `conflict`) and the subjects of the first three unpushed commits.
- **Search, filter, group:** by project, worktree or branch; uncommitted or closable only; by status or by project. Your choices are remembered.
- **Open and hide:** *Open* jumps to the worktree in Orca. *Hide* only removes it from the list, and a hidden worktree comes back as soon as it gets worse than it was.
- **Status bar count:** `Sessions 3 open` or `Sessions ok` in Orca's status bar, without opening the panel. Hidden worktrees do not count, and a worktree that could not be checked never counts as ok (`Sessions ?` when none could be checked). The tooltip names the five worktrees with the most uncommitted files. Clicking it rescans.
- **Agent finished, work left:** a desktop notification such as `acme-shop / checkout: agent finished, 3 files uncommitted` when an agent stops and its worktree still has uncommitted files, new files or unpushed commits. At most one per worktree every 10 minutes, never for hidden or clean worktrees, and you can switch it off.
- **English, German, Spanish:** the panel, the status bar and the notification follow Orca's language, or the one you pick in the settings. Names, branches and file paths are always shown as they are.
- **Facts only:** it never closes, deletes, commits, stashes, pushes or fetches anything, and never reads file contents.

## See it

**Which sessions have open work.** The current session on top, then worktrees grouped by status.

![Current session on top, then worktrees grouped by status with colored chips](assets/screenshot-overview.png)

**Open a card.** Changed files in plain words, and the commits that exist only on your machine.

![One worktree card opened: chips, lines changed, changed files and unpushed commits](assets/screenshot-details.png)

**See it without opening the panel.** The status bar count and the notification when an agent leaves work behind.

![Status bar item with a tooltip and a desktop notification](assets/screenshot-alerts.png)

**English, Deutsch, Español.** The panel follows Orca's language or the one you pick in the settings.

![The same panel in English, German and Spanish](assets/screenshot-languages.png)

**One project at a time.** The same list grouped by project.

![The worktrees grouped by project](assets/screenshot-projects.png)

**Light theme.** It follows Orca's theme.

![The panel in Orca's light theme](assets/screenshot-light.png)

## The verdicts

![The four verdicts: keep open, check first, can close and not checked](assets/screenshot-verdicts.png)

| Verdict | Meaning |
|---|---|
| **Keep open** | uncommitted or conflicted files, unpushed commits, an agent working or waiting for you, a detached HEAD with commits no base branch holds, or a merge, rebase, cherry-pick, revert or bisect in progress |
| **Check first** | only untracked files, stash entries, a branch without upstream that has commits outside the base branch, a deleted upstream, a detached HEAD without own commits, or submodules (their changes are not looked at) |
| **Can close** | clean, nothing unpushed (or every commit is already in the base branch), and no active agent |
| **Not checked** | folder workspace, remote (SSH) workspace, partial clone, not a git repository, git missing or failing. The reason is shown, nothing is guessed |

When in doubt it is stricter: a worktree is never shown as closable because something could not be read.

## Install

Requires Orca 1.4.259 or newer and `git` in your `PATH`. Tested with git 2.42 and newer.

1. In Orca, open **Settings → Plugins**.
2. Add the marketplace `https://github.com/stablyai/orca-community-plugins.git` (ref `main`).
3. Search for **Session Check**, install it and approve the access.

From source: `git clone https://github.com/brodesigns/orca-session-check`, then `orca plugin dev load .` in the folder.

## Settings

| Setting | Default | |
|---|---|---|
| Base branch | empty | Branch that counts as "already merged", for example `origin/main`. Empty detects it from `origin/HEAD`. |
| Refresh interval | 30 s | How often the open panel rescans (10 to 300 seconds). |
| Background refresh | 120 s | How often the status bar count is refreshed while the panel is closed (30 to 600 seconds, `0` = off). Agent and workspace changes rescan the workspace concerned either way. |
| Notify when an agent finishes | on | The desktop notification described above. |
| Language | Automatic | `Automatic` follows Orca's language (English when it is none of the three), or pick English, Deutsch or Español. |

The worker rescans on its own: once shortly after Orca starts, when an agent or a workspace changes (only the workspace concerned), and on the background refresh. A workspace is read again on its own account at most every 15 seconds, and at most 4 repositories are read at the same time.

## Privacy and access

Orca labels every plugin with a worker "Full access". Here is what this one does with it:

![Why Full access? Read-only, repositories are untrusted, no network, almost nothing stored](assets/screenshot-access.png)

- reads your workspace list (names, branches, paths, agent status) and gets notified when workspaces or agents change
- uses the **workspace write** permission only for one call, `workspace.open`, when you press **Open**. Orca's wording for that permission is broader (it also covers renaming workspaces and similar), the plugin calls nothing else.
- runs the system tool `git` in your local worktrees with fixed arguments, read-only (`status`, `stash list`, `log`, `diff --shortstat`, `rev-parse`, `symbolic-ref`, `merge-base`, `config` to list names). It never uses a shell, never fetches or pushes, and passes only a short list of environment variables (`PATH`, `HOME`, ...).
- treats every repository as untrusted. A repository's own config can make git start programs, so the plugin switches off `core.fsmonitor`, hooks, `log.showSignature` (gpg) and every network protocol (a partial clone would fetch missing objects on its own), sets `GIT_NO_LAZY_FETCH`, skips partial clones, ignores the worktree's `.gitattributes`, and empties every `filter.*.clean`, `smudge` and `process` command the repository defines. Tests with malicious repositories prove that these programs do not run, and that they do run when git is called without this protection. Two independent security reviews found issues, all fixed and tested.
- stops git after 8 seconds or 2 MB of output, runs at most 4 repositories at the same time and checks at most 100 workspaces
- rescans in the background while Orca runs (see Settings), with the same fixed git calls and limits; set the background refresh to `0` to keep only the event-driven rescans
- uses the **notifications** permission only for the "agent finished" notification. It contains the project and worktree name (cleaned of control characters and cut to 40 characters) and counts, never file names or file contents. The status bar item shows the same kind of text.
- makes no network requests and collects nothing
- reads the time of the last commit and the first unpushed commit subjects (`git log`), the size of your changes (`git diff --shortstat`, with textconv and external diff switched off) and the modification time of changed files (`lstat`, no symlinks followed, no contents)
- stores only the list of worktrees you hid, in the plugin's own storage, and its settings

## Good to know

- Unpushed and behind counts use the **last known** upstream. Nothing is fetched, so run `git fetch` yourself for fresh numbers.
- "Already in the base branch" compares with the remote-tracking branch `origin/HEAD` (or `origin/main`, `origin/master`, or the base branch you set). A local branch never counts as the base.
- Git shares one stash between all worktrees, so stash entries are counted per branch.
- Filters such as Git LFS are not run, and the `.gitattributes` of the worktree is ignored (a repository must not be able to start a program through it). So LFS files and files with an `eol` attribute can show up as modified when only their time stamp changed. That is the stricter side.
- Workspaces on other hosts (SSH) and partial clones are listed as "not checked".

<details>
<summary>How it works, develop</summary>

The git logic is in `src/git.ts` (pure functions: arguments, parsers, verdict). `src/runner.ts` is the only place that starts git. `src/worker.ts` scans, answers the panel, updates the status bar and sends the notification, `src/summary.ts` builds their text, `src/chips.ts` turns the numbers into chips and groups, `src/i18n.ts` holds every text in English, German and Spanish, `src/panel.tsx` draws it. About 2,000 lines of code in `src/`, plus tests that run against real temporary git repositories, including malicious ones.

```bash
orca plugin types .       # write the typings to .orca/
orca plugin test .        # unit tests
orca plugin validate .
orca plugin dev watch .   # load into Orca and stream logs
```

</details>

Made by [BroDesigns](https://brodesigns.de). MIT, see [LICENSE](LICENSE).
