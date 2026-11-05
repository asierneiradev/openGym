// End-to-end against a throwaway API: a fresh DATA_DIR under the OS temp dir, the real
// api/server.js on a free localhost port, a password-registered user, a token minted from that
// directory's own secret. Nothing outside the temp dir is read or written.
// Needs api/node_modules (cd api && npm ci); skipped with a note otherwise.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, EXIT } from '../lib/api.mjs'
import { mintToken, signToken } from '../lib/token.mjs'
import { applyPlanFlow, applyChangesFlow } from '../lib/write.mjs'
import { EXAMPLES, loadPlan, seedHistory } from './fixtures.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(HERE, '..', 'opengym.mjs')
const API = path.resolve(HERE, '..', '..', '..', 'api')
const hasDeps = fs.existsSync(path.join(API, 'node_modules', '@simplewebauthn', 'server'))
const PLAN3 = path.join(EXAMPLES, 'plan-3dias-casa-principiante.json')

let server, dataDir, work, url, token, uid

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  s.on('error', reject)
})

async function waitHealthy(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('sandbox API did not come up')
}

/** Runs the CLI; returns { code, out, err }. */
function cli(args, { tok = token, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: work, OPENGYM_URL: url, OPENGYM_BACKUP_DIR: path.join(work, 'backups'), ...(tok ? { OPENGYM_TOKEN: tok } : {}), ...env }
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const state = async () => createClient({ url, token }).getData()

before(async () => {
  if (!hasDeps) return
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'og-sandbox-test-'))
  dataDir = path.join(work, 'data')
  fs.mkdirSync(dataDir)
  const port = await freePort()
  url = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [path.join(API, 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir, RP_ID: 'localhost', ORIGIN: `http://localhost:${port}`, PASSWORD_LOGIN: '1' },
    stdio: 'ignore'
  })
  await waitHealthy(url)
  const res = await fetch(url + '/api/register/password', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` },
    body: JSON.stringify({ name: 'Sandbox Coach', password: 'sandbox-Coach-2026!x' })
  })
  assert.equal(res.status, 200, await res.clone().text())
  uid = (await res.json()).user.id
  token = mintToken({ dataDir, uid, days: 1 }).token
})

after(() => {
  server?.kill()
  if (work && work.startsWith(os.tmpdir())) fs.rmSync(work, { recursive: true, force: true })
})

const t = (name, fn) => test(name, { skip: hasDeps ? false : 'api/node_modules missing (cd api && npm ci)' }, fn)

t('token check: a good token is accepted and names the user', () => {
  const r = cli(['token', 'check'])
  assert.equal(r.code, EXIT.OK, r.err)
  assert.match(r.out, new RegExp(`Sandbox Coach \\(${uid}\\)`))
})

t('invalid tokens → 401 → exit 4', () => {
  const tampered = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA')
  for (const bad of [tampered, signToken('not-the-secret', uid, Date.now() + 86400000, 0), signToken(fs.readFileSync(path.join(dataDir, 'secret'), 'utf8').trim(), uid, Date.now() - 1000, 0)]) {
    const r = cli(['status'], { tok: bad })
    assert.equal(r.code, EXIT.AUTH, r.out + r.err)
    assert.match(r.err, /401/)
  }
  assert.equal(cli(['status'], { tok: '' }).code, EXIT.AUTH)
})

t('plan with an invented id is rejected before anything is written', async () => {
  const p = loadPlan('plan-3dias-casa-principiante.json')
  p.routines[1].ex[0].id = 'peso-muerto-inventado'
  const file = path.join(work, 'bad.json')
  fs.writeFileSync(file, JSON.stringify(p))
  const before = await state()
  for (const sub of ['validate', 'apply']) {
    const r = cli(['plan', sub, file, ...(sub === 'apply' ? ['--yes'] : [])])
    assert.equal(r.code, EXIT.INVALID, r.out + r.err)
    assert.match(r.out + r.err, /"peso-muerto-inventado" is not in the exercise library/)
  }
  assert.equal((await state()).rev, before.rev)
})

t('plan apply: dry run writes nothing; --yes leaves exactly N routines and N days; a second apply does not duplicate', async () => {
  const rev0 = (await state()).rev
  let r = cli(['plan', 'apply', PLAN3, '--schedule'])
  assert.equal(r.code, EXIT.OK, r.err)
  assert.match(r.out, /SIMULACIÓN/)
  assert.equal((await state()).rev, rev0)

  r = cli(['plan', 'apply', PLAN3, '--schedule', '--yes'])
  assert.equal(r.code, EXIT.OK, r.err)
  assert.match(r.out, /Aplicado: rev \d+ → \d+/)
  const backup = r.out.match(/Copia previa: (.+)/)[1]
  assert.equal((fs.statSync(backup).mode & 0o777), 0o600)
  let { state: S } = await state()
  assert.deepEqual(S.routines.map(x => x.name), ['Full body A', 'Full body B', 'Full body C'])
  assert.deepEqual(Object.keys(S.week).sort(), ['1', '3', '5'])
  assert.equal(S.coach.log.at(-1).kind, 'create')

  r = cli(['plan', 'apply', PLAN3, '--schedule', '--yes'])
  assert.equal(r.code, EXIT.ALREADY, r.out + r.err)
  S = (await state()).state
  assert.equal(S.routines.length, 3)
  assert.equal(Object.keys(S.week).length, 3)
})

t('changes apply: sets/reps of an existing exercise change and show in the state', async () => {
  const file = path.join(work, 'changes.json')
  fs.writeFileSync(file, JSON.stringify({ changes: [
    { type: 'sets', target: { routineName: 'Full body A', exId: '0289' }, after: 4, why: 'test' },
    { type: 'reps', target: { routineName: 'Full body B', exId: '1459' }, after: 10, why: 'test' }
  ] }))
  let r = cli(['changes', 'apply', file, '--yes'])
  assert.equal(r.code, EXIT.OK, r.out + r.err)
  const { state: S } = await state()
  assert.equal(S.routines.find(x => x.name === 'Full body A').ex.find(e => e.id === '0289').sets, 4)
  assert.equal(S.routines.find(x => x.name === 'Full body B').ex.find(e => e.id === '1459').reps, 10)
  r = cli(['changes', 'apply', file, '--yes'])
  assert.equal(r.code, EXIT.ALREADY, r.out + r.err)
})

t('read commands agree with a seeded history', async () => {
  const c = createClient({ url, token })
  const { state: S, rev, wid } = await c.getData()
  assert.equal((await c.putData(seedHistory(S, { weeks: 3 }), { baseRev: rev, baseWid: wid })).ok, true)
  const one = JSON.parse(cli(['one-rm', '--ex', '1760', '--json']).out)
  assert.equal(one.best.e1rm, 25.3)                         // 20 kg × 8, Epley
  const w = JSON.parse(cli(['workouts', '--limit', '3', '--json']).out)
  assert.equal(w.length, 3)
  w.forEach(x => assert.ok(x.setsDone > 0 && x.volume > 0 && x.top))
  const bal = JSON.parse(cli(['balance', '--days', '28', '--json']).out)
  assert.equal(bal.workouts, 9)
  assert.ok(bal.rows.find(r => r.muscle === 'quadriceps').perWeek > 0)
  const st = cli(['status'])
  assert.match(st.out, /9 sesiones/)
})

t('409: the same plan applied by someone else in between → stop, no duplicates', async () => {
  const p = loadPlan('plan-4dias-torso-pierna-intermedio.json')
  const real = createClient({ url, token })
  const other = createClient({ url, token })
  let raced = false
  // A client whose first PUT is preceded by another device applying the very same plan.
  const racing = { ...real, putData: async (s, base) => {
    if (!raced) { raced = true; await applyPlanFlow({ client: other, data: p, schedule: true, yes: true, backupDir: path.join(work, 'backups'), label: 'other' }) }
    return real.putData(s, base)
  } }
  await assert.rejects(
    applyPlanFlow({ client: racing, data: p, schedule: true, yes: true, backupDir: path.join(work, 'backups'), label: 'me' }),
    e => e.code === EXIT.ALREADY && /409/.test(e.message)
  )
  const { state: S } = await state()
  assert.equal(S.routines.filter(r => r.name === 'Torso A · fuerza').length, 1)
  assert.equal(S.routines.length, 3 + 4)
})

t('409: an unrelated write in between → re-applied once on top of it, nothing lost', async () => {
  const real = createClient({ url, token })
  let raced = false
  const racing = { ...real, putData: async (s, base) => {
    if (!raced) {
      raced = true
      const cur = await real.getData()
      cur.state.bodyweight = [...(cur.state.bodyweight || []), { d: '2026-11-05', w: 77.7, t: Date.now() }]
      assert.equal((await real.putData(cur.state, { baseRev: cur.rev, baseWid: cur.wid })).ok, true)
    }
    return real.putData(s, base)
  } }
  const data = { changes: [{ type: 'sets', target: { routineName: 'Full body C', exId: '0314' }, after: 4, why: 'test 409' }] }
  const r = await applyChangesFlow({ client: racing, data, yes: true, backupDir: path.join(work, 'backups'), label: 'me' })
  assert.equal(r.retried, true)
  const { state: S } = await state()
  assert.ok(S.bodyweight.some(b => b.w === 77.7))
  assert.equal(S.routines.find(x => x.name === 'Full body C').ex.find(e => e.id === '0314').sets, 4)
})

t('plan revert undoes the last applied change-set', async () => {
  const r = cli(['plan', 'revert', '--yes'])
  assert.equal(r.code, EXIT.OK, r.err)
  const { state: S } = await state()
  assert.equal(S.routines.find(x => x.name === 'Full body C').ex.find(e => e.id === '0314').sets, 3)
})
