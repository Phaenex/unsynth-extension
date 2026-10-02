# Unsynth support

Start with the public guide: https://unsynth.vercel.app

## Fast checks

1. Confirm the feature is enabled in the Unsynth dashboard.
2. Reload Unsynth on your browser's extensions page.
3. Reload every YouTube tab that was already open.
4. Confirm you are using Chromium 120 or newer.

If Chrome says `manifest.json` is missing, extract the ZIP and select the folder that contains `manifest.json` directly.

## Audio: presets, Custom EQ and the meter

The bar over the video sets the level (up to 600%) and the sound: Cinema, Smart, Bass, Vocal, Treble, Night, Mono, Custom, or Off. The Unsynth toolbar button opens the same controls plus a ten-band **Custom EQ** (31 Hz to 16 kHz; what you set on a fader is what that band measures) and a live meter.

The meter's line says what is actually happening:

- **Processing · Bass · -21 dB**: the effect is running; the bar moves with the sound.
- **Effects off · YouTube plays the audio as is**: Off at 100% or less, nothing is applied.
- **Chrome is holding the audio: click the video once**: Chrome blocks audio until the page has been clicked.
- **Effects not running: another extension or YouTube already owns this video's audio**: another audio extension got there first; turn one of them off for YouTube.
- **This tab runs an old copy of Unsynth: reload the tab**: happens after every Unsynth update or reload. Reload the YouTube tab.

Presets are matched in loudness to Off, so compare them at the same volume. Bass adds harmonics that laptop and phone speakers can play; very deep sub-bass still needs real speakers or headphones.

## When reporting a problem

Report bugs at https://github.com/Phaenex/unsynth-extension/issues. Security problems go privately through https://github.com/Phaenex/unsynth-extension/security/advisories/new (see SECURITY.md).

Include the Unsynth version, browser version, page address, exact steps, expected result, actual result, and a screenshot when layout matters. Say whether the problem survives an extension reload plus a YouTube tab reload.

Do not attach API keys, OAuth secrets or tokens, GitHub tokens, exported history, or a browser profile.

## Credential-gated features

Google OAuth is optional and is used for playlist writes, subscription import, and opt-in device sync. AI provider keys are optional and are used only by the assistant and fact-check features. Playlist Forge sync is separately opt-in.

For Google errors, confirm YouTube Data API v3 is enabled, the account is listed as a test user when the consent screen is in Testing, and the redirect address matches Unsynth's Account tab exactly.

## Updates and removal

Unpacked extensions do not update themselves. Replace the files in the same folder, reload Unsynth on the extensions page, then reload YouTube tabs. Your settings and watch history are kept because Chrome ties them to the folder's location: unzip into the same folder, not a new one. The dashboard's Updates card checks for new releases and shows the same steps.

To remove Unsynth, remove it from the extensions page and delete its extracted folder. If Google was connected, revoke the app from your Google Account.
