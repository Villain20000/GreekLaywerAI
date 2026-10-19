const request = require('supertest');
const app = require('./app');
const db = require('../src/config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const inferenceQueue = require('../src/services/inferenceQueue');
const { AUTH_ERROR_CODES } = require('../src/constants/authErrors');

const JWT_SECRET = 'nomos-super-secret-key-development';

/**
 * Phase 22: every authenticated request triggers a SELECT inside
 * authMiddleware (for id/email/role/subscription_tier/created_at/token_version).
 * Queue an appropriate row BEFORE each request as mockResolvedValueOnce
 * (consumed by authMiddleware), AND install a fallback `mockResolvedValue`
 * with empty rows so any handler-internal db.query calls (e.g. conversation
 * tracking in /api/ai, billing user fetch) return cleanly instead of
 * `undefined`, which would crash the handler and break the route's response.
 *
 * Tests that ALSO need to mock handler-specific queries (change-password
 * lookup + UPDATE) chain additional mockResolvedValueOnce() AFTER queueAuth:
 * the Once queue is FIFO, so they fire after authMiddleware consumes #1.
 */
function queueAuth(userOverride = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: userOverride.id ?? 2,
      email: userOverride.email ?? 'user@nomos.ai',
      role: userOverride.role ?? 'user',
      subscription_tier: userOverride.subscription_tier ?? 'basic',
      created_at: userOverride.created_at ?? new Date('2024-01-01T00:00:00Z'),
      token_version: userOverride.token_version ?? 1
    }]
  });
  // Fallback default for any further db.query the handler may issue.
  // Returning `{ rows: [] }` keeps handlers that read tiers / conversations
  // from crashing on undefined.
  db.query.mockResolvedValue({ rows: [] });
}

describe('NomosAI API Endpoints', () => {
  let enterpriseToken = '';
  let adminToken = '';
  let userToken = '';

  beforeAll(() => {
    // Phase 22: include `tv: 1` so authMiddleware doesn't 401 the test JWTs
    // out of hand. Tests that exercise stale rejection use other values.
    enterpriseToken = jwt.sign(
      { id: 1, email: 'ent@nomos.ai', role: 'enterprise', tv: 1 },
      JWT_SECRET
    );
    adminToken = jwt.sign(
      { id: 99, email: 'admin@nomos.ai', role: 'admin', tv: 1 },
      JWT_SECRET
    );
    userToken = jwt.sign(
      { id: 2, email: 'user@nomos.ai', role: 'user', tv: 1 },
      JWT_SECRET
    );
  });

  // Phase 22: reset db.query ONLY. jest.resetAllMocks() is too aggressive —
  // it would wipe the `mockResolvedValue` / `mockImplementation` defaults
  // set on ollamaService.generateResponse /
  // ragService.formatContextForGemma in tests/app.js, turning AI tests'
  // mocked `Mock response` into `undefined` and hanging the audio-query
  // response stream. Targeted mockReset() preserves the module-scoped mocks
  // while still clearing db.query's once-queue and recorded calls.
  afterEach(() => {
    db.query.mockReset();
  });

  // 1. Auth API Tests
  describe('Auth API (/api/auth)', () => {
    it('should register a new user and force role="user" regardless of client-supplied role', async () => {
      // Phase 24: /register now runs inside a db.connect() transaction
      // (BEGIN/INSERT-for-update-existing/INSERT-users/INSERT-email_verification_tokens/COMMIT),
      // so ALL four calls land on the mocked client. Each client.query call
      // delegates to db.query in the singleton mock factory, so we still
      // queue responses on db.query.
      // SELECT FOR UPDATE (existing): empty
      db.query.mockResolvedValueOnce({ rows: [] });
      // INSERT users RETURNING
      db.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            email: 'newuser@nomos.ai',
            role: 'user',
            subscription_tier: 'basic',
            token_version: 1
          }
        ]
      });
      // INSERT email_verification_tokens
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'newuser@nomos.ai',
          password: 'password123',
          role: 'enterprise' // should be ignored
        });

      expect(res.statusCode).toEqual(200);
      // Phase 24: register no longer mints a JWT. The success envelope
      // carries requires_verification + the user row, but NO `token`.
      expect(res.body.token).toBeUndefined();
      expect(res.body.ok).toBe(true);
      expect(res.body.requires_verification).toBe(true);
      expect(res.body.user).toHaveProperty('email', 'newuser@nomos.ai');
      expect(res.body.user).toHaveProperty('role', 'user'); // forced
      expect(res.body.user).toHaveProperty('subscription_tier', 'basic');
      expect(res.body.user).toHaveProperty('token_version', 1);
      expect(res.body.user).toHaveProperty('verified_at', null);
    });

    it('should fail registration if user exists', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // SELECT FOR UPDATE finds existing

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@nomos.ai', password: 'password123' });

      expect(res.statusCode).toEqual(400);
      expect(res.body).toHaveProperty('error', 'User already exists');
      // Machine-readable companion to the (unchanged) error string.
      expect(res.body.code).toBe('email_taken');
    });

    it('should hash-set a sha256 verify-token and INSERT into email_verification_tokens on register', async () => {
      // SELECT FOR UPDATE existing: empty
      db.query.mockResolvedValueOnce({ rows: [] });
      // INSERT users RETURNING
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 7, email: 'newv@nomos.ai', role: 'user',
          subscription_tier: 'basic', token_version: 1
        }]
      });
      // INSERT email_verification_tokens
      db.query.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .post('/api/auth/register')
        .send({ email: 'newv@nomos.ai', password: 'password123' });

      // We should have hit the singleton db.query three times (matching
      // the three queries the transactional register handler queues).
      expect(db.query.mock.calls.length).toBeGreaterThanOrEqual(3);

      // The third call is the INSERT into email_verification_tokens. The
      // token_hash column is sha256(plaintext), and the plaintext was
      // mailed to the dev console transport — re-derive via the same hash
      // and confirm shape.
      const insertCall = db.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' &&
                   /INSERT INTO email_verification_tokens/i.test(sql)
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[0]).toMatch(/INSERT INTO email_verification_tokens/i);
      // First positional param is user_id (must match INSERT-users row id)
      expect(insertCall[1][0]).toBe(7);
      // Second is sha256(plaintext-as-hex-64). No raw plaintext should
      // ever be stored.
      expect(typeof insertCall[1][1]).toBe('string');
      expect(insertCall[1][1]).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should reject passwords shorter than 8 chars with 400', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'short@nomos.ai', password: 'abc' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/at least 8/);
      // No DB calls should have happened.
      expect(db.query).not.toHaveBeenCalled();
    });

    it('should login an existing user and embed the live token_version in the JWT', async () => {
      const mockHashedPassword = await bcrypt.hash('password123', 10);
      // Phase 24: SELECT now includes verified_at. Pre-verified user ⇒
      // login returns a JWT normally.
      db.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            email: 'ent@nomos.ai',
            password_hash: mockHashedPassword,
            role: 'enterprise',
            subscription_tier: 'enterprise',
            token_version: 1,
            verified_at: new Date('2026-01-01T00:00:00Z')
          }
        ]
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ent@nomos.ai', password: 'password123' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user).toHaveProperty('role', 'enterprise');
      expect(res.body.user).toHaveProperty('token_version', 1);
      expect(res.body.user).toHaveProperty('verified_at');
      // Confirm the JWT body embeds the tv claim (that's how authMiddleware
      // will accept the token on subsequent requests).
      const decoded = jwt.verify(res.body.token, JWT_SECRET);
      expect(decoded.tv).toBe(1);
    });

    it('should normalize login email case/whitespace to the stored lowercase form', async () => {
      const mockHashedPassword = await bcrypt.hash('password123', 10);
      db.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            email: 'ent@nomos.ai',
            password_hash: mockHashedPassword,
            role: 'enterprise',
            subscription_tier: 'enterprise',
            token_version: 1,
            verified_at: new Date('2026-01-01T00:00:00Z')
          }
        ]
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: '  Ent@Nomos.AI  ', password: 'password123' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('token');
      // The SELECT must receive the normalized email — not the raw body —
      // otherwise a mixed-case registration could never log in.
      const selectCall = db.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && /FROM users WHERE email = \$1/.test(sql)
      );
      expect(selectCall).toBeDefined();
      expect(selectCall[1][0]).toBe('ent@nomos.ai');
    });

    it('should reject login for unverified accounts with the canonical "Email not verified" message', async () => {
      const mockHashedPassword = await bcrypt.hash('password123', 10);
      db.query.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            email: 'pending@nomos.ai',
            password_hash: mockHashedPassword,
            role: 'user',
            subscription_tier: 'basic',
            token_version: 1,
            // Phase 24: verified_at IS NULL = unverified.
            verified_at: null
          }
        ]
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'pending@nomos.ai', password: 'password123' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/Email not verified/);
      // The stable code the client should branch on instead of matching
      // the English prose above.
      expect(res.body.code).toBe('unverified_email');
      expect(res.body.token).toBeUndefined();
    });

    it('should return the authenticated user from /me using authMiddleware\'s hydrated req.user', async () => {
      queueAuth({
        id: 2,
        email: 'user@nomos.ai',
        role: 'user',
        subscription_tier: 'basic'
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.user).toHaveProperty('id', 2);
      expect(res.body.user).toHaveProperty('email', 'user@nomos.ai');
      expect(res.body.user).toHaveProperty('role', 'user');
      expect(res.body.user).toHaveProperty('subscription_tier', 'basic');
      expect(res.body.user).toHaveProperty('token_version', 1);
      // Phase 22: /me now only hits authMiddleware's SELECT, not its own.
      // Exactly one db.query should have been made.
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('should block self-registration as admin with 403', async () => {
      // No DB calls should happen; the route short-circuits before querying.
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'evil@nomos.ai', password: 'password123', role: 'admin' });

      expect(res.statusCode).toEqual(403);
      expect(res.body).toHaveProperty('error', 'Cannot self-register as admin');
      expect(res.body.code).toBe('admin_registration_forbidden');
    });

    // (Phase 18 test: anonymous /me still 401s.)
    it('should reject /me requests without a Bearer token with 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.statusCode).toEqual(401);
    });

    // Phase 22: missing user now surfaces as 401 from authMiddleware
    // (no longer 404 from /me — /me no longer has its own SELECT).
    it('should return 401 from /me if the user no longer exists', async () => {
      db.query.mockResolvedValueOnce({ rows: [] }); // authMiddleware: no user

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.statusCode).toEqual(401);
      expect(res.body.error).toBe('User not found');
    });

    // Phase 22: stale-token rejection. JWT was signed with tv=5 but the live
    // users.token_version is 1, so the strict equality check fails.
    it('should reject JWTs whose tv claim is below the live token_version', async () => {
      const staleToken = jwt.sign(
        { id: 2, email: 'user@nomos.ai', role: 'user', tv: 5 },
        JWT_SECRET
      );
      queueAuth({ id: 2, token_version: 1 });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${staleToken}`);

      expect(res.statusCode).toEqual(401);
      expect(res.body.error).toMatch(/invalidated/i);
    });

    // Phase 22: legacy JWT (no tv claim at all) gets bounced so users re-login
    // once after the migration ships.
    it('should reject legacy JWTs without a tv claim', async () => {
      const legacyToken = jwt.sign(
        { id: 2, email: 'user@nomos.ai', role: 'user' },
        JWT_SECRET
      );
      queueAuth({ id: 2, token_version: 1 });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${legacyToken}`);

      expect(res.statusCode).toEqual(401);
      expect(res.body.error).toMatch(/invalidated/i);
    });
  });

  describe('Change-password API (POST /api/auth/change-password)', () => {
    const currentHash = bcrypt.hashSync('oldPassword123', 4); // low cost for test speed

    it('should reject unauthenticated requests with 401', async () => {
      const res = await request(app)
        .post('/api/auth/change-password')
        .send({ currentPassword: 'oldPassword123', newPassword: 'newPassword456' });
      expect(res.statusCode).toEqual(401);
    });

    it('should reject missing fields with 400', async () => {
      queueAuth({ id: 2 });
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'oldPassword123' }); // missing newPassword
      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/required/i);
      // No DB calls happened past authMiddleware — guard checks fire first.
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('should reject non-string password fields with 400', async () => {
      queueAuth({ id: 2 });
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 12345, newPassword: { evil: true } });
      expect(res.statusCode).toEqual(400);
    });

    it('should reject short new passwords with 400', async () => {
      queueAuth({ id: 2 });
      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'oldPassword123', newPassword: 'short' });
      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/at least 8/);
    });

    it('should reject when current password is wrong with a generic 400', async () => {
      queueAuth({ id: 2 });
      db.query.mockResolvedValueOnce({
        rows: [{ id: 2, password_hash: currentHash }]
      });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'definitely-wrong', newPassword: 'newPassword456' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Password change failed');
    });

    it('should reject no-op rotation (new same as current) with 400', async () => {
      queueAuth({ id: 2 });
      db.query.mockResolvedValueOnce({
        rows: [{ id: 2, password_hash: currentHash }]
      });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'oldPassword123', newPassword: 'oldPassword123' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Password change failed');
    });

    it('should UPDATE password_hash + token_version on success and return a fresh JWT signed with the NEW tv', async () => {
      queueAuth({ id: 2 });                                  // authMiddleware SELECT
      db.query.mockResolvedValueOnce({
        rows: [{ id: 2, password_hash: currentHash }]          // change-password lookup
      });
      db.query.mockResolvedValueOnce({                        // UPDATE returning the bumped row
        rows: [
          {
            id: 2,
            email: 'user@nomos.ai',
            role: 'user',
            subscription_tier: 'basic',
            token_version: 2
          }
        ],
        rowCount: 1
      });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'oldPassword123', newPassword: 'newPassword456' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
      // Phase 22: response carries a fresh token + updated user.row.
      expect(res.body.token).toBeDefined();
      expect(res.body.user.token_version).toBe(2);

      // The fresh token must be signed with the bumped tv so authMiddleware
      // accepts it on subsequent requests.
      const decodedFresh = jwt.verify(res.body.token, JWT_SECRET);
      expect(decodedFresh.tv).toBe(2);
      expect(decodedFresh.id).toBe(2);

      // Last UPDATE must use compare-and-set on password_hash AND bump tv.
      const lastCall = db.query.mock.calls[db.query.mock.calls.length - 1];
      expect(lastCall[0]).toMatch(/UPDATE users/);
      expect(lastCall[0]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/);
      expect(lastCall[0]).toMatch(/password_hash\s*=\s*\$3/); // compare-and-set predicate
      expect(lastCall[1][0]).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt hash: $2a$NN$...
      expect(lastCall[1][1]).toBe(2);                     // user id from JWT
      expect(lastCall[1][2]).toBe(currentHash);            // old hash for compare-and-set
    });

    it('should return 409 when the UPDATE affects 0 rows (concurrent rotation)', async () => {
      queueAuth({ id: 2 });
      db.query.mockResolvedValueOnce({ rows: [{ id: 2, password_hash: currentHash }] });
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'oldPassword123', newPassword: 'newPassword456' });

      expect(res.statusCode).toEqual(409);
      expect(res.body.error).toBe('Password change failed');
    });

    it('should return 401 if the JWT points at a deleted user', async () => {
      // authMiddleware SELECT returns empty — matches updated behavior where
      // 401 from authMiddleware (instead of 401 from inside the handler).
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'oldPassword123', newPassword: 'newPassword456' });

      expect(res.statusCode).toEqual(401);
      expect(res.body.error).toBe('User not found');
    });

    // Phase 22: the freshly returned JWT must be accepted by authMiddleware
    // on a follow-up /me call. End-to-end happy path.
    it('should make the freshly-issued token valid for subsequent /me calls', async () => {
      queueAuth({ id: 2, token_version: 1 });                  // authMiddleware before rotate
      db.query.mockResolvedValueOnce({
        rows: [{ id: 2, password_hash: currentHash }]          // change-password lookup
      });
      db.query.mockResolvedValueOnce({                        // UPDATE returning tv=2
        rows: [
          { id: 2, email: 'user@nomos.ai', role: 'user', subscription_tier: 'basic', token_version: 2 }
        ],
        rowCount: 1
      });

      const changeRes = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ currentPassword: 'oldPassword123', newPassword: 'newPassword456' });

      expect(changeRes.statusCode).toEqual(200);
      const newToken = changeRes.body.token;

      // Now use the NEW token on a follow-up /me.
      queueAuth({ id: 2, token_version: 2 });                  // DB tv is now 2
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${newToken}`);
      expect(meRes.statusCode).toEqual(200);
      expect(meRes.body.user.token_version).toBe(2);

      // And the OLD token should now be rejected (live tv=2, old tv=1).
      queueAuth({ id: 2, token_version: 2 });
      const oldTokenRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${userToken}`);
      expect(oldTokenRes.statusCode).toEqual(401);
      expect(oldTokenRes.body.error).toMatch(/invalidated/i);
    });
  });

  // 2. AI API Tests
  describe('AI API (/api/ai)', () => {
    it('should block unauthorized access', async () => {
      const res = await request(app).post('/api/ai/query').send({ prompt: 'Hello' });
      expect(res.statusCode).toEqual(401);
    });

    it('should allow user-role to use basic chat query', async () => {
      queueAuth({ id: 2, role: 'user' });
      const res = await request(app)
        .post('/api/ai/query')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ prompt: 'Τι προβλέπει ο νόμος;' });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('response', 'Mock response');
    });

    it('should allow enterprise-role to use basic chat query', async () => {
      queueAuth({ id: 1, role: 'enterprise', subscription_tier: 'enterprise' });
      const res = await request(app)
        .post('/api/ai/query')
        .set('Authorization', `Bearer ${enterpriseToken}`)
        .send({ prompt: 'Γεια σου' });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('response', 'Mock response');
    });

    it('should block user-role basic-tier from premium audio-query with 403', async () => {
      queueAuth({ id: 2, role: 'user', subscription_tier: 'basic' });
      const res = await request(app)
        .post('/api/ai/audio-query')
        .set('Authorization', `Bearer ${userToken}`)
        .attach('audio', Buffer.from('fake-audio-data'), 'test.webm');
      expect(res.statusCode).toEqual(403);
      expect(res.body.error).toMatch(/requires the pro subscription tier/i);
    });

    // Phase 29: audio-query now enqueues an inference job and returns its
    // jobId (frontend polls GET /api/ai/query/stream/:jobId). The upload
    // must also pass magic-byte validation (WebM EBML header).
    it('should allow enterprise-role to use audio-query', async () => {
      queueAuth({ id: 1, role: 'enterprise', subscription_tier: 'enterprise' });
      const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake-audio')]);
      const res = await request(app)
        .post('/api/ai/audio-query')
        .set('Authorization', `Bearer ${enterpriseToken}`)
        .attach('audio', webm, 'test.webm');
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('jobId');
    });

    it('should allow user-role PRO-tier to use audio-query (tier, not role, is the gate)', async () => {
      queueAuth({ id: 2, role: 'user', subscription_tier: 'pro' });
      const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake-audio')]);
      const res = await request(app)
        .post('/api/ai/audio-query')
        .set('Authorization', `Bearer ${userToken}`)
        .attach('audio', webm, 'test.webm');
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('jobId');
    });

    it('should allow admin (basic tier) to bypass the tier gate', async () => {
      queueAuth({ id: 99, role: 'admin', subscription_tier: 'basic' });
      const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake-audio')]);
      const res = await request(app)
        .post('/api/ai/audio-query')
        .set('Authorization', `Bearer ${adminToken}`)
        .attach('audio', webm, 'test.webm');
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('jobId');
    });

    it('should reject audio uploads whose magic bytes do not match an allowed audio type', async () => {
      queueAuth({ id: 1, role: 'enterprise', subscription_tier: 'enterprise' });
      const res = await request(app)
        .post('/api/ai/audio-query')
        .set('Authorization', `Bearer ${enterpriseToken}`)
        .attach('audio', Buffer.from('definitely-not-audio'), 'test.mp3');
      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/Unsupported file type/);
    });

    it('should block user-role basic-tier from multimodal upload with 403', async () => {
      queueAuth({ id: 2, role: 'user', subscription_tier: 'basic' });
      const res = await request(app)
        .post('/api/ai/multimodal')
        .set('Authorization', `Bearer ${userToken}`)
        .attach('file', Buffer.from('fake-pdf-data'), 'document.pdf');
      expect(res.statusCode).toEqual(403);
      expect(res.body.error).toMatch(/requires the enterprise subscription tier/i);
    });

    it('should block user-role PRO-tier from multimodal upload with 403 (enterprise required)', async () => {
      queueAuth({ id: 2, role: 'user', subscription_tier: 'pro' });
      const res = await request(app)
        .post('/api/ai/multimodal')
        .set('Authorization', `Bearer ${userToken}`)
        .attach('file', Buffer.from('fake-pdf-data'), 'document.pdf');
      expect(res.statusCode).toEqual(403);
      expect(res.body.error).toMatch(/requires the enterprise subscription tier/i);
    });

    // Phase 29: multimodal requires the enterprise tier AND valid PDF magic
    // bytes (%PDF header).
    it('should allow enterprise-role to use multimodal upload', async () => {
      queueAuth({ id: 1, role: 'enterprise', subscription_tier: 'enterprise' });
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake-pdf-data')]);
      const res = await request(app)
        .post('/api/ai/multimodal')
        .set('Authorization', `Bearer ${enterpriseToken}`)
        .attach('file', pdf, 'document.pdf');
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('response');
    });

    it('should allow user-role ENTERPRISE-tier to use multimodal upload', async () => {
      queueAuth({ id: 2, role: 'user', subscription_tier: 'enterprise' });
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake-pdf-data')]);
      const res = await request(app)
        .post('/api/ai/multimodal')
        .set('Authorization', `Bearer ${userToken}`)
        .attach('file', pdf, 'document.pdf');
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('response');
    });

    it('should reject multimodal uploads whose magic bytes do not match a document type', async () => {
      queueAuth({ id: 1, role: 'enterprise', subscription_tier: 'enterprise' });
      const binaryGarbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x00, 0x01]);
      const res = await request(app)
        .post('/api/ai/multimodal')
        .set('Authorization', `Bearer ${enterpriseToken}`)
        .attach('file', binaryGarbage, 'fake.gif');
      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/Unsupported file type/);
    });

    it('attaches the authenticated owner to queued stream jobs', async () => {
      queueAuth({ id: 2, role: 'user' });
      const res = await request(app)
        .post('/api/ai/query/stream')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ prompt: 'ιδιοκτησία', conversationId: 7 });

      expect(res.statusCode).toEqual(200);
      expect(inferenceQueue.addInferenceJob).toHaveBeenCalledWith(
        'ιδιοκτησία',
        'Formatted context',
        expect.objectContaining({ userId: 2, conversationId: 7, prompt: 'ιδιοκτησία' })
      );
    });

    it('hides a queued job from another authenticated user', async () => {
      queueAuth({ id: 2, role: 'user' });
      inferenceQueue.getJob.mockResolvedValueOnce({
        data: { userId: 99, conversationId: null },
        getState: jest.fn().mockResolvedValue('waiting')
      });

      const res = await request(app)
        .get('/api/ai/query/stream/private-job')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.statusCode).toEqual(404);
      expect(res.body.error).toBe('Job not found');
    });

    it('does not cancel a queued job without matching owner metadata', async () => {
      queueAuth({ id: 2, role: 'user' });
      inferenceQueue.getJob.mockResolvedValueOnce({ data: { userId: 99 } });

      const res = await request(app)
        .delete('/api/ai/query/stream/private-job')
        .set('Authorization', `Bearer ${userToken}`);

      expect(res.statusCode).toEqual(404);
      expect(inferenceQueue.cancelJob).not.toHaveBeenCalled();
    });
  });

  // 3. Billing API Tests
  describe('Billing API (/api/billing)', () => {
    it('should allow user-role to start checkout (so they can upgrade)', async () => {
      queueAuth({ id: 2, role: 'user' });
      const res = await request(app)
        .post('/api/billing/create-checkout-session')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ tier: 'enterprise' });
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('url');
      expect(res.body.url).toContain('tier=enterprise');
    });

    it('should allow admin-role to start checkout', async () => {
      queueAuth({ id: 99, role: 'admin' });
      const res = await request(app)
        .post('/api/billing/create-checkout-session')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tier: 'enterprise' });
      expect(res.statusCode).toEqual(200);
      expect(res.body.url).toContain('tier=enterprise');
    });
  });

  // 4. Admin API Tests
  describe('Admin API (/api/admin)', () => {
    it('should block non-admin from listing users with 403', async () => {
      queueAuth({ id: 2, role: 'user' });
      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.statusCode).toEqual(403);
    });

    it('should allow admin to list users', async () => {
      queueAuth({ id: 99, role: 'admin' });
      db.query.mockResolvedValueOnce({
        rows: [
          { id: 1, email: 'u@nomos.ai', role: 'user', subscription_tier: 'basic' }
        ]
      });

      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('users');
      expect(Array.isArray(res.body.users)).toBe(true);
    });

    it('should allow admin to patch a user role (no extra tv bump; authMiddleware reads fresh role)', async () => {
      queueAuth({ id: 99, role: 'admin' });
      // Phase 29: admin.js captures the previous role for the audit trail
      // BEFORE the UPDATE, so the mock needs a SELECT row first.
      db.query.mockResolvedValueOnce({ rows: [{ role: 'user' }] });
      db.query.mockResolvedValueOnce({
        rows: [
          { id: 2, email: 'u2@nomos.ai', role: 'enterprise', subscription_tier: 'enterprise', token_version: 1 }
        ]
      });

      const res = await request(app)
        .patch('/api/admin/users/2/role')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'enterprise' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.user).toHaveProperty('role', 'enterprise');
    });

    it('should reject invalid role values with 400', async () => {
      queueAuth({ id: 99, role: 'admin' });
      const res = await request(app)
        .patch('/api/admin/users/2/role')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'super-admin' });
      expect(res.statusCode).toEqual(400);
    });
  });

  // ------------------------------------------------------------------------
  // Machine-readable auth error codes.
  //
  // The Angular client used to classify auth failures by matching the
  // server's ENGLISH PROSE (e.g. `data.error.startsWith('Email not
  // verified')`). That is brittle: rewording a message silently breaks
  // the client. Every auth error response now carries a stable `code`.
  //
  // These tests pin BOTH halves of the contract:
  //   1. the `code` vocabulary is small, frozen and snake_case, and
  //   2. the human-readable `error` strings are BYTE-FOR-BYTE unchanged
  //      (a concurrent frontend effort depends on them).
  // ------------------------------------------------------------------------
  describe('Auth error codes (machine-readable)', () => {
    it('exposes a small, frozen, unique, snake_case vocabulary', () => {
      const values = Object.values(AUTH_ERROR_CODES);

      // Frozen: a consumer cannot mutate the shared map.
      expect(Object.isFrozen(AUTH_ERROR_CODES)).toBe(true);

      // Unique: no two names may share a wire value.
      expect(new Set(values).size).toBe(values.length);

      // Small: the vocabulary is a fixed, documented set, not a free-for-all.
      expect(values.length).toBeLessThanOrEqual(20);

      // Stable shape: lower snake_case, no spaces, no punctuation surprises.
      for (const value of values) {
        expect(value).toMatch(/^[a-z][a-z0-9_]*$/);
      }

      // The values the client actually branches on are pinned verbatim.
      expect(AUTH_ERROR_CODES.UNVERIFIED_EMAIL).toBe('unverified_email');
      expect(AUTH_ERROR_CODES.INVALID_CREDENTIALS).toBe('invalid_credentials');
      expect(AUTH_ERROR_CODES.EMAIL_TAKEN).toBe('email_taken');
      expect(AUTH_ERROR_CODES.INVALID_TOKEN).toBe('invalid_token');
      expect(AUTH_ERROR_CODES.REQUEST_ACCEPTED).toBe('request_accepted');
    });

    it('re-exports the same map from routes/auth.js (single source of truth)', () => {
      expect(require('../src/routes/auth').AUTH_ERROR_CODES).toBe(AUTH_ERROR_CODES);
    });

    it('keeps the human-readable error strings byte-for-byte unchanged', async () => {
      // Golden strings. If one of these changes, the frontend's prose
      // matching (and any other client) breaks — that is a breaking change
      // and must be a deliberate, reviewed edit.
      const mockHashedPassword = await bcrypt.hash('password123', 4);

      // 1. login — unknown address / wrong password → generic 400.
      db.query.mockResolvedValueOnce({ rows: [] });
      const badLogin = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ghost@nomos.ai', password: 'password123' });
      expect(badLogin.statusCode).toEqual(400);
      expect(badLogin.body.error).toBe('Invalid credentials');
      expect(badLogin.body.code).toBe('invalid_credentials');

      // 2. login — unverified account.
      db.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          email: 'pending@nomos.ai',
          password_hash: mockHashedPassword,
          role: 'user',
          subscription_tier: 'basic',
          token_version: 1,
          verified_at: null
        }]
      });
      const unverified = await request(app)
        .post('/api/auth/login')
        .send({ email: 'pending@nomos.ai', password: 'password123' });
      expect(unverified.statusCode).toEqual(400);
      expect(unverified.body.error).toBe(
        'Email not verified. Check your inbox for the verification link.'
      );
      expect(unverified.body.code).toBe('unverified_email');

      // 3. register — address already taken.
      db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      const taken = await request(app)
        .post('/api/auth/register')
        .send({ email: 'taken@nomos.ai', password: 'password123' });
      expect(taken.statusCode).toEqual(400);
      expect(taken.body.error).toBe('User already exists');
      expect(taken.body.code).toBe('email_taken');

      // 4. verify-email — invalid / expired token.
      const badVerify = await request(app)
        .post('/api/auth/verify-email')
        .send({ token: 'not-hex' });
      expect(badVerify.statusCode).toEqual(400);
      expect(badVerify.body.error).toBe('Invalid or expired verification link');
      expect(badVerify.body.code).toBe('invalid_token');

      // 5. reset-password — invalid / expired token.
      const badReset = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'not-hex', newPassword: 'newSecret123' });
      expect(badReset.statusCode).toEqual(400);
      expect(badReset.body.error).toBe('Invalid or expired reset link');
      expect(badReset.body.code).toBe('invalid_token');
    });
  });
});
