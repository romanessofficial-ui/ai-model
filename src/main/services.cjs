const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const chokidar = require('chokidar');

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

class Services {
  constructor(app, db, safeStorage, notify, shellApi) {
    this.app = app; this.db = db; this.safeStorage = safeStorage; this.notify = notify; this.shell = shellApi;
    this.watcher = null; this.scheduler = null; this.oauthServer = null; this.oauthPromise = null;
  }
  log(level, message) {
    this.db.run('INSERT INTO logs(at,level,message) VALUES(?,?,?)', [now(), level, message]);
    if (level === 'ERROR') this.notify('Instagram Manager', message);
  }
  getSetting(key, fallback = '') { return this.db.one('SELECT value FROM settings WHERE key=?', [key])?.value ?? fallback; }
  setSetting(key, value) { this.db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]); }
  encrypt(value) { return value && this.safeStorage.isEncryptionAvailable() ? this.safeStorage.encryptString(value).toString('base64') : ''; }
  decrypt(value) { try { return value && this.safeStorage.isEncryptionAvailable() ? this.safeStorage.decryptString(Buffer.from(value, 'base64')) : ''; } catch { return ''; } }
  async initialize() {
    const folder = this.getSetting('contentFolder', path.join(this.app.getPath('documents'), 'Instagram Content'));
    this.setSetting('contentFolder', folder); fs.mkdirSync(folder, { recursive: true });
    const interrupted = this.db.all("SELECT id,media_id FROM posts WHERE status='PUBLISHING'");
    for (const post of interrupted) {
      this.db.run("UPDATE posts SET status='FAILED',error=? WHERE id=?", ['App restarted during publishing. Check Instagram before retrying to avoid a duplicate post.', post.id]);
      this.db.run("UPDATE media SET status='FAILED' WHERE id=?", [post.media_id]);
    }
    if (interrupted.length) this.log('WARNING', `${interrupted.length} interrupted publish attempt(s) need review`);
    await this.watchFolder(folder); await this.importFolder(folder);
    this.scheduler = setInterval(() => this.processDuePosts().catch(e => this.log('ERROR', e.message)), 15000);
    this.processDuePosts().catch(e => this.log('ERROR', e.message));
  }
  async watchFolder(folder) {
    if (this.watcher) await this.watcher.close();
    fs.mkdirSync(folder, { recursive: true });
    this.watcher = chokidar.watch(folder, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 150 } });
    this.watcher.on('add', file => this.importFile(file).catch(e => this.log('ERROR', `Import failed: ${e.message}`)));
  }
  async importFolder(folder) {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    for (const entry of entries) if (entry.isFile()) await this.importFile(path.join(folder, entry.name));
  }
  async importFile(file) {
    if (!imageExtensions.has(path.extname(file).toLowerCase())) return null;
    let stat; try { stat = await fs.promises.stat(file); } catch { return null; }
    const hash = crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
    if (this.db.one('SELECT id FROM media WHERE sha256=?', [hash])) return null;
    const row = { id: id(), path: file, filename: path.basename(file), sha256: hash, bytes: stat.size, added_at: now(), status: 'NEW' };
    try { this.db.run('INSERT INTO media(id,path,filename,sha256,bytes,added_at,status) VALUES(?,?,?,?,?,?,?)', Object.values(row)); }
    catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; return null; }
    this.log('INFO', `New media detected: ${row.filename}`); this.notify('New content detected', row.filename); return row;
  }
  async listMedia() { return this.db.all('SELECT * FROM media ORDER BY added_at DESC'); }
  async imageData(mediaId) {
    const row = this.db.one('SELECT path FROM media WHERE id=?', [mediaId]);
    if (!row || !fs.existsSync(row.path)) return null;
    const ext = path.extname(row.path).toLowerCase(); const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${(await fs.promises.readFile(row.path)).toString('base64')}`;
  }
  async updateMedia(id, publicUrl) { this.db.run('UPDATE media SET public_url=? WHERE id=?', [publicUrl.trim(), id]); }
  async getDashboard() {
    return {
      counts: {
        new: this.db.one("SELECT COUNT(*) n FROM media WHERE status='NEW'").n,
        scheduled: this.db.one("SELECT COUNT(*) n FROM posts WHERE status='SCHEDULED'").n,
        published: this.db.one("SELECT COUNT(*) n FROM posts WHERE status='PUBLISHED'").n,
        failed: this.db.one("SELECT COUNT(*) n FROM posts WHERE status='FAILED'").n
      },
      next: this.db.one("SELECT p.*,m.filename,m.id media_id FROM posts p JOIN media m ON m.id=p.media_id WHERE p.status='SCHEDULED' ORDER BY p.scheduled_at LIMIT 1"),
      account: this.accountSummary(),
      paused: this.getSetting('automationPaused', 'false') === 'true',
      development: this.getSetting('developmentMode', 'true') === 'true'
    };
  }
  accountSummary() {
    const a = this.db.one('SELECT username,user_id,account_type,token_expires_at,connected_at FROM instagram_account WHERE id=1');
    return a ? { ...a, status: a.token_expires_at && Date.parse(a.token_expires_at) < Date.now() ? 'TOKEN EXPIRED' : 'CONNECTED' } : { status: 'DISCONNECTED' };
  }
  async listPosts() { return this.db.all('SELECT p.*,m.filename,m.path,m.public_url,m.id media_id FROM posts p JOIN media m ON m.id=p.media_id ORDER BY COALESCE(p.scheduled_at,p.created_at) DESC'); }
  async createDraft(mediaId, caption = '') {
    const media = this.db.one('SELECT id FROM media WHERE id=?', [mediaId]); if (!media) throw new Error('Photo was not found.');
    const post = { id: id(), media_id: mediaId, caption, created_at: now() };
    this.db.run('INSERT INTO posts(id,media_id,caption,created_at) VALUES(?,?,?,?)', Object.values(post));
    this.db.run("UPDATE media SET status='DRAFT' WHERE id=? AND status='NEW'", [mediaId]); this.log('INFO', 'Draft created'); return post.id;
  }
  async schedulePost(postId, at) {
    const timestamp = Date.parse(at); if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new Error('Choose a time in the future.');
    this.db.run("UPDATE posts SET status='SCHEDULED',scheduled_at=?,error=NULL WHERE id=? AND status IN ('DRAFT','FAILED')", [new Date(timestamp).toISOString(), postId]);
    this.db.run("UPDATE media SET status='SCHEDULED' WHERE id=(SELECT media_id FROM posts WHERE id=?)", [postId]); this.log('INFO', `Post scheduled for ${new Date(timestamp).toLocaleString()}`);
  }
  async generateCaption(mediaId, prefs = {}) {
    const keyCipher = this.getSetting('openaiKey'); const apiKey = this.decrypt(keyCipher);
    if (!apiKey) throw new Error('Add your OpenAI API key in AI Settings first.');
    const media = this.db.one('SELECT * FROM media WHERE id=?', [mediaId]); if (!media) throw new Error('Photo was not found.');
    const image = await this.imageData(mediaId); if (!image) throw new Error('The photo file is unavailable.');
    const prompt = `Write one original Instagram caption based on this photo. Persona: ${prefs.persona || 'confident, elegant lifestyle creator'}. Tone: ${prefs.tone || 'natural and modern'}. Language: ${prefs.language || 'English'}. Length: ${prefs.length || 'short'}. Add at most ${prefs.hashtags ?? 5} relevant hashtags. Avoid generic claims and do not describe uncertain details. Return only the caption.`;
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: this.getSetting('openaiModel', 'gpt-4o-mini'), messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image, detail: 'low' } }] }], temperature: 0.9 }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error?.message || `OpenAI API returned ${response.status}`);
    const caption = body.choices?.[0]?.message?.content?.trim(); if (!caption) throw new Error('OpenAI returned an empty caption.');
    this.db.run('INSERT INTO caption_generations(id,media_id,caption,created_at) VALUES(?,?,?,?)', [id(), mediaId, caption, now()]); this.log('INFO', 'Caption generated'); return caption;
  }
  async startOAuth() {
    const clientId = this.getSetting('metaClientId'); const clientSecret = this.decrypt(this.getSetting('metaClientSecret'));
    if (!clientId || !clientSecret) throw new Error('Enter your Meta App ID and App Secret in Instagram settings first.');
    if (this.oauthPromise) throw new Error('An Instagram connection is already in progress.');
    const http = require('node:http'); const redirectUri = 'http://127.0.0.1:8787/meta/callback'; const oauthState = crypto.randomBytes(24).toString('hex');
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { server.close(); this.oauthPromise = null; reject(new Error('Instagram connection timed out.')); }, 180000);
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== '/meta/callback') { res.writeHead(404).end(); return; }
        if (url.searchParams.get('state') !== oauthState) { res.writeHead(403).end('Invalid OAuth state. Return to Instagram Manager and try again.'); return; }
        if (url.searchParams.get('error')) { res.writeHead(400).end('Instagram authorization was cancelled. You can close this tab.'); clearTimeout(timeout); server.close(); this.oauthPromise = null; reject(new Error(url.searchParams.get('error_description') || 'Instagram authorization failed.')); return; }
        try {
          const tokenResponse = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: url.searchParams.get('code') }) });
          const token = await tokenResponse.json(); if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_message || 'Could not exchange Instagram authorization code.');
          let accessToken = token.access_token; let expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
          try { const long = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(clientSecret)}&access_token=${encodeURIComponent(accessToken)}`); const data = await long.json(); if (long.ok && data.access_token) { accessToken = data.access_token; expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString(); } } catch {}
          const profileResponse = await fetch(`https://graph.instagram.com/v25.0/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(accessToken)}`); const profile = await profileResponse.json();
          if (!profileResponse.ok) throw new Error(profile.error?.message || 'Could not read Instagram profile.');
          const cipher = this.encrypt(accessToken); this.db.run('INSERT INTO instagram_account(id,username,user_id,account_type,token_expires_at,token_cipher,connected_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,user_id=excluded.user_id,account_type=excluded.account_type,token_expires_at=excluded.token_expires_at,token_cipher=excluded.token_cipher,connected_at=excluded.connected_at', [profile.username, profile.user_id || profile.id, profile.account_type || 'Professional', expiresAt, cipher, now()]);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>Instagram connected</h2><p>You can close this window and return to Instagram Manager.</p>');
          clearTimeout(timeout); server.close(); this.oauthPromise = null; this.log('INFO', `Instagram account connected: @${profile.username}`); resolve(this.accountSummary());
        } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Connection failed. Return to Instagram Manager for details.'); clearTimeout(timeout); server.close(); this.oauthPromise = null; reject(e); }
      });
      server.once('error', e => { clearTimeout(timeout); this.oauthPromise = null; reject(e); });
      server.listen(8787, '127.0.0.1', () => {
        this.oauthServer = server; this.oauthPromise = response;
        const auth = new URL('https://www.instagram.com/oauth/authorize'); auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'instagram_business_basic,instagram_business_content_publish', state: oauthState }).toString();
          this.shell.openExternal(auth.toString());
      });
    });
    return response;
  }
  async disconnectInstagram() { this.db.run('DELETE FROM instagram_account WHERE id=1'); this.log('INFO', 'Instagram account disconnected'); return this.accountSummary(); }
  async publishPost(post) {
    if (this.getSetting('developmentMode', 'true') === 'true') {
      this.db.run("UPDATE posts SET status='PUBLISHED',published_at=?,instagram_media_id=?,error=NULL WHERE id=?", [now(), `DEV-${post.id}`, post.id]);
      this.db.run("UPDATE media SET status='PUBLISHED' WHERE id=?", [post.media_id]); this.log('INFO', `Development publish succeeded: ${post.filename}`); this.notify('Development post published', post.filename); return;
    }
    if (this.getSetting('productionPublishingEnabled', 'false') !== 'true') throw new Error('Production publishing is disabled. Enable it explicitly in Settings.');
    if (!post.public_url || !/^https:\/\//i.test(post.public_url)) throw new Error('Instagram requires a publicly reachable HTTPS media URL. Add one to this photo before publishing.');
    const account = this.db.one('SELECT * FROM instagram_account WHERE id=1'); if (!account) throw new Error('Connect an Instagram Professional account first.');
    const token = this.decrypt(account.token_cipher); if (!token || Date.parse(account.token_expires_at) < Date.now()) throw new Error('Instagram token expired. Reconnect the account.');
    if (post.attempts > 0) throw new Error('Automatic retry is paused because Instagram may have accepted a previous request. Check the account before retrying to prevent duplicate posts.');
    this.db.run("UPDATE posts SET status='PUBLISHING',attempts=attempts+1,error=NULL WHERE id=?", [post.id]);
    const base = 'https://graph.instagram.com/v25.0'; const params = new URLSearchParams({ image_url: post.public_url, caption: post.caption, access_token: token });
    const containerResponse = await fetch(`${base}/${account.user_id}/media`, { method: 'POST', body: params }); const container = await containerResponse.json();
    if (!containerResponse.ok || !container.id) throw new Error(container.error?.message || `Instagram media upload returned ${containerResponse.status}`);
    let mediaId = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const status = await fetch(`${base}/${container.id}?fields=status_code&access_token=${encodeURIComponent(token)}`).then(r => r.json());
      if (status.status_code === 'FINISHED') break;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') throw new Error(`Instagram media container status: ${status.status_code}`);
      if (i === 9) throw new Error('Instagram media processing timed out; check status before retrying.');
    }
    const publishResponse = await fetch(`${base}/${account.user_id}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: container.id, access_token: token }) }); const published = await publishResponse.json();
    if (!publishResponse.ok || !published.id) throw new Error(published.error?.message || `Instagram publish returned ${publishResponse.status}`);
    this.db.run("UPDATE posts SET status='PUBLISHED',published_at=?,instagram_media_id=?,error=NULL WHERE id=?", [now(), published.id, post.id]);
    this.db.run("UPDATE media SET status='PUBLISHED' WHERE id=?", [post.media_id]); this.log('INFO', `Post published to Instagram: ${published.id}`); this.notify('Instagram post published successfully', post.filename);
  }
  async processDuePosts() {
    if (this.getSetting('automationPaused', 'false') === 'true') return;
    const due = this.db.all("SELECT p.*,m.filename,m.public_url FROM posts p JOIN media m ON m.id=p.media_id WHERE p.status='SCHEDULED' AND p.scheduled_at<=? ORDER BY p.scheduled_at", [now()]);
    for (const post of due) {
      try { await this.publishPost(post); }
      catch (e) { this.db.run("UPDATE posts SET status='FAILED',error=? WHERE id=?", [e.message, post.id]); this.db.run("UPDATE media SET status='FAILED' WHERE id=?", [post.media_id]); this.log('ERROR', `${post.filename}: ${e.message}`); this.notify('Instagram post failed', e.message); }
    }
  }
  async retryPost(postId) {
    const post = this.db.one("SELECT p.*,m.filename,m.public_url FROM posts p JOIN media m ON m.id=p.media_id WHERE p.id=? AND p.status='FAILED'", [postId]);
    if (!post) throw new Error('Only failed posts can be retried.');
    if (post.attempts > 0 && this.getSetting('developmentMode', 'true') !== 'true') throw new Error('Retry is blocked after a production attempt because Instagram may have accepted it. Verify the account first, then create a new scheduled post if it is absent.');
    this.db.run("UPDATE posts SET status='SCHEDULED',scheduled_at=?,attempts=0,error=NULL WHERE id=?", [now(), postId]); this.db.run("UPDATE media SET status='SCHEDULED' WHERE id=?", [post.media_id]); this.log('WARNING', `Retry queued: ${post.filename}`);
  }
  async setFolder(folder) {
    if (!folder || !path.isAbsolute(folder)) throw new Error('Choose a valid absolute folder path.');
    fs.mkdirSync(folder, { recursive: true }); this.setSetting('contentFolder', folder); await this.watchFolder(folder); await this.importFolder(folder); this.log('INFO', `Content folder set: ${folder}`); return folder;
  }
  async getSettings() {
    const keys = ['contentFolder','openaiModel','persona','tone','language','captionLength','maxHashtags','developmentMode','productionPublishingEnabled','notifications','automationPaused','frequency','preferredTime','mediaUrlHelp','updateFeedUrl'];
    const result = Object.fromEntries(keys.map(k => [k, this.getSetting(k, ({ openaiModel:'gpt-4o-mini', persona:'Fashion and lifestyle creator', tone:'Confident, natural, elegant', language:'English', captionLength:'Short', maxHashtags:'5', developmentMode:'true', productionPublishingEnabled:'false', notifications:'true', frequency:'3 posts/week', preferredTime:'18:00' })[k] || '')]));
    result.hasOpenAIKey = !!this.getSetting('openaiKey'); result.metaClientId = this.getSetting('metaClientId'); result.hasMetaClientSecret = !!this.getSetting('metaClientSecret');
    return result;
  }
  async saveSettings(data) {
    const regular = ['openaiModel','persona','tone','language','captionLength','maxHashtags','developmentMode','productionPublishingEnabled','notifications','frequency','preferredTime','metaClientId','updateFeedUrl'];
    for (const key of regular) if (data[key] !== undefined) this.setSetting(key, data[key]);
    if (data.openaiKey) this.setSetting('openaiKey', this.encrypt(data.openaiKey));
    if (data.metaClientSecret) this.setSetting('metaClientSecret', this.encrypt(data.metaClientSecret));
    if (data.developmentMode === 'true') this.setSetting('productionPublishingEnabled', 'false');
    this.log('INFO', 'Settings saved securely'); return this.getSettings();
  }
  async updatePost(postId, caption) {
    const changes = this.db.run("UPDATE posts SET caption=? WHERE id=? AND status IN ('DRAFT','FAILED','SCHEDULED')", [caption, postId]);
    if (!changes) throw new Error('This post can no longer be edited.');
    this.log('INFO', 'Post caption updated');
  }
  async autoPlan() {
    const media = this.db.all("SELECT * FROM media WHERE status='NEW' ORDER BY added_at"); if (!media.length) return [];
    if (!this.getSetting('openaiKey')) throw new Error('Add your OpenAI API key before creating an AI schedule proposal.');
    const frequency = this.getSetting('frequency', '3 posts/week'); const intervalDays = frequency === '1 post/day' ? 1 : frequency === '2 posts/day' ? 0.5 : frequency === '5 posts/week' ? 1.4 : 7 / 3;
    const [hour, minute] = this.getSetting('preferredTime', '18:00').split(':').map(Number); let start = new Date(); start.setHours(hour, minute, 0, 0); if (start <= new Date()) start.setDate(start.getDate() + 1);
    const results = [];
    for (let i = 0; i < media.length; i++) {
      const caption = await this.generateCaption(media[i].id, { persona:this.getSetting('persona'), tone:this.getSetting('tone'), language:this.getSetting('language'), length:this.getSetting('captionLength'), hashtags:this.getSetting('maxHashtags','5') });
      const postId = await this.createDraft(media[i].id, caption); const at = new Date(start.getTime() + i * intervalDays * 86400000);
      await this.schedulePost(postId, at.toISOString()); this.db.run("UPDATE posts SET status='DRAFT' WHERE id=?", [postId]); this.db.run("UPDATE media SET status='NEW' WHERE id=?", [media[i].id]);
      results.push({ ...media[i], caption, scheduled_at: at.toISOString(), post_id: postId, status: 'DRAFT' });
    }
    this.log('INFO', `AI schedule proposal created: ${results.length} posts`); return results;
  }
  async getLogs() { return this.db.all('SELECT * FROM logs ORDER BY id DESC LIMIT 500'); }
  async exportCsv() {
    const rows = this.db.all('SELECT p.scheduled_at,p.published_at,m.filename,p.caption,p.status,p.instagram_media_id FROM posts p JOIN media m ON m.id=p.media_id ORDER BY p.created_at');
    const quote = value => `"${String(value ?? '').replaceAll('"','""')}"`;
    return ['date,time,filename,caption,status,instagram_id', ...rows.map(r => { const d = r.published_at || r.scheduled_at || ''; return [d.slice(0,10),d.slice(11,16),r.filename,r.caption,r.status,r.instagram_media_id].map(quote).join(','); })].join('\r\n');
  }
  async backup(destination) { fs.copyFileSync(this.db.file, destination); this.log('INFO', 'Database backup created'); return destination; }
  async restore(source) {
    const target = this.db.file; const { Database } = require('./db.cjs');
    const probe = new Database(source); await probe.open();
    fs.copyFileSync(source, target); const restored = new Database(target); await restored.open(); this.db = restored;
    this.log('WARNING', 'Database restored from backup'); return true;
  }
  async dispose() { if (this.scheduler) clearInterval(this.scheduler); if (this.watcher) await this.watcher.close(); if (this.oauthServer) this.oauthServer.close(); }
}

module.exports = { Services };
