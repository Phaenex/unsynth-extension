# Changelog

## [1.2.1] - 2026-10-01

A cleanup of 1.2.0's download removal. Nothing changes in how you use Unsynth.

- **The last of the video-download code is gone.** 1.2.0 removed the download
  button, its settings and the stream permission, but a small helper that could
  look up YouTube's raw video-stream addresses was still in the page bridge.
  Nothing in Unsynth called it anymore, but a script running on a YouTube page
  could still have asked it. It's deleted now, and a test reads every source
  file so it can't quietly come back.
## [1.2.0] - 2026-09-25

The first public release of this line. Unsynth no longer downloads videos.

- **Video download is gone.** The player's download button, its quality
  picker and its settings are removed, and so is the permission that let
  Unsynth fetch YouTube's video streams (`*.googlevideo.com`). Saving whole
  videos is against YouTube's terms and it isn't something Unsynth should do.
  If you had it switched on, the switch simply disappears; nothing else in
  your setup changes.
- **Screenshots, clip capture and transcript export stay.** Clips are capped
  at 20 seconds, so they work as quotes, not as a way to save a video.
- **The update check still verifies the ZIP.** The download permission now
  only serves updates: Unsynth fetches its own release ZIP from
  unsynth.vercel.app, checks it against the published SHA-256, and only then
  saves it.
- **The tip link works.** "Support Phaenex" pointed at a Ko-fi page that
  doesn't exist and landed on Ko-fi's sign-up screen. It now opens
  ko-fi.com/phaenex.
- **Numbered above 1.1.1.** The last ZIP on the download site was 1.1.1, from
  an older line of development, and the in-app update check only offers a
  newer version. 1.2.0 is the first version it will offer those installs.

## [0.9.26] - 2026-09-24

The watch guide, tightened after a look at every state it can be in.

- **The chapter you're in is marked.** The chapter list beside the video
  highlights the current chapter and follows the video as it plays, and the
  Now line names the same chapter (YouTube's own label lagged after a seek,
  so the two could disagree). Jumping to a chapter moves the mark straight
  away, even while the video is still buffering.
- **You can tell there's more.** The description area fades at the bottom
  while there's more below, and stops fading at the end.
- **An open door stays on screen.** Opening Stats, Ask AI or Forge no longer
  runs the guide past the bottom of the window; the panel ends inside it and
  scrolls on its own.
- **Hide the full description from its end,** not only from the top.
- **Link names wrap** to two lines instead of being cut off at different
  points.

## [0.9.25] - 2026-09-24

- **The quick description is whole, and first.** Beside the video, the
  description section now opens with the video's own summary, in full: no
  one-line clamp, no "...". Long ones end at a full sentence. It comes before
  the chapters, so it is the first thing you read.
- **Open the full description right there.** "Open full description" unfolds
  the whole description inside the guide, under the summary: line breaks
  kept, links clickable, timestamps jump the video. "Show on YouTube" still
  expands YouTube's own and takes you to it. Under the video (one-column
  layout) it expands YouTube's, which is right there.

## [0.9.24] - 2026-09-24

- **"Previous chapter" can take you back to the start.** YouTube links the
  first chapter to the video with no time on it, so it was skipped, and the
  tools menu's Previous chapter never reached 0:00.
- **Screen readers hear the description section correctly beside the video.**
  0.9.23 showed its links while still announcing it as collapsed. Beside the
  video it is now always open, and says so.

## [0.9.23] - 2026-09-24

- **The watch guide stays beside the video when you open one from the
  homepage or search.** It kept dropping under the player. YouTube leaves the
  page you came from in the background, and the guide was measuring that
  page's hidden, zero-width column instead of the video page's, decided there
  was no room beside the video, and never checked again. It now looks only at
  the video page's own columns, and re-checks its position whenever the layout
  changes size.
- **Choose where the guide sits.** Dashboard, Watch guide, Position: beside
  the video (above related videos) or under the video (above the description).
  It moves in open tabs straight away.
- **Every link in the description, and what it is for.** The Description
  part of the guide now lists every link, not four website names and a "+3",
  grouped by what it is for (Sponsors & deals, Support the creator, Merch,
  Socials, Listen, More on YouTube, Sources, Other links) and named by the
  description's own words, with the site beside each. Above them, "Worth
  knowing" pulls out a sponsor and its discount code, affiliate or paid
  disclosures, disclaimers, corrections, and the credits. It is all taken from
  the description's text; nothing is made up. Beside the video the section
  fits to the bottom of the player and scrolls inside, so the related videos
  stay where they were.
- **The rest of your features are back.** 0.9.22 restored 12 features that
  new defaults had switched off, but the defaults had changed earlier too, on
  2026-09-06, and 14 more were still off: pause other tabs when you play one,
  the speed chip, skip-seconds buttons, A-B loop, clip capture, keyboard
  shortcuts, the quick switcher, queue auto-advance, the scroll miniplayer,
  chapters, transcript export, Live now, taste rank and the description
  digest. Existing installs get them all back; anything you turned off stays
  off. (The speed and quality chips stay hidden by their own display settings
  from 0.9.x, because YouTube's gear menu already has them; they can be shown
  from the dashboard.)

## [0.9.22] - 2026-09-24

- **Your features are back after updating.** 0.9.19 made a quieter set of
  features the default, meant for new installs. But anything you had never
  switched on yourself was only on because of the old default, so updating
  quietly turned off the sidebar hub, playlist folders and bulk tools, Forge,
  the volume control, pop-out, screenshot, the downloader, ambient mode, Fact
  check, Full stats and Ask AI. Existing installs now keep all of those on.
  Anything you switched off yourself stays off, and new installs still start
  with the quieter set.

## [0.9.21] - 2026-09-24

The watch guide shows what Unsynth can do, even the parts you switched off.

- **More tools.** Every watch-page feature you have turned off is listed at the
  bottom of the guide: its name, one line on what it does, and a Turn on button.
  Turning one on loads it right there in the tab you are on. No reload, no trip
  to settings. With a playlist or live chat under the guide, the list folds into
  one "+ 5 tools you can turn on" button so the queue keeps its place near the
  top; it opens into "+ Fact check" style buttons. Before, a switched-off feature left no
  trace, so on a light setup the guide was a runtime and a Stats row and nothing
  said the rest existed.
- **Now.** One line at the top of the guide follows the video while it plays:
  the chapter you are in, how long is left at your playback speed, and the clock
  time it ends. Live streams say Live. It hides during ads.
- **The guide is there even with every watch-page feature off**, so the list of
  what you can turn on is always one glance away.
- **Summarize only shows when it can work.** It fires Fact check's own button,
  so with Fact check off it used to sit in the Stats row as the one filled
  button and answer "Claim review is turned off" when pressed.

For developers:

- `npm run dev:watch` no longer reloads the extension when a file is only read.
  On Windows, fs.watch reports reads as changes, so a grep, a test browser
  loading the extension, or Chrome itself kept reloading Unsynth in your real
  browser and cutting it out of every open YouTube tab. It now reloads only when
  a file's contents change.
- `docs/design/audit-contrast.js` can run a reduced profile
  (`UNSYNTH_AUDIT_MODULES_OFF`, `UNSYNTH_AUDIT_PAGES`, `UNSYNTH_AUDIT_THEMES`),
  flags a run that measured nothing instead of printing "fails=0" for it, and
  writes partial runs to `contrast-partial.json` instead of over the full record.

## [0.9.20] - 2026-09-23

- **SponsorBlock strips on related videos show the right places.** When two
  segments overlapped (a sponsor read inside a self-promo, which is common),
  the overlap was drawn twice, the strip ran past 100%, and every later segment
  was shifted to the right. Overlaps are now clipped, so the strip tiles the
  video exactly.

## [0.9.19] - 2026-09-23

The watched filter says what it is doing, and you can still read what it dimmed.

- **The top bar shows up without the sub manager.** The watched chip, Pause
  and the playlist Select button live in a shared top-bar slot that only loaded
  when the sub manager was on. On a lighter setup (close to the Essentials
  preset) the watched filter dimmed videos with no control anywhere to change
  it. The slot now loads whenever any feature that uses it is on.

- **Dimmed videos stay readable.** Dim used to fade the whole tile to 30%,
  titles included (about 2:1). Now the thumbnail goes grey under a scrim while
  the title stays readable, the watched eye, checkbox and progress bar stay
  crisp, and hovering or focusing a tile brings it back to full.
- **Hidden videos are counted.** The top-bar chip shows how many the filter
  hid on this page ("Hide watched | 15"), the number grows as you scroll, and
  its menu can show them for this page only, dimmed.
- **Playlists and history tell the truth.** A saved "Hide watched" used to do
  nothing at all on a playlist while the chip claimed it was hiding. It dims
  there now, and the chip says "Dim watched".
- **Only videos get marked.** Playlists, courses and mixes were marked
  "watched" whenever their first video was, and a sponsored result could get
  the watched eye. Both are skipped now.
- **Quieter badges.** "New" is a plain pill instead of a glowing gradient, and
  the watched progress bar lost its glow. The playlist toolbar's "Watched"
  button is now "Select watched", because it selects rather than filters.
- **Sidebar menus in light theme.** In a channel group's menu and its Manage
  panel, the lighter buttons were near-white on near-white (1.08:1 and 1.16:1).
  Readable now in both themes.

## [0.9.18] - 2026-09-23

The guide moved beside the video, and everything it opens now opens inside it.

- **Beside the video, not under it.** At a normal two-column width the guide
  sits in the related column next to the player: runtime, the four doors (Stats,
  Fact check, Ask AI, Forge), every chapter by name and the links. Arriving on a
  video shows all of it without a scroll. It only falls back to sitting under
  the video in YouTube's own one-column layout.
- **One system.** The doors are the panel's tabs. Clicking one opens that section
  in place, inside the guide, and clicking it again closes it. The separate tab
  bar and the stack of cards in the column are gone. Pop-out still floats the
  open section and Dock puts it back.
- **Every YouTube view has an answer.** Theater gets a slim guide column beside
  the player (never over it; the picture gives up about 8%, mostly from the
  black side bars). With a playlist or live chat in the column the guide goes
  compact so the queue and chat stay near the top. Fullscreen and the
  mini-player hide it.
- **Live streams opened as `/@channel/live`** now get the guide, stats and the
  rest. YouTube serves the stream there without a `/watch` address, and about
  21 checks only knew `/watch`. An extension update also no longer reloads a
  background live tab, which made it start playing.
- **The guide shows its values, not counts of them.** Chapters are real named
  chips that seek, links show their host once, and a timestamp is spelled one
  way everywhere.
- **Fixes that were quietly wrong.** Block channel was disabled on every video
  (it read the avatar link, which has no text, as the channel name); watch
  history, AI and fact check had the same bug. The owner row said "9y ago" one
  line under YouTube's "8y ago" for the same upload. Switching tabs never told
  the old one it was hidden, so AI reopened itself on the next video.
  Fact-checking a comment read the video title after waiting for the
  transcript, so moving to another video meanwhile sent the AI the wrong title.
- **YouTube's compact tiles.** YouTube is testing a tile that says "10M" and
  "2h ago" instead of "10M views" and "2 hours ago". On those pages the catch-up
  digest recorded nothing from channel pages, search view filters hid nothing,
  the fresh-upload badge never showed, and Suggested rows lost their view
  counts. All four read both forms now.
- **Readable in light theme.** Ten thumbnail and panel overlays took the theme's
  text colour on a plate that is dark in both themes (1.1 to 2.4:1). Seven
  dashboard buttons were near-white on near-white (1.07:1) and the popup's
  Reload was white on coral (3.05:1). All fixed, with tests that fail if they
  come back.
- **Quieter everywhere else.** The YouTube sidebar rows use one set of line
  icons instead of emoji, and their empty states are one line instead of dashed
  boxes. The empty "Live now" shelf is one line with a still grey dot, not a
  pulsing red live dot over "nobody is live". SponsorBlock's no-data state is
  one quiet line. Fact check says what it will do before it runs.
- **The guide on a lighter setup.** With analytics, fact check, AI and Forge
  off (close to the Essentials preset), the Stats row could hide itself on a
  fresh page load, leaving an empty strip beside the video, and on a channel
  live URL there was no guide at all, and a background tab kept the guide
  empty until you switched to it. With no chapters or links the guide also drew
  a divider over nothing. All found in a real browser and fixed.
- **Calmer thumbnails.** The select checkbox in each thumbnail's top-left
  corner rests at 70% so the watched eye leads, and comes up to full on hover,
  keyboard focus and touch screens. It stays clickable at rest and its outline
  keeps 3:1 contrast on the brightest thumbnail. (Decided by the design panel.)
- **Screen readers.** Inside the guide the open section is announced as a
  labelled region, not a tab panel whose tabs are hidden.
- **Correction to 0.9.17.** Its notes called `UNSideDock` dead code. It is not:
  off the watch page AI and Forge are still separate drawers, and it keeps
  them side by side when both are open.

## [0.9.17] - 2026-09-21

The watch page says each thing once, and depth opens beside the video.

- **One side panel.** Stats, Fact check, AI and Forge open in a single tabbed
  panel docked in the related column — sticky under the masthead, so the video
  never moves while you read. The deck's Stats and Fact check headers and the
  masthead AI and Forge chips open it; Escape or the chip closes it; the chip
  stays lit while its tab is open. Off the watch page the same panel is a right
  drawer that starts below the masthead. Pop-out moves the live tab into a
  floating window and Dock puts it back — no more disabled clone.
- **The deck is a glance strip.** Runtime hero, `Stats · 5.1K dislikes · 99.1%
  liked ▸`, `Fact check · Not run ▸`, chapters and links. Compare, Expand and
  the meter left the deck for the Stats tab. 363px at 1440, 340 or under at
  1680.
- **One date, one place.** "Published Oct 5, 2017 · 9y ago" under the channel
  name, for every stats-position setting. The title chip and the stats-row copy
  are gone; the orphan line that the aboveChannel layout printed between two
  slots is gone with them.
- **Launchers in the masthead.** The fixed AI and Forge tabs — gradients, glow,
  painting over the Stats card's corner at 100% zoom — are plain masthead chips
  that survive YouTube rebuilding its masthead.
- **A ratio that cannot lie.** A tile printed "▲235K ▼844 100%". With any
  dislikes the label can no longer round to 100%; one shared formatter, every
  call site.
- **Stats card collapsed on install**, with a one-line summary; the Length cell
  (a duplicate of the strip's "Full length") and the empty eighth cell are gone.
- Smaller: popup footer spells out Queue/Pinned/Groups/Folders and wraps at
  11px; the popup's "audio not active" card is a plain line, not a blurred
  ghost; the AI panel says what will appear before the first answer; the stats
  page's empty state uses a drawn mark; organizer rail actions stop wrapping
  mid-word; Forge asks a never-connected account to Connect, not Reconnect.

## [0.9.16] - 2026-09-20

- Pin the runtime strip's recovery lifecycle. G5 — the strip going missing and staying
  missing, reported as "renders 0px, about 1 in 3 in dark theme" — was traced live and
  does not reproduce: across 10 real pre-rolls the strip returned on its own within 3-6s,
  and 24 themed loads produced no zero-height render. The fix had already landed in
  7f53f16 as a side effect of another pass, with nothing guarding it. Four assertions now
  pin the two re-entry paths that make recovery possible, each verified red under sabotage.

## [0.9.14] - 2026-09-20

- Move the publication date beneath the channel information.
- Give Explore this video a visible button surface.
- Replace ambiguous unchecked thumbnail labels with an on-demand SponsorBlock check, including retry and no-results feedback.

All notable changes to Unsynth are documented here.

## [0.9.9] - 2026-09-19

### Changed

- Explain the runtime strip with After skips, Full length and Skippable labels, a visible category key and exact ranges on hover or keyboard focus.
- Describe unmarked footage without implying it has been reviewed.
- Name the claim-review action Fact check, and show the publication date while audience details are collapsed when date display is enabled.

## [0.9.8] - 2026-09-19

### Changed

- Integrate the native creator and subscription row with the watch guide in one visual surface without moving or replacing YouTube controls.
- Separate runtime, audience and claim-review actions with a responsive two-column layout and a dedicated chapter/link area.
- Preserve native subscription labels and improve their contrast in both themes.

## [0.9.7] - 2026-09-19

### Changed

- Give under-video section controls readable labels, nearby disclosure arrows and visible button surfaces.
- Make claim review a distinct action in both themes and retain its label while expanded.
- Increase chapter and link text sizes without removing content to meet a height target.

## [0.9.1] - 2026-09-18

### Changed

**The area under the video stopped repeating YouTube back at you.** The stats
line read "561K likes · 5K dislikes · 99.1% liked · 24.4M views · Oct 5, 2017 ·
9y ago". Three of those six are printed by YouTube a hundred pixels higher: the
like count sits in its own button and the native line already says "24M views 8
years ago". It now reads "5K dislikes · 561K likes · 99.1% liked", leading with
the restored data that is the only reason the row exists. Views and date are
still available, just off by default.

**Four buttons that looked identical now have three weights.** Compare, Expand,
Claim review and Summarize all rendered at the same border, weight and size,
separated only by a 3% fill — and that fill was on the wrong pair, so Summarize,
the one action most people want, was the faintest thing in the row. Summarize is
now the single filled control, Compare is outlined, and Expand recedes to plain
text because it is a disclosure rather than an action.

**Claim review had two buttons and one job.** The copy in the stats row was a
mirror that clicked the real one further down, with nothing to tell them apart.
There is now one, next to where its results appear, and it says "Review claims"
so it names the action rather than repeating the section heading beside it.

**Two panels stopped being panels.** The description digest and the claim-review
block were each a bordered, rounded, filled card with a coloured edge, sitting
inside a strip that already separates its sections with a hairline. Two frames
around one group, and the inner one was louder. Both are gone; the text now
lines up with everything else in the column. The deck is 198px tall instead of
225px — smaller, with the same chapters and links still on screen.

### Fixed

**White text on a white background in the live shelf.** "0 streams" and
"Nobody you follow is live right now" were invisible on the light theme, along
with the subtitle on each live card. All three were hardcoded white with no
light-theme alternative. The empty state mattered most: it is the only thing on
screen when the shelf has nothing to show.

**The catch-up digest could stay empty forever on a channel page.** A video tile
whose age had not rendered yet was skipped on the assumption that the next scan
would pick it up. On a feed that holds, because new tiles keep arriving. On a
channel page nothing else happens, so the next scan was 150 seconds away or
never. Thirty videos could sit on screen with the digest showing none of them.

**A control was unreachable at 150% zoom.** The row of Unsynth buttons in
YouTube's top bar had no way to shrink or scroll, so at higher zoom it ran off
the right edge of the window and took a button with it. Two other controls were
too short to click reliably.

## [0.9.2] - 2026-09-19

### Fixed

**The exact upload date came back.** 0.9.1 turned off both the view count and
the publication date in the stats row, on the reasoning that YouTube already
shows them. That was right about views and wrong about the date: YouTube prints
a relative age ("8 years ago"), while this printed the actual date ("Oct 5,
2017"), which appears nowhere else on the page. Turning it off deleted
information rather than a repetition. Views stay off; the date is back on.

## [0.9.3] - 2026-09-19

### Fixed

**"Hide watched" no longer appears in the menu on History and playlist pages.**
It was listed there as a selectable option, but those pages already refuse to
hide anything — removing entries from a list you assembled looks like the list
lost videos. So picking it set a mode the page then overrode, and the chip came
back reading "Dim watched" instead. The option is now simply absent where it
cannot apply. Dimming still works there, which is where it is most useful, and
nothing changes on the home feed, subscriptions, search or a channel.

## [0.9.4] - 2026-09-19

### Security

**Signing out is now restricted to extension pages.** Disconnecting your
YouTube account is the one action in this extension that destroys credentials,
and it was reachable by any script running on a youtube.com page. Nothing
actually sent it from there, so no account was at risk in practice — but the
planned unified panel runs on YouTube pages, which would have turned a
theoretical hole into a live one. Sign out from the dashboard works exactly as
before.

## [0.9.5] - 2026-09-19

### Fixed

**An expired YouTube connection now says so everywhere, instead of only in the
dashboard.** The extension tracks three separate facts about your connection: a
token exists, it still works, and what it is allowed to do. The dashboard
checked all three. Playlist Forge, the playlist organizer and the stats page
checked only the first, so a token that had expired with no way to renew it —
or one Google had revoked — showed as connected in three places out of four
while every request failed. The Forge bridge even answered the website with a
success code. All four now read the same shared answer, and an expired
connection offers Reconnect rather than sending you through first-time setup.

**"Read-only" no longer reads as "not connected".** A connection without edit
permission is a working connection; the organizer was reporting it as a missing
one and the stats page told you to add a permission you already had.

## [0.9.6] - 2026-09-19

### Fixed

**A connection that could not be checked no longer reads as a disconnection.**
If the extension cannot reach its own background worker — a dropped message, a
sleeping worker, no network — that says nothing about whether your YouTube
credential is good. It now says it could not check, keeps showing what it last
knew, and offers no sign-in prompt. Being asked to reconnect a working account
because a message timed out is the specific thing this prevents.

**A failed check can no longer overwrite a good one, and a slow older check
cannot overwrite a newer result.** Both were possible before.

## [0.9.10] - 2026-09-19

### Fixed

**The Subscribe button was unreadable in dark theme.** It rendered as a blank
white pill with invisible white text. Confirmed in rendered captures, not only
in a contrast reading, and it happened whether or not the button was restyled.

**Subscribe looks like YouTube again.** It had been repainted in Unsynth's warm
accent, which made a YouTube control look like one of ours and put it in direct
competition with Fact check, the action the strip actually exists to offer.

**A time label inside a short skip segment no longer clips.** 0:36 needed 23
pixels in an 18 pixel box and rendered as a broken glyph that read as a
different number. Segments too small for a readable label now show colour and
position only; the duration is already stated in full above.

## [0.9.11] - 2026-09-19

### Fixed

**A contrast check was measuring the wrong element.** It read the colour of the
Subscribe button, which paints no text, instead of the span that actually shows
the word. That reported a readable label as unreadable. The threshold is
unchanged; the check now looks at the text and the surface behind it.

## [0.9.12] - 2026-09-19

### Fixed

**Reconnecting could silently lose the permission you just granted.** If a
token refresh was already running when you completed the YouTube consent
screen, the refresh finished afterwards and wrote back the older record —
discarding the new refresh token and any edit permission you had just given.
No error appeared. The window was up to fifteen seconds and it opened on
exactly the action people take when their connection already looks wrong.

**A dropped message no longer says your setup is missing.** The playlist
organizer turned a failed connection check into "YouTube setup needed" with a
Set up button, for accounts that were connected the whole time. It now says it
could not check, shows what it last knew, and offers Retry.

**The fact-check section shows its progress and failures again.** It was
watching for class names that nothing set, so a run in flight and a run that
failed both collapsed back to the plain button with no explanation.

## [0.9.13] - 2026-09-19

### Fixed

**Reconnecting could still lose the permission you just granted.** The previous
fix only protected you when Google issued a different refresh token. Google
reuses the same one on every re-consent after the first, so the common case was
still unprotected. Ordering is now tracked directly instead of inferred from
whether a value changed.

**A "Retry" button that opened the Google consent screen.** When a connection
check failed, the organizer offered Retry, but pressing it started sign-in —
the exact thing that state exists to avoid. It now simply checks again.

## [0.9.15] - 2026-09-20

### Fixed

**Add to queue works from search, channel and home pages.** It used to say
the queue only builds on a watch page and throw away the list you had just
built. YouTube genuinely cannot write its queue from those pages — verified,
the add silently does nothing there — so instead of failing, Unsynth now
keeps your list, opens the first video, and queues the rest once it arrives.
That is what YouTube's own "play this and queue the rest" does.

Nothing is stored until you press the button, and a plan you abandon expires
after ten minutes rather than surprising a later video.

## [Unreleased]

### Fixed

**Restored like and dislike counts read as part of YouTube again.** The row
under each thumbnail sat on a faint panel of its own, a couple of shades off the
card behind it, which is enough to read as something bolted on rather than as
the video's own numbers. It also printed a second view count directly under
YouTube's, from a different source and often a different number, with nothing to
say which was which. And it carried a small bar showing the like ratio next to
the exact percentage, so the same fact appeared as an arrow, a colour, a bar, a
number and a count in one 12-pixel line. The panel and the bar are gone, the
duplicate count only appears when YouTube is not already showing one, and the
row now uses the same weight as the text above it.

**The volume bar was invisible on the light theme.** When it appears under the
video rather than over it, which happens while the player is still loading, its
text was near-white on a near-white page, measured at 1.05 to 1 where 4.5 is the
floor for readable text. The preset buttons were worse: the active one was pale
pink on white, and hovering any of them turned the label pure white. Every value
in that bar now has a colour for each theme. The version that floats over the
video is unchanged, since it sits on its own dark panel.

**The masthead row now shows where the filters end and Pause begins.** Pause
suspends every filter beside it, so it is meant to sit past a divider. The
divider was drawn as a border on the button itself, and a rule meant for buttons
that touch each other was deleting that border unpredictably: Select had a left
edge, Download had none, and the Pause divider was identical to an ordinary
button border. The separator is now its own mark, and the three buttons are
consistent pills.

**Animations stop when your system asks them to.** Six parts of the extension
animated regardless of the "reduce motion" setting, including three that never
stopped: the loading spinner, the shimmer on placeholder rows, and the live dot
beside a channel name. They hold still now while keeping what they were
communicating. The spinner keeps its ring, the placeholders keep their fill, and
the live dot stays lit.

**The watch deck was close to unreadable in light theme.** The stats row showed
the like ratio, the view count and the upload date as blank space, and the
section headers, buttons and fact-check panel were all washed out. Eighteen
elements failed the contrast floor, the worst of them white text on the deck's
near-white background. The colours were written against the dark page the deck
was built on, and several of them came from YouTube variables that do not
resolve inside an extension, so their dark defaults applied in both themes. The
whole deck now takes its text colours from tokens that have a value for each
theme, and a test measures every row in both.


**A large move could delete a video that never arrived.** A move is an add
followed by a delete, and above ten videos it runs through the background worker
rather than a single message. That path resolved which rows to delete before the
adds were attempted, so it could not tell which videos had actually landed — it
deleted every original as long as at least one destination had taken something.
A video whose add failed was removed from the source anyway and existed in
neither playlist, while the toast reported a clean move. The worker now pairs
each original with its add result and removes only the ones that arrived; the
rest stay put and the toast names them: "Moved 11 to 1 playlist — kept 1 here
(add failed)". The smaller one-shot path always did this correctly, so this only
ever affected moves big enough to be hard to check by eye.

The page and the worker now agree on which row belongs to which video by sending
them as explicit pairs. They used to be two separate lists lined up by position,
which held until a video had no row id to send — then everything after it shifted
by one and the wrong originals were kept or removed.


**The runtime readout is legible while you are hovering the tile.** The
"unchecked" / "12:04 real" chip shared the thumbnail top-right corner with the
hover action bar. At rest the bar is invisible and the chip read correctly, so
the collision only existed in the state you are in right when you go to click
something: a tile reading "99% unchecked" showed a bare "9" with the rest
underneath the bar. The readout moves to the bottom-left corner, which is the
only one not already spoken for, and the action bar keeps its position because
every alternative for an interactive control was measured and collided. The chip
also ellipsises now instead of being cut mid-word by the thumbnail box.

**One "+Q" button per row, not two.** They were a front-insert / append pair
until the native queue turned out not to accept front-insert from an extension.
Both then called the same function with the same argument and differed only in
their tooltip, so one of them was removed. This also settles an ambiguous
selector in the test suite, where clicking "Add to queue" matched two elements on
a single thumbnail.

## [0.9.0] - 2026-09-15

Per-channel completion, the playlist debt line, organizer time budgets, and the
Up next rail. Also removes "Play next", which YouTube never permitted, and takes
the e2e suite from ten standing failures to zero.

Developed on a branch that numbered itself 1.7.0-1.10.0 before merging; those
sections are folded in below and this ships as 0.9.0 to continue the released
line.


### From 1.10.0 - 2026-09-15

### What a playlist is made of, and what fits tonight

The debt line now carries the channel mix, and the header answers the question a
backlog actually raises.

**Channel mix.** A long playlist reads as undifferentiated; whether it is forty
creators or secretly three is what decides keep, split or prune. Three shapes,
because the interesting fact differs: "all from Kurzgesagt", "mostly Kurzgesagt
(62%) and 3 others", or "24 channels, none over 20%". That last one matters —
reporting only the top channel would make a genuinely diverse playlist look
identical to a single-channel archive.

**"I have [90] minutes."** A number input in the header, answering in playlist
order. Two refusals hold it up:
- It never packs a video whose duration is unknown, and says how many it had to
  leave out. A fit built on a guessed length is not a fit.
- It does not reorder to squeeze in more minutes. A greedy pack would claim a
  better answer about a different playlist from the one on screen.

### Undo for destructive bulk actions

A bulk remove now offers "Put N videos back" for 30 seconds instead of asking
for confirmation first. A confirm costs a decision on the 99 runs that were
correct to protect the 1 that was not, and trains people to click through it.

It says "put back", never "undo": a removed item's id dies with it and YouTube
mints a new one on re-add, so the videos return at the END of the playlist. The
offer text says so rather than implying the playlist returns to its prior state.
Undoing a *move* reverses both halves — re-adding alone would leave the video in
both playlists.

**Not verified end to end.** The full round trip needs YouTube write auth, which
the test harness does not have. The undo logic has unit coverage (10 tests,
including the move-reversal and expiry cases) and the wiring is checked live, but
no automated run has actually removed and restored a real video.

### Fixed

- The minutes input used `--un-input-bg`, a dark surface token, which put its
  text at 2.82:1 on a light page — under the 4.5:1 floor, on a control whose
  whole job is to show a number. Now 6.29:1 light and 8.25:1 dark, matching the
  line it belongs to, with a live contrast gate so it cannot regress.
- Channel keys with no display name leaked their storage prefix ("@google") into
  a sentence meant for people. Stripped now — and the name-upgrade path that
  replaces a key with a real name when a later row supplies one was silently
  broken by that change, caught by a regression test.

### From 1.9.0 - 2026-09-15

### The playlist debt line

Under a playlist title: "418 videos · at least 62h 14m · 390 unfinished · you
finish 31% of what you start here".

This is the one surface where the saved-vs-finished number is honest. Per-channel
completion refuses to report it, because it computes from watch history where
saved equals played by construction — you cannot play what you never saved, so
the ratio is 1 and the claim is meaningless. Playlist membership is what you
SAVED, independent of what you played, so `fromPlaylist: true` is true here and
only here.

- The time figure is prefixed "at least" until every id has a cached duration.
  A sum over part of the list is a floor, and presenting a floor as the total
  makes every "can I clear this" answer wrong in the user's favour.
- With an empty duration cache it claims no hours at all rather than inventing
  them. Pinned by a live test.
- No completion rate below three started videos.
- Off by default and toggleable in the popup and dashboard, like every module.

### Fixed

- `playlistPageMeta()` returned the first matching header block. Measured live:
  a playlist page carries six, and most are hidden template instances at a zero
  rect — so the line would have mounted somewhere nobody could see while passing
  every existence assertion. It now returns a block that is actually visible.

### From 1.8.0 - 2026-09-15

### Playlist columns say how long, not just how many

An open column header now reads "312 videos · at least 41h 8m · 296 unfinished"
instead of "312 videos".

A count cannot tell you whether you can clear a playlist. Ten minutes of Shorts
and a 40-hour lecture series are both a number. Every playlist tool shows the
count because the count is what the API returns — `playlistItems.list` carries
no duration at all, which is why nobody shows hours.

- Durations come from `videos.list`: 50 ids per call at 1 quota unit, so a
  2,445-video playlist costs 49 units, about 0.5% of a day. They never change, so
  the cache is permanent and the second open of a playlist costs nothing.
- **"at least" is not filler.** The cache may hold 40 ids of 312, and a sum over
  those 40 is a floor, not the playlist's length. The hedge stays until every id
  has a duration, then disappears. Presenting a partial sum as the total would
  make every "can I finish this tonight" answer wrong in the user's favour.
- The unfinished count includes videos whose duration is unknown — how many are
  left is answerable without knowing how long they are — while the time figure
  never claims seconds it does not have.
- Durations load after the column renders, so videos appear immediately and the
  budget fills in. A failed fetch leaves the count alone rather than showing a
  wrong total.

### From 1.7.2 - 2026-09-15

### The Up next rail annotated 4 rows and then stopped, forever

Not a fetch failure and not a rate limit. `observeRail()` ran only from the
navigation handler, so the IntersectionObserver was handed the tiles that existed
at that instant and nothing after. YouTube appends sidebar tiles lazily as you
scroll, and every one of those was invisible to the rail.

Measured live on the same page, same scroll: annotations were stuck at 4 through
5,400px while the tile count went 20 to 40. After the fix the same walk reaches
32, and keeps climbing as tiles arrive.

- `observeRail()` now also runs from the module's `scan()` hook, which is how
  `dearrow.js` and `dislike-restore.js` have always handled the same problem.
  This module had a `scan()` and simply never called it.
- A MutationObserver on the rail picks up tiles added between scans, coalesced on
  a 250ms timer so a burst of insertions costs one sweep rather than hundreds.
- A new e2e asserts the count GROWS as tiles appear. Not an absolute number: how
  many rows SponsorBlock has data for depends on the community database that day,
  and pinning a figure would make the gate a flake.

Rails outnumber chips by design — a video that has been reviewed and is clean
gets a rail and no chip, because a chip saying "no news" is one more thing to
read past.

### From 1.7.1 - 2026-09-15

### "Play next" is gone, because YouTube never allowed it

The button appended and said otherwise. `toFront` was threaded correctly through
three layers and then read nowhere in the page-world handler, so `▶+` and `+Q`
ran the identical command and differed only in their label.

Measured live: a native queue row's action menu contains exactly "Remove from
playlist" and "Share". There is no front-insert and no reorder control, and the
command the bridge uses is append-only by construction. This is a platform limit,
not a missing feature, so the honest fix was to stop claiming it.

- `▶+` removed from the Forge search panel thumbnails and from playlist rows.
  One `+Q` that does what it says.
- The playlist row menu offered "Play next" and "Add to queue" as separate items
  running the same code. Now one item.
- Status and toast text says where the video actually lands: the end of Up next.
- `UNNativeQueue.playNext()` kept as an alias so nothing breaks, but it no
  longer pretends to front-insert.
- A live gate now pins the platform limit. If YouTube ever adds a front-insert
  menu item, that test fails — which is the signal to build the feature properly.

The queue-bar "Play next", which pops the extension's own queue and navigates to
that video, is untouched. It always worked.

### Fixed

- `test/native-queue.test.js` asserted that `playNext()` forwards
  `toFront:true`, and passed for the life of the bug. It tested the sending,
  which worked, and nothing about the receiving, which did not exist. It now
  encodes the platform limit instead.
- The rail height e2e compared two layout reads and blamed the chip for any row
  that resized in between. It now takes a third read to prove the row held still,
  and discards rows that moved rather than reporting a false failure.

### From 1.7.0 - 2026-09-14

### Per-channel completion, on the channel page

"21% of what you start here, you finish", under the handle on a channel page.

Google Takeout history carries no duration and no completion, so every history
tool on the market is structurally blind to whether you actually liked anything:
a four-second bail and a finished 40-minute deep dive look identical in the
export. Unsynth already records progress per video, so it can say something none
of them can. A thumbnail can fake a click. It cannot fake a finish.

- **It works without importing anything.** The obvious data source was
  watchStats.channelVideos, and that was a trap: it is built only by the
  dashboard Takeout importer, verified empty on a fresh live profile. So the
  video-to-channel link is now recorded as you watch, on both the partial and
  the full-watch path. A video watched to 30% and abandoned is exactly the case
  completion is about, and hooking only the full-watch threshold would have
  counted the finishes and missed every abandonment, inverting the number.
- **It refuses to say anything below three started videos.** A confident "0%"
  from one abandoned video is worse than silence, and two of the four live tests
  assert that nothing renders at all.
- **It never shows a saved-vs-finished count here.** That needs playlist
  membership; from watch history saved equals played by construction, so the
  ratio would be 1 and the claim a lie. It stays behind the playlist path.
- Off by default, and toggleable in the popup and dashboard like every other
  module. A new profile would otherwise see an enabled feature that shows
  nothing until history accumulates, which reads as broken.
- The channel link map is pruned on every save: a video in neither watchProgress
  nor watchedVideos can no longer affect any number, so its link is dropped
  rather than kept forever.

### Fixed

- The channel header selectors matched nothing on current YouTube. The markup
  moved from kebab-case `page-header-view-model-wiz__` names to camelCase
  `ytPageHeaderViewModel` ones, so the feature mounted nowhere and failed
  silently rather than erroring. Both generations are now covered in yt-dom.


## [0.8.0] - 2026-08-04

### Fixed

- **An imported history no longer loses almost all of its channels.** The ranked
  channel list was capped at 30. Measured against a real Takeout import of
  15,805 distinct channels, that discarded 15,775 of them and left the "Top
  channels" section representing just 16.5% of actual plays. The cap is now
  1,000 and lives in one place — the import used to apply its own hard-coded 30
  at parse time, before the shared code ever saw the data.

### Added

- **Top channels is now filterable and paged.** A search box and "Show more"
  replace the single expand-everything toggle, which would have rendered a
  thousand rows at once. A running "showing N of M" line means the count is
  legible whether or not a filter is applied.
- **A storage diagnostics page** at `src/dashboard/diagnostics.html`. Read-only
  summary of what the extension has stored — play totals, date ranges, retained
  vs discarded channel counts, histogram coverage, and whether the drift signal
  the hidden-gems shelf depends on is populated. It exists because there was
  previously no way to check what an import actually produced, so problems were
  diagnosed by inferring from badges rendered on a page — which is guesswork,
  and produced at least one wrong conclusion. Credentials are reported as
  present/absent only; no token or key value is ever read or displayed, and the
  smoke check asserts that guard.

## [0.7.3] - 2026-08-03

### Fixed

- **Move to…** now actually moves. The video was added to the destination but
  left in the source playlist, while the toast still said "Moved N" and the row
  disappeared from view — so it looked like it had worked until a reload.

  Three faults compounded. The videoId → playlistItem map was cached, but a
  playlistItem id belongs to a *row*, not a video, so any id captured before an
  earlier move in the same session was already dead and its delete returned 404.
  The service worker then reported `ok: true` even when every delete had failed,
  so the caller saw success. And the client hid every selected row regardless of
  what was actually deleted. The map is now refetched before any delete, a
  wholesale failure is reported as a failure, and only rows the API confirms
  gone are cleared.

- **A move can no longer lose videos.** Adding to the destination and removing
  from the source were independent: if the add failed, or partly failed, the
  originals were deleted anyway and the videos were gone from both playlists.
  A video is now only removed from the source once it is confirmed present in at
  least one destination; anything that didn't land stays put and is reported.

- **Remove** reports honestly too — partial failures no longer hide rows for
  videos that are still in the playlist.

## [0.7.2] - 2026-08-03

### Fixed

- A subscription group no longer hides videos inside your playlists. Playlist
  pages were treated as a filterable feed, so with a group selected every video
  whose channel wasn't in that group was hidden — on a mixed-channel playlist
  that meant nearly all of them (47 of 47 in the reported case). The rows were
  in the page the whole time, hidden by CSS; opening a video appeared to fix it
  only because navigating drops the filter class before the next page re-applies
  it. Subscription groups now apply to the subscriptions and history feeds only,
  which is what they describe. A playlist is a list you curated by hand — which
  group its channels belong to has no bearing on whether its videos should show.

## [0.7.1] - 2026-08-03

### Fixed

- Updating the extension no longer starts playing every YouTube video you had
  open. Reloading a `/watch` tab makes YouTube autoplay it, and the update
  reloaded *every* YouTube tab — so a set of videos saved for later would all
  begin playing at once, in background tabs. Background video tabs are now left
  alone and shown the existing "reload to resume" banner instead; only the tab
  you are actually looking at reloads, feed and library tabs reload as before,
  and tabs Chrome has discarded are left asleep rather than woken.
- Playlists no longer disappear from your Library when a folder filter is
  active. Each tile was stamped after its first pass and then permanently
  skipped, so a playlist hidden under one folder stayed hidden after switching
  folders or clearing the filter — until you opened a video, which made YouTube
  rebuild the list. Filtering is now re-evaluated on every pass.
- `scripts/set-ai-key.ps1` runs on Windows PowerShell 5.1 (the Start-menu
  default) as well as PowerShell 7. It previously required 7.0 and used two
  PS7-only constructor calls — one of which was what wrote the file without a
  BOM, so the failure would otherwise have produced an `ai-local.json` the
  service worker could not parse.

## [0.7.0] - 2026-08-01

### Added

- **Hidden gems shelf** — an opt-in row above the YouTube home feed that surfaces
  what the home feed buries. Four signals decide what qualifies: few views for a
  video's age, channels well below the subscriber counts you normally watch,
  subscriptions you stopped watching, and videos you saved and never returned to.
  Each card says *why* it is there rather than being another opaque ranker.

  Three tiers, each degrading to the one below instead of failing:
  local signals need no account; the YouTube Data API adds recent uploads from
  drifted subscriptions and your pinned playlists; an optional pass with your own
  AI key re-ranks and writes the one-line reason.

  Quota-conscious by construction: candidates come from uploads playlists at
  1 unit per call, never `search.list` at 100, so a full refresh costs about 15
  of the 10,000 daily units. Results cache for six hours, and **Shuffle** re-rolls
  the cached pool with no network call at all.

  Off by default — enable **Hidden gems shelf** on the dashboard Modules tab, then
  reload your YouTube tabs.

### Fixed

- A module declared with `popup: true` / `dashboard: true` could reach
  `defaults.js` and the injection table while never appearing in either UI: the
  generated lists were filtered by a hand-maintained order array, so any key
  missing from it was silently dropped. Membership now comes from the module
  registry, the order array only orders, and the smoke check asserts the two
  directions agree.

## [0.6.10] - 2026-07-31

### Fixed

- Blocking a channel no longer fails silently. The block and allow lists live in
  `chrome.storage.sync`, which caps one item at 8 KB; past that the write was
  rejected and dropped while the button still said "Blocked". Every write now
  checks for failure and says what went wrong.
- The update ZIP is verified against the published SHA-256 **before** it is
  saved. A mismatch aborts the download instead of leaving a tampered archive in
  Downloads looking exactly like a good one; when no checksum is published, or
  verification is unavailable, the dashboard says the file was not verified.
- Expired API cache entries are deleted instead of merely being ignored on read,
  so `storage.local` no longer grows without bound.
- Turning a feature off in the popup no longer removes its own row, which left
  no way to turn it back on without opening the dashboard.
- The bundled PocketTube seeds are not part of the release ZIP, so a sideloaded
  install re-requested two missing files on every browser start. The miss is now
  remembered per version.
- The OAuth code-for-token exchange has the same 15s timeout as the refresh
  call, so an unresponsive endpoint no longer hangs the Connect button forever.

### Changed

- CI runs on Node 22. `npm test` uses a glob that needs Node >= 21, so every run
  on the previous Node 20 pin failed before executing a single test.
- Resolved a high-severity `brace-expansion` advisory (via `archiver`) and moved
  to `@playwright/test` 1.62.1.

## [0.6.9] - 2026-07-15

### Fixed

- Made generated injection metadata deterministic so packaging and production deployments no longer leave the tracked build output dirty solely because a timestamp changed.

## [0.6.8] - 2026-07-15

### Added

- Public deployed update manifest with version and SHA-256 metadata.
- Dashboard **Fetch latest ZIP** action for updating unpacked installs on macOS and Windows.
- Atlas/Chromium browser capability diagnostics and an Atlas executable test runner.
- Browser-level navigation, lifecycle, performance, and MV3 compatibility coverage.

### Changed

- Modules and styles are loaded lazily to reduce YouTube startup and mutation-scan work.
- Update checks prefer the public deployed release and fall back to private GitHub with a locally stored PAT.
- Playlist folders and bulk playlist tools now have separate module ownership and migration handling.
- Forge synchronization requires explicit consent and validates shared data.

### Fixed

- Extension-origin validation no longer assumes a `chrome-extension://` scheme.
- Repeated YouTube SPA navigation no longer duplicates module instances, observers, or sidebar surfaces.
- Storage imports, caches, requests, downloads, and diagnostics are bounded and validated.
- Atlas documentation no longer relies on an undocumented `atlas://extensions` URL.

### Update notes

- Unpacked extensions cannot replace their own files. On another machine, use `npm run update`, or fetch the ZIP from Dashboard → Account → Updates, replace the existing folder contents at the same path, reload Unsynth, then reload YouTube tabs.
- ChatGPT Atlas is scheduled to stop working on August 9, 2026; Chrome remains the supported migration target.
