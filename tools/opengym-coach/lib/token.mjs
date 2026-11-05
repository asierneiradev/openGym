// Session tokens in the API's own format (api/server.js sign/makeSession):
//   payload = `<uid>:<expMs>:<sv>`, token = payload + '.' + base64url(HMAC-SHA256(secret, payload))
// `secret` is DATA_DIR/secret trimmed — the server reads it the same way. `sv` is the user's
// session version; bumping it (log out everywhere) or rotating the secret revokes the token.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CliError, EXIT } from './api.mjs'

export const MAX_DAYS = 365

export function signToken(secret, uid, expMs, sv = 0) {
  const payload = `${uid}:${expMs}:${sv}`
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

/** Reads secret and the user's `sv` from a data dir; never writes anything there. */
export function mintToken({ dataDir, uid, days, now = Date.now() }) {
  if (!dataDir) throw new CliError('Falta --data-dir (o OPENGYM_DATA_DIR): el directorio con secret y db.json', EXIT.USAGE)
  if (!uid) throw new CliError('Falta --uid', EXIT.USAGE)
  const d = Number(days)
  if (!Number.isFinite(d) || d <= 0) throw new CliError('--days debe ser un número de días mayor que 0', EXIT.USAGE)
  if (d > MAX_DAYS) throw new CliError(`--days no puede pasar de ${MAX_DAYS}: un token largo es una llave larga`, EXIT.USAGE)
  let secret, db
  try { secret = fs.readFileSync(path.join(dataDir, 'secret'), 'utf8').trim() } catch (e) {
    throw new CliError(`No puedo leer ${path.join(dataDir, 'secret')}: ${e.code || e.message}`, EXIT.ERROR)
  }
  if (!secret) throw new CliError('El secret está vacío', EXIT.ERROR)
  try { db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')) } catch (e) {
    throw new CliError(`No puedo leer ${path.join(dataDir, 'db.json')}: ${e.code || e.message}`, EXIT.ERROR)
  }
  const user = (db.users || []).find(u => u.id === uid)
  if (!user) throw new CliError(`No existe el usuario ${uid} en ${dataDir}/db.json`, EXIT.USAGE)
  if (user.disabled) throw new CliError(`El usuario ${uid} está deshabilitado`, EXIT.USAGE)
  const exp = now + Math.round(d * 86400000)
  return { token: signToken(secret, uid, exp, user.sv || 0), uid, name: user.name, exp }
}

/** Reads the unsigned half of a token (uid, expiry, version). Does not verify it. */
export function decodeToken(token) {
  const i = String(token).lastIndexOf('.')
  const [uid, exp, sv] = (i < 0 ? '' : token.slice(0, i)).split(':')
  return uid && exp ? { uid, exp: Number(exp), sv: Number(sv || 0) } : null
}
