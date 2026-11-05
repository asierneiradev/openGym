// Read-side summaries of a profile state. Pure: each takes the state (and `now` where time
// matters) and returns plain data; formatting for the terminal lives in the entry point.
import {
  LIBRARY, LIB_BY_ID, EXIDX, loadOfWorkouts, loadOfWeeklyPlan, muscleBalanceWindow, MUSCLE_NAME,
  best1RM, bestSetOf, e1rmSeries, is1RMRecord, formulaOf, workoutVolume, workSetsDone,
  workoutDuration, weeklyWeights, weekStartOf, isWarmupRow
} from './repo.mjs'

export const DAY_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
export const MUSCLE_ES = {
  trapezius: 'trapecio', deltoids: 'hombros', chest: 'pecho', 'upper-back': 'espalda alta/dorsal',
  serratus: 'serrato', biceps: 'bíceps', triceps: 'tríceps', forearm: 'antebrazo', abs: 'abdomen',
  obliques: 'oblicuos', 'lower-back': 'lumbar', gluteal: 'glúteos', quadriceps: 'cuádriceps',
  hamstring: 'isquios', adductors: 'aductores', 'hip-flexors': 'flexores de cadera',
  calves: 'gemelos', tibialis: 'tibial', 'cardiovascular system': 'cardio'
}
const DAY_MS = 86400000

export const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const list = v => (Array.isArray(v) ? v : [])

/** Display name for an exercise id: the user's own exercise, then the catalogue. */
export function exName(S, id) {
  const own = list(S?.customEx).find(c => c && c.id === id)
  if (own) return own.n
  return EXIDX[id]?.n || LIB_BY_ID.get(id)?.n || `¿${id}?`
}

/** Weekday order the profile uses (Monday or Sunday first). */
export const weekOrder = S => (weekStartOf(S) === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0])

export function weekView(S) {
  const byId = new Map(list(S.routines).map(r => [r.id, r]))
  return weekOrder(S).map(d => {
    const ids = [].concat(S.week?.[d] || [])
    return { day: d, dayName: DAY_ES[d], routines: ids.map(id => ({ id, name: byId.get(id)?.name ?? `¿${id}?` })) }
  })
}

export function routinesView(S) {
  const days = new Map()
  Object.entries(S.week || {}).forEach(([d, v]) => [].concat(v || []).forEach(id => {
    days.set(id, [...(days.get(id) || []), DAY_ES[+d]])
  }))
  return list(S.routines).map(r => ({
    id: r.id, name: r.name, prog: r.prog || null, days: days.get(r.id) || [],
    ex: list(r.ex).map(e => ({
      id: e.id, name: exName(S, e.id), sets: e.sets, mode: e.mode || 'reps', reps: e.reps, sec: e.sec,
      min: e.min, repsMin: e.repsMin, repsMax: e.repsMax, setsMax: e.setsMax, prog: e.prog || null,
      inc: e.inc, sg: e.sg || null, side: !!e.side, weight: e.weight || null
    }))
  }))
}

const lastBodyweight = S => {
  const bw = list(S.bodyweight).filter(b => b && b.d && Number(b.w) > 0)
  bw.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  return bw[bw.length - 1] || null
}

export function statusView(S, me, rev) {
  const workouts = list(S.workouts)
  const last = workouts.reduce((m, w) => (!m || (w.d || '') > (m.d || '') ? w : m), null)
  const bw = lastBodyweight(S)
  return {
    name: me?.user?.name ?? null, uid: me?.user?.id ?? null, admin: !!me?.user?.admin,
    rev, wid: S._wid || null, unit: S.unit || 'kg',
    routines: list(S.routines).length, trainingDays: Object.keys(S.week || {}).filter(d => [].concat(S.week[d]).length).length,
    workouts: workouts.length, lastWorkout: last ? { d: last.d, name: last.name } : null,
    bodyweight: bw ? { d: bw.d, w: Number(bw.w) } : null,
    targetW: Number(S.targetW) > 0 ? Number(S.targetW) : null,
    coachProfile: !!S.coach?.profile, customEx: list(S.customEx).length
  }
}

/* ---------------------------------- workouts ---------------------------------- */

const plannedSets = entry => {
  const p = entry.planned?.sets ?? entry.target?.sets
  if (Number.isInteger(p)) return p
  return list(entry.sets).filter(s => !isWarmupRow(s)).length
}

/** Most recent first. PRs are estimated-1RM records against everything logged before. */
export function workoutsView(S, { limit = 10 } = {}) {
  const all = list(S.workouts).map((w, i) => ({ w, i }))
  all.sort((a, b) => ((a.w.d || '') < (b.w.d || '') ? -1 : (a.w.d || '') > (b.w.d || '') ? 1 : (a.w.start || 0) - (b.w.start || 0)))
  const formula = formulaOf(S)
  const pick = all.slice(-limit).reverse()
  return pick.map(({ w }) => {
    const idx = all.findIndex(x => x.w === w)
    const before = { ...S, workouts: all.slice(0, idx).map(x => x.w) }
    let top = null
    const prs = []
    let planned = 0
    list(w.entries).forEach(en => {
      planned += plannedSets(en)
      const best = bestSetOf(en, formula)
      if (best && (!top || best.est > top.est)) top = { ...best, id: en.id, name: exName(S, en.id) }
      const pr = is1RMRecord(before, en.id, en, formula)
      if (pr && pr.prev > 0) prs.push({ id: en.id, name: exName(S, en.id), est: round(pr.est), prev: round(pr.prev) })
    })
    return {
      id: w.id, d: w.d, name: w.name || null,
      min: round(workoutDuration(w) / 60000, 0),
      volume: round(workoutVolume(w), 0),
      setsDone: workSetsDone(w), setsPlanned: planned,
      exercises: list(w.entries).length,
      top: top ? { name: top.name, w: top.w, r: top.r, e1rm: round(top.est) } : null,
      prs
    }
  })
}

/* --------------------------------- bodyweight --------------------------------- */

/** Weigh-ins in the window, weekly means, and a least-squares slope in kg/week. */
export function bodyweightView(S, { days = 90, now = Date.now() } = {}) {
  const from = new Date(now - days * DAY_MS).toISOString().slice(0, 10)
  const entries = list(S.bodyweight).filter(b => b && b.d && Number(b.w) > 0 && b.d >= from)
    .map(b => ({ d: b.d, w: Number(b.w) })).sort((a, b) => (a.d < b.d ? -1 : 1))
  let slope = null
  if (entries.length >= 2) {
    const xs = entries.map(e => Date.parse(e.d + 'T12:00:00Z') / (7 * DAY_MS))
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = entries.reduce((a, e) => a + e.w, 0) / entries.length
    const num = xs.reduce((a, x, i) => a + (x - mx) * (entries[i].w - my), 0)
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0)
    slope = den > 0 ? round(num / den, 2) : null
  }
  const weeks = weeklyWeights(entries, weekStartOf(S)).map(w => ({ week: w.key, avg: round(w.avg, 2), n: w.n, delta: round(w.delta, 2) }))
  const current = entries[entries.length - 1] || lastBodyweight(S)
  const targetW = Number(S.targetW) > 0 ? Number(S.targetW) : null
  return {
    days, entries, weeks, slopePerWeek: slope,
    current: current ? { d: current.d, w: Number(current.w) } : null,
    targetW, toTarget: current && targetW ? round(targetW - Number(current.w), 1) : null
  }
}

/* ---------------------------------- balance ---------------------------------- */

/** Effective sets per muscle done in the window, per week, next to what the week plans. */
export function balanceView(S, { days = 28, now = Date.now() } = {}) {
  const ws = muscleBalanceWindow(list(S.workouts), days, now)
  const done = loadOfWorkouts(ws)
  const planned = loadOfWeeklyPlan(S)
  const weeks = Math.max(days / 7, 1)
  const slugs = [...new Set([...Object.keys(done), ...Object.keys(planned)])]
  const rows = slugs.map(m => ({
    muscle: m, name: MUSCLE_ES[m] || MUSCLE_NAME[m] || m,
    sets: round(done[m] || 0), perWeek: round((done[m] || 0) / weeks), plannedPerWeek: round(planned[m] || 0)
  })).sort((a, b) => b.perWeek - a.perWeek || b.plannedPerWeek - a.plannedPerWeek)
  return { days, workouts: ws.length, rows }
}

/* ---------------------------------- one-rm ---------------------------------- */

export function oneRmView(S, { ex, limit = 15 } = {}) {
  const formula = formulaOf(S)
  if (ex) {
    const series = e1rmSeries(S, ex, formula)
    const best = best1RM(S, ex, formula)
    return {
      formula, ex, name: exName(S, ex),
      best: best ? { e1rm: round(best.est), w: best.w, r: best.r, d: best.d } : null,
      recent: series.slice(-8).map(p => ({ d: p.d, e1rm: round(p.y), w: p.w, r: p.r }))
    }
  }
  const ids = [...new Set(list(S.workouts).flatMap(w => list(w.entries).map(e => e.id)))]
  const rows = ids.map(id => {
    const best = best1RM(S, id, formula)
    if (!best) return null
    const series = e1rmSeries(S, id, formula)
    return { id, name: exName(S, id), e1rm: round(best.est), w: best.w, r: best.r, d: best.d, last: round(series[series.length - 1]?.y), sessions: series.length }
  }).filter(Boolean).sort((a, b) => b.e1rm - a.e1rm)
  return { formula, rows: rows.slice(0, limit), total: rows.length }
}

/* ---------------------------------- library ---------------------------------- */

const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Every term must appear in the name or target muscle; --bp / --eq filter exactly. */
export function librarySearch({ q = '', bp, eq, tg, limit = 20 } = {}) {
  const terms = fold(q).split(/\s+/).filter(Boolean)
  const want = (field, v) => !v || fold(field) === fold(v)
  const hits = LIBRARY.filter(e => want(e.bp, bp) && want(e.eq, eq) && want(e.tg, tg) &&
    terms.every(t => fold(e.n).includes(t) || fold(e.tg) === t))
  // Shorter names first: "barbell bench press" before "barbell bench press with chains".
  hits.sort((a, b) => a.n.length - b.n.length || a.n.localeCompare(b.n))
  return { total: hits.length, rows: hits.slice(0, limit) }
}

export function libraryFacets() {
  const count = key => Object.entries(LIBRARY.reduce((m, e) => ({ ...m, [e[key]]: (m[e[key]] || 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])
  return { bp: count('bp'), eq: count('eq'), tg: count('tg') }
}

/** ids that are in the catalogue (or the user's own exercises) and ids that are not. */
export function libraryCheck(ids, S = null) {
  const own = new Set(list(S?.customEx).map(c => c.id))
  return ids.map(id => ({ id, ok: LIB_BY_ID.has(id) || own.has(id), name: LIB_BY_ID.get(id)?.n || list(S?.customEx).find(c => c.id === id)?.n || null, own: own.has(id) }))
}
