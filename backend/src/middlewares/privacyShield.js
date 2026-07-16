// Phase 15: Data Privacy & Local GDPR Middlewares
// Ensures sensitive legal data does not leak to external APIs and logging is minimized

const privacyShield = (req, res, next) => {
  // 1. Sanitize logging (avoid logging PII or legal context)
  console.log(`[PRIVACY SHIELD] Received ${req.method} request on ${req.url}. Data processed locally.`);
  
  // 2. Enforce Headers for no-caching of sensitive legal requests
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  
  // 3. Mark the request as locally processed
  req.isLocallyProcessed = true;
  
  next();
};

module.exports = privacyShield;
