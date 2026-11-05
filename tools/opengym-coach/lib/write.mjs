// Plan and change-set writes. The judging is validate.js's and the applying is coach.js's —
// the same two functions the in-app Coach runs — so a plan that goes in through this CLI lands
// exactly as one accepted on the Coach screen would, snapshot and log entry included.
//
// Each flow is: read → validate against the live profile → refuse if already applied →
// apply to a copy → (dry run stops here) → back up → conditional PUT. On a 409 the document
// that won comes back with it; the flow checks again whether its work is already in there and
// either stops or re-applies once onto that document. Never a second retry.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validatePlan, validateReview, cleanPlan, isWarmupSet, applyCreatedPlan, applyChangeSet,
  markStale, canonicalExId, deleteRoutine, revertLast
} from './repo.mjs'
import { CliError, EXIT } from './api.mjs'
import { DAY_ES, exName } from './read.mjs'

const list = v => (Array.isArray(v) ? v : [])
const clone = o => JSON.parse(JSON.stringify(o))
const norm = s => String(s || '').trim().toLowerCase()

export const DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.local', 'state', 'opengym-coach', 'backups')

/* ------------------------------- validation context ------------------------------- */

/** Heaviest completed work set per exercise — what payload.js hands the Coach as workingWeights. */
export function workingWeights(S) {
  const best = {}
  list(S.workouts).forEach(w => list(w.entries).forEach(en => list(en.sets).forEach(s => {
    if (s && s.done && s.w > 0 && !isWarmupSet(s)) best[en.id] = Math.max(best[en.id] || 0, s.w)
  })))
  return Object.entries(best).map(([id, best]) => ({ id, best }))
}

/** The equipment the Coach would use: its own intake answer, else the active equipment profile. */
export function profileEquipment(S) {
  const own = list(S.coach?.profile?.equipment).filter(x => typeof x === 'string' && x)
  if (own.length) return own
  if (!S.equipFilterOn) return []
  return list(list(S.equipProfiles).find(p => p && p.id === S.activeEquipId)?.equipment)
}

/** ctx for validatePlan / validateReview, built from the live profile like pipeline.js does. */
export function planContext(S, { days, equipment } = {}) {
  const trained = new Set(list(S.workouts).flatMap(w => list(w.entries).map(e => e.id)))
  const planned = new Set(list(S.routines).flatMap(r => list(r.ex).map(e => e.id)))
  const want = days != null ? Number(days) : S.coach?.profile?.daysPerWeek
  return {
    customIds: list(S.customEx).map(c => c && c.id).filter(Boolean),
    equipment: equipment ? equipment : profileEquipment(S),
    // Already in their plan or history: never refused as off-equipment, as in the Coach.
    offered: new Set([...trained, ...planned]),
    workingWeights: workingWeights(S),
    ...(Number.isInteger(want) && want >= 1 && want <= 7 ? { daysPerWeek: want } : {})
  }
}

/** validatePlan plus the CLI's own warnings. { ok, bundle, errors, warnings, ctx } */
export function checkPlan(data, S, opts = {}) {
  const ctx = planContext(S, opts)
  const errors = []
  const warnings = []
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // validatePlan only enforces the week size when a day count is known; with none, a plan
    // that schedules nothing would still pass, and that is never what anyone asked for.
    if (ctx.daysPerWeek == null && !Object.keys(data.week || {}).length) errors.push('week is empty — schedule at least one day (or pass --days N)')
    const caps = new Map(ctx.workingWeights.map(w => [w.id, w.best]))
    list(data.routines).forEach((r, ri) => list(r?.ex).forEach((e, ei) => {
      if (e?.weight == null) return
      if (caps.has(e.id)) warnings.push(`routines[${ri}].ex[${ei}] (${exName(S, e.id)}) fija weight ${e.weight} pero ya tiene historial (máx ${caps.get(e.id)}): el motor parte de la última sesión; el validador lo limita a ${caps.get(e.id)}`)
      else warnings.push(`routines[${ri}].ex[${ei}] (${e.id}) fija weight sin historial que lo respalde: se descarta y la primera sesión fija la base`)
    }))
  }
  const res = validatePlan(data, ctx)
  if (!res.ok) errors.push(...res.errors)
  return errors.length ? { ok: false, errors, warnings, ctx } : { ok: true, bundle: res.bundle, errors: [], warnings, ctx }
}

/* ------------------------------- already applied? ------------------------------- */

// An exercise's identity across the merge: catalogue ids by canonical id, the plan's own
// exercises by name (mergePlan gives them fresh ids, or reuses one with the same name).
const exKeyIn = (customs, id) => {
  const own = customs.find(c => c && c.id === id)
  return own ? 'c:' + norm(own.n) : 'l:' + canonicalExId(id)
}
const routineKey = (customs, r) => norm(r.name) + '|' + list(r.ex).map(e => exKeyIn(customs, e.id)).join(',')

/** Which of the bundle's routines already exist in S, same name and same exercises in order. */
export function findApplied(S, bundle) {
  const have = new Set(list(S.routines).map(r => routineKey(list(S.customEx), r)))
  const applied = [], missing = []
  bundle.routines.forEach(r => (have.has(routineKey(list(bundle.customEx), r)) ? applied : missing).push(r.name))
  return { applied, missing, all: !missing.length, none: !applied.length }
}

export const proposalId = data => 'cli-' + crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 12)

const weekNames = S => {
  const byId = new Map(list(S.routines).map(r => [r.id, r.name]))
  const out = {}
  Object.entries(S.week || {}).forEach(([d, v]) => {
    const ids = [].concat(v || [])
    if (ids.length) out[d] = ids.map(id => byId.get(id) ?? `¿${id}?`).join(' + ')
  })
  return out
}

export function weekDiff(before, after) {
  const a = weekNames(before), b = weekNames(after)
  return [1, 2, 3, 4, 5, 6, 0].map(d => ({ day: d, dayName: DAY_ES[d], before: a[d] || null, after: b[d] || null }))
    .filter(x => x.before !== x.after)
}

const PRESC = ['sets', 'reps', 'repsMin', 'repsMax', 'setsMax', 'sec', 'min', 'speed', 'prog', 'inc', 'mode', 'sg']
/** Routine-level changes between two states: lines like "Torso A › bench press: sets 5 → 4". */
export function routineDiff(a, b) {
  const lines = []
  const A = new Map(list(a.routines).map(r => [r.id, r])), B = new Map(list(b.routines).map(r => [r.id, r]))
  B.forEach((r, id) => { if (!A.has(id)) lines.push(`+ rutina ${r.name}`) })
  A.forEach((r, id) => {
    const n = B.get(id)
    if (!n) return lines.push(`- rutina ${r.name}`)
    if (r.name !== n.name) lines.push(`${r.name}: nombre → ${n.name}`)
    if ((r.prog || null) !== (n.prog || null)) lines.push(`${n.name}: prog ${r.prog || '—'} → ${n.prog || '—'}`)
    const ex = new Map(list(r.ex).map(e => [e.id, e]))
    list(n.ex).forEach(e => {
      const o = ex.get(e.id)
      if (!o) return lines.push(`${n.name}: + ${exName(b, e.id)}`)
      const f = PRESC.filter(k => JSON.stringify(o[k] ?? null) !== JSON.stringify(e[k] ?? null))
      if (f.length) lines.push(`${n.name} › ${exName(b, e.id)}: ${f.map(k => `${k} ${o[k] ?? '—'} → ${e[k] ?? '—'}`).join(', ')}`)
    })
    list(r.ex).forEach(e => { if (!list(n.ex).some(x => x.id === e.id)) lines.push(`${n.name}: - ${exName(a, e.id)}`) })
    if (list(r.ex).map(e => e.id).join() !== list(n.ex).map(e => e.id).join() && list(r.ex).length === list(n.ex).length) lines.push(`${n.name}: orden cambiado`)
  })
  return lines
}

/** Apply a validated bundle to a copy of S. Returns { next, diff }. */
export function applyPlanToState(S, bundle, { schedule = false, replace = false, id, summary } = {}) {
  const next = clone(S)
  next.routines = list(next.routines)
  next.week = next.week && typeof next.week === 'object' ? next.week : {}
  next.dayPlan = next.dayPlan && typeof next.dayPlan === 'object' ? next.dayPlan : {}
  const removed = []
  const dayPlanDrops = {}
  if (replace) {
    // Same delete the Plan screen does, one routine at a time; workouts keep their history.
    list(S.routines).forEach(r => { Object.assign(dayPlanDrops, deleteRoutine(next, r.id)); removed.push(r.name) })
  }
  const beforeIds = new Set(next.routines.map(r => r.id))
  applyCreatedPlan(next, { id, kind: 'create', bundle, summary: summary ?? bundle.summary }, { schedule })
  if (replace) {
    // applyCreatedPlan snapshotted the plan as it found it — already emptied by the deletes
    // above. The undo has to bring back what was there before this command, so the snapshot
    // is pointed at that, with the reschedules the deletes dropped.
    const snap = next.coach.snapshots[next.coach.snapshots.length - 1]
    snap.routines = clone(list(S.routines))
    snap.week = clone(S.week || {})
    if (Object.keys(dayPlanDrops).length) snap.dayPlanRestore = { ...dayPlanDrops, ...(snap.dayPlanRestore || {}) }
  }
  const added = next.routines.filter(r => !beforeIds.has(r.id)).map(r => ({ id: r.id, name: r.name, ex: r.ex.length }))
  return { next, diff: { added, removed, week: weekDiff(S, next), routines: next.routines.length, days: Object.keys(next.week).length } }
}

/* ------------------------------------ backups ------------------------------------ */

export function backupState(S, { dir = DEFAULT_BACKUP_DIR, label = 'perfil', rev } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `${label}-rev${rev}-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(S), { mode: 0o600, flag: 'wx' })
  return file
}

/* ------------------------------------- flows ------------------------------------- */

const STAMPS = ['_ts', '_f', '_u']
/**
 * Give every routine and custom exercise that was already in the document read the stamps it
 * had there. This CLI does not stamp its own edits — the server does (api/sync-stamps.js), and
 * it decides "edited after this writer's copy" by comparing the per-field stamps sent with the
 * stored ones. revertLast puts back whole routine objects from a snapshot, older stamps and all,
 * so the server took the restored values for a stale copy and kept the newer ones: the revert
 * was silently undone. The CLI did read the current version, so that is the one it answers to.
 */
export function rebaseStamps(read, next) {
  for (const key of ['routines', 'customEx']) {
    const was = new Map(list(read[key]).filter(x => x && x.id != null).map(x => [x.id, x]))
    list(next[key]).forEach(x => {
      const old = x && was.get(x.id)
      if (!old) return
      STAMPS.forEach(k => { if (k in old) x[k] = clone(old[k]); else delete x[k] })
    })
  }
  return next
}

/**
 * Shared read → check → apply → PUT loop. `prepare(S)` returns { next, diff } or throws a
 * CliError (invalid, already applied). Called again on the 409 document, once.
 */
async function writeFlow({ client, prepare, yes, backupDir, label }) {
  const { state, rev, wid } = await client.getData()
  const first = prepare(state)
  rebaseStamps(state, first.next)
  if (!yes) return { dryRun: true, rev, ...first }
  const backup = backupState(state, { dir: backupDir, label, rev })
  let put = await client.putData(first.next, { baseRev: rev, baseWid: wid })
  if (put.ok) return { dryRun: false, rev: put.rev, prevRev: rev, backup, ...first }

  // Someone wrote in between. Their document is the new base: if it already holds this work,
  // stop; otherwise lay the same work onto it and try exactly once more.
  const c = put.conflict
  let second
  try { second = prepare(c.state) } catch (e) {
    if (e.code === EXIT.ALREADY) e.message += ' (detectado tras un 409: otro cliente escribió antes)'
    throw e
  }
  rebaseStamps(c.state, second.next)
  const backup2 = backupState(c.state, { dir: backupDir, label, rev: c.rev })
  put = await client.putData(second.next, { baseRev: c.rev, baseWid: c.wid })
  if (put.ok) return { dryRun: false, rev: put.rev, prevRev: c.rev, backup: backup2, retried: true, ...second }
  throw new CliError(`Conflicto otra vez (409, rev ${put.conflict.rev}): no reintento más. Nada escrito por este comando.`, EXIT.CONFLICT)
}

export async function applyPlanFlow({ client, data, schedule, replace, days, equipment, yes, backupDir, label }) {
  const id = proposalId(data)
  const warnings = []
  const result = await writeFlow({
    client, yes, backupDir, label,
    prepare: S => {
      const check = checkPlan(data, S, { days, equipment })
      if (!check.ok) throw new CliError('Plan rechazado por validatePlan', EXIT.INVALID, { errors: check.errors, warnings: check.warnings })
      warnings.splice(0, warnings.length, ...check.warnings)
      const found = findApplied(S, check.bundle)
      if (found.all) throw new CliError(`El plan ya está aplicado (${found.applied.join(', ')}). No escribo nada para no duplicar.`, EXIT.ALREADY)
      if (!found.none && !replace) {
        throw new CliError(`El plan está aplicado a medias: ya existen ${found.applied.join(', ')}; faltan ${found.missing.join(', ')}. ` +
          'Usa --replace para sustituir el plan entero o `changes` para completar lo que falta.', EXIT.ALREADY)
      }
      return applyPlanToState(S, check.bundle, { schedule, replace, id })
    }
  })
  return { ...result, warnings, proposalId: id }
}

/** Accepts a target routine by name as well as by id: `target.routineName`. */
export function resolveTargets(data, S) {
  const routines = list(S.routines)
  const byName = name => {
    const hits = routines.filter(r => norm(r.name) === norm(name))
    if (hits.length === 1) return hits[0].id
    throw new CliError(hits.length ? `Hay ${hits.length} rutinas llamadas "${name}": usa target.routineId` : `No hay ninguna rutina llamada "${name}"`, EXIT.INVALID)
  }
  const raw = Array.isArray(data) ? { changes: data } : clone(data || {})
  raw.changes = list(raw.changes).map(c => {
    if (!c || typeof c !== 'object') return c
    const t = { ...(c.target || {}) }
    if (!t.routineId && t.routineName) t.routineId = byName(t.routineName)
    delete t.routineName
    const out = { ...c, target: t }
    // `week` may name the routine to put on that day instead of its id.
    if (c.type === 'week' && typeof c.after === 'string' && c.after !== 'rest' && !routines.some(r => r.id === c.after)) out.after = byName(c.after)
    return out
  })
  return raw
}

export function checkChanges(data, S, opts = {}) {
  const resolved = resolveTargets(data, S)
  const ctx = planContext(S, opts)
  const res = validateReview(resolved, cleanPlan(S), { customIds: ctx.customIds, equipment: ctx.equipment, offered: ctx.offered })
  if (!res.ok || res.nochange) return { ...res, ctx }
  // validateReview drops a change whose `after` already equals the plan, but for `week` it
  // compares the day's routine-id list (cleanPlan) with a bare id, which never match — so the
  // same week change re-applied would write again. Compared here the way markStale does in the
  // app: as a joined list, with "rest"/null being the empty day.
  const day = v => (v == null || v === 'rest' ? '' : [].concat(v).join('+'))
  const changes = res.proposal.changes.filter(c => c.type !== 'week' || day(c.before) !== day(c.after))
  if (!changes.length) return { ok: true, nochange: true, ctx }
  return { ...res, proposal: { ...res.proposal, changes }, ctx }
}

export const describeChange = (S, c) => {
  const routineName = id => list(S.routines).find(x => x.id === id)?.name || id
  const r = list(S.routines).find(x => x.id === c.target?.routineId)
  const where = [r?.name, c.target?.exId ? exName(S, c.target.exId) : null, c.type === 'week' ? DAY_ES[c.target.weekday] : null].filter(Boolean).join(' › ')
  const show = v => (v == null || (Array.isArray(v) && !v.length) ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  const day = v => (v == null || v === 'rest' ? 'descanso' : [].concat(v).map(routineName).join(' + '))
  return c.type === 'week'
    ? { type: c.type, where, before: day(c.before), after: day(c.after) }
    : { type: c.type, where, before: show(c.before), after: show(c.after) }
}
const describe = describeChange

export function applyChangesToState(S, proposal) {
  const next = clone(S)
  const marked = markStale(proposal, next)
  const stale = marked.changes.filter(c => c.status === 'stale')
  if (stale.length) throw new CliError(`Cambios obsoletos frente al plan actual: ${stale.map(c => c.id).join(', ')}`, EXIT.CONFLICT)
  const res = applyChangeSet(next, marked, marked.changes.map(c => c.id))
  return { next, diff: { applied: res.applied, changes: marked.changes.map(c => describe(S, c)), week: weekDiff(S, next), routines: list(next.routines).length } }
}

export async function applyChangesFlow({ client, data, yes, backupDir, label, equipment }) {
  const id = proposalId(data)
  return writeFlow({
    client, yes, backupDir, label,
    prepare: S => {
      const res = checkChanges(data, S, { equipment })
      if (!res.ok) throw new CliError('Cambios rechazados por validateReview', EXIT.INVALID, { errors: res.errors })
      if (res.nochange) throw new CliError('Nada que cambiar: el plan ya tiene esos valores. No escribo nada.', EXIT.ALREADY)
      return applyChangesToState(S, { id, kind: 'review', ...res.proposal })
    }
  })
}

/** Undo the last plan or change-set applied (by this CLI or the Coach screen): routines + week. */
export async function revertFlow({ client, yes, backupDir, label }) {
  return writeFlow({
    client, yes, backupDir, label,
    prepare: S => {
      const next = clone(S)
      if (!revertLast(next)) throw new CliError('No hay ninguna instantánea del Coach que deshacer', EXIT.ALREADY)
      return { next, diff: { week: weekDiff(S, next), routines: list(next.routines).length, before: list(S.routines).length, lines: routineDiff(S, next) } }
    }
  })
}

