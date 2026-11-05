# opengym-coach — CLI de entrenador para openGym

Lee un perfil de openGym y le escribe planes y revisiones desde la terminal, con **el mismo
contrato, validador y código de aplicación que el Coach integrado**:

- `api/coach/core/validate.js` (`validatePlan`, `validateReview`) decide si un plan o un cambio es válido;
- `frontend/src/lib/coach.js` (`applyCreatedPlan`, `applyChangeSet`, `revertLast`) lo aplica, con
  instantánea y entrada en el log del Coach, igual que al aceptar una propuesta en la app;
- `muscles.js`, `onerm.js`, `history.js` y `bodyweight.js` calculan los resúmenes.

Node 22, solo la biblioteca estándar y módulos puros del repo: **sin `npm install`**.

```bash
node tools/opengym-coach/opengym.mjs help
```

## Autenticación

Token Bearer en el formato de sesión de la API (`uid:expMs:sv.HMAC`). Se busca, en este orden:
`--token-file FILE` → `OPENGYM_TOKEN` → `~/.config/opengym-coach/token`. La URL es
`--url` → `OPENGYM_URL` → `https://gym.iruxu.cloud`.

Emitir un token (administrador, en la máquina que tiene `DATA_DIR`; solo lee `secret` y `db.json`):

```bash
node opengym.mjs token mint --uid <uid> --days 30 --data-dir /ruta/a/data --out ~/.config/opengym-coach/token
node opengym.mjs token check           # GET /api/me: ¿funciona y con qué usuario?
```

`--days` admite como máximo 365. Para revocar: «cerrar sesión en todos los dispositivos» en la
app (sube `sv`) o rotar `data/secret` (cierra todas las sesiones de la instancia).

## Comandos

| Comando | Qué hace |
|---|---|
| `status` | nombre, uid, `rev`, nº de rutinas/días/sesiones, peso actual y objetivo |
| `routines` / `week` | plan actual: ejercicios, prescripción (`3×8-12`, `3×8→15`, `/lado`), progresión, días |
| `workouts [--limit N]` | sesiones: duración, volumen, series hechas/planeadas, top set (e1RM), PRs de e1RM |
| `bodyweight [--days N]` | pesajes, medias semanales, tendencia por mínimos cuadrados (kg/semana) |
| `balance [--days N]` | series efectivas por músculo: total, por semana y lo que programa la semana actual |
| `one-rm [--ex ID]` | 1RM estimado con la fórmula del perfil (todas o una con su serie reciente) |
| `library search --q … [--bp] [--eq] [--tg] [--limit]` | busca en `api/coach/core/library-data.js` |
| `library check ID…` | ¿existen? (código 3 si alguno no) |
| `library facets` | valores válidos de `--bp`, `--eq` y `--tg` |
| `plan validate FILE` | `validatePlan` con el contexto real del perfil (equipamiento, ejercicios propios, pesos de trabajo, días) |
| `plan apply FILE [--schedule] [--replace]` | valida, comprueba si ya está aplicado, aplica y hace PUT condicional |
| `plan revert` | deshace el último plan o cambio aplicado (rutinas y semana; el historial no se toca) |
| `changes validate FILE` / `changes apply FILE` | revisión con la lista cerrada de tipos de cambio |

Todas aceptan `--json`. **Las escrituras son simulación por defecto**: sin `--yes` imprimen el
diff y no escriben. Con `--yes` guardan antes una copia del state en `--backup-dir`
(`OPENGYM_BACKUP_DIR`, por defecto `~/.local/state/opengym-coach/backups`, ficheros `0600`).

### Planes

El fichero es el JSON de `api/coach/prompts/create.md` (`week` + `routines[].ex[]`). Validación:

- Ids de ejercicio: tienen que existir en la librería o ser ejercicios propios del perfil o
  `customEx` del propio plan. Si no, se rechaza antes de escribir nada.
- Equipamiento: el del perfil del Coach o, si está vacío, el perfil de equipamiento activo.
  `--equipment a,b` lo sustituye. Lo que ya está en el plan o en el historial nunca se rechaza por esto.
- Días: `--days N` o `coach.profile.daysPerWeek`. Sin ninguno de los dos, la semana no puede estar vacía.
- `weight`: se descarta si no hay historial del ejercicio y se limita al máximo levantado si lo
  hay. El CLI avisa en ambos casos: el motor de progresión ya parte de la última sesión.
- `plan validate` sin token (o con `--offline`) valida sin perfil. `--state FILE` usa un state local.

`plan apply` añade las rutinas como nuevas (`mergePlan`). `--schedule` sustituye la semana.
`--replace` borra antes las rutinas existentes (el historial se conserva) y la instantánea guarda
las anteriores, así que `plan revert` las recupera.

**No duplica.** Si todas las rutinas del plan ya existen (mismo nombre y mismos ejercicios en el
mismo orden), sale con código 7 sin escribir. Si solo existen algunas, también sale con 7, salvo
con `--replace`.

### Cambios

```json
{ "summary": "…", "changes": [
  { "type": "sets", "target": { "routineName": "Torso A", "exId": "0025" }, "after": 5, "why": "…" },
  { "type": "week", "target": { "weekday": 6 }, "after": "Pierna B", "why": "…" } ] }
```

Tipos: `add-exercise`, `remove-exercise`, `swap-exercise`, `sets`, `reps`, `repsMin`, `repsMax`,
`sec`, `cardio`, `reorder`, `superset`, `routine-prog`, `exercise-prog`, `inc`, `add-routine`,
`remove-routine`, `rename-routine`, `week`. La rutina se indica con `target.routineId` o
`target.routineName`. Un cambio de `week` acepta el nombre de la rutina en `after`. Un cambio
cuyo valor ya está en el plan se descarta, y si no queda ninguno sale con código 7.

### Escritura concurrente (409)

El PUT lleva `baseRev` y `baseWid`. Si otro cliente escribió entre medias, el servidor responde
409 con su documento. Sobre ese documento el CLI vuelve a comprobar si su trabajo ya está hecho:
si lo está, sale con 7 sin escribir; si no, lo aplica otra vez **una sola vez**. Un segundo 409
termina con código 5.

Antes de cada PUT, cada rutina que ya existía en el documento leído conserva los sellos
(`_ts`, `_f`) que traía. El servidor sella los cambios de los clientes que no sellan
(`api/sync-stamps.js`). Si recibiera los sellos antiguos de una instantánea, tomaría un
`revert` por una copia vieja y lo desharía.

## Códigos de salida

`0` ok · `1` error · `2` uso · `3` plan o cambios inválidos (o id inexistente en `library check`) ·
`4` autenticación (401, token ausente) · `5` conflicto (409 persistente o cambios obsoletos) ·
`6` red o servidor · `7` ya aplicado o nada que cambiar (no se ha escrito nada).

## Tests

```bash
node --test tools/opengym-coach/test/*.test.mjs
```

- `unit.test.mjs`: puro, sin red.
- `sandbox.test.mjs`: arranca `api/server.js` en un puerto libre con un `DATA_DIR` temporal
  vacío, registra un usuario con contraseña, emite su token con el `secret` de ese directorio y
  recorre el ciclo completo. Cubre token inválido → 401, id inventado → rechazo, N rutinas y N
  días sin duplicar, `sets`/`reps` aplicados, dos 409 reales (mismo plan → se detiene; escritura
  ajena → se reaplica) y `revert`. Necesita `api/node_modules` (`cd api && npm ci`); si no
  existe, se marca como omitido.
