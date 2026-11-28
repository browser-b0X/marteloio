# Changelog

What changed in each version of Marteloio, newest first. Your version is in Settings › About.

## 0.4.0 — 2026-11-27

Marteloio now needs one key, your free AI key, and asks eBay for nothing.

### Removed

- **Look up and Find keywords.** They needed an eBay developer account, an application keyset
  and an opt-out from eBay's account-deletion notices before the first search. The reference
  panel, the "Keywords from other sellers" list and each bundle card's Lookup details went
  with them.
- **Settings › eBay.** eBay keys saved by an older version are deleted the first time 0.4.0
  starts. Your AI keys are not touched, and a key file Marteloio can't read is left as it is.
- References and keyword chips saved inside older drafts. Such a draft opens with your notes,
  barcode and listing unchanged, and a note says so the first time.

### Added

- **Search eBay.** A link beside the product name, and on each bundle card, opens eBay's own
  search in your browser for the name, or for the barcode when one is set. Nothing is filled
  in and no keys are needed.

### Changed

- **The welcome puts the key first.** The three setup steps are now a progress bar under the
  title, the paste box leads the first step at a larger size, and the four steps to a free
  Google key sit side by side. Once a key works, those four steps make way for the result.
  Text in the welcome is larger (16px). Phones keep the full-screen sheet.
- A barcode that isn't valid is marked at its field as you type, and the line under the
  product name says it won't be searched.
- The AI is no longer sent keyword suggestions or references: only what you typed.
- **Listings keep their look on eBay.** Every style is now written on its own element instead
  of in one style block with class names. eBay's Standard editor, quick listing form and app
  can drop style blocks and class names, which left a pasted listing as plain text. On a
  computer the listing looks exactly as before; on a phone the title and spacing are a little
  larger, because a style on an element can't change with the screen width.

## 0.3.0 — 2026-11-18

eBay is now used for one thing only: looking up other sellers' listings. Marteloio no longer
signs in to your eBay account.

### Removed

- **Connect eBay and Get my feedback numbers.** Settings › eBay no longer has the RuName box,
  Connect eBay, Finish connecting or Get my feedback numbers. eBay now limits how apps may
  read user data such as usernames, and Marteloio doesn't need your account to write a
  listing. Type your feedback score, positive % and member-since year in Settings › Your
  shop; what you already entered there is kept.
- The feedback star colour beside the feedback score in the seller header. It only came from
  the eBay account connection.

### Changed

- **Look up** and **Find keywords** work as before with your eBay Client ID and Client Secret.
- Search results keep only each listing's title, link and listing number. The seller's
  feedback numbers that eBay sends along are no longer copied.
- Settings › eBay says that Marteloio never signs in to your eBay account.

### Security

- The first time this version starts, it deletes any eBay account sign-in saved by an older
  version: from the encrypted store on Windows, or from `.ebay_token.json` elsewhere. Your
  Client ID, Client Secret and AI keys are kept. The RuName saved in the browser is removed too.
- You can also remove Marteloio's access on eBay's side: in your eBay account settings, open
  the list of apps with access and remove your developer application.

## 0.2.0 — 2026-10-13

This version is about getting started without help: a Windows installer, a guided first run,
messages in plain words and one box for every AI key.

### Added

- **Windows installer.** Marteloio-Setup.exe (about 12 MB) brings its own Python, so there is
  nothing else to install. It installs for your Windows account only, without administrator
  rights, adds **Marteloio** and **Stop Marteloio** to the Start menu and a desktop shortcut,
  and opens Marteloio when it finishes. Running a newer Setup updates Marteloio and keeps your
  keys. Uninstalling asks whether to keep your saved keys and settings.
- **Welcome setup** on the first run: connect a free AI service, add your shop details
  (optional), then take a quick tour.
- **A one-minute tour** of the real screen in six stops, from Start here to Copy into eBay.
- **Get set up guide**: four steps in the right-hand pane that tick themselves off and hide
  after your first copied listing.
- **Tips**: an (i) beside each field, a tip on the main buttons and a Start here marker on the
  product name.
- **Help menu (?)**: Show the setup again, Take the tour, the user guide and Report a problem.
- **One box for AI keys.** Paste a key from Google Gemini, Groq, OpenRouter or FreeLLMAPI and
  Marteloio recognises the service, saves the key and tests it.
- **FreeLLMAPI support.** Marteloio finds FreeLLMAPI when it runs on your computer, explains
  how to copy its key, and tries it first once it is set up.
- **Use switch, Test again and Remove** for each AI service in Settings › AI.
- **Settings › About** with the version, the build, your data folder and **Quit Marteloio**.
- A warning before you copy or download a listing that contains a web address or an email,
  because eBay doesn't allow contact details in listings.

### Changed

- **Messages fade on their own** and say what happened and what to do next, without technical
  words. Done fades after 4 seconds, Notice after 8 and Problem after 10 to 20; pointing at a
  message pauses it. A step that failed keeps a one-line note until it's fixed, often with the
  button that fixes it.
- **Settings has four tabs**: AI, Your shop, eBay (optional) and About.
- The AI button in the header says **Set up AI**, **AI ready**, **AI busy** or **AI offline**
  and opens the right place.
- **Look up** and **Find keywords** are marked Optional, with a tip saying they need free eBay
  developer keys.
- AI services are tried in the order FreeLLMAPI, Google Gemini, Groq, OpenRouter. One listing
  may keep trying for up to 160 seconds (was 90), so a slow FreeLLMAPI has time to answer.
- The installed version keeps keys, settings and the log in `%LOCALAPPDATA%\Marteloio`, so
  updates never touch them. ZIP and source copies keep them in their own folder, as before.
- Bundle auto-fill makes one item per line or bullet; the box is now called "Make a bundle
  item from each line or bullet of the description".
- In What's included, a comma adds an item too.
- Shortcuts made by `create-shortcuts.bat` open a normal window, so a startup problem stays
  on screen.

### Fixed

35 problems found in a review of version 0.1.

Listings and drafts:

- Bundle items lost their condition and brand when a card was added or deleted.
- Choosing Generate listing again threw away your edits. The edited version is now kept in
  Recent drafts, with Undo.
- A condition changed while the AI was writing was ignored.
- Condition notes applied in Edit content were lost when you changed the Condition.
- Using a suggested template brought back the old item's notes and condition.
- A restored draft file was always locked as Manually edited.
- Restoring a draft whose HTML was cleared could show and copy another listing.
- Ticking Conditions vary across items didn't update the listing.
- Recent drafts filled up with copies of the same listing.
- The seller header could say "Member for 0 years", "1 years" or "99.6%%".
- Text typed in What's included without pressing Enter was lost, and a whole line became one
  item.
- Bundle auto-fill invented items from sentences, and deleted items came back.
- Web addresses and emails written by the AI could reach your listing.

Screen and keyboard:

- The Generate bar could hide the field you were typing in.
- On a phone, the new listing was off screen after generating.
- Barcode problems were hidden when More options was folded.
- Keyboard focus got lost after Restore, Delete template or closing a message.
- Copy HTML could stay stuck on "Copied!" after a double-click.
- Restart advice told Mac and Linux users to run a Windows file.

AI services:

- A wrong Google Gemini key was reported as "shorten your notes".
- An answer cut off halfway was accepted instead of trying the next service.
- A dropped connection stopped Marteloio from trying the next service.
- OpenRouter could switch to a paid model.
- One retry could run past the time limit.
- Notes over 40,000 characters gave a confusing error that blamed your keys.

eBay:

- Wrong eBay keys were reported as "temporarily unavailable".
- An ended eBay listing gave a general error instead of saying it's gone.
- A damaged `.ebay_token.json` could make all saved keys unreadable.

Starting and stopping:

- Marteloio wouldn't open when its saved keys couldn't be read, for example after moving to
  another PC. It now opens and asks you to paste your keys again.
- Quotes or an odd line in `.env` could stop Marteloio from starting or break a key.
- On Windows, two copies could share port 8080 and cause "Session expired" errors.
- Shortcuts opened the start window minimized, so error messages stayed hidden.
- When the browser didn't open, the message with the address vanished at once.
- Running `start-all.bat` from inside the ZIP failed with an unclear error; it now says to
  extract the ZIP first.
- With `PORT=80`, every request was refused.

## 0.1.0 — 2026-10-04

The first public release.

- Drafts an eBay title, description, item specifics and highlights from your notes, in
  self-contained HTML layouts with a plain-text mobile summary.
- Single items and bundles, with item cards filled in from the description.
- Condition rules that never upgrade what you wrote: Untested stays untested and For parts is
  never upgraded.
- Look up other sellers' eBay listings by name or barcode and accept one as a labelled
  reference; Find keywords.
- Templates, Regenerate for one section, autosave, Recent drafts and draft backups.
- Free AI keys for Google Gemini, Groq and OpenRouter with automatic fallback; keys encrypted
  for your Windows account.
- Runs from the ZIP or the source with Python 3.10 or newer (`start-all.bat`, `start-all.sh`),
  with optional Start menu and desktop shortcuts.
