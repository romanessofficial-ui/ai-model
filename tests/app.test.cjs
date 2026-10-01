const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../src/main/db.cjs');
const { Services } = require('../src/main/services.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-manager-'));
  const db = new Database(path.join(root, 'state.sqlite')); await db.open();
  const app = { getPath: () => root };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const services = new Services(app, db, safeStorage, () => {}, { openExternal: () => {} });
  t.after(async () => { await services.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'car.jpg'); fs.writeFileSync(file, Buffer.from('test image bytes'));
  return { root, db, services, file };
}

test('database initializes tables and persists settings across reopen', async t => {
  const { db } = await fixture(t); db.run('INSERT INTO settings(key,value) VALUES(?,?)', ['theme','dark']);
  const reopened = new Database(db.file); await reopened.open();
  assert.equal(reopened.one('SELECT value FROM settings WHERE key=?',['theme']).value,'dark');
  assert.ok(reopened.one("SELECT name FROM sqlite_master WHERE type='table' AND name='posts'"));
});

test('media import deduplicates identical file bytes by SHA-256', async t => {
  const { services, file } = await fixture(t);
  const first = await services.importFile(file); const second = await services.importFile(file);
  assert.ok(first.id); assert.equal(second,null); assert.equal((await services.listMedia()).length,1);
});

test('caption generation uses image input and stores the generated caption', async t => {
  const { services, file } = await fixture(t); const media = await services.importFile(file);
  services.setSetting('openaiKey', services.encrypt('test-key'));
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => { const body=JSON.parse(options.body); assert.equal(body.messages[0].content[1].type,'image_url'); return { ok:true, json:async()=>({choices:[{message:{content:'Night drive, clear mind. ✨'}}]}) }; };
  t.after(()=>{global.fetch=originalFetch});
  const caption = await services.generateCaption(media.id,{language:'English',hashtags:0});
  assert.equal(caption,'Night drive, clear mind. ✨');
  assert.equal(services.db.one('SELECT caption FROM caption_generations').caption,caption);
});

test('development scheduler publishes due post once and protects published media', async t => {
  const { services, file } = await fixture(t); const media = await services.importFile(file);
  const draft = await services.createDraft(media.id,'Test caption');
  services.setSetting('developmentMode','true');
  await services.schedulePost(draft,new Date(Date.now()+3600000).toISOString());
  services.db.run("UPDATE posts SET scheduled_at=? WHERE id=?",[new Date(Date.now()-1000).toISOString(),draft]);
  await services.processDuePosts();
  assert.equal(services.db.one('SELECT status FROM posts WHERE id=?',[draft]).status,'PUBLISHED');
  assert.match(services.db.one('SELECT instagram_media_id FROM posts WHERE id=?',[draft]).instagram_media_id,/^DEV-/);
  const nextDraft = await services.createDraft(media.id,'Second caption');
  await assert.rejects(services.schedulePost(nextDraft,new Date(Date.now()+3600000).toISOString()));
});

test('scheduled posts resume from persisted database after a reopen', async t => {
  const { services, db, file } = await fixture(t); const media = await services.importFile(file);
  const post = await services.createDraft(media.id,'Queued');
  const future = new Date(Date.now()+86400000).toISOString(); await services.schedulePost(post,future);
  const reopened = new Database(db.file); await reopened.open();
  assert.equal(reopened.one('SELECT status FROM posts WHERE id=?',[post]).status,'SCHEDULED');
  assert.equal(reopened.one('SELECT scheduled_at FROM posts WHERE id=?',[post]).scheduled_at,future);
});

test('production publish refuses local-only media without public HTTPS URL', async t => {
  const { services, file } = await fixture(t); const media = await services.importFile(file);
  const post = await services.createDraft(media.id,'Caption'); services.setSetting('developmentMode','false'); services.setSetting('productionPublishingEnabled','true');
  await assert.rejects(services.publishPost({id:post,media_id:media.id,public_url:'',attempts:0,caption:'Caption'}),/publicly reachable HTTPS media URL/);
});

test('API secrets are persisted only in encrypted form', async t => {
  const { services, db } = await fixture(t);
  await services.saveSettings({ openaiKey:'openai-secret', metaClientSecret:'meta-secret', metaClientId:'123' });
  const stored = db.all('SELECT key,value FROM settings');
  assert.equal(services.decrypt(stored.find(row=>row.key==='openaiKey').value),'openai-secret');
  assert.notEqual(stored.find(row=>row.key==='metaClientSecret').value,'meta-secret');
  assert.equal((await services.getSettings()).hasOpenAIKey,true);
});

test('failed post can be retried in development mode without retaining stale error', async t => {
  const { services, file } = await fixture(t); const media = await services.importFile(file);
  const post = await services.createDraft(media.id,'Caption'); await services.schedulePost(post,new Date(Date.now()+3600000).toISOString());
  services.db.run("UPDATE posts SET status='FAILED',error=?,attempts=0 WHERE id=?",['Temporary failure',post]);
  await services.retryPost(post);
  const updated = services.db.one('SELECT status,error,attempts FROM posts WHERE id=?',[post]);
  assert.equal(updated.status,'SCHEDULED'); assert.equal(updated.error,null); assert.equal(updated.attempts,0);
});

test('startup marks interrupted production publishing for manual review', async t => {
  const { services, db, file, root } = await fixture(t); const media = await services.importFile(file);
  const post = await services.createDraft(media.id,'Caption');
  db.run("UPDATE posts SET status='PUBLISHING',attempts=1 WHERE id=?",[post]); db.run("UPDATE media SET status='PUBLISHING' WHERE id=?",[media.id]);
  services.setSetting('contentFolder',root);
  await services.initialize();
  const result=db.one('SELECT status,error FROM posts WHERE id=?',[post]);
  assert.equal(result.status,'FAILED'); assert.match(result.error,/Check Instagram before retrying/);
});
