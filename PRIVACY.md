# Privacy

Unsynth has no account, no analytics and no Unsynth tracking server. Your settings, watch history, watch progress, stats, groups, folders and queues live in your browser's extension storage on your own computer.

## What leaves your computer, and when

Only the features you have switched on make these calls.

| Where | Why | What it receives |
|---|---|---|
| youtube.com, music.youtube.com, i.ytimg.com | the pages Unsynth works on | nothing extra from Unsynth |
| returnyoutubedislikeapi.com | dislike counts (Return YouTube Dislike module) | a video ID |
| sponsor.ajay.app | skip segments (SponsorBlock module) | a 4-character hash prefix of the video ID (the full ID only if that lookup fails) |
| dearrow-thumb.ajay.app | neutral titles and thumbnails (DeArrow module) | a video ID |
| raw.githubusercontent.com | the community AI-channel list (AiSList), once a day | nothing but the request |
| suggestqueries.google.com | search suggestions on the Creator tab | the text you type there |
| unsynth.vercel.app | the update check and ZIP download | nothing but the request |
| unsynth.vercel.app/api/sync | watch history, queue and library sync, **only if you turn sync on** | watched IDs, progress and dates, queue and library; plus your Google sign-in token to confirm it is you (not stored) |
| accounts.google.com, oauth2.googleapis.com, www.googleapis.com | Google sign-in with **your own** OAuth client, only if you connect it | your Google authorisation and the YouTube API calls you trigger |
| api.openai.com, api.anthropic.com, openrouter.ai | the AI assistant and fact-check, with **your own** key, only if you add one | the transcript or text you ask about |
| playlist-forge.vercel.app | Playlist Forge sync (if you turn it on), Forge search and Discover, and the AI assistant's transcript fallback | the playlists you send; for search, your query and (with "Exclude watched") your watched video IDs; for transcripts, a video ID |
| api.github.com | an update check fallback | nothing but the request |

## Things worth knowing before you switch them on

- **Sync** sends your Google sign-in token with each sync so the server can confirm which channel is yours. It is used for that one check with Google and not stored; your data is stored under a one-way hash of the channel ID, never the ID itself. "Turn off & delete synced data" removes it.
- **Forge search and Discover** run on the Playlist Forge server. With "Exclude watched" on (the default), it receives your watched video IDs (up to 8,000) so it can leave them out, plus what you searched for.
- **Transcripts for the AI assistant**: when YouTube's own transcript cannot be read in the page, Unsynth asks the Playlist Forge server for it, sending the video ID.
- **AI answers** go to the provider you chose. If that provider has no key or fails and you have saved a key for another provider, Unsynth uses that other provider instead.
- **SponsorBlock** is asked with a short hash prefix of the video ID, not the ID itself; only if that lookup fails does it ask with the full ID.

## Secrets

Your OAuth client secret, AI keys and any GitHub token are stored only in your browser and are never included in backups or exports.

## Removing everything

Remove Unsynth from the extensions page and delete its folder. If you connected Google, also remove Unsynth's access at https://myaccount.google.com/permissions.

The full technical list, with exactly what sync sends, is in docs/SETUP.md under "Privacy / Data Flow".
