// Pure tests: no server, no network. `node --test tools/opengym-coach/test/`
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { parseArgs } from '../opengym.mjs'
import { signToken, decodeToken } from '../lib/token.mjs'
import { checkPlan, findApplied, applyPlanToState, workingWeights, checkChanges, applyChangesToState } from '../lib/write.mjs'
import { librarySearch, libraryCheck, oneRmView, balanceView, workoutsView, bodyweightView } from '../lib/read.mjs'
import { revertLast } from '../lib/repo.mjs'
import { loadPlan, seedHistory } from './fixtures.mjs'

const empty = () => ({ routines: [], week: {}, workouts: [], bodyweight: [], customEx: [], dayPlan: {}, unit: 'kg' })

test('parseArgs: positionals, valued options, booleans and --k=v', () => {
  const { pos, opt } = parseArgs(['plan', 'apply', 'p.json', '--schedule', '--days', '3', '--url=http://x'])
  assert.deepEqual(pos, ['plan', 'apply', 'p.json'])
  assert.deepEqual(opt, { schedule: true, days: '3', url: 'http://x' })
  assert.throws(() => parseArgs(['--limit']), /necesita un valor/)
})

test('token: same payload and HMAC the API verifies', () => {
  const secret = 'a'.repeat(64)
  const tok = signToken(secret, 'uid123', 1800000000000, 2)
  const [payload, mac] = [tok.slice(0, tok.lastIndexOf('.')), tok.slice(tok.lastIndexOf('.') + 1)]
  assert.equal(payload, 'uid123:1800000000000:2')
  assert.equal(mac, crypto.createHmac('sha256', secret).update(payload).digest('base64url'))
  assert.deepEqual(decodeToken(tok), { uid: 'uid123', exp: 1800000000000, sv: 2 })
})

test('example plans validate against an empty profile', () => {
  for (const f of ['plan-3dias-casa-principiante.json', 'plan-4dias-torso-pierna-intermedio.json']) {
    const r = checkPlan(loadPlan(f), empty())
    assert.equal(r.ok, true, f + ': ' + r.errors.join('; '))
  }
})

test('an invented exercise id is rejected with validatePlan’s own message', () => {
  const p = loadPlan('plan-3dias-casa-principiante.json')
  p.routines[0].ex[0].id = '999999'
  const r = checkPlan(p, empty())
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /"999999" is not in the exercise library/)
})

test('daysPerWeek from --days is enforced; an empty week is refused without it', () => {
  const p = loadPlan('plan-3dias-casa-principiante.json')
  assert.match(checkPlan(p, empty(), { days: 4 }).errors.join(), /schedules 3 days but 4 were asked/)
  assert.match(checkPlan({ ...p, week: {} }, empty()).errors.join(), /week is empty/)
})

test('equipment from the profile gates exercises it does not reach', () => {
  const p = loadPlan('plan-4dias-torso-pierna-intermedio.json')
  const S = { ...empty(), coach: { profile: { equipment: ['dumbbell', 'body weight'] } } }
  const r = checkPlan(p, S)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /"0025" needs equipment the user does not have/.test(e)))
})

test('weights: dropped without history, capped and warned with it', () => {
  const p = loadPlan('plan-3dias-casa-principiante.json')
  p.routines[0].ex[0].weight = 40
  let r = checkPlan(p, empty())
  assert.equal(r.bundle.routines[0].ex[0].weight, undefined)
  assert.match(r.warnings[0], /sin historial/)
  const S = seedHistory(applyPlanToState(empty(), checkPlan(loadPlan('plan-3dias-casa-principiante.json'), empty()).bundle, { schedule: true }).next)
  const best = workingWeights(S).find(w => w.id === '1760').best
  r = checkPlan(p, S)
  assert.equal(r.bundle.routines[0].ex[0].weight, best)
  assert.match(r.warnings[0], /ya tiene historial/)
})

test('apply + findApplied: N routines, N days, and the same plan is recognised as applied', () => {
  const p = loadPlan('plan-3dias-casa-principiante.json')
  const { bundle } = checkPlan(p, empty())
  const { next, diff } = applyPlanToState(empty(), bundle, { schedule: true, id: 'x' })
  assert.equal(next.routines.length, 3)
  assert.equal(Object.keys(next.week).length, 3)
  assert.equal(diff.added.length, 3)
  assert.ok(next.coach.snapshots.length === 1 && next.coach.log[0].kind === 'create')
  assert.deepEqual(findApplied(next, bundle), { applied: ['Full body A', 'Full body B', 'Full body C'], missing: [], all: true, none: false })
  // --replace removes what was there; the week keeps only the new plan.
  const other = checkPlan(loadPlan('plan-4dias-torso-pierna-intermedio.json'), empty()).bundle
  const rep = applyPlanToState(next, other, { schedule: true, replace: true })
  assert.equal(rep.next.routines.length, 4)
  assert.equal(Object.keys(rep.next.week).length, 4)
  assert.deepEqual(rep.diff.removed, ['Full body A', 'Full body B', 'Full body C'])
  // …and its undo brings back what --replace removed, not the emptied plan.
  const undone = JSON.parse(JSON.stringify(rep.next))
  assert.equal(revertLast(undone), true)
  assert.deepEqual(undone.routines.map(r => r.name), ['Full body A', 'Full body B', 'Full body C'])
  assert.deepEqual(undone.week, next.week)
})

test('changes: by routine name, applied with applyChangeSet, and a repeat is "no change"', () => {
  const { bundle } = checkPlan(loadPlan('plan-3dias-casa-principiante.json'), empty())
  const S = applyPlanToState(empty(), bundle, { schedule: true }).next
  const data = { changes: [
    { type: 'sets', target: { routineName: 'Full body A', exId: '0289' }, after: 4, why: 'x' },
    { type: 'week', target: { weekday: 6 }, after: 'Full body C', why: 'y' }
  ] }
  const res = checkChanges(data, S)
  assert.equal(res.ok, true, (res.errors || []).join('; '))
  const { next } = applyChangesToState(S, { id: 'p', kind: 'review', ...res.proposal })
  assert.equal(next.routines.find(r => r.name === 'Full body A').ex.find(e => e.id === '0289').sets, 4)
  assert.equal(next.routines.find(r => r.id === next.week[6][0]).name, 'Full body C')
  assert.equal(checkChanges(data, next).nochange, true)
})

test('changes: an exercise not in the routine is rejected', () => {
  const { bundle } = checkPlan(loadPlan('plan-3dias-casa-principiante.json'), empty())
  const S = applyPlanToState(empty(), bundle, { schedule: true }).next
  const res = checkChanges({ changes: [{ type: 'sets', target: { routineName: 'Full body A', exId: '0025' }, after: 4, why: 'x' }] }, S)
  assert.equal(res.ok, false)
  assert.match(res.errors[0], /is not in routine "Full body A"/)
})

test('library search and check', () => {
  const r = librarySearch({ q: 'goblet squat', eq: 'dumbbell' })
  assert.ok(r.rows.some(e => e.id === '1760'))
  assert.ok(r.rows.every(e => e.eq === 'dumbbell'))
  assert.deepEqual(libraryCheck(['1760', 'nope']).map(x => x.ok), [true, false])
})

test('read views agree with a seeded history', () => {
  const now = Date.parse('2026-11-05T12:00:00Z')
  const { bundle } = checkPlan(loadPlan('plan-3dias-casa-principiante.json'), empty())
  const S = seedHistory(applyPlanToState(empty(), bundle, { schedule: true }).next, { now })
  assert.equal(S.workouts.length, 9)
  // Goblet squat: 16 → 18 → 20 kg × 8, Epley 20 × (1 + 8/30) = 25.3.
  assert.equal(oneRmView(S, { ex: '1760' }).best.e1rm, 25.3)
  const w = workoutsView(S, { limit: 1 })[0]
  assert.equal(w.setsDone, w.setsPlanned)
  assert.ok(w.prs.length > 0)
  const bal = balanceView(S, { days: 21, now })
  assert.equal(bal.workouts, 9)
  const chest = bal.rows.find(r => r.muscle === 'chest')
  assert.equal(chest.perWeek, chest.plannedPerWeek)   // full adherence: done == planned
  const bw = bodyweightView(S, { days: 30, now })
  assert.equal(bw.slopePerWeek, -0.4)
})
