// Jest configuration.
//
// `setupFiles` runs in every worker before the test framework and before any
// test file is loaded, so `tests/setupEnv.js` can pin the environment that
// application modules read at import time. See that file for the rationale.
module.exports = {
  setupFiles: ['<rootDir>/tests/setupEnv.js']
};
