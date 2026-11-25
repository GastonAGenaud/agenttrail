// The Map mod's actions: who a card reaches, what it sends, cards moved by hand,
// and tasks added to a plan. All pure, so they run without Herdr.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { addTask, agentFor, agentForRun, looksLikeDialog, moveLayout, ownerOf, promptFor, readOffsets } from '../herdr/agenttrail/mods/agenttrail/act.js'

const agents = [
  { address: 't17', pane: 'p1', app: 'claude-code', tab_name: 'Lead TERRAPOINT · pod 3 y release', pane_name: null, title: 'claude' },
  { address: 'wsl-gg/t4', pane: 'p2', app: 'claude-code', tab_name: 'Lead CHACO · horas', pane_name: null, title: 'claude' },
  { address: 'wsl-dk/t2', pane: 'p3', app: 'pi', tab_name: 'gaston-e8', pane_name: null, title: 'pi' },
]
const panes = [{ pane: 'p1', cwd: '/r/kopius' }, { pane: 'p2', cwd: '/r/chaco' }, { pane: 'p3', cwd: '/r/arcadia' }]

describe('who a card reaches', () => {
  test('a by: name finds the one agent whose tab holds its words', () => {
    assert.equal(agentFor('lead-terrapoint', agents)?.address, 't17')
    assert.equal(agentFor('lead-chaco', agents)?.address, 'wsl-gg/t4')
    assert.equal(agentFor('gaston-e8', agents)?.address, 'wsl-dk/t2')
  })
  test('an unclear name finds no one rather than a guess', () => {
    assert.equal(agentFor('claude', agents), null)
    assert.equal(agentFor('lead', agents), null)
    assert.equal(agentFor(null, agents), null)
  })
  test('a pick by hand wins, and an address is taken as it is', () => {
    assert.equal(agentFor('claude', agents, { claude: 'wsl-dk/t2' })?.address, 'wsl-dk/t2')
    assert.equal(agentFor('claude', agents, { claude: 'gone' }), null)
    assert.equal(agentFor('t17', agents)?.address, 't17')
    assert.equal(agentFor('constructor', agents, {}), null)
  })
  test('a Map session reaches the agent running that program in its folder', () => {
    assert.equal(agentForRun({ agent: 'claude', cwd: '/r/chaco/' }, agents, panes)?.address, 'wsl-gg/t4')
    assert.equal(agentForRun({ agent: 'claude', cwd: '/elsewhere' }, agents, panes), null)
  })
  test('a card reaches the owner of its stuck task first, then its live one', () => {
    const b = { plan: [
      { id: 'c', level: 'component', title: 'C' },
      { id: 'a', parent: 'c', status: 'done', by: 'x' },
      { id: 'b', parent: 'c', status: 'active', by: 'y' },
      { id: 'd', parent: 'c', status: 'blocked', by: 'z' },
    ] }
    assert.equal(ownerOf(b, { kind: 'node', id: 'c' }), 'z')
    assert.equal(ownerOf(b, { kind: 'node', id: 'a' }), 'x')
    assert.equal(ownerOf(b, { kind: 'run', run: { agent: 'codex' } }), 'codex')
  })
})

describe('what it sends', () => {
  test('a task names itself, a card does not', () => {
    assert.equal(promptFor('next', { level: 'task', title: 'Smoke Web' }), 'Sobre "Smoke Web": Seguí con el siguiente paso.')
    assert.match(promptFor('status', { level: 'component', title: 'X' }), /^Dame un status/)
    assert.equal(promptFor('free', null, '  probá de nuevo '), 'probá de nuevo')
    assert.equal(promptFor('free', null, '   '), '')
  })
  test('a dialog on screen is recognised', () => {
    assert.ok(looksLikeDialog('Do you want to proceed?\n❯ 1. Yes\n  2. No'))
    assert.ok(!looksLikeDialog('✻ Brewed for 15s · done 11:45\n❯ '))
  })
})

describe('cards moved by hand', () => {
  const L = { width: 1000, height: 600, pos: { a: { x: 64, y: 64, w: 400, h: 128, nodeX: 64, nodeY: 64, nodeW: 400, nodeH: 128 } } }
  test('an offset moves the card and grows the region', () => {
    const M = moveLayout(L, { a: { dx: 900, dy: 10 } })
    assert.equal(M.pos.a.nodeX, 964)
    assert.equal(M.pos.a.y, 74)
    assert.ok(M.width >= 964 + 400)
    assert.equal(L.pos.a.x, 64)
  })
  test('a card never leaves the region by the top or left', () => {
    const M = moveLayout(L, { a: { dx: -500, dy: -500 } })
    assert.equal(M.pos.a.x, 16)
    assert.equal(M.pos.a.y, 16)
  })
  test('stored offsets are read defensively', () => {
    assert.deepEqual(readOffsets('nope'), {})
    assert.deepEqual(readOffsets('{"a":{"dx":"3","dy":4.6},"__proto__":{}}'), { a: { dx: 3, dy: 5 } })
  })
})

describe('tasks added to a plan', () => {
  const plan = '# P\n\n## One {#one}\ntech: t\n- [ ] First {#one-a}\n  by: claude\n\n## Two {#two}\n- [x] Done {#two-a}\n\n## decisions\n- d\n'
  test('it lands at the end of its card and nowhere else', () => {
    const r = addTask(plan, 'one', 'Revisar el smoke', 'lead-terrapoint')
    assert.equal(r.id, 'one-revisar-el-smoke')
    assert.equal(r.text, plan.replace('  by: claude\n', '  by: claude\n- [ ] Revisar el smoke {#one-revisar-el-smoke}\n  by: lead-terrapoint\n  from: roadmap\n'))
  })
  test('ids stay unique and titles stay one line', () => {
    const once = addTask(plan, 'two', 'Done').text
    const twice = addTask(once, 'two', 'Done\nagain')
    assert.equal(twice.id, 'two-done-again')
    assert.equal(addTask(once, 'two', 'Done').id, 'two-done-2')
  })
  test('an unknown card or an empty title writes nothing', () => {
    assert.equal(addTask(plan, 'nope', 'x'), null)
    assert.equal(addTask(plan, 'one', '  '), null)
  })
})
