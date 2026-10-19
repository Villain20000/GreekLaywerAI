// Machine-readable error codes for the /api/auth surface.
//
// WHY THIS EXISTS
// ---------------
// The Angular client used to classify auth failures by pattern-matching the
// server's ENGLISH PROSE — e.g.
//
//   frontend/src/app/services/auth.service.ts
//     if (response.status === 400 &&
//         typeof data?.error === 'string' &&
//         data.error.startsWith('Email not verified')) { ... }
//
// That couples the client to the server's copy: rewording a message silently
// breaks the client's branching (the user would see a generic error instead
// of the "Resend verification email" affordance). Every auth response now
// carries a stable, machine-readable `code` next to the human-readable
// `error` string, so clients branch on the code and humans still read prose.
//
// CONTRACT
// --------
//   1. The `error` strings are BYTE-FOR-BYTE UNCHANGED. `code` is purely
//      additive: a client that ignores `code` sees exactly the same
//      responses it saw before.
//   2. The map below is the COMPLETE, stable vocabulary. Add a new value
//      HERE rather than inlining a literal at a call site, so the set stays
//      greppable and reviewable. Values are snake_case and are part of the
//      public API contract — do not rename one without a version bump.
//   3. ANTI-ENUMERATION. `/forgot-password` and `/resend-verification`
//      exist to stop attackers from discovering which addresses have
//      accounts. They must answer with the SAME body — including the SAME
//      `code` — whether or not the address exists, is already verified, or
//      is malformed. A per-outcome code (e.g. `email_exists` vs
//      `email_unknown`) would reintroduce the very oracle these routes
//      exist to prevent, so they share ONE generic code
//      (REQUEST_ACCEPTED).
//   4. The same rule applies to `/login`: an unknown address and a wrong
//      password both answer `invalid_credentials`, so the code carries no
//      enumeration signal either.
//
// The `unverified_email` code is the one the client actually needs to
// branch on today (it drives the "Resend verification email" UI); the rest
// exist so every failure mode is nameable without string matching.

const AUTH_ERROR_CODES = Object.freeze({
  // ---- /login ----
  // Unknown address AND wrong password. One code for both so the response
  // stays a perfect enumeration shield.
  INVALID_CREDENTIALS: 'invalid_credentials',
  // Correct credentials, but the account has not consumed its
  // /verify-email link yet. The client uses this to offer "Resend
  // verification email" instead of a dead-end error.
  UNVERIFIED_EMAIL: 'unverified_email',

  // ---- /register ----
  // The address is already registered (both the pre-check and the
  // UNIQUE-violation race return this).
  EMAIL_TAKEN: 'email_taken',
  // A client tried to self-register with role: 'admin'.
  ADMIN_REGISTRATION_FORBIDDEN: 'admin_registration_forbidden',

  // ---- bearer-token endpoints ----
  // /reset-password, /verify-email and /admin-magic-link/redeem all treat
  // "missing / malformed / expired / already-consumed / wrong-kind" tokens
  // identically, so they share ONE code.
  INVALID_TOKEN: 'invalid_token',

  // ---- request shape ----
  // Missing/malformed fields, or a password below the minimum length.
  INVALID_REQUEST: 'invalid_request',

  // ---- /change-password ----
  // Generic failure: wrong current password, a no-op rotation, or a
  // concurrent-rotation conflict. Deliberately coarse so the endpoint
  // cannot be used as a password oracle.
  PASSWORD_CHANGE_FAILED: 'password_change_failed',
  // The JWT pointed at a user that no longer exists.
  USER_NOT_FOUND: 'user_not_found',

  // ---- /admin-magic-link/redeem ----
  // The token is valid but the account is no longer an admin.
  ADMIN_ROLE_REQUIRED: 'admin_role_required',
  // The endpoint is disabled in this deployment (production gate).
  NOT_FOUND: 'not_found',

  // ---- anti-enumeration generic answer ----
  // The ONLY code /forgot-password and /resend-verification ever return.
  // Identical for known and unknown addresses (see CONTRACT rule 3).
  REQUEST_ACCEPTED: 'request_accepted',

  // ---- catch-all ----
  SERVER_ERROR: 'server_error'
});

module.exports = { AUTH_ERROR_CODES };
