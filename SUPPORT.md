# Unsynth support

Start with the public guide: https://unsynth.vercel.app

On any watch page, the guide beside the video has a **Tour** button that walks through the main features on the page you are on, ten steps. The dashboard's Guide tab can hide that button once you no longer need it.

## Fast checks

1. Confirm the feature is enabled in the Unsynth dashboard.
2. Reload Unsynth on your browser's extensions page.
3. Reload every YouTube tab that was already open.
4. Confirm you are using Chromium 120 or newer.

If Chrome says `manifest.json` is missing, extract the ZIP and select the folder that contains `manifest.json` directly.

## Audio presets, Custom EQ and the meter

The bar over the video sets the level (up to 600%) and the sound: Cinema, Smart, Bass, Vocal, Treble, Night, Mono, Custom, or Off. The Unsynth toolbar button opens the same controls plus a ten-band **Custom EQ** (31 Hz to 16 kHz, and the dB you set on a fader is the dB measured at that band) and a live meter.

The meter's line says what is happening:

- **Processing · Bass · -21 dB**: the effect is running and the bar moves with the sound.
- **Effects off · YouTube plays the audio as is**: Off at 100% or less. Nothing is applied.
- **Chrome is holding the audio: click the video once**: Chrome will not let an extension process audio until the page has had a click. One click anywhere on the video does it.
- **Effects not running: another extension or YouTube already owns this video's audio**: some other audio extension got there first. Turn one of them off for YouTube.
- **This tab runs an old copy of Unsynth: reload the tab**: you will see this after every Unsynth update or reload, and reloading the YouTube tab clears it.

Presets are matched in loudness to Off on the video that is playing, so compare them at the same volume. Bass adds harmonics that laptop and phone speakers can play. Very deep sub-bass still needs real speakers or headphones.

## AI filter misses and false catches

The filter hides channels on the community [AiSList](https://github.com/Override92/AiSList) (about 25,000 AI channels, updated daily) and videos whose titles say they are AI-made. It does not hide people who talk about AI. It cannot see inside a video, so an AI channel that is not on the list and never says "AI" gets through.

- If it missed one, right-click the video and pick **Mark this channel as AI (Unsynth)**. Every video from that channel is hidden from then on. The toast has an **Undo**.
- A real person got hidden? Put the video back on screen first: switch the filter to Blur or Label in the dashboard's Filter tab. Then right-click it and pick **Not AI: never hide this channel (Unsynth)**. On a watch page, the "Not AI" button on the overlay does the same.
- Your marks stay on this browser profile. The community list takes suggestions as well: open an issue with the channel's link on [the AiSList GitHub](https://github.com/Override92/AiSList/issues), or see [aisloplist.com](https://aisloplist.com) for other ways.

## Where the docked miniplayer sits

Scroll the video off the top of a watch page and it docks into a small box so you can read the comments. By default it sits at the right end of the comment column, clear of the suggestions. When a long comment line runs under it, it narrows to clear the line. If no width would clear it, the box moves to the bottom-right corner over the suggestions instead and stays there until you scroll back up.

- Drag the bar at the top of the box to put it where you want. That spot is remembered, and a box you placed yourself never moves on its own.
- Double-click the bar to go back to the default spot and size.
- The corner handle resizes it. **Back to full view** and **Close mini player** are on the bar.
- A position saved on a smaller screen is dropped on a bigger one rather than left floating mid-page.
- Turn it off under **Scroll miniplayer** in the dashboard if you would rather YouTube's own behaviour.

## When reporting a problem

Report bugs at https://github.com/Phaenex/unsynth-extension/issues, or email nick@phaenex.com with the same details if you do not use GitHub. Security problems go privately through https://github.com/Phaenex/unsynth-extension/security/advisories/new (see SECURITY.md).

Pick the form that matches: a plain bug, a page that broke after YouTube changed something, or a video the AI filter should have caught. Each asks for the same block: in the dashboard, **Account › Local diagnostics › Copy report for an issue** with the YouTube page open, then paste. The block holds the Unsynth version, your browser, the page and which features are on. It also lists what the extension could not find on that page and its recent errors. It goes to your clipboard and nowhere else until you paste it. On a version without that button, **Copy diagnostics** will do. Then add the exact steps and what you expected against what happened. A screenshot helps when layout matters, and say whether the problem survives an extension reload plus a YouTube tab reload.

Do not attach API keys, OAuth secrets or tokens, GitHub tokens, exported history, or a browser profile.

## Credential-gated features

Google sign-in is optional. Playlist writes, subscription import and opt-in device sync are the features that need it. An AI provider key is needed by the assistant and fact-check features and nothing else. Playlist Forge sync is separately opt-in.

Google errors usually trace back to the project settings. Check that YouTube Data API v3 is enabled. If the consent screen is still in Testing, the account has to be listed as a test user. The redirect address in the Google console needs to match the one shown on Unsynth's Account tab, character for character.

## Updates and removal

An install from the Chrome Web Store is updated by Chrome. The dashboard's Updates card says so and shows only the installed version.

An unpacked (ZIP) install does not update itself. Replace the files in the same folder, reload Unsynth on the extensions page, then reload YouTube tabs. Your settings and watch history are kept because Chrome ties them to the folder's location: unzip into the same folder, not a new one. The dashboard's Updates card checks for new releases and shows the same steps.

To remove Unsynth, remove it from the extensions page and delete its extracted folder. If Google was connected, revoke the app from your Google Account.
