# Instagram Manager

A local-first Windows desktop MVP for organizing Instagram Feed photo posts. It watches one chosen folder, imports images with SHA-256 duplicate detection, drafts AI captions, schedules posts, records history, and keeps logs and a SQLite database on the PC.

## Architecture

- Electron main process: scheduler, folder watcher, SQLite persistence, OAuth callback, Windows notifications, tray menu, and secure IPC.
- Renderer: local HTML/CSS/JavaScript interface with dashboard, media library, post editor, calendar, scheduler, history, settings, and logs.
- SQLite: database stored under Electron's per-user application data directory. Writes are flushed through a temporary file.
- Credentials: OpenAI keys, Meta app secret, and Instagram token are encrypted with Electron `safeStorage` when Windows secure storage is available.
- Integrations: OpenAI Chat Completions vision input for captions; Instagram API with Instagram Login for a Business or Creator account.

## Run from source

Install Node.js 20 or later, then from this folder:

```powershell
pnpm install
pnpm start
```

## Build Windows executables

```powershell
pnpm install
pnpm build:win
```

The `dist` folder receives a portable executable and an NSIS installer. The installer can create Start Menu and desktop shortcuts. The application bundles Electron, so end users do not need Python or Node.js.

## Application updates

Automatic updates are supported by the installed NSIS version, not the portable executable. In **Settings → Application**, enter the public GitHub repository as `owner/repository`. Releases are checked on launch and every six hours; installers download in the background and wait for confirmation before restarting to install. The first installation must be updated manually because older installed versions do not yet contain the updater.

The `.github/workflows/release.yml` workflow builds and publishes a Windows release when a `v*` tag is pushed. Bump `version` in `package.json` to match the tag (for example, `0.1.3` with tag `v0.1.3`), push the commit, then push the tag. The GitHub repository must be public for the current update configuration. Each release includes `latest.yml`, the NSIS installer, and its `.blockmap`; the portable executable is a manual-download option and does not self-update. The workflow needs the repository Actions setting **Workflow permissions: Read and write permissions** so its `GITHUB_TOKEN` can publish a release.

## OpenAI setup

Open **AI Settings**, enter an OpenAI API key, and choose the model and caption profile. The default model is `gpt-4o-mini`; it accepts image input. The photo is sent to OpenAI only when the user presses **Generate**. The key is encrypted at rest by Windows secure storage and is not put in `.env` or the source.

## Meta / Instagram setup

1. Convert the Instagram account to Business or Creator.
2. Create a Meta developer app and enable Instagram API with Instagram Login.
3. Add `http://127.0.0.1:8787/meta/callback` as an allowed OAuth redirect URI.
4. Request `instagram_business_basic` and `instagram_business_content_publish`.
5. Enter the app ID and app secret in **Settings → Instagram**, then choose **Connect Instagram**.
6. For production use, configure the Meta app and obtain the required app review / access for the account.

This app calls Instagram's official API. It does not automate Instagram's website, scrape pages, or use browser login automation. Only professional accounts that Meta authorizes can publish.

### Publishing limitation

The standard Instagram image publishing flow asks Meta to fetch an `image_url`. A local file path is not a publicly reachable upload URL. To publish a photo, set its **Public HTTPS photo URL** in the post editor to a stable URL that Meta can fetch. This MVP does not upload local files to a third-party host or create a public tunnel. Posts without a valid URL fail with a clear message. A production publishing toggle and connected account are both required. Production retry is blocked after an ambiguous API attempt to reduce duplicate posts.

Development mode is on by default. It simulates due posts locally and never calls Instagram's publish endpoints.

## Environment variables

No secrets are read from environment variables. `.env.example` documents the default model only; credentials are entered in Settings and encrypted with Windows `safeStorage`.

## Data and backups

Media remains in the folder selected by the user. The SQLite database is in Electron's `userData` directory. Use **Settings → Application → Backup database** and **Restore database**. CSV export is available under History.

## Troubleshooting

- **Caption generation fails:** check the key, model, internet access, and OpenAI account/API access.
- **Instagram connection fails:** check the App ID and secret, allowed redirect URI, account type, scopes, and Meta app role/review.
- **Publishing reports a missing public URL:** provide a public HTTPS URL for that image. The app intentionally does not pretend a local path can be fetched by Meta.
- **Token expired:** reconnect the Instagram account.
- **Folder appears empty:** verify the selected folder and use JPG, JPEG, PNG, or WEBP files.
- **Restore database:** restoration replaces the current local database; make a backup first.

## Development mode and production setup

Development mode stores successful simulated publications with IDs prefixed `DEV-`. For production, connect an authorized professional account, supply public HTTPS photo URLs, switch off Development Mode, and explicitly enable production publishing. Start with a single reviewed post and confirm it appears in Instagram before relying on the scheduler.

## Current MVP boundaries

The app targets one Instagram account and Feed photos. It does not publish Reels, Stories, or video; does not host media; does not implement multi-account support; and does not guarantee desktop scheduling while Windows is shut down. Scheduled jobs are recovered when the app starts again.
