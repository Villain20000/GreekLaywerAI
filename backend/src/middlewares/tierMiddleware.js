// Phase 29: Tier-based subscription enforcement.
//
// Complements rbacMiddleware (role gates) with billing-tier gates:
//   - requireTier('pro')        → basic users get 403
//   - requireTier('enterprise') → basic AND pro users get 403
// Reads the live tier from req.user, which authMiddleware hydrates from
// the users table on every authenticated request (no stale JWT claims).

const TIER_ORDER = { basic: 1, pro: 2, enterprise: 3 };

function requireTier(minTier) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    const tier = req.user.subscription_tier || 'basic';
    if (!TIER_ORDER[tier] || TIER_ORDER[tier] < TIER_ORDER[minTier]) {
      return res.status(403).json({
        error: `This feature requires the ${minTier} subscription tier.`
      });
    }
    next();
  };
}

module.exports = { requireTier };
