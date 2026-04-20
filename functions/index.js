/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {setGlobalOptions} = require("firebase-functions");
const {onRequest} = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

// Initialize Firebase Admin
admin.initializeApp();

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

// ── DART REST API ────────────────────────────────────────────────────────────────

const {getAuth} = require("firebase-admin/auth");

// Middleware to verify Firebase ID token
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing Bearer token' });
    return;
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Token verification failed:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid token', details: error.message });
  }
}

// GET /dart/probe - Connectivity check + server info
exports.probe = onRequest((req, res) => {
  res.json({
    ok: true,
    server: 'DART v6.0 — Firebase Cloud Functions',
    time: new Date().toISOString(),
    transport: 'https',
    backends: ['firebase-storage', 'firestore', 'realtime-database'],
    region: process.env.FUNCTION_REGION || 'us-central1'
  });
});

// POST /dart/manifest - Batch dedup check before uploading
exports.manifest = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  await verifyAuth(req, res, async () => {
    const {files} = req.body;
    if (!Array.isArray(files)) {
      res.status(400).json({ error: 'Invalid request: files must be an array' });
      return;
    }
    // Check dedup for each file
    const {getFirestore} = require("firebase-admin/firestore");
    const db = getFirestore();
    const results = await Promise.all(files.map(async (file) => {
      const fileId = file.id; // SHA-256 hash of name|size|lastModified
      const snap = await db.collection('dedup').doc(fileId).get();
      return {
        id: fileId,
        exists: snap.exists,
        downloadURL: snap.exists ? snap.data().downloadURL : null
      };
    }));
    res.json({results});
  });
});

// POST /dart/direct-url - Get signed GCS URL for direct upload
exports.directUrl = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  await verifyAuth(req, res, async () => {
    const {name, contentType} = req.body;
    if (!name || !contentType) {
      res.status(400).json({ error: 'Missing required fields: name, contentType' });
      return;
    }
    const {getStorage} = require("firebase-admin/storage");
    const storage = getStorage();
    const bucket = storage.bucket();
    const uid = req.user.uid;
    const filePath = `uploads/${uid}/${name}`;
    const file = bucket.file(filePath);
    const [url] = await file.getSignedUrl({
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType: contentType
    });
    res.json({url, filePath});
  });
});

// POST /dart/publish - Upload to locker or publish directly to public area
exports.publish = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  await verifyAuth(req, res, async () => {
    const {name, downloadURL, filePath, fileSize, publish} = req.body;
    if (!name || !downloadURL || !filePath) {
      res.status(400).json({ error: 'Missing required fields: name, downloadURL, filePath' });
      return;
    }
    
    const {getFirestore} = require("firebase-admin/firestore");
    const db = getFirestore();
    const uid = req.user.uid;
    const user = req.user;
    
    // Verify user has email (DART account requirement)
    if (!user.email) {
      res.status(403).json({ error: 'Forbidden: User must have an email address to publish' });
      return;
    }
    
    try {
      if (publish) {
        // Publish to public area
        const fileId = await _hashId({name, size: fileSize || 0, lastModified: Date.now()});
        await db.collection('public_files').doc(fileId).set({
          ownerUid: uid,
          ownerEmail: user.email || '',
          ownerName: user.displayName || user.email || '',
          fileName: name,
          filePath: filePath,
          downloadURL: downloadURL,
          fileSize: fileSize || 0,
          ts: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, fileId, published: true });
      } else {
        // Upload to private locker
        const fileId = await _hashId({name, size: fileSize || 0, lastModified: Date.now()});
        await db.collection('transfers').doc(uid).collection('files').doc(fileId).set({
          name: name,
          size: fileSize || 0,
          filePath: filePath,
          downloadURL: downloadURL,
          folder: '',
          status: 'complete',
          ts: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await db.collection('dedup').doc(fileId).set({
          downloadURL: downloadURL,
          filePath: filePath,
          uid: uid,
          ts: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, fileId, published: false });
      }
    } catch (error) {
      logger.error('Publish error:', error);
      res.status(500).json({ error: 'Internal server error', details: error.message });
    }
  });
});

// Helper function to generate file ID (SHA-256 hash)
function _hashId(data) {
  const str = `${data.name}|${data.size}|${data.lastModified}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}
