class UpdateService {
  constructor({ app, NsisUpdater, broadcast, log, isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE }) {
    this.app = app;
    this.NsisUpdater = NsisUpdater;
    this.broadcast = broadcast;
    this.log = log;
    this.isPortable = isPortable;
    this.updater = null;
    this.feedUrl = '';
    this.checkPromise = null;
    this.timer = null;
    this.current = { state: 'idle', version: app.getVersion() };
  }

  setState(state, details = {}) {
    this.current = { ...this.current, state, ...details, version: this.app.getVersion() };
    this.broadcast(this.current);
    return this.current;
  }

  async configure(feedUrl) {
    this.feedUrl = String(feedUrl || '').trim();
    if (!this.app.isPackaged) return this.setState('development');
    if (this.isPortable()) return this.setState('portable', { message: 'Automatic updates are available in the installed version.' });
    if (!this.feedUrl) return this.setState('needs-feed', { message: 'Set an HTTPS update feed to receive releases.' });

    const githubRepo = this.parseGitHubRepo(this.feedUrl);
    let options;
    if (githubRepo) {
      options = { provider: 'github', ...githubRepo };
      this.feedUrl = `${githubRepo.owner}/${githubRepo.repo}`;
    } else {
      let parsed;
      try { parsed = new URL(this.feedUrl); }
      catch { return this.setState('invalid-feed', { message: 'Enter owner/repo or a valid HTTPS update feed URL.' }); }
      if (parsed.protocol !== 'https:') return this.setState('invalid-feed', { message: 'Update feeds must use HTTPS.' });
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
      this.feedUrl = parsed.toString();
      options = { provider: 'generic', url: this.feedUrl };
    }

    try {
      this.updater = new this.NsisUpdater(options);
      this.updater.autoDownload = true;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.on('checking-for-update', () => this.setState('checking'));
      this.updater.on('update-available', info => this.setState('downloading', { availableVersion: info.version, percent: 0 }));
      this.updater.on('update-not-available', info => this.setState('up-to-date', { availableVersion: info.version || this.app.getVersion() }));
      this.updater.on('download-progress', progress => this.setState('downloading', { percent: Math.floor(progress.percent), transferred: progress.transferred, total: progress.total }));
      this.updater.on('update-downloaded', info => this.setState('downloaded', { availableVersion: info.version, percent: 100, message: 'Restart to install the update.' }));
      this.updater.on('update-cancelled', () => this.setState('cancelled'));
      this.updater.on('error', error => {
        this.log('ERROR', `Update check failed: ${error.message}`);
        this.setState('error', { message: error.message });
      });
      this.setState('ready', { feedUrl: this.feedUrl });
      if (!this.timer) {
        this.timer = setInterval(() => this.check().catch(() => {}), 6 * 60 * 60 * 1000);
        this.timer.unref?.();
      }
      setTimeout(() => this.check().catch(() => {}), 12000).unref?.();
      return this.current;
    } catch (error) {
      this.log('ERROR', `Could not configure updates: ${error.message}`);
      return this.setState('error', { message: error.message });
    }
  }

  parseGitHubRepo(value) {
    const normalized = value.replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/i, '').replace(/\/$/, '');
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) return null;
    const [owner, repo] = normalized.split('/');
    return { owner, repo };
  }

  async check() {
    if (!this.updater) return this.current;
    if (this.checkPromise) return this.checkPromise;
    this.setState('checking');
    this.checkPromise = this.updater.checkForUpdates()
      .catch(error => { this.setState('error', { message: error.message }); throw error; })
      .finally(() => { this.checkPromise = null; });
    await this.checkPromise;
    return this.current;
  }

  async install() {
    if (!this.updater || this.current.state !== 'downloaded') throw new Error('There is no downloaded update ready to install.');
    this.updater.quitAndInstall(false, true);
    return true;
  }

  status() { return this.current; }
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { UpdateService };
