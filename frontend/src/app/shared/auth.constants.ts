/**
 * Client-side mirror of backend constants.
 *
 * These MUST stay in sync with `backend/src/routes/auth.js` (and any future
 * server-side guard). The server is the source of truth — if it ever
 * diverges, the UI's client-side validation will produce a different error
 * than the server, and the user will see two slightly different warnings.
 * Keep this file under change-control when bumping the threshold.
 */
export const MIN_PASSWORD_LENGTH = 8;
