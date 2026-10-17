/**
 * The built-in secret screen, a leaf module so the capture tier (#13) can screen excerpts without importing the
 * curated store. `store.ts` re-exports `looksSecret`; the public entry keeps its original name and behavior.
 */
const SECRETS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/, /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i];
/** A secret-looking string: refused before anything is written, since long-term entries leave the machine. */
export const looksSecret = (text: string): boolean => SECRETS.some((re) => re.test(text));
