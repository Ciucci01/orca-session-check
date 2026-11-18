// Panel: every Orca worktree with its uncommitted files, unpushed commits, stash and agent, plus a traffic light
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  env,
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
  Switch,
  Text,
  type PanelContext
} from 'orca'
import { chips, stateLabel, groupTitle, GROUPS, groupOf, type Group } from './chips'
import { errorText, LANGUAGE_NAMES, LANGUAGE_SETTINGS, languageSetting, resolveLang, tr, type Lang, type LanguageSetting } from './i18n'
import type { Config, Session, SessionsState } from './protocol'

type Filter = 'all' | 'changes' | 'safe'
type Grouping = 'status' | 'project'

const state = atom<SessionsState | null>(null)
const config = atom<Config>({ baseBranch: '', intervalSeconds: 30, notifyOnAgentDone: true, backgroundSeconds: 120, language: 'auto' })
// Filter and grouping are remembered between runs; the stored value is checked before it is used
const filter = atom<Filter>('filter', 'all', { persist: 'plugin' })
const query = atom('')
const grouping = atom<Grouping>('grouping', 'status', { persist: 'plugin' })
const refreshing = atom(false)
const notice = atom('')
const showHidden = atom(false)
const baseDraft = atom<string | null>(null)

const INTERVALS = [10, 30, 60, 120, 300]
const BACKGROUND = [0, 30, 60, 120, 300, 600]

const message = (err: unknown) => String(err instanceof Error ? err.message : err)
const MAX_WORKSPACES = 100

/** Orca's UI language, read while rendering */
function uiLocale(): string {
  try {
    return typeof env.locale === 'string' ? env.locale : ''
  } catch {
    return ''
  }
}
/** The language the panel speaks now: an explicit setting wins, auto follows Orca */
function currentLang(): Lang {
  return resolveLang(read(config).language, uiLocale())
}

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
  // The worker has no locale API: it learns Orca's language from the panel (status bar, notification)
  const locale = uiLocale()
  if (locale) void plugin.request('ui.locale', { locale }).catch(() => undefined)
  void plugin
    .request('sessions.get')
    .then((s) => set(state, s))
    .catch((err) => set(notice, message(err)))
  // The open panel looks again from time to time; the worker's own background scan is slower
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

/** First line of a row: the project and the worktree, e.g. "acme-shop / checkout" */
function title(s: Session): string {
  return s.project && s.project !== s.name ? `${s.project} / ${s.name}` : s.name
}

/** Second line: the branch, only when it tells more than the name */
function subline(s: Session, lang: Lang): string | null {
  const branch = s.branch ?? tr(lang, 'card.detached')
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
function detailNotes(s: Session, lang: Lang): string[] {
  const notes: string[] = []
  if (s.staged > 0) notes.push(tr(lang, 'card.staged', { n: s.staged }))
  if (s.upstream) notes.push(tr(lang, 'card.upstream', { name: s.upstream }))
  if (s.stashTotal > s.stash) notes.push(tr(lang, 'card.otherStash', { n: s.stashTotal - s.stash }))
  if (s.merged === true && s.ahead > 0) notes.push(tr(lang, 'card.allMerged'))
  return notes
}

function SessionCard({ s }: { s: Session }) {
  const lang = currentLang()
  const sub = subline(s, lang)
  const notes = detailNotes(s, lang)
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
              {tr(lang, 'card.open')}
            </Button>
            <Button size="xs" variant="ghost" onPress={() => void hide(s, !s.hidden)}>
              {s.hidden ? tr(lang, 'card.show') : tr(lang, 'card.hide')}
            </Button>
          </Row>
        </Row>
        {sub ? (
          <Text size="xs" muted truncate>
            {sub}
          </Text>
        ) : null}
        <Row gap="xs" wrap>
          {chips(s, lang).map((c) => (
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
            {s.dirtySince ? <>{`${tr(lang, 'card.oldestChange')} `}<RelativeTime at={s.dirtySince} format="short" /></> : null}
            {s.dirtySince && (s.lastCommitAt || s.lastActiveAt) ? ' · ' : null}
            {s.lastCommitAt ? <>{`${tr(lang, 'card.commit')} `}<RelativeTime at={s.lastCommitAt} format="short" /></> : null}
            {s.lastCommitAt && s.lastActiveAt ? ' · ' : null}
            {s.lastActiveAt ? <>{`${tr(lang, 'card.active')} `}<RelativeTime at={s.lastActiveAt} format="short" /></> : null}
          </Text>
        ) : null}
        {hasDetails ? (
          <Collapsible title={s.files.length > 0 ? tr(lang, 'card.files', { n: s.files.length + s.moreFiles }) : tr(lang, 'card.details')}>
            <Stack gap="xs">
              {s.unpushed.length > 0 ? (
                <Stack gap="xs">
                  <Text size="xs" weight="semibold">
                    {tr(lang, 'card.unpushed', { n: s.ahead })}
                  </Text>
                  {s.unpushed.map((m, i) => (
                    <Text key={`${i}:${m}`} size="xs" truncate>
                      {m}
                    </Text>
                  ))}
                  {s.ahead > s.unpushed.length ? (
                    <Text size="xs" muted>
                      {tr(lang, 'card.more', { n: s.ahead - s.unpushed.length })}
                    </Text>
                  ) : null}
                </Stack>
              ) : null}
              {s.files.map((f, i) => (
                <Text key={`${i}:${f.path}`} size="xs" truncate>
                  {`${stateLabel(f.state, lang)}: ${f.path}`}
                </Text>
              ))}
              {s.moreFiles > 0 ? (
                <Text size="xs" muted>
                  {tr(lang, 'card.more', { n: s.moreFiles })}
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
function byProject(list: Session[], none: string): [string, Session[]][] {
  const map = new Map<string, Session[]>()
  for (const s of list) map.set(s.project ?? none, [...(map.get(s.project ?? none) ?? []), s])
  const dirty = (items: Session[]) => items.reduce((n, x) => n + x.uncommitted, 0)
  return [...map.entries()].sort((a, b) => dirty(b[1]) - dirty(a[1]) || a[0].localeCompare(b[0]))
}

function GroupTitle({ group, count }: { group: Group; count: number }) {
  return (
    <Row justify="between">
      <Text weight="semibold">{groupTitle(group, currentLang())}</Text>
      <Badge>{String(count)}</Badge>
    </Row>
  )
}

function SettingsBox() {
  const c = read(config)
  const draft = read(baseDraft)
  const lang = currentLang()
  const every = (n: number) => tr(lang, 'settings.every', { n })
  const langLabel = (v: LanguageSetting) => (v === 'auto' ? tr(lang, 'settings.languageAuto') : LANGUAGE_NAMES[v])
  return (
    <Collapsible title={tr(lang, 'settings.title')} description={tr(lang, 'settings.description')}>
      <Stack gap="sm">
        <Select
          label={tr(lang, 'settings.language')}
          value={languageSetting(c.language)}
          options={LANGUAGE_SETTINGS.map((v) => ({ value: v, label: langLabel(v) }))}
          onChange={(v) => void updateConfig({ language: languageSetting(v) })}
        />
        <Input
          label={tr(lang, 'settings.base')}
          placeholder={tr(lang, 'settings.basePlaceholder')}
          value={draft ?? c.baseBranch}
          maxLength={200}
          onChange={(v) => set(baseDraft, v)}
          onSubmit={(v) => {
            set(baseDraft, null)
            void updateConfig({ baseBranch: v.trim() })
          }}
        />
        <Select
          label={tr(lang, 'settings.interval')}
          value={String(c.intervalSeconds)}
          options={INTERVALS.map((n) => ({ value: String(n), label: every(n) }))}
          onChange={(v) => void updateConfig({ intervalSeconds: Number(v) })}
        />
        <Select
          label={tr(lang, 'settings.background')}
          value={String(c.backgroundSeconds)}
          options={(BACKGROUND.includes(c.backgroundSeconds) ? BACKGROUND : [...BACKGROUND, c.backgroundSeconds].sort((a, b) => a - b)).map((n) => ({
            value: String(n),
            label: n === 0 ? tr(lang, 'settings.backgroundOff') : every(n)
          }))}
          onChange={(v) => void updateConfig({ backgroundSeconds: Number(v) })}
        />
        <Switch
          label={tr(lang, 'settings.notify')}
          checked={c.notifyOnAgentDone}
          onChange={(v) => void updateConfig({ notifyOnAgentDone: v })}
        />
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const s = read(state)
  const lang = currentLang()
  const note = read(notice) ? errorText(lang, read(notice)) : ''
  if (!s) return note ? <Callout tone="danger">{note}</Callout> : <Skeleton lines={4} label={tr(lang, 'panel.loading')} />
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
    ['all', tr(lang, 'filter.all', { n: counted.length })],
    ['changes', tr(lang, 'filter.changes', { n: dirty })],
    ['safe', tr(lang, 'filter.safe', { n: safe })]
  ]
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={3}>Session Check</Heading>
        <IconButton icon="refresh" label={tr(lang, 'panel.rescan')} disabled={read(refreshing)} onPress={() => void refresh()} />
      </Row>
      <Text muted={dirty === 0} tone={dirty === 0 ? 'success' : undefined}>
        {dirty > 0 ? tr(lang, 'panel.dirtyCount', { n: dirty }) : tr(lang, 'panel.allCommitted')}
      </Text>
      {note ? <Callout tone="danger">{note}</Callout> : null}
      {s.truncated ? <Callout tone="warning">{tr(lang, 'panel.truncated', { n: MAX_WORKSPACES })}</Callout> : null}
      {current ? (
        <Stack gap="sm">
          <Text weight="semibold">{tr(lang, 'panel.current')}</Text>
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
      <Input label={tr(lang, 'search.label')} labelHidden type="search" placeholder={tr(lang, 'search.placeholder')} value={read(query)} maxLength={100} onChange={(v) => set(query, v)} />
      <Row gap="xs" align="center">
        <Text size="xs" muted>
          {tr(lang, 'group.by')}
        </Text>
        {(['status', 'project'] as Grouping[]).map((g) => (
          <Button key={g} size="xs" variant={by === g ? 'solid' : 'ghost'} onPress={() => set(grouping, g)}>
            {tr(lang, g === 'project' ? 'group.project' : 'group.status')}
          </Button>
        ))}
      </Row>
      {s.sessions.length === 0 ? (
        <EmptyState title={tr(lang, 'empty.none.title')} description={tr(lang, 'empty.none.text')} />
      ) : groups.length === 0 ? (current ? null : (
        <EmptyState title={tr(lang, 'empty.filter.title')} description={tr(lang, 'empty.filter.text')} />)
      ) : by === 'project' ? (
        byProject(groups.flatMap((g) => g.items), tr(lang, 'group.noProject')).map(([project, items]) => (
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
            <Collapsible key={group} title={groupTitle(group, lang)} description={String(items.length)} defaultOpen={group === 'safe'}>
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
          {read(showHidden) ? tr(lang, 'hidden.hide') : tr(lang, 'hidden.show', { n: hiddenCount })}
        </Button>
      ) : null}
      <Separator />
      <Text size="xs" muted>
        {tr(lang, 'panel.footer')}
      </Text>
      <SettingsBox />
    </Stack>
  )
}
