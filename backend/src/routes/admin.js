const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authMiddleware, rbacMiddleware, ALLOWED_ROLES, ALLOWED_TIERS } = require('../middlewares/authMiddleware');

// All admin endpoints require auth AND admin role.
router.use(authMiddleware);
router.use(rbacMiddleware(['admin']));

function parseUserId(rawId) {
  const parsed = parseInt(rawId, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

// GET /api/admin/users — list every user (without password)
router.get('/users', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, role, subscription_tier, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/admin/users/:id/role — change a user's role
router.patch('/users/:id/role', async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    if (userId === null) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const { role } = req.body;
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({
        error: `Invalid role. Must be one of: ${ALLOWED_ROLES.join(', ')}.`
      });
    }

    // Guard: don't let an admin demote themselves (would lock the system out of admins).
    if (userId === req.user.id && role !== 'admin') {
      return res.status(409).json({
        error: 'Refusing to demote yourself. Have another admin make the change.'
      });
    }

    const result = await db.query(
      `UPDATE users SET role = $1 WHERE id = $2
       RETURNING id, email, role, subscription_tier`,
      [role, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/admin/users/:id/tier — change a user's billing tier
router.patch('/users/:id/tier', async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    if (userId === null) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const { tier } = req.body;
    if (!ALLOWED_TIERS.includes(tier)) {
      return res.status(400).json({
        error: `Invalid tier. Must be one of: ${ALLOWED_TIERS.join(', ')}.`
      });
    }

    const result = await db.query(
      `UPDATE users SET subscription_tier = $1 WHERE id = $2
       RETURNING id, email, role, subscription_tier`,
      [tier, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
