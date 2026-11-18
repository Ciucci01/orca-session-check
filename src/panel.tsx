// Panel: every Orca worktree with its uncommitted files, unpushed commits, stash and agent, plus a traffic light
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import { chips, stateLabel, GROUP_TITLE, GROUPS, groupOf, type Group } from './chips'
import type { Config, Session, SessionsState } from './protocol'

type Filter = 'all' | 'changes' | 'safe'
type Grouping = 'status' | 'project'

const state = atom<SessionsState | null>(null)
const config = atom<Config>({ baseBranch: '', intervalSeconds: 30 })
// Filter and grouping are remembered between runs; the stored value is checked before it is used
const filter = atom<Filter>('filter', 'all', { persist: 'plugin' })
const query = atom('')
const grouping = atom<Grouping>('grouping', 'status', { persist: 'plugin' })
const refreshing = atom(false)
const notice = atom('')
const showHidden = atom(false)
const baseDraft = atom<string | null>(null)

const INTERVALS = [10, 30, 60, 120, 300]

const message = (err: unknown) => String(err instanceof Error ? err.message : err)

async function refresh(quiet = false): Promise<void> {
  if (!quiet) set(refreshing, true)
  try {
    set(state, await plugin.request('sessions.refresh'))
    if (!quiet) set(notice, '')
  } catch (err) {
    // A failed background scan keeps the last list
    if (!quiet) set(notice, message(err))
  } finally {
    if (!quiet) set(refreshing, false)
  }
}

async function open(s: Session): Promise<void> {
  set(notice, '')
  try {
    await plugin.request('session.open', { id: s.id })
  } catch (err) {
    set(notice, message(err))
  }
}

async function hide(s: Session, hidden: boolean): Promise<void> {
  try {
    set(state, await plugin.request('session.hide', { id: s.id, hidden }))
  } catch (err) {
    set(notice, message(err))
  }
}

let rearm: ((seconds: number) => void) | undefined

async function updateConfig(change: Partial<Config>): Promise<void> {
  set(config, { ...read(config), ...change })
  try {
    const next = await plugin.request('config.set', change)
    set(config, next)
    rearm?.(next.intervalSeconds)
    if (change.baseBranch !== undefined) void refresh()
  } catch (err) {
    set(notice, message(err))
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('sessions.changed', (s) => set(state, s)))
  void plugin
    .request('sessions.get')
    .then((s) => set(state, s))
    .catch((err) => set(notice, message(err)))
  // The open panel looks again from time to time; the worker itself runs no timer
  let timer: ReturnType<typeof setInterval> | undefined
  rearm = (seconds) => {
    if (timer) clearInterval(timer)
    timer = setInterval(() => void refresh(true), seconds * 1000)
  }
  rearm(read(config).intervalSeconds)
  void plugin.request('config.get').then((c) => {
    set(config, c)
    rearm?.(c.intervalSeconds)
  }).catch(() => undefined)
  ctx.subscriptions.push({
    dispose: () => {
      if (timer) clearInterval(timer)
      rearm = undefined
    }
  })
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** First line of a row: the project and the worktree, e.g. "acme-shop / checkout" */
function title(s: Session): string {
  return s.project && s.project !== s.name ? `${s.project} / ${s.name}` : s.name
}

/** Second line: the branch, only when it tells more than the name */
function subline(s: Session): string | null {
  const branch = s.branch ?? 'detached HEAD'
  return branch === s.name ? null : branch
}

/** The first changed files and the size of the change, e.g. "+120 -30 · cart.tsx, checkout.tsx +2" */
function glance(s: Session): string | null {
  if (s.uncommitted === 0 && s.untracked === 0) return null
  const parts: string[] = []
  if (s.added !== null && s.removed !== null && s.uncommitted > 0) parts.push(`+${s.added} -${s.removed}`)
  const names = s.files.slice(0, 3).map((f) => f.path)
  const rest = s.files.length + s.moreFiles - names.length
  if (names.length) parts.push(`${names.join(', ')}${rest > 0 ? ` +${rest}` : ''}`)
  return parts.join(' · ') || null
}

/** Details behind the fold: changed files and the numbers that only matter when you look closer */
function detailNotes(s: Session): string[] {
  const notes: string[] = []
  if (s.staged > 0) notes.push(`${s.staged} of the changed files staged`)
  if (s.upstream) notes.push(`upstream ${s.upstream}`)
  if (s.stashTotal > s.stash) notes.push(`${plural(s.stashTotal - s.stash, 'stash entry', 'stash entries')} on other branches`)
  if (s.merged === true && s.ahead > 0) notes.push('all commits are already in the base branch')
  return notes
}

function SessionCard({ s }: { s: Session }) {
  const notes = detailNotes(s)
  const hasDetails = s.files.length > 0 || notes.length > 0 || s.unpushed.length > 0
  const look = glance(s)
  return (
    <Box border={s.current ? 'accent' : true} radius="md" padding="sm">
      <Stack gap="xs">
        <Row justify="between" gap="xs" align="center">
          <Row gap="xs" align="center">
            <Text weight="semibold" truncate>
              {title(s)}
            </Text>
          </Row>
          <Row gap="xs" align="center">
            <Button size="xs" variant="outline" onPress={() => void open(s)}>
              {`Open`}
            </Button>
            <Button size="xs" variant="ghost" onPress={() => void hide(s, !s.hidden)}>
              {s.hidden ? 'Show' : 'Hide'}
            </Button>
          </Row>
        </Row>
        {subline(s) ? (
          <Text size="xs" muted truncate>
            {subline(s)}
          </Text>
        ) : null}
        <Row gap="xs" wrap>
          {chips(s).map((c) => (
            <Badge key={c.text} tone={c.tone}>
              {c.text}
            </Badge>
          ))}
        </Row>
        {look ? (
          <Text size="xs" truncate>
            {look}
          </Text>
        ) : null}
        {s.dirtySince || s.lastCommitAt || s.lastActiveAt ? (
          <Text size="xs" muted>
            {s.dirtySince ? <>oldest change <RelativeTime at={s.dirtySince} format="short" /></> : null}
            {s.dirtySince && (s.lastCommitAt || s.lastActiveAt) ? ' · ' : null}
            {s.lastCommitAt ? <>commit <RelativeTime at={s.lastCommitAt} format="short" /></> : null}
            {s.lastCommitAt && s.lastActiveAt ? ' · ' : null}
            {s.lastActiveAt ? <>active <RelativeTime at={s.lastActiveAt} format="short" /></> : null}
          </Text>
        ) : null}
        {hasDetails ? (
          <Collapsible title={s.files.length > 0 ? `Files (${s.files.length + s.moreFiles})` : 'Details'}>
            <Stack gap="xs">
              {s.unpushed.length > 0 ? (
                <Stack gap="xs">
                  <Text size="xs" weight="semibold">
                    {`Unpushed: ${s.ahead}`}
                  </Text>
                  {s.unpushed.map((m, i) => (
                    <Text key={`${i}:${m}`} size="xs" truncate>
                      {m}
                    </Text>
                  ))}
                  {s.ahead > s.unpushed.length ? (
                    <Text size="xs" muted>
                      {`…and ${s.ahead - s.unpushed.length} more`}
                    </Text>
                  ) : null}
                </Stack>
              ) : null}
              {s.files.map((f, i) => (
                <Text key={`${i}:${f.path}`} size="xs" truncate>
                  {`${stateLabel(f.state)}: ${f.path}`}
                </Text>
              ))}
              {s.moreFiles > 0 ? (
                <Text size="xs" muted>
                  {`…and ${s.moreFiles} more`}
                </Text>
              ) : null}
              {notes.map((n) => (
                <Text key={n} size="xs" muted>
                  {n}
                </Text>
              ))}
            </Stack>
          </Collapsible>
        ) : null}
      </Stack>
    </Box>
  )
}

/** Worktrees of the same project together; projects with the most uncommitted files first */
function byProject(list: Session[]): [string, Session[]][] {
  const map = new Map<string, Session[]>()
  for (const s of list) map.set(s.project ?? '(no project)', [...(map.get(s.project ?? '(no project)') ?? []), s])
  const dirty = (items: Session[]) => items.reduce((n, x) => n + x.uncommitted, 0)
  return [...map.entries()].sort((a, b) => dirty(b[1]) - dirty(a[1]) || a[0].localeCompare(b[0]))
}

function GroupTitle({ group, count }: { group: Group; count: number }) {
  return (
    <Row justify="between">
      <Text weight="semibold">{GROUP_TITLE[group]}</Text>
      <Badge>{String(count)}</Badge>
    </Row>
  )
}

function SettingsBox() {
  const c = read(config)
  const draft = read(baseDraft)
  return (
    <Collapsible title="Settings" description="base branch, refresh">
      <Stack gap="sm">
        <Input
          label="Base branch (empty = detect from origin/HEAD)"
          placeholder="origin/main"
          value={draft ?? c.baseBranch}
          maxLength={200}
          onChange={(v) => set(baseDraft, v)}
          onSubmit={(v) => {
            set(baseDraft, null)
            void updateConfig({ baseBranch: v.trim() })
          }}
        />
        <Select
          label="Refresh while the panel is open"
          value={String(c.intervalSeconds)}
          options={INTERVALS.map((n) => ({ value: String(n), label: `every ${n} seconds` }))}
          onChange={(v) => void updateConfig({ intervalSeconds: Number(v) })}
        />
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const s = read(state)
  if (!s) return read(notice) ? <Callout tone="danger">{read(notice)}</Callout> : <Skeleton lines={4} label="Loading" />
  const stored = read(filter)
  const f: Filter = stored === 'changes' || stored === 'safe' ? stored : 'all'
  const by = read(grouping) === 'project' ? 'project' : 'status'
  const q = read(query).trim().toLowerCase()
  const matches = (x: Session) => !q || `${x.project ?? ''} ${x.name} ${x.branch ?? ''}`.toLowerCase().includes(q)
  // The session you are in is pinned on top, whatever filter, search or grouping is set
  const current = s.sessions.find((x) => x.current) ?? null
  const listed = s.sessions.filter((x) => !x.current && (!x.hidden || read(showHidden)) && matches(x))
  const counted = s.sessions.filter((x) => !x.hidden)
  const dirty = counted.filter((x) => x.uncommitted > 0).length
  const safe = counted.filter((x) => groupOf(x) === 'safe').length
  const hiddenCount = s.sessions.filter((x) => x.hidden).length
  const groups = GROUPS.map((g) => ({ group: g, items: listed.filter((x) => groupOf(x) === g) })).filter(
    (g) => g.items.length > 0 && (f === 'all' || (f === 'changes' && g.group === 'dirty') || (f === 'safe' && g.group === 'safe'))
  )
  const FILTERS: [Filter, string][] = [
    ['all', `All ${counted.length}`],
    ['changes', `Uncommitted ${dirty}`],
    ['safe', `Can close ${safe}`]
  ]
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={3}>Session Check</Heading>
        <IconButton icon="refresh" label="Rescan worktrees" disabled={read(refreshing)} onPress={() => void refresh()} />
      </Row>
      <Text muted={dirty === 0} tone={dirty === 0 ? 'success' : undefined}>
        {dirty > 0 ? `${plural(dirty, 'worktree')} with uncommitted files` : 'Everything is committed'}
      </Text>
      {read(notice) ? <Callout tone="danger">{read(notice)}</Callout> : null}
      {s.truncated ? <Callout tone="warning">Only the first 100 workspaces are checked.</Callout> : null}
      {current ? (
        <Stack gap="sm">
          <Text weight="semibold">Current session</Text>
          <SessionCard s={current} />
        </Stack>
      ) : null}
      <Row gap="xs" wrap>
        {FILTERS.map(([value, label]) => (
          <Button key={value} size="sm" variant={f === value ? 'solid' : 'outline'} onPress={() => set(filter, value)}>
            {label}
          </Button>
        ))}
      </Row>
      <Input label="Search worktrees" labelHidden type="search" placeholder="Search project, worktree or branch" value={read(query)} maxLength={100} onChange={(v) => set(query, v)} />
      <Row gap="xs" align="center">
        <Text size="xs" muted>
          Group by
        </Text>
        {(['status', 'project'] as Grouping[]).map((g) => (
          <Button key={g} size="xs" variant={by === g ? 'solid' : 'ghost'} onPress={() => set(grouping, g)}>
            {g}
          </Button>
        ))}
      </Row>
      {s.sessions.length === 0 ? (
        <EmptyState title="No workspaces" description="Add a workspace in Orca, then rescan." />
      ) : groups.length === 0 ? (current ? null : (
        <EmptyState title="Nothing matches" description="No worktree fits the filter." />)
      ) : by === 'project' ? (
        byProject(groups.flatMap((g) => g.items)).map(([project, items]) => (
          <Stack key={project} gap="sm">
            <Row justify="between">
              <Text weight="semibold">{project}</Text>
              <Badge>{String(items.length)}</Badge>
            </Row>
            <Stack gap="sm">
              {items.map((x) => (
                <SessionCard key={x.id} s={x} />
              ))}
            </Stack>
          </Stack>
        ))
      ) : (
        groups.map(({ group, items }) => {
          const cards = (
            <Stack gap="sm">
              {items.map((x) => (
                <SessionCard key={x.id} s={x} />
              ))}
            </Stack>
          )
          // Quiet groups fold away; the ones that need a decision stay open
          return group === 'unknown' || group === 'safe' ? (
            <Collapsible key={group} title={GROUP_TITLE[group]} description={String(items.length)} defaultOpen={group === 'safe'}>
              {cards}
            </Collapsible>
          ) : (
            <Stack key={group} gap="sm">
              <GroupTitle group={group} count={items.length} />
              {cards}
            </Stack>
          )
        })
      )}
      {hiddenCount ? (
        <Button variant="ghost" onPress={() => set(showHidden, !read(showHidden))}>
          {read(showHidden) ? 'Hide hidden worktrees' : `Show hidden worktrees (${hiddenCount})`}
        </Button>
      ) : null}
      <Separator />
      <Text size="xs" muted>
        Unpushed and behind use the last known upstream. Nothing is fetched.
      </Text>
      <SettingsBox />
    </Stack>
  )
}
