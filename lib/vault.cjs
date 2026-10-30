// Saved-credential vault. Secrets are encrypted by the supplied cipher (Electron
// safeStorage, which uses Windows DPAPI for the current user) and stored as
// base64 in state.json under `vault`. Plaintext never leaves the main process.
const SECRET_FIELDS = ['password', 'passphrase', 'gatewayPassword', 'gatewayPassphrase'];

class CredentialVault {
  constructor(store, cipher) { this.store = store; this.cipher = cipher; }
  available() { try { return Boolean(this.cipher?.isEncryptionAvailable()); } catch { return false; } }
  entries() { return this.store.read().vault || {}; }
  has(sessionId) { return Boolean(this.entries()[sessionId]); }
  save(sessionId, secrets = {}) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 100) throw new Error('Invalid session for saved credentials.');
    if (!this.available()) throw new Error('Windows credential encryption is not available, so passwords cannot be saved.');
    const record = {};
    for (const field of SECRET_FIELDS) {
      const value = secrets[field];
      if (typeof value === 'string' && value) { if (value.length > 4096) throw new Error('Credential is too long.'); record[field] = this.cipher.encryptString(value).toString('base64'); }
    }
    const vault = { ...this.entries() };
    if (Object.keys(record).length) vault[sessionId] = { ...(vault[sessionId] || {}), ...record };
    this.store.update('vault', vault);
    return { saved: Object.keys(record) };
  }
  forget(sessionId) { const vault = { ...this.entries() }; delete vault[sessionId]; this.store.update('vault', vault); return { ok: true }; }
  // Fill in secrets the caller left blank; explicit values typed by the user win.
  apply(config = {}) {
    const record = config.id ? this.entries()[config.id] : null;
    if (!record || !this.available()) return config;
    // Only release secrets to the destination they were saved for.
    const saved = (this.store.read().sessions || []).find(session => session.id === config.id);
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    if (!saved || !same(saved.host, config.host) || !same(saved.gatewayHost, config.gatewayHost)) return config;
    const merged = { ...config };
    for (const field of SECRET_FIELDS) {
      if (merged[field] || !record[field]) continue;
      try { merged[field] = this.cipher.decryptString(Buffer.from(record[field], 'base64')); } catch {}
    }
    return merged;
  }
  prune(sessionIds) { const keep = new Set(sessionIds); const vault = Object.fromEntries(Object.entries(this.entries()).filter(([key]) => keep.has(key))); this.store.update('vault', vault); }
}

module.exports = { CredentialVault, SECRET_FIELDS };
