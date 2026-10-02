# Unsynth

A local-first YouTube power suite for Chromium browsers. Content filtering, playback controls, subscription and playlist organization, watch history, stats and creator tools in one extension. No account, no telemetry.

[Download and setup guide](https://unsynth.vercel.app) · [Latest release](https://github.com/Phaenex/unsynth-extension/releases/latest) · [Support](SUPPORT.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Unsynth isn't in the Chrome Web Store. You load it yourself, which takes about a minute.

## Install

1. Download the ZIP from the [latest release](https://github.com/Phaenex/unsynth-extension/releases/latest) or from the [setup site](https://unsynth.vercel.app).
2. Extract it somewhere permanent. Chrome runs it from that folder, so don't leave it in Downloads if you clean that out.
3. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
4. Turn on **Developer mode** and choose **Load unpacked**.
5. Pick the extracted folder, the one with `manifest.json` in it.
6. Open the Unsynth dashboard, run One-click setup, then reload any YouTube tabs you already had open.

Works in Chrome, Edge, Brave, Opera, Vivaldi and other Chromium browsers, version 120 or newer. Firefox isn't supported.

Each release lists a SHA-256 checksum next to the ZIP if you want to check your download.

## What you get without signing in to anything

- AI content filtering and feed cleanup (runs on your machine)
- subscription groups, and side-by-side playlist organization with bulk moves
- watch progress, watched markers, local stats, imports and backups
- volume up to 600% with sound presets (Cinema, Vocal for clearer voices, Bass that small speakers can play, Night) and a ten-band Custom EQ, quality lock, SponsorBlock, pop-out player, scroll miniplayer, screenshots, clips, A-B loops, chapters, transcript export
- a watch guide beside the video: what's playing now, time left, stats, skip segments, the chapter you're in (fold the list with a click), and every link in the description sorted by what it's for
- Return YouTube Dislike, DeArrow, title cleanup, a live shelf, queue tools, and pausing other tabs when you start a video

Optional connections, all off until you turn them on:

| Connection | Unlocks | Where data goes |
|---|---|---|
| Google sign-in with your own OAuth client | playlist writes, subscription import, opt-in watch-state sync | Google APIs and the opt-in sync endpoint |
| Your own OpenRouter, OpenAI or Anthropic key | transcript assistant and fact-check | the provider you pick |
| Playlist Forge sync | shared taste and playlist workflow | playlist-forge.vercel.app |

The content filter and Forge discovery don't need an AI key.

Unsynth is free. Tips are optional and never unlock anything.

## Privacy

Settings, watch data, groups, playlists, queues, notes and any credentials you add stay in your browser's extension storage. There's no Unsynth analytics account and no telemetry service.

Some modules call public services when they're on: Return YouTube Dislike and DeArrow get a video ID, SponsorBlock gets a short hash of it. Google sign-in, AI providers, Playlist Forge and device sync are opt-in. [PRIVACY.md](PRIVACY.md) lists every network call and what it receives.

This build carries no signing key, so every install gets its own extension ID and nothing is shared with anyone else's copy.

## Updates

Unpacked extensions can't update themselves. When a new version is out (the dashboard's Updates card tells you), download it, extract it over your existing folder, reload Unsynth on the extensions page, then reload your YouTube tabs. Your settings and watch history are kept as long as you use the same folder. Back up your watch history from Dashboard → Watched before moving computers or clearing extension data.

## This repository

This is the published source of each release: the same `manifest.json` and `src/` that are in the ZIP. Development happens elsewhere, so pull requests aren't merged here, but [issues and bug reports](https://github.com/Phaenex/unsynth-extension/issues) are welcome. Report security problems privately (see [SECURITY.md](SECURITY.md)). See [SUPPORT.md](SUPPORT.md) for what to include.

## License

No open-source license is granted. You're welcome to read the code and install the extension for your own use; all other rights are reserved by the author.
