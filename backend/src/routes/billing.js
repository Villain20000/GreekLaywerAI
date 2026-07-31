const express = require('express');
const router = express.Router();
const stripeService = require('../services/stripeService');
const { rbacMiddleware, ALLOWED_TIERS } = require('../middlewares/authMiddleware');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');

// Checkout endpoint. Open to user|admin|enterprise so a free-tier 'user'
// can still pay to upgrade (otherwise the billing catch-22 would block
// upgrades entirely).
router.post(
  '/create-checkout-session',
  validate([
    check('tier')
      .isString()
      .isIn(ALLOWED_TIERS)
      .withMessage(`tier must be one of: ${ALLOWED_TIERS.join(', ')}`)
  ]),
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      const { tier } = req.body;
      const session = await stripeService.createCheckoutSession({
        tier,
        user: req.user
      });
      res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
