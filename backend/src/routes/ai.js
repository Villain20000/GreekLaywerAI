const express = require('express');
const router = express.Router();
const multer = require('multer');
const ragService = require('../services/ragService');
const ollamaService = require('../services/ollamaService');
const { rbacMiddleware } = require('../middlewares/authMiddleware');

// Multer setup for handling multimodal inputs (PDFs, Images, Audio).
// 25 MB cap to mitigate trivial DoS on premium endpoints.
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

// AI tiers:
//   user | admin | enterprise => basic chat & SSE streaming
//   admin | enterprise         => premium multimodal/audio
router.post(
  '/query',
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      const { prompt, useRag = true } = req.body;
      let contextStr = '';

      if (useRag) {
        const docs = await ragService.retrieveContext(prompt);
        contextStr = ragService.formatContextForGemma(docs);
      }

      const response = await ollamaService.generateResponse(prompt, contextStr);
      res.json({ response });
    } catch (error) {
      console.error('AI query error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

router.post(
  '/query/stream',
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      const { prompt, useRag = true } = req.body;
      let contextStr = '';

      if (useRag) {
        const docs = await ragService.retrieveContext(prompt);
        contextStr = ragService.formatContextForGemma(docs);
      }

      await ollamaService.streamResponse(prompt, contextStr, res);
    } catch (error) {
      console.error('AI stream error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Phase 7: Audio Streaming Endpoint — premium (admin/enterprise only)
router.post(
  '/audio-query',
  rbacMiddleware(['admin', 'enterprise']),
  upload.single('audio'),
  async (req, res) => {
    try {
      const audioBuffer = req.file.buffer;
      console.log(`Received audio clip of size ${audioBuffer.length} bytes`);

      const mockTranscription = 'Τι προβλέπει ο νόμος για το δικαίωμα στην προσωπικότητα;';

      const docs = await ragService.retrieveContext(mockTranscription);
      const contextStr = ragService.formatContextForGemma(docs);

      await ollamaService.streamResponse(mockTranscription, contextStr, res);
    } catch (error) {
      console.error('Audio query error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Multimodal Upload Endpoint — premium (admin/enterprise only)
router.post(
  '/multimodal',
  rbacMiddleware(['admin', 'enterprise']),
  upload.single('file'),
  async (req, res) => {
    try {
      const fileBuffer = req.file.buffer;
      console.log(`Received file of size ${fileBuffer.length} bytes, type: ${req.file.mimetype}`);

      const mockResponse =
        'Έχω αναλύσει το επισυναπτόμενο έγγραφο. Φαίνεται να είναι νομικό συμβόλαιο.';
      res.json({ response: mockResponse });
    } catch (error) {
      console.error('Multimodal error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
