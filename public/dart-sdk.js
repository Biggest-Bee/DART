/**
 * dart-sdk.js — DART Upload SDK v5
 * Standalone Firebase upload library. No bundler needed.
 *
 * Script tag:   <script src="dart-sdk.js"></script>
 * ES module:    import { DartSDK } from './dart-sdk.js'
 * CommonJS:     const { DartSDK } = require('./dart-sdk')
 */

const FB_CDN = 'https://www.gstatic.com/firebasejs/10.12.0';

class DartSDK {
  /**
   * @param {object}   opts
   * @param {object}   opts.firebaseConfig     Firebase project config (required)
   * @param {string}   [opts.container]        CSS selector or DOM el for auto-render widget
   * @param {boolean}  [opts.autoRender=false] Render full upload widget into container
   * @param {function} [opts.onComplete]       (file, result) => void — fires on every upload
   * @param {function} [opts.onError]          (file, err) => void
   * @param {function} [opts.onAuthChange]     (user|null) => void
   */
  constructor(opts = {}) {
    this._config       = opts.firebaseConfig;
    this._container    = opts.container    ?? null;
    this._autoRender   = opts.autoRender   ?? false;
    this._onComplete   = opts.onComplete   ?? null;
    this._onError      = opts.onError      ?? null;
    this._onAuthChange = opts.onAuthChange ?? null;
    this._progressCbs  = [];
    this._completeCbs  = [];
    this._user         = null;
    this._app = this._auth = this._storage = this._db = this._rtdb = null;
    this._ready = this._init();
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  async _init() {
    const fb = await this._loadFirebase();
    const id = 'dart-sdk-' + Math.random().toString(36).slice(2);
    this._app     = fb.initializeApp(this._config, id);
    this._auth    = fb.getAuth(this._app);
    this._storage = fb.getStorage(this._app);
    this._db      = fb.getFirestore(this._app);
    this._rtdb    = fb.getDatabase(this._app);
    fb.onAuthStateChanged(this._auth, user => {
      this._user = user;
      this._onAuthChange?.(user);
    });
    if (this._autoRender && this._container) await this._render(this._container);
  }

  async _loadFirebase() {
    if (window.__dartFB) return window.__dartFB;
    const [app, auth, stor, fs, db] = await Promise.all([
      import(`${FB_CDN}/firebase-app.js`),
      import(`${FB_CDN}/firebase-auth.js`),
      import(`${FB_CDN}/firebase-storage.js`),
      import(`${FB_CDN}/firebase-firestore.js`),
      import(`${FB_CDN}/firebase-database.js`),
    ]);
    window.__dartFB = {
      initializeApp:        app.initializeApp,
      getAuth:              auth.getAuth,
      onAuthStateChanged:   auth.onAuthStateChanged,
      GoogleAuthProvider:   auth.GoogleAuthProvider,
      signInWithPopup:      auth.signInWithPopup,
      signInAnonymously:    auth.signInAnonymously,
      signOut:              auth.signOut,
      getStorage:           stor.getStorage,
      ref:                  stor.ref,
      uploadBytesResumable: stor.uploadBytesResumable,
      getDownloadURL:       stor.getDownloadURL,
      deleteObject:         stor.deleteObject,
      getFirestore:         fs.getFirestore,
      doc:                  fs.doc,
      getDoc:               fs.getDoc,
      getDocs:              fs.getDocs,
      setDoc:               fs.setDoc,
      deleteDoc:            fs.deleteDoc,
      collection:           fs.collection,
      query:                fs.query,
      orderBy:              fs.orderBy,
      limit:                fs.limit,
      onSnapshot:           fs.onSnapshot,
      serverTimestamp:      fs.serverTimestamp,
      getDatabase:          db.getDatabase,
      dbRef:                db.ref,
      update:               db.update,
      onValue:              db.onValue,
      off:                  db.off,
      onDisconnect:         db.onDisconnect,
      dbTS:                 db.serverTimestamp,
    };
    return window.__dartFB;
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  /** Sign in with Google popup */
  async signIn() {
    await this._ready;
    const fb = window.__dartFB;
    return fb.signInWithPopup(this._auth, new fb.GoogleAuthProvider());
  }

  /** Sign in anonymously (no account needed) */
  async signInAnonymously() {
    await this._ready;
    return window.__dartFB.signInAnonymously(this._auth);
  }

  /** Sign out */
  async signOut() {
    await this._ready;
    return window.__dartFB.signOut(this._auth);
  }

  /** Current Firebase user, or null */
  get user() { return this._user; }

  // ─── Upload ────────────────────────────────────────────────────────────────

  /**
   * Upload a single File to Firebase Storage.
   * Checks dedup first — skips the upload if the file was seen before.
   *
   * @param {File}     file
   * @param {object}   [opts]
   * @param {function} [opts.onProgress]  (pct 0–100, speedMBps) => void
   * @param {function} [opts.onComplete]  ({ downloadURL, filePath, deduped }) => void
   * @param {function} [opts.onError]     (Error) => void
   * @returns {Promise<{ downloadURL, filePath, deduped, name, size }>}
   */
  async upload(file, opts = {}) {
    await this._ready;
    const fb   = window.__dartFB;
    const user = this._user;
    if (!user) throw new Error('Not signed in — call dart.signIn() first');

    const uid      = user.uid;
    const fileId   = await this._fileId(file);
    const filePath = `uploads/${uid}/${file.name}`;

    // Dedup: check Firestore before uploading
    try {
      const snap = await fb.getDoc(fb.doc(this._db, 'dedup', fileId));
      if (snap.exists()) {
        const result = { deduped: true, downloadURL: snap.data().downloadURL, filePath, name: file.name, size: file.size };
        opts.onComplete?.(result);
        this._completeCbs.forEach(cb => cb(file, result));
        this._onComplete?.(file, result);
        return result;
      }
    } catch {}

    // Upload direct to Firebase Storage (resumable, auto-retry)
    const storRef = fb.ref(this._storage, filePath);
    const task    = fb.uploadBytesResumable(storRef, file, {
      contentType: file.type || 'application/octet-stream',
      customMetadata: { uid, originalName: file.name, size: String(file.size), dartVersion: '5' }
    });
    const t0 = Date.now();

    return new Promise((resolve, reject) => {
      task.on('state_changed',
        snap => {
          const pct   = (snap.bytesTransferred / snap.totalBytes) * 100;
          const speed = snap.bytesTransferred / 1048576 / Math.max(0.001, (Date.now() - t0) / 1000);
          opts.onProgress?.(pct, speed);
          this._progressCbs.forEach(cb => cb(file, pct, speed));
          this._pushRTDB(uid, fileId, file.name, pct / 100, Math.round(speed));
        },
        err => {
          opts.onError?.(err);
          this._onError?.(file, err);
          reject(err);
        },
        async () => {
          const downloadURL = await fb.getDownloadURL(task.snapshot.ref);
          const result = { deduped: false, downloadURL, filePath, name: file.name, size: file.size };
          await Promise.allSettled([
            fb.setDoc(fb.doc(this._db, 'transfers', uid, 'files', fileId), {
              name: file.name, size: file.size, filePath, downloadURL,
              status: 'complete', ts: fb.serverTimestamp()
            }, { merge: true }),
            fb.setDoc(fb.doc(this._db, 'dedup', fileId), {
              downloadURL, filePath, uid, ts: fb.serverTimestamp()
            }),
          ]);
          this._pushRTDB(uid, fileId, file.name, 1, 0, 'done');
          opts.onComplete?.(result);
          this._completeCbs.forEach(cb => cb(file, result));
          this._onComplete?.(file, result);
          resolve(result);
        }
      );
    });
  }

  /**
   * Upload multiple files with controlled concurrency.
   *
   * @param {FileList|File[]} files
   * @param {object}   [opts]
   * @param {number}   [opts.concurrency=4]   Max parallel uploads
   * @param {function} [opts.onFileProgress]  (file, pct, speedMBps) => void
   * @param {function} [opts.onFileComplete]  (file, result) => void
   * @param {function} [opts.onAllComplete]   (results[]) => void
   * @returns {Promise<Array>}
   */
  async uploadMultiple(files, opts = {}) {
    const list    = [...files];
    const limit   = opts.concurrency ?? 4;
    const results = [];
    let   i = 0;
    const worker = async () => {
      while (i < list.length) {
        const file = list[i++];
        try {
          const result = await this.upload(file, {
            onProgress: (p, s) => opts.onFileProgress?.(file, p, s),
            onComplete: r      => opts.onFileComplete?.(file, r),
            onError:    e      => this._onError?.(file, e),
          });
          results.push(result);
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
    opts.onAllComplete?.(results);
    return results;
  }

  // ─── History ───────────────────────────────────────────────────────────────

  /**
   * Fetch transfer history once (not real-time).
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @returns {Promise<Array<{id, name, size, filePath, downloadURL, status, ts}>>}
   */
  async getHistory(opts = {}) {
    await this._ready;
    const fb   = window.__dartFB;
    const user = this._user;
    if (!user) return [];
    const q    = fb.query(
      fb.collection(this._db, 'transfers', user.uid, 'files'),
      fb.orderBy('ts', 'desc'),
      fb.limit(opts.limit ?? 50)
    );
    const snap = await fb.getDocs(q).catch(() => null);
    if (!snap) return [];
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /**
   * Listen to transfer history in real time.
   * @param {function} cb  (transfers[]) => void — fires immediately + on every change
   * @returns {function}   Call to unsubscribe
   */
  listenHistory(cb) {
    const fb   = window.__dartFB;
    const user = this._user;
    if (!user || !fb) return () => {};
    const q = fb.query(
      fb.collection(this._db, 'transfers', user.uid, 'files'),
      fb.orderBy('ts', 'desc'),
      fb.limit(50)
    );
    return fb.onSnapshot(q, snap => {
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, () => {});
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  /**
   * Delete a file from Storage (Firestore record remains for history).
   * @param {string} filePath  e.g. "uploads/uid/video.mp4" from upload result
   */
  async delete(filePath) {
    await this._ready;
    if (!this._user) throw new Error('Not signed in');
    await window.__dartFB.deleteObject(window.__dartFB.ref(this._storage, filePath));
  }

  /**
   * Delete a file by its Firestore document ID (from listenHistory entries).
   * Also deletes from Storage using the stored filePath.
   * @param {string} fileId  The document ID from listenHistory()
   */
  async deleteById(fileId) {
    await this._ready;
    const fb   = window.__dartFB;
    const user = this._user;
    if (!user) throw new Error('Not signed in');
    // Fetch the record to get filePath
    const snap = await fb.getDoc(fb.doc(this._db, 'transfers', user.uid, 'files', fileId));
    if (!snap.exists()) throw new Error('File not found');
    const { filePath } = snap.data();
    // Delete from Storage
    try { await fb.deleteObject(fb.ref(this._storage, filePath)); } catch {}
    // Delete Firestore record
    await fb.deleteDoc(fb.doc(this._db, 'transfers', user.uid, 'files', fileId));
  }

  // ─── Publish ─────────────────────────────────────────────────────────────────

  /**
   * Upload a file and either add to private locker or publish directly to public area.
   * Requires Google OAuth authentication with an email that exists in DART.
   *
   * @param {File}     file
   * @param {object}   [opts]
   * @param {boolean}  [opts.publish=false]  If true, publish to public area; if false, add to locker
   * @param {function} [opts.onProgress]  (pct 0–100, speedMBps) => void
   * @param {function} [opts.onComplete]  ({ downloadURL, filePath, published, fileId }) => void
   * @param {function} [opts.onError]     (Error) => void
   * @returns {Promise<{ downloadURL, filePath, published, fileId, name, size }>}
   */
  async publish(file, opts = {}) {
    await this._ready;
    const fb   = window.__dartFB;
    const user = this._user;
    if (!user) throw new Error('Not signed in — call dart.signIn() first');
    if (!user.email) throw new Error('User must have an email address to publish');

    const publish = opts.publish ?? false;

    // First upload the file to get downloadURL and filePath
    const uploadResult = await this.upload(file, {
      onProgress: opts.onProgress,
      onError: opts.onError,
    });

    // Now call the REST API to either publish or add to locker
    const idToken = await user.getIdToken();
    const projectId = this._config.projectId;
    const region = 'us-central1'; // Default region, can be made configurable
    const apiUrl = `https://${region}-${projectId}.cloudfunctions.net/dart/publish`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        name: uploadResult.name,
        downloadURL: uploadResult.downloadURL,
        filePath: uploadResult.filePath,
        fileSize: uploadResult.size,
        publish: publish
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || 'Publish failed');
    }

    const result = await response.json();
    const finalResult = {
      ...uploadResult,
      published: result.published,
      fileId: result.fileId
    };

    opts.onComplete?.(finalResult);
    return finalResult;
  }

  // ─── Global listeners ─────────────────────────────────────────────────────

  /** Add a progress listener that fires for ALL uploads */
  onProgress(cb)  { this._progressCbs.push(cb); return this; }
  offProgress()   { this._progressCbs = []; return this; }

  /** Add a completion listener that fires for ALL uploads */
  onComplete(cb)  { this._completeCbs.push(cb); return this; }
  offComplete()   { this._completeCbs = []; return this; }

  // ─── Auto-render widget ────────────────────────────────────────────────────
  async _render(container) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!el) return;
    el.innerHTML = `
      <style>
        ._dw{font-family:'DM Mono',monospace;background:#0b0b12;border:1px solid #1e1e30;padding:16px;color:#eeeef5;min-width:280px}
        ._dw-title{font-size:.7rem;font-weight:700;letter-spacing:2px;color:#00ffc8;margin-bottom:8px}
        ._dw-auth{font-size:.56rem;color:#55556a;margin-bottom:10px}
        ._dw-drop{border:1px dashed #252540;padding:20px;text-align:center;cursor:pointer;font-size:.58rem;color:#55556a;margin-bottom:10px;transition:border-color .15s}
        ._dw-drop:hover,._dw-drop.over{border-color:#00ffc8;color:#00ffc8}
        ._dw-row{padding:6px 0;border-bottom:1px solid #1e1e30}
        ._dw-name{font-size:.54rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
        ._dw-bar{background:#171726;height:2px;margin:2px 0}
        ._dw-fill{height:100%;background:linear-gradient(90deg,#6c47ff,#00ffc8);transition:width .08s}
        ._dw-meta{display:flex;justify-content:space-between;font-size:.46rem;color:#55556a}
      </style>
      <div class="_dw">
        <div class="_dw-title">⟁ DART</div>
        <div class="_dw-auth" id="_dw_auth">Not signed in</div>
        <input type="file" id="_dw_fi" multiple style="display:none">
        <div class="_dw-drop" id="_dw_drop">Drop files here or click to browse</div>
        <div id="_dw_list"></div>
      </div>`;
    const drop = el.querySelector('#_dw_drop');
    el.querySelector('#_dw_fi').addEventListener('change', e => [...e.target.files].forEach(f => this._widgetFile(f, el)));
    drop.addEventListener('click',     () => el.querySelector('#_dw_fi').click());
    drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop',      e => { e.preventDefault(); drop.classList.remove('over'); [...e.dataTransfer.files].forEach(f => this._widgetFile(f, el)); });
    this._onAuthChange = user => {
      const a = el.querySelector('#_dw_auth');
      if (a) { a.textContent = user ? (user.isAnonymous ? 'Signed in anonymously' : user.displayName || user.email) : 'Not signed in'; a.style.color = user ? '#00ffc8' : '#55556a'; }
    };
  }

  _widgetFile(file, el) {
    const list = el.querySelector('#_dw_list');
    const safe = file.name.replace(/\W/g, '_');
    const row  = document.createElement('div');
    row.className = '_dw-row';
    row.innerHTML = `<div class="_dw-name" title="${file.name}">${file.name}</div><div class="_dw-bar"><div class="_dw-fill" id="_f${safe}" style="width:0%"></div></div><div class="_dw-meta"><span id="_p${safe}">0%</span><span id="_s${safe}">—</span></div>`;
    list.prepend(row);
    this.upload(file, {
      onProgress: (pct, spd) => {
        const b = document.getElementById('_f' + safe); if (b) b.style.width = pct + '%';
        const p = document.getElementById('_p' + safe); if (p) p.textContent = Math.round(pct) + '%';
        const s = document.getElementById('_s' + safe); if (s) s.textContent = spd >= 1000 ? (spd/1000).toFixed(2)+' GB/s' : spd.toFixed(0)+' MB/s';
      },
      onComplete: r => {
        const p = document.getElementById('_p' + safe); if (p) p.textContent = r.deduped ? 'Cached ↑' : '✓ Done';
        const s = document.getElementById('_s' + safe); if (s) s.textContent = '';
        const b = document.getElementById('_f' + safe); if (b) b.style.width = '100%';
      },
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _fileId(file) {
    const raw = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified ?? 0}`);
    const buf = await crypto.subtle.digest('SHA-256', raw);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 40);
  }

  _pushRTDB(uid, fileId, name, progress, speed, status = 'uploading') {
    const fb = window.__dartFB;
    if (!fb || !this._rtdb) return;
    fb.update(fb.dbRef(this._rtdb, `progress/${uid}/${fileId}`), {
      progress, speed, name, status, ts: fb.dbTS()
    }).catch(() => {});
  }

  /** Clean up */
  destroy() { this._progressCbs = []; this._completeCbs = []; }
}

// ─── Export for script tag / ESM / CommonJS ────────────────────────────────
if (typeof module !== 'undefined' && module.exports) module.exports = { DartSDK };
if (typeof window !== 'undefined') window.DartSDK = DartSDK;
export { DartSDK };
