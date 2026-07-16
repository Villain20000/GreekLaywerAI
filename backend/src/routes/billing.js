const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { rbacMiddleware, ALLOWED_TIERS } = require('../middlewares/authMiddleware');

// Use mock key if no real key provided
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_mock');

/**
 * Checkout endpoint. Open to user|admin|enterprise so a free-tier 'user'
 * can still pay to upgrade (otherwise the billing catch-22 would block
 * upgrades entirely).
 */
router.post(
  '/create-checkout-session',
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      const { tier } = req.body;

      if (!ALLOWED_TIERS.includes(tier)) {
        return res.status(400).json({
          error: `Invalid tier. Must be one of: ${ALLOWED_TIERS.join(', ')}.`
        });
      }

      // Phase 14: Mocking Stripe Integration
      console.log(`[BILLING] Mocking checkout session for tier: ${tier}`);

      const mockSessionUrl = `http://localhost:4200/chat?mock_payment=success&tier=${encodeURIComponent(tier)}`;

      res.json({ url: mockSessionUrl });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
