// Export express app without starting the server for testing
// Pin NODE_ENV='test' BEFORE requiring rateLimiters/auth so the singleton
// router picks up the in-memory / high-ceiling test config rather than the
// strict production defaults.
process.env.NODE_ENV = 'test';

const express = require('express');
const cors = require('cors');
const aiRoutes = require('../src/routes/ai');
const billingRoutes = require('../src/routes/billing');
const authRoutes = require('../src/routes/auth');
const adminRoutes = require('../src/routes/admin');
const conversationsRoutes = require('../src/routes/conversations');
const documentsRoutes = require('../src/routes/documents');
const subscriptionsRoutes = require('../src/routes/subscriptions');
const gdprRoutes = require('../src/routes/gdpr');
const privacyShield = require('../src/middlewares/privacyShield');
const { authMiddleware } = require('../src/middlewares/authMiddleware');

const app = express();
app.use(cors());
app.use(express.json());
app.use(privacyShield);

// Mock DB, Redis, and services for tests
jest.mock('../src/config/db', () => ({
  // Phase 23: reset-password uses db.connect() for a BEGIN/COMMIT transaction;
  // the singleton db.query is still used for authMiddleware + the
  // forgot-password SELECT user by email. Tests for either route reach
  // into this same mock object.
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/ollamaService', () => ({
  generateResponse: jest.fn().mockResolvedValue('Mock response'),
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));
jest.mock('../src/services/ragService', () => ({
  retrieveContext: jest.fn().mockResolvedValue([{ content: 'Mock context', similarity: 0.8 }]),
  formatContextForGemma: jest.fn().mockReturnValue('Formatted context'),
  toSources: jest.fn().mockReturnValue([]),
  calculateConfidence: jest.fn().mockReturnValue(0)
}));
// Phase 29: mock the inference queue so AI routes don't touch Redis.
jest.mock('../src/services/inferenceQueue', () => ({
  addInferenceJob: jest.fn().mockImplementation(async () => ({
    id: 'mock-job-1',
    waitUntilFinished: async () => 'Mock response'
  })),
  getJob: jest.fn().mockResolvedValue(null),
  cancelJob: jest.fn().mockResolvedValue(false),
  getQueueEvents: jest.fn().mockReturnValue(null),
  startWorker: jest.fn(),
  getQueueStatus: jest.fn().mockResolvedValue({ enabled: false, reason: 'test env' }),
  pingRedis: jest.fn().mockResolvedValue(null),
  closeQueue: jest.fn().mockResolvedValue(undefined)
}));
// Phase 29: mock the document pipeline (real PDF/DOCX parsing is exercised
// by dedicated unit tests, not route tests).
jest.mock('../src/services/documentService', () => ({
  // Phase 1-7: /multimodal extracts text through this shared parser.
  extractMetadata: jest.fn().mockResolvedValue({
    meta: { size_bytes: 10, filename: 'doc.pdf', contentType: 'application/pdf', char_count: 18 },
    text: 'Μοκ νομικό κείμενο εγγράφου.'
  }),
  processAndStoreDocument: jest.fn().mockResolvedValue({
    document: {
      id: 1,
      user_id: 2,
      filename: 'doc.pdf',
      content_type: 'application/pdf',
      title: 'doc',
      metadata: { size_bytes: 10, title: 'doc' },
      created_at: '2026-01-01T00:00:00Z'
    },
    chunkCount: 3
  }),
  searchUserDocuments: jest.fn().mockResolvedValue([
    { chunk_id: 1, content: 'chunk', similarity: 0.9, document_id: 1, filename: 'doc.pdf', title: 'doc' }
  ]),
  chunkText: jest.fn()
}));
// Phase 1-6: the whisper STT sidecar is a real HTTP dependency; route tests
// drive this mock (unit coverage of the real client lives in
// tests/transcription.test.js). TranscriptionError/ERROR_CODES are re-exported
// from the real module so the route's typed error mapping stays exercised.
jest.mock('../src/services/transcriptionService', () => {
  const actual = jest.requireActual('../src/services/transcriptionService');
  return {
    transcribe: jest.fn().mockResolvedValue('Μεταγραμμένο κείμενο δοκιμής'),
    TranscriptionError: actual.TranscriptionError,
    ERROR_CODES: actual.ERROR_CODES
  };
});
// Phase 23 + 24: stub the emailService dev-transport so test runs don't
// spam the console with `[DEV-EMAIL] ...` lines. The focus tests register
// + login in `api.test.js` don't introspect these mock calls; this mock
// exists primarily so the FIRE-AND-FORGET .catch() in /register doesn't
// throw `TypeError: sendEmailVerification is not a function`. Tests that
// DO introspect calls (e.g. forgotReset.test.js, emailVerification.test.js)
// install their own deeper mock factory with a top-of-file
// `jest.mock('../src/services/emailService', ...)` and shadow this one.
jest.mock('../src/services/emailService', () => ({
  sendPasswordReset: jest.fn().mockResolvedValue(undefined),
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
  APP_BASE_URL: 'http://localhost:4200'
}));
// Phase 29: audit logging must not break tests — route handlers call it
// fire-and-forget against db.query, which is already mocked. The mock here
// only prevents an unexpected require-time failure.
jest.mock('../src/services/auditLog', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue([]),
  deleteAuditLogsForUser: jest.fn().mockResolvedValue(undefined)
}));

app.use('/api/auth', authRoutes);
app.use('/api/ai', authMiddleware, aiRoutes);
app.use('/api/billing', authMiddleware, billingRoutes);
app.use('/api/conversations', authMiddleware, conversationsRoutes);
app.use('/api/documents', authMiddleware, documentsRoutes);
app.use('/api/subscriptions', authMiddleware, subscriptionsRoutes);
app.use('/api/gdpr', authMiddleware, gdprRoutes);
app.use('/api/admin', adminRoutes);

module.exports = app;
