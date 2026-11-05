#!/usr/bin/env node
// opengym — read a profile and write plans to it, for a coach working from a terminal.
// Node 22, no dependencies: the plan contract, validator and apply code are the repo's own.
// `node opengym.mjs help` for the commands; README.md for the details.
import fs from 'node:fs'
import { CliError, EXIT, DEFAULT_URL, resolveToken, createClient } from './lib/api.mjs'
import { mintToken, decodeToken } from './lib/token.mjs'
import {
  statusView, routinesView, weekView, workoutsView, bodyweightView, balanceView, oneRmView,
  librarySearch, libraryCheck, libraryFacets, DAY_ES
} from './lib/read.mjs'
import { checkPlan, checkChanges, describeChange, applyPlanFlow, applyChangesFlow, revertFlow, DEFAULT_BACKUP_DIR } from './lib/write.mjs'

const HELP = `opengym — CLI de entrenador para openGym

Uso: node opengym.mjs <comando> [opciones]

Lectura
  status                              perfil, rev, rutinas, sesiones, peso
  routines                            rutinas con ejercicios y prescripción
  week                                semana: qué rutina toca cada día
  workouts [--limit N]                sesiones: volumen, series hechas/planeadas, top set, PRs
  bodyweight [--days N]               pesajes, media semanal y tendencia (kg/semana)
  balance [--days N]                  series efectivas por músculo (hechas/semana vs plan)
  one-rm [--ex ID] [--limit N]        1RM estimado (fórmula del perfil)
  library search --q "texto" [--bp parte] [--eq equipo] [--tg músculo] [--limit N]
  library check ID [ID...]            ¿existen esos ids?
  library facets                      valores válidos de --bp, --eq y --tg

Escritura (simulación por defecto; solo escribe con --yes)
  plan validate FILE [--days N] [--equipment a,b] [--offline | --state FILE]
  plan apply FILE [--schedule] [--replace] [--days N] [--yes]
  plan revert [--yes]                 deshace el último plan/cambios (rutinas + semana)
  changes validate FILE
  changes apply FILE [--yes]

Tokens
  token mint --uid UID --days N [--data-dir DIR] [--out FILE]
  token check

Opciones globales
  --url URL          API (OPENGYM_URL, por defecto ${DEFAULT_URL})
  --token-file FILE  token (si no: OPENGYM_TOKEN, luego ~/.config/opengym-coach/token)
  --backup-dir DIR   copias previas a cada escritura (OPENGYM_BACKUP_DIR, por defecto ${DEFAULT_BACKUP_DIR})
  --json             salida JSON en vez de texto

Códigos de salida: 0 ok · 1 error · 2 uso · 3 plan/cambios inválidos · 4 auth
                   5 conflicto (409 persistente) · 6 red/servidor · 7 ya aplicado (nada escrito)`

const BOOL = new Set(['yes', 'dry-run', 'schedule', 'replace', 'json', 'help', 'offline'])

export function parseArgs(argv) {
  const pos = [], opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h') { opt.help = true; continue }
    if (!a.startsWith('--')) { pos.push(a); continue }
    const eq = a.indexOf('=')
    const key = a.slice(2, eq < 0 ? undefined : eq)
    if (eq >= 0) opt[key] = a.slice(eq + 1)
    else if (BOOL.has(key)) opt[key] = true
    else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CliError(`--${key} necesita un valor`, EXIT.USAGE)
      opt[key] = argv[++i]
    }
  }
  return { pos, opt }
}

const intOpt = (opt, key, def, lo = 1, hi = 100000) => {
  if (opt[key] == null) return def
  const n = Number(opt[key])
  if (!Number.isInteger(n) || n < lo || n > hi) throw new CliError(`--${key} debe ser un entero entre ${lo} y ${hi}`, EXIT.USAGE)
  return n
}

function readJson(file) {
  if (!file) throw new CliError('Falta el fichero JSON', EXIT.USAGE)
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { throw new CliError(`No puedo leer ${file}: ${e.code || e.message}`, EXIT.USAGE) }
  try { return JSON.parse(raw) } catch (e) { throw new CliError(`${file} no es JSON válido: ${e.message}`, EXIT.INVALID) }
}

/* ----------------------------------- output ----------------------------------- */

const fmt = (n, d = 1) => (n == null ? '—' : Number(n).toLocaleString('es-ES', { maximumFractionDigits: d }))
const pad = (s, n) => String(s).padEnd(n)

function printStatus(v, out) {
  out(`${v.name ?? '?'} (uid ${v.uid ?? '?'})${v.admin ? ' · admin' : ''}`)
  out(`rev ${v.rev} · ${v.routines} rutinas · ${v.trainingDays} días programados · ${v.workouts} sesiones` +
    (v.lastWorkout ? ` (última ${v.lastWorkout.d}, ${v.lastWorkout.name || 'sin nombre'})` : ''))
  out(`peso ${v.bodyweight ? `${fmt(v.bodyweight.w)} ${v.unit} (${v.bodyweight.d})` : '—'} · objetivo ${v.targetW ? fmt(v.targetW) + ' ' + v.unit : '—'}` +
    ` · perfil Coach ${v.coachProfile ? 'sí' : 'no'} · ejercicios propios ${v.customEx}`)
}

const presc = e => {
  if (e.mode === 'cardio') return `${e.sets}× ${e.min ?? 20} min`
  if (e.mode === 'time') return `${e.sets}× ${e.sec ?? 45}s`
  // double/triple: reps is the ceiling, repsMin the floor. Bodyweight: repsMax is the ceiling.
  const k = e.side ? 2 : 1
  const r = n => (n == null ? null : n / k)
  const reps = e.repsMin && e.repsMin !== e.reps ? `${r(e.repsMin)}-${r(e.reps)}` : e.repsMax ? `${r(e.reps ?? 10)}→${r(e.repsMax)}` : `${r(e.reps ?? 10)}`
  return `${e.sets}${e.setsMax ? `(→${e.setsMax})` : ''}×${reps}${e.side ? '/lado' : ''}`
}

function printRoutines(rows, out) {
  if (!rows.length) return out('Sin rutinas.')
  rows.forEach(r => {
    out(`■ ${r.name}  [${r.id}]  prog ${r.prog || 'por defecto'} · ${r.days.length ? r.days.join(', ') : 'sin día fijo'}`)
    r.ex.forEach((e, i) => out(`  ${String(i + 1).padStart(2)}. ${pad(e.name, 42)} ${pad(e.id, 6)} ${pad(presc(e), 10)}` +
      `${e.prog ? ' prog ' + e.prog : ''}${e.inc ? ' +' + e.inc : ''}${e.sg ? ' ss:' + e.sg.slice(-4) : ''}`))
  })
}

function printWeek(rows, out) {
  rows.forEach(d => out(`${pad(d.dayName, 10)} ${d.routines.length ? d.routines.map(r => r.name).join(' + ') : 'descanso'}`))
}

function printWorkouts(rows, out, unit) {
  if (!rows.length) return out('Sin sesiones registradas.')
  rows.forEach(w => {
    out(`${w.d}  ${pad(w.name || '—', 22)} ${pad(w.min != null ? w.min + ' min' : '', 7)} vol ${fmt(w.volume, 0)} ${unit} · series ${w.setsDone}/${w.setsPlanned}` +
      (w.top ? ` · top ${w.top.name} ${fmt(w.top.w)}×${w.top.r} (e1RM ${fmt(w.top.e1rm)})` : ''))
    if (w.prs.length) out(`            PR: ${w.prs.map(p => `${p.name} ${fmt(p.prev)}→${fmt(p.est)}`).join('; ')}`)
  })
}

function printBodyweight(v, out, unit) {
  if (!v.entries.length) return out(`Sin pesajes en los últimos ${v.days} días.`)
  out(`Actual ${fmt(v.current.w)} ${unit} (${v.current.d}) · objetivo ${v.targetW ? fmt(v.targetW) + ' ' + unit : '—'}` +
    (v.toTarget ? ` · ${v.toTarget < 0 ? 'bajar' : 'subir'} ${fmt(Math.abs(v.toTarget))} ${unit}` : v.toTarget === 0 ? ' · en el objetivo' : ''))
  out(`Tendencia ${v.slopePerWeek == null ? '—' : (v.slopePerWeek > 0 ? '+' : '') + fmt(v.slopePerWeek, 2) + ` ${unit}/semana`} (${v.entries.length} pesajes, ${v.days} días)`)
  v.weeks.slice(0, 8).forEach(w => out(`  semana ${w.week}: media ${fmt(w.avg, 2)} (${w.n})${w.delta != null ? ` Δ ${w.delta > 0 ? '+' : ''}${fmt(w.delta, 2)}` : ''}`))
}

function printBalance(v, out) {
  out(`Series efectivas por músculo, últimos ${v.days} días (${v.workouts} sesiones). Columnas: total · por semana · plan/semana`)
  if (!v.rows.length) return out('Sin datos.')
  v.rows.forEach(r => out(`  ${pad(r.name, 22)} ${String(fmt(r.sets)).padStart(6)} ${String(fmt(r.perWeek)).padStart(6)} ${String(fmt(r.plannedPerWeek)).padStart(6)}`))
}

function printOneRm(v, out, unit) {
  if (v.ex) {
    out(`${v.name} [${v.ex}] · fórmula ${v.formula}`)
    if (!v.best) return out('Sin series con las que estimar.')
    out(`Mejor e1RM ${fmt(v.best.e1rm)} ${unit} (${fmt(v.best.w)}×${v.best.r}, ${v.best.d})`)
    v.recent.forEach(p => out(`  ${p.d}  ${fmt(p.e1rm)}  (${fmt(p.w)}×${p.r})`))
    return
  }
  out(`1RM estimado · fórmula ${v.formula} · ${v.rows.length}/${v.total} ejercicios`)
  v.rows.forEach(r => out(`  ${pad(r.name, 42)} ${pad(r.id, 6)} ${String(fmt(r.e1rm)).padStart(6)} ${unit}  (${fmt(r.w)}×${r.r}, ${r.d}) último ${fmt(r.last)}`))
}

function printWeekDiff(week, out) {
  if (!week.length) return out('Semana: sin cambios')
  out('Semana:')
  week.forEach(d => out(`  ${pad(d.dayName, 10)} ${d.before || 'descanso'} → ${d.after || 'descanso'}`))
}

/* ----------------------------------- commands ----------------------------------- */

function clientFrom(opt, env) {
  const tok = resolveToken({ tokenFile: opt['token-file'], env })
  if (!tok) throw new CliError('Falta el token: usa --token-file, OPENGYM_TOKEN o ~/.config/opengym-coach/token', EXIT.AUTH)
  const client = createClient({ url: opt.url || env.OPENGYM_URL || DEFAULT_URL, token: tok.token })
  return { client, token: tok.token, uid: decodeToken(tok.token)?.uid || 'perfil' }
}

export async function run(argv, { out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), env = process.env } = {}) {
  const { pos, opt } = parseArgs(argv)
  const [cmd, sub, ...rest] = pos
  if (!cmd || opt.help || cmd === 'help') { out(HELP); return EXIT.OK }
  const json = !!opt.json
  const emit = (data, text) => (json ? out(JSON.stringify(data, null, 2)) : text())
  const backupDir = opt['backup-dir'] || env.OPENGYM_BACKUP_DIR || DEFAULT_BACKUP_DIR
  if (opt['dry-run'] && opt.yes) throw new CliError('--dry-run y --yes a la vez no tienen sentido', EXIT.USAGE)
  const equipment = opt.equipment ? String(opt.equipment).split(',').map(s => s.trim()).filter(Boolean) : undefined

  const readState = async () => {
    const { client } = clientFrom(opt, env)
    return client.getData()
  }

  switch (cmd) {
    case 'status': {
      const { client } = clientFrom(opt, env)
      const [me, data] = await Promise.all([client.me(), client.getData()])
      const v = statusView(data.state, me, data.rev)
      emit(v, () => printStatus(v, out))
      return EXIT.OK
    }
    case 'routines': {
      const { state } = await readState()
      const v = routinesView(state)
      emit(v, () => printRoutines(v, out))
      return EXIT.OK
    }
    case 'week': {
      const { state } = await readState()
      const v = weekView(state)
      emit(v, () => printWeek(v, out))
      return EXIT.OK
    }
    case 'workouts': {
      const { state } = await readState()
      const v = workoutsView(state, { limit: intOpt(opt, 'limit', 10, 1, 500) })
      emit(v, () => printWorkouts(v, out, state.unit || 'kg'))
      return EXIT.OK
    }
    case 'bodyweight': {
      const { state } = await readState()
      const v = bodyweightView(state, { days: intOpt(opt, 'days', 90, 1, 3650) })
      emit(v, () => printBodyweight(v, out, state.unit || 'kg'))
      return EXIT.OK
    }
    case 'balance': {
      const { state } = await readState()
      const v = balanceView(state, { days: intOpt(opt, 'days', 28, 1, 3650) })
      emit(v, () => printBalance(v, out))
      return EXIT.OK
    }
    case 'one-rm': {
      const { state } = await readState()
      const v = oneRmView(state, { ex: opt.ex, limit: intOpt(opt, 'limit', 15, 1, 500) })
      emit(v, () => printOneRm(v, out, state.unit || 'kg'))
      return EXIT.OK
    }
    case 'library': {
      if (sub === 'search') {
        if (!opt.q && !opt.bp && !opt.eq && !opt.tg) throw new CliError('library search necesita --q, --bp, --eq o --tg', EXIT.USAGE)
        const v = librarySearch({ q: opt.q, bp: opt.bp, eq: opt.eq, tg: opt.tg, limit: intOpt(opt, 'limit', 20, 1, 500) })
        emit(v, () => {
          out(`${v.total} resultados${v.total > v.rows.length ? ` (muestro ${v.rows.length})` : ''}`)
          v.rows.forEach(e => out(`  ${pad(e.id, 6)} ${pad(e.n, 46)} ${pad(e.bp, 12)} ${pad(e.tg, 16)} ${e.eq}`))
        })
        return EXIT.OK
      }
      if (sub === 'check') {
        if (!rest.length) throw new CliError('library check necesita al menos un id', EXIT.USAGE)
        const v = libraryCheck(rest)
        emit(v, () => v.forEach(x => out(x.ok ? `  ok   ${x.id}  ${x.name}` : `  NO   ${x.id}  no existe en la librería`)))
        return v.every(x => x.ok) ? EXIT.OK : EXIT.INVALID
      }
      if (sub === 'facets') {
        const v = libraryFacets()
        emit(v, () => ['bp', 'eq', 'tg'].forEach(k => out(`--${k}: ${v[k].map(([n, c]) => `${n} (${c})`).join(', ')}`)))
        return EXIT.OK
      }
      throw new CliError('Uso: library search|check|facets', EXIT.USAGE)
    }
    case 'plan': {
      if (sub === 'validate') {
        const data = readJson(rest[0])
        let state = {}
        let source = 'sin perfil'
        if (opt.state) { state = readJson(opt.state); state = state.state || state; source = opt.state }
        else if (!opt.offline && resolveToken({ tokenFile: opt['token-file'], env })) {
          const d = await readState(); state = d.state; source = `perfil rev ${d.rev}`
        } else err('Aviso: sin token, valido sin perfil (sin equipamiento, historial ni ejercicios propios).')
        const res = checkPlan(data, state, { days: opt.days, equipment })
        if (json) { out(JSON.stringify({ ok: res.ok, errors: res.errors, warnings: res.warnings, bundle: res.bundle, ctx: { ...res.ctx, offered: undefined } }, null, 2)); return res.ok ? EXIT.OK : EXIT.INVALID }
        res.warnings.forEach(w => err('Aviso: ' + w))
        if (!res.ok) {
          out(`Plan RECHAZADO (${res.errors.length} errores, contexto: ${source}):`)
          res.errors.forEach(e => out('  - ' + e))
          return EXIT.INVALID
        }
        const b = res.bundle
        out(`Plan válido (contexto: ${source}): "${b.name}", ${b.routines.length} rutinas, ${Object.keys(b.week).length} días`)
        Object.entries(b.week).forEach(([d, rid]) => out(`  ${pad(DAY_ES[d], 10)} ${b.routines.find(r => r.id === rid)?.name}`))
        b.routines.forEach(r => out(`  ■ ${r.name}: ${r.ex.length} ejercicios`))
        return EXIT.OK
      }
      if (sub === 'apply') {
        const data = readJson(rest[0])
        const { client, uid } = clientFrom(opt, env)
        const r = await applyPlanFlow({ client, data, schedule: !!opt.schedule, replace: !!opt.replace, days: opt.days, equipment, yes: !!opt.yes, backupDir, label: uid })
        if (json) { out(JSON.stringify({ ...r, next: undefined }, null, 2)); return EXIT.OK }
        r.warnings.forEach(w => err('Aviso: ' + w))
        out(r.dryRun ? `SIMULACIÓN (rev ${r.rev}; sin --yes no escribo nada)` : `Aplicado: rev ${r.prevRev} → ${r.rev}${r.retried ? ' (tras un 409, reaplicado una vez)' : ''}`)
        if (r.diff.removed.length) out(`Rutinas eliminadas (--replace): ${r.diff.removed.join(', ')}`)
        out(`Rutinas añadidas: ${r.diff.added.map(a => `${a.name} (${a.ex} ej.)`).join(', ')}`)
        if (opt.schedule) printWeekDiff(r.diff.week, out)
        else out('Semana: sin tocar (añade --schedule para que el plan sustituya tu semana)')
        out(`Total tras aplicar: ${r.diff.routines} rutinas, ${r.diff.days} días programados`)
        if (r.backup) out(`Copia previa: ${r.backup}`)
        return EXIT.OK
      }
      if (sub === 'revert') {
        const { client, uid } = clientFrom(opt, env)
        const r = await revertFlow({ client, yes: !!opt.yes, backupDir, label: uid })
        if (json) { out(JSON.stringify({ ...r, next: undefined }, null, 2)); return EXIT.OK }
        out(r.dryRun ? `SIMULACIÓN (rev ${r.rev}; sin --yes no escribo nada)` : `Revertido: rev ${r.prevRev} → ${r.rev}`)
        out(`Rutinas: ${r.diff.before} → ${r.diff.routines}`)
        r.diff.lines.forEach(l => out('  ' + l))
        printWeekDiff(r.diff.week, out)
        if (r.backup) out(`Copia previa: ${r.backup}`)
        return EXIT.OK
      }
      throw new CliError('Uso: plan validate|apply|revert', EXIT.USAGE)
    }
    case 'changes': {
      if (sub === 'validate') {
        const data = readJson(rest[0])
        const { state } = await readState()
        const res = checkChanges(data, state, { equipment })
        if (json) { out(JSON.stringify({ ok: res.ok, nochange: !!res.nochange, errors: res.errors, proposal: res.proposal }, null, 2)); return res.ok ? EXIT.OK : EXIT.INVALID }
        if (!res.ok) {
          out(`Cambios RECHAZADOS (${res.errors.length} errores):`)
          res.errors.forEach(e => out('  - ' + e))
          return EXIT.INVALID
        }
        if (res.nochange) { out('Nada que cambiar: el plan ya tiene esos valores.'); return EXIT.ALREADY }
        out(`Cambios válidos: ${res.proposal.changes.length}`)
        res.proposal.changes.map(c => describeChange(state, c)).forEach(c => out(`  ${pad(c.type, 16)} ${c.where}: ${c.before} → ${c.after}`))
        return EXIT.OK
      }
      if (sub === 'apply') {
        const data = readJson(rest[0])
        const { client, uid } = clientFrom(opt, env)
        const r = await applyChangesFlow({ client, data, yes: !!opt.yes, backupDir, label: uid, equipment })
        if (json) { out(JSON.stringify({ ...r, next: undefined }, null, 2)); return EXIT.OK }
        out(r.dryRun ? `SIMULACIÓN (rev ${r.rev}; sin --yes no escribo nada)` : `Aplicado: rev ${r.prevRev} → ${r.rev}${r.retried ? ' (tras un 409, reaplicado una vez)' : ''}`)
        r.diff.changes.forEach(c => out(`  ${pad(c.type, 16)} ${c.where}: ${c.before} → ${c.after}`))
        if (r.diff.week.length) printWeekDiff(r.diff.week, out)
        if (r.backup) out(`Copia previa: ${r.backup}`)
        return EXIT.OK
      }
      throw new CliError('Uso: changes validate|apply FILE', EXIT.USAGE)
    }
    case 'token': {
      if (sub === 'mint') {
        const dataDir = opt['data-dir'] || env.OPENGYM_DATA_DIR
        const r = mintToken({ dataDir, uid: opt.uid, days: opt.days })
        if (opt.out) {
          fs.writeFileSync(opt.out, r.token + '\n', { mode: 0o600 })
          fs.chmodSync(opt.out, 0o600)
          err(`Token de ${r.name} (${r.uid}) guardado en ${opt.out}, caduca ${new Date(r.exp).toISOString()}`)
        } else {
          out(r.token)
          err(`Token de ${r.name} (${r.uid}), caduca ${new Date(r.exp).toISOString()}`)
        }
        return EXIT.OK
      }
      if (sub === 'check') {
        const { client, token } = clientFrom(opt, env)
        const me = await client.me()
        const t = decodeToken(token)
        const v = { ok: true, uid: me.user.id, name: me.user.name, admin: !!me.user.admin, expires: t ? new Date(t.exp).toISOString() : null, renewOffered: !!me.token }
        emit(v, () => out(`Token válido: ${v.name} (${v.uid})${v.admin ? ' · admin' : ''} · caduca ${v.expires}${v.renewOffered ? ' · el servidor ofrece renovarlo (mintea otro)' : ''}`))
        return EXIT.OK
      }
      throw new CliError('Uso: token mint|check', EXIT.USAGE)
    }
    default:
      throw new CliError(`Comando desconocido: ${cmd}. Prueba: node opengym.mjs help`, EXIT.USAGE)
  }
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + fs.realpathSync(process.argv[1])).href
if (isMain) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code }, e => {
    if (e instanceof CliError) {
      process.stderr.write('Error: ' + e.message + '\n')
      ;(e.errors || []).forEach(x => process.stderr.write('  - ' + x + '\n'))
      ;(e.warnings || []).forEach(x => process.stderr.write('  aviso: ' + x + '\n'))
      process.exitCode = e.code
    } else {
      process.stderr.write('Error inesperado: ' + (e && e.stack || e) + '\n')
      process.exitCode = EXIT.ERROR
    }
  })
}
