const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateService } = require('../src/main/updater.cjs');

function createHarness({ packaged = true, portable = false } = {}) {
  const events = new EventEmitter();
  const app = { isPackaged: packaged, getVersion: () => '0.1.2', quit: () => {} };
  const updaterCalls = { options: null, checks: 0, installs: [] };
  class FakeUpdater extends EventEmitter {
    constructor(options) { super(); updaterCalls.options = options; }
    checkForUpdates() { updaterCalls.checks++; return Promise.resolve({}); }
    quitAndInstall(...args) { updaterCalls.installs.push(args); }
  }
  const service = new UpdateService({
    app,
    NsisUpdater: FakeUpdater,
    broadcast: status => events.emit('status', status),
    log: () => {},
    isPortable: () => portable
  });
  return { service, events, updaterCalls };
}

test('requires HTTPS for a configured update feed', async () => {
  const { service, updaterCalls } = createHarness();
  const status = await service.configure('http://updates.example/app');
  assert.equal(status.state, 'invalid-feed');
  assert.equal(updaterCalls.options, null);
  service.dispose();
});

test('configures HTTPS feed and reports downloaded updates', async () => {
  const { service, updaterCalls } = createHarness();
  const status = await service.configure('https://updates.example/app');
  assert.equal(status.state, 'ready');
  assert.equal(updaterCalls.options.url, 'https://updates.example/app/');
  const updater = service.updater;
  updater.emit('update-available', { version: '0.1.3' });
  assert.equal(service.status().state, 'downloading');
  updater.emit('download-progress', { percent: 51, transferred: 51, total: 100 });
  assert.equal(service.status().percent, 51);
  updater.emit('update-downloaded', { version: '0.1.3' });
  assert.equal(service.status().state, 'downloaded');
  assert.equal(await service.install(), true);
  assert.deepEqual(updaterCalls.installs, [[false, true]]);
  service.dispose();
});

test('configures GitHub Releases from owner/repository or repository URL', async () => {
  for (const repository of ['sample-owner/instagram-manager', 'https://github.com/sample-owner/instagram-manager']) {
    const { service, updaterCalls } = createHarness();
    const status = await service.configure(repository);
    assert.equal(status.state, 'ready');
    assert.deepEqual(updaterCalls.options, { provider: 'github', owner: 'sample-owner', repo: 'instagram-manager' });
    assert.equal(status.feedUrl, 'sample-owner/instagram-manager');
    service.dispose();
  }
});

test('does not enable self-update for development or portable builds', async () => {
  const development = createHarness({ packaged: false });
  assert.equal((await development.service.configure('')).state, 'development');
  development.service.dispose();

  const portable = createHarness({ portable: true });
  assert.equal((await portable.service.configure('https://updates.example/')).state, 'portable');
  assert.equal(portable.updaterCalls.options, null);
  portable.service.dispose();
});
