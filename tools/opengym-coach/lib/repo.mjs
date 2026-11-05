// The repo's own pure modules, imported by path so the CLI judges and applies a plan with the
// exact code the app and the Coach use — no copy that could drift. Nothing here needs
// node_modules: these files import only each other and JSON.
export { validatePlan, validateReview, CHANGE_TYPES as REVIEW_CHANGE_TYPES } from '../../../api/coach/core/validate.js'
export { LIBRARY, LIB_BY_ID, libraryHas, libraryName, equipmentAllows } from '../../../api/coach/core/library.js'
export { cleanPlan, isWarmupSet } from '../../../api/coach/core/payload.js'
export { applyCreatedPlan, applyChangeSet, validateProposal, markStale, revertLast, CHANGE_TYPES } from '../../../frontend/src/lib/coach.js'
export { mergePlan } from '../../../frontend/src/lib/plan-share.js'
export { deleteRoutine } from '../../../frontend/src/lib/routines.js'
export { loadOfWorkouts, loadOfWeeklyPlan, muscleBalanceWindow, MUSCLE_NAME } from '../../../frontend/src/lib/muscles.js'
export { best1RM, bestSetOf, e1rmSeries, is1RMRecord, formulaOf, FORMULA_NAMES } from '../../../frontend/src/lib/onerm.js'
export { workoutVolume, workSetsDone, workoutDuration, entryExcluded } from '../../../frontend/src/lib/history.js'
export { weeklyWeights } from '../../../frontend/src/lib/bodyweight.js'
export { EXIDX, canonicalExId } from '../../../frontend/src/lib/exercises.js'
export { weekStartOf, todayISO } from '../../../frontend/src/lib/format.js'
export { isWarmupRow } from '../../../frontend/src/lib/workout-model.js'
