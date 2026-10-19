// Secret resolution with Docker/Kubernetes secret-file support.
//
// For every secret NAME, `${NAME}_FILE` takes precedence over the plain
// environment variable: the file is read as UTF-8 and only trailing CR/LF
// characters are stripped (secrets managers commonly append a newline).
// When no file is configured, `process.env[NAME]` is used, then the caller's
// fallback. A configured-but-unreadable file throws: silently booting with a
// weaker fallback would defeat the point of mounting the secret.

const fs = require('fs');

function readSecretFile(variableName, filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/[\r\n]+$/, '');
  } catch (err) {
    throw new Error(
      `[secrets] ${variableName} is set to ${filePath}, but the file could not be read: ${err.message}`
    );
  }
}

/**
 * Resolve a secret from `${name}_FILE`, then `process.env[name]`, then
 * `fallback`. An empty plain env var is treated as unset so `FOO=` in a
 * compose file does not mask the fallback.
 *
 * @param {string} name Environment variable name (e.g. 'JWT_SECRET').
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
function getSecret(name, fallback) {
  const fileVariable = `${name}_FILE`;
  const filePath = (process.env[fileVariable] || '').trim();
  if (filePath) {
    const value = readSecretFile(fileVariable, filePath);
    // A few legacy modules still read process.env directly. Hydrating here
    // (the first consumer always loads before them in the server boot path)
    // keeps file-only deployments consistent without a second code path.
    process.env[name] = value;
    return value;
  }
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  return fallback;
}

module.exports = { getSecret };
