import { assert, test } from 'orca/testing'
import { agentDoneText, clampBackground, label, statusBar, type BarItem } from './summary'

const item = (name: string, uncommitted: number, extra: Partial<BarItem> = {}): BarItem => ({ project: 'acme-shop', name, hidden: false, unknown: false, uncommitted, ...extra })

test('status bar: nothing open is ok, no worktree at all too', () => {
  assert.equal(statusBar([item('a', 0), item('b', 0)]).text, 'Sessions ok')
  assert.equal(statusBar([]).text, 'Sessions ok')
})

test('status bar: open worktrees are counted, the biggest five named', () => {
  const items = Array.from({ length: 7 }, (_, i) => item(`wt${i}`, i))
  const b = statusBar(items)
  assert.equal(b.text, 'Sessions 6 open')
  assert.equal(b.tone, 'warning')
  assert.equal(b.tooltip, 'Uncommitted files: acme-shop / wt6 (6), acme-shop / wt5 (5), acme-shop / wt4 (4), acme-shop / wt3 (3), acme-shop / wt2 (2), +1 more')
})

test('status bar: hidden ones do not count, unknown ones are never ok', () => {
  assert.equal(statusBar([item('a', 3, { hidden: true }), item('b', 0)]).text, 'Sessions ok')
  assert.equal(statusBar([item('a', 0, { unknown: true })]).text, 'Sessions ?')
  assert.equal(statusBar([item('a', 0, { unknown: true }), item('b', 0)]).text, 'Sessions 1 unchecked')
  assert.equal(statusBar([item('a', 0, { unknown: true }), item('b', 2)]).text, 'Sessions 1 open')
  // only hidden unknown ones: nothing to show as unknown
  assert.equal(statusBar([item('a', 0, { unknown: true, hidden: true }), item('b', 0)]).text, 'Sessions ok')
})

test('status bar: the tooltip stays within Orca limits and on one line', () => {
  const long = Array.from({ length: 5 }, (_, i) => item(`${'n'.repeat(200)}${i}`, 1, { project: 'p\n'.repeat(80) }))
  const b = statusBar(long)
  assert.ok(b.tooltip.length <= 256)
  assert.ok(!/[\n\r\t]/.test(b.tooltip))
})

test('label cleans and cuts project and name', () => {
  assert.equal(label('acme-shop', 'checkout'), 'acme-shop / checkout')
  assert.equal(label('same', 'same'), 'same')
  assert.equal(label(null, 'x‮y'), 'x?y')
  assert.equal(label(null, 'n'.repeat(60)), `${'n'.repeat(39)}…`)
})

test('agent done text: counts only, null when clean', () => {
  const s = { project: 'acme-shop', name: 'checkout', uncommitted: 3, untracked: 0, ahead: 0 }
  assert.equal(agentDoneText(s), 'acme-shop / checkout: agent finished, 3 files uncommitted')
  assert.equal(agentDoneText({ ...s, uncommitted: 1, untracked: 2, ahead: 1 }), 'acme-shop / checkout: agent finished, 1 file uncommitted, 2 new files, 1 commit unpushed')
  assert.equal(agentDoneText({ ...s, uncommitted: 0 }), null)
})

test('background seconds: 0 or 30 to 600, rounded, null for anything else', () => {
  assert.equal(clampBackground(0), 0)
  assert.equal(clampBackground(-5), 0)
  assert.equal(clampBackground(0.4), 0)
  assert.equal(clampBackground(1), 30)
  assert.equal(clampBackground(120), 120)
  assert.equal(clampBackground(601), 600)
  assert.equal(clampBackground(Number.POSITIVE_INFINITY), null)
  assert.equal(clampBackground('60'), null)
  assert.equal(clampBackground(undefined), null)
})
