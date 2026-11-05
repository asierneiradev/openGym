// HTTP client for the openGym API. Bearer token only: a Bearer request skips the CSRF check
// and needs no cookie jar (api/server.js sessionOf). Errors are CliError with an exit code, so
// the entry point can map every failure to one documented status.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const EXIT = {
  OK: 0, ERROR: 1, USAGE: 2, INVALID: 3, AUTH: 4, CONFLICT: 5, NETWORK: 6, ALREADY: 7
}

export class CliError extends Error {
  constructor(message, code = EXIT.ERROR, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

export const DEFAULT_URL = 'https://gym.iruxu.cloud'
export const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.config', 'opengym-coach', 'token')

/** Token lookup, first hit wins: --token-file, OPENGYM_TOKEN, ~/.config/opengym-coach/token. */
export function resolveToken({ tokenFile, env = process.env } = {}) {
  const fromFile = file => {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch (e) {
      throw new CliError(`No puedo leer el token de ${file}: ${e.code || e.message}`, EXIT.AUTH)
    }
    const tok = raw.trim()
    if (!tok) throw new CliError(`El fichero de token ${file} está vacío`, EXIT.AUTH)
    return { token: tok, source: file }
  }
  if (tokenFile) return fromFile(tokenFile)
  if (env.OPENGYM_TOKEN && env.OPENGYM_TOKEN.trim()) return { token: env.OPENGYM_TOKEN.trim(), source: 'OPENGYM_TOKEN' }
  if (fs.existsSync(DEFAULT_TOKEN_FILE)) return fromFile(DEFAULT_TOKEN_FILE)
  return null
}

export function createClient({ url = DEFAULT_URL, token, timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(url).replace(/\/+$/, '')
  if (!token) throw new CliError('Falta el token: usa --token-file, OPENGYM_TOKEN o ~/.config/opengym-coach/token', EXIT.AUTH)

  async function call(method, route, body) {
    let res
    try {
      res = await fetchImpl(base + route, {
        method,
        headers: {
          authorization: 'Bearer ' + token,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (e) {
      throw new CliError(`No hay conexión con ${base}: ${e.cause?.code || e.message}`, EXIT.NETWORK)
    }
    let data = null
    const text = await res.text()
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (res.status === 401) throw new CliError('Token rechazado por el servidor (401): caducado, revocado o mal firmado', EXIT.AUTH, { status: 401 })
    if (res.status === 409) return { status: 409, data }
    if (!res.ok) {
      throw new CliError(`El servidor respondió ${res.status} en ${method} ${route}: ${data?.error || text.slice(0, 200)}`,
        res.status >= 500 ? EXIT.NETWORK : EXIT.ERROR, { status: res.status })
    }
    return { status: res.status, data }
  }

  return {
    base,
    me: async () => (await call('GET', '/api/me')).data,
    /** { state, rev, wid } — wid is the document's write id, needed for a safe conditional PUT. */
    getData: async () => {
      const { data } = await call('GET', '/api/data')
      const state = data?.state || {}
      return { state, rev: data?.rev || 0, wid: state._wid || null }
    },
    /** Conditional write. Returns { ok:true, rev, wid } or { ok:false, conflict:{ state, rev, wid } }. */
    putData: async (state, { baseRev, baseWid }) => {
      const r = await call('PUT', '/api/data', { state, baseRev, ...(baseWid ? { baseWid } : {}) })
      if (r.status === 409) {
        const st = r.data?.state || {}
        return { ok: false, conflict: { state: st, rev: r.data?.rev || 0, wid: st._wid || null } }
      }
      return { ok: true, rev: r.data?.rev, wid: r.data?.wid }
    }
  }
}
