// Deterministic training history laid onto a profile's routines, for the sandbox tests.
// Workouts are shaped like the app's finished sessions (id, d, start, end, routineIds, entries
// with sets {w, r, done, at}, target, planned), so the repo's own readers see real data.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'plans')
export const loadPlan = name => JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), 'utf8'))

const DAY = 86400000
// Plausible starting loads for the example plans' exercises (kg).
const BASE = { '1760': 16, '0289': 14, '0293': 14, '0334': 5, '1459': 18, '0405': 10, '3335': 16, '2290': 8, '0314': 12, '0292': 14, '0294': 8, '1502': 0, '0025': 70, '0027': 60, '0043': 90, '0085': 70, '0032': 110 }
const iso = t => new Date(t).toISOString().slice(0, 10)

/**
 * Adds `weeks` weeks of sessions following S.week, ending the day before `now`. Loads start at
 * `base` (by exercise id, default 20) and rise one step every week, so the last week holds an
 * estimated-1RM record for every loaded exercise. Also 1 weigh-in per week, falling 0.4 kg.
 */
export function seedHistory(S, { now = Date.now(), weeks = 3, base = {}, bw = 80, targetW = 76 } = {}) {
  const next = JSON.parse(JSON.stringify(S))
  const byId = new Map((next.routines || []).map(r => [r.id, r]))
  next.workouts = next.workouts || []
  next.bodyweight = next.bodyweight || []
  const start = now - weeks * 7 * DAY
  let n = 0
  for (let t = start; t < now - DAY / 2; t += DAY) {
    const ids = [].concat(next.week?.[new Date(t).getUTCDay()] || [])
    const week = Math.floor((t - start) / (7 * DAY))
    ids.forEach(rid => {
      const r = byId.get(rid)
      if (!r) return
      const t0 = t + 18 * 3600000
      const entries = r.ex.map((e, i) => {
        const timed = e.mode === 'time'
        const bodyw = ['0662', '0970', '0276', '0652', '0463'].includes(e.id)
        const w = timed || bodyw ? 0 : (base[e.id] ?? BASE[e.id] ?? 20) + week * (e.inc || 2.5)
        const reps = timed ? 0 : (e.repsMin || e.reps || 8)
        const sets = Array.from({ length: e.sets }, (_, k) => ({
          w, r: reps, done: true, at: t0 + (i * 10 + k * 3) * 60000, ...(timed ? { sec: e.sec || 30 } : {})
        }))
        return { id: e.id, sets, topW: w, rid, target: { ...e }, planned: { sets: e.sets, reps: e.reps, weight: 0 } }
      })
      next.workouts.push({
        id: `seed${++n}`, d: iso(t), start: t0, end: t0 + 55 * 60000,
        routineIds: [rid], routineId: rid, name: r.name, bw: null, entries
      })
    })
    if (new Date(t).getUTCDay() === 1) next.bodyweight.push({ d: iso(t), w: Math.round((bw - week * 0.4) * 10) / 10, t })
  }
  next.targetW = targetW
  return next
}
