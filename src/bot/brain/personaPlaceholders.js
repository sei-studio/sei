// 261013 (T111): card {{user}} / {{char}} placeholder fill. The definition
// lives in promptLibrary.js, which must stay import-free (the dev-viewer
// LIBRARY tab re-imports its rewritten source from a data: URL); this module is
// the import point for everything outside the prompt document.
export { fillPersonaPlaceholders, hasPersonaPlaceholders } from './promptLibrary.js'




