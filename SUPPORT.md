# Unsynth support

Start with the public guide: https://unsynth.vercel.app

## Fast checks

1. Confirm the feature is enabled in the Unsynth dashboard.
2. Reload Unsynth on your browser's extensions page.
3. Reload every YouTube tab that was already open.
4. Confirm you are using Chromium 120 or newer.

If Chrome says `manifest.json` is missing, extract the ZIP and select the folder that contains `manifest.json` directly.

## When reporting a problem

Include the Unsynth version, browser version, page address, exact steps, expected result, actual result, and a screenshot when layout matters. Say whether the problem survives an extension reload plus a YouTube tab reload.

Do not attach API keys, OAuth secrets or tokens, GitHub tokens, exported history, or a browser profile.

## Credential-gated features

Google OAuth is optional and is used for playlist writes, subscription import, and opt-in device sync. AI provider keys are optional and are used only by the assistant and fact-check features. Playlist Forge sync is separately opt-in.

For Google errors, confirm YouTube Data API v3 is enabled, the account is listed as a test user when the consent screen is in Testing, and the redirect address matches Unsynth's Account tab exactly.

## Updates and removal

Unpacked extensions do not update themselves. Replace the files in the same folder, reload Unsynth on the extensions page, then reload YouTube tabs.

To remove Unsynth, remove it from the extensions page and delete its extracted folder. If Google was connected, revoke the app from your Google Account.
