# Marteloio user guide

This guide covers everything past the [README](../README.md): installing, the first run,
connecting AI, how each part of the app behaves, where your data lives, and what to do when
something goes wrong. Menu paths are written like Settings › AI, and button names are shown
as they appear in the app.

- [Installing on Windows](#installing-on-windows)
- [The first run](#the-first-run)
- [Connecting AI](#connecting-ai)
- [Messages](#messages)
- [Settings](#settings)
- [Describing an item](#describing-an-item)
- [Bundles and lots](#bundles-and-lots)
- [References and keyword suggestions](#references-and-keyword-suggestions)
- [Reviewing and editing the listing](#reviewing-and-editing-the-listing)
- [Templates and fewer AI requests](#templates-and-fewer-ai-requests)
- [Drafts, history and backups](#drafts-history-and-backups)
- [Where your data lives](#where-your-data-lives)
- [Keys and credential storage](#keys-and-credential-storage)
- [Connecting eBay](#connecting-ebay)
- [How AI services are chosen](#how-ai-services-are-chosen)
- [Moving from the ZIP version](#moving-from-the-zip-version)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

## Installing on Windows

Marteloio-Setup.exe is free, about 12 MB, and works on 64-bit Windows 10 and 11. It brings its
own Python, so there is nothing else to install. Get it only from the
[latest release](https://github.com/browser-b0X/marteloio/releases/latest) or the
[website](https://browser-b0x.github.io/marteloio/).

1. Download **Marteloio-Setup.exe**. Your browser may say the file isn't commonly downloaded.
   Keep it: in Edge choose **…** › **Keep** › **Show more** › **Keep anyway**. Other browsers
   have a similar **Keep** choice in their download list.
2. Open the file. If Windows shows **"Windows protected your PC"**, choose **More info**, then
   **Run anyway**. The warning appears because the installer isn't code-signed yet; the plan
   is to apply to the [SignPath Foundation](https://signpath.org/), which signs open-source
   projects for free. To check the file first, see
   [Checking the installer](../SECURITY.md#checking-the-installer).
3. Setup has one page, **Install Marteloio**. Tick or untick **Add a Marteloio shortcut to the
   desktop**, then choose **Install**. There is no administrator prompt: Marteloio is installed
   for your Windows account only.
4. On the last page, **Open Marteloio now** is ticked. Choose **Finish** and Marteloio opens in
   your browser at `http://localhost:8080` with the [welcome setup](#welcome-setup).

Setup puts the program in `%LOCALAPPDATA%\Programs\Marteloio` and keeps your keys, settings and
log in `%LOCALAPPDATA%\Marteloio`, outside the program folder, so updates never touch them. It
adds a **Marteloio** folder to the Start menu with **Marteloio** and **Stop Marteloio**, and the
desktop shortcut if you kept it.

**Opening and stopping.** Open Marteloio from the Start menu or the desktop. It runs in the
background without a window and opens your browser; if it is already running, it just opens
the browser. Closing the browser tab doesn't stop it. To stop it, use Start menu ›
**Stop Marteloio** or Settings › About › **Quit Marteloio**.

On macOS, Linux, or to run the code yourself, see
[Mac, Linux or running from source](../README.md#mac-linux-or-running-from-source).

## The first run

### Welcome setup

The first time Marteloio opens without an AI service, it shows **Welcome to Marteloio**: three
short steps, listed on the left.

1. **Connect AI.** Paste a key into the box, or choose **Paste**. Marteloio works out which
   service the key belongs to, saves it and tests it, then says for example "Google Gemini is
   connected · it answered in 1.2 seconds". No key yet? Follow **No key yet? Get a free Google
   key in about 2 minutes**: choose **Open Google AI Studio**, sign in with your Google account,
   choose **Create API key** (or copy the key that's already listed) and paste it. When
   FreeLLMAPI is running on your PC, a card says so; see [FreeLLMAPI](#freellmapi).
2. **Your shop** (optional). Store or seller name, Member since and Positive % go in the seller
   header at the top of each listing. Change them any time in Settings › Your shop, or choose
   **Skip this step** (nothing you typed is saved). **Continue** saves only valid values.
3. **Quick tour.** Choose **Start the tour** or **Not now**.

**Continue** moves to the next step. **Skip setup**, × or Esc close the welcome; the AI button
at the top of the page then says **Set up AI** until a service is connected. Help (**?**) ›
**Show the setup again** opens the welcome later. If you already had a key saved in version
0.1, the welcome doesn't appear; a message offers the tour instead.

### The tour

A one-minute tour of the real screen in six stops: **Start here**, **Describe the item**,
**Condition**, **Generate listing**, **Review** and **Copy into eBay**. **Next** and **Back** (or
the arrow keys) move between stops; **Skip tour** or Esc ends it, and the last stop ends with
**Done**. The tour never changes your draft. Take it again with Help (**?**) › **Take the tour**.

### Get set up guide

Until you copy your first listing, the right-hand pane shows **Get set up**: four steps that
tick themselves off as you go.

1. **Connect a free AI service**, with its own paste box and a **Get a free Google key** link.
2. **Describe your first item.**
3. **Generate the listing.** It takes 10–30 seconds.
4. **Copy it into eBay.** Switch eBay's description box to HTML (the < > button), then paste.

**Try a sample item** fills the form with a made-up item; nothing is generated until you choose
**Generate listing**. After your first listing the guide shrinks to one line, "Last step: copy
it into eBay.", and after your first **Copy HTML** or **Download HTML** it hides itself.
**Hide this guide** hides it sooner; Help (**?**) › **Show the Get set up guide** brings it back.

### Tips

- An (i) beside a field opens a short tip: Product name or model, Describe the item, What's
  included, Condition, Brand and Condition notes. Esc closes it.
- The main buttons show a tip when you point at them or reach them with the keyboard, for
  example **Look up**, **Find keywords**, **New listing**, **Generate listing**, **Copy HTML** and
  **Regenerate…**.
- A **Start here** marker sits beside Product name or model until you start typing.
- After your first **Copy HTML**, a message explains how to paste it into eBay.

### Help menu

The **?** button at the top of the page holds **Show the setup again**, **Take the tour**,
**Show the Get set up guide** (while it is hidden), **User guide** (this page) and **Report a
problem**.

## Connecting AI

### The paste box

The welcome setup, the Get set up guide and Settings › AI each have one box for any key.
Paste the key (Ctrl+V), or type it and press Enter. With an empty box, **Paste** (in Settings,
**Add key**) reads the clipboard when your browser allows it. Marteloio recognises the key by
how it starts:

| A key that starts with | Belongs to |
| --- | --- |
| `AIza` | Google Gemini |
| `gsk_` | Groq |
| `sk-or-` | OpenRouter |
| `freellmapi-` or `sk-cp-` | FreeLLMAPI |

A FreeLLMAPI address that carries its own access code (`…/v1/t/flmurl_…`) works in place of
a key. Spaces, quotes and a leading "Bearer " are removed for you. Marteloio then saves the
key, sends one tiny test request and says what happened, for example "Google Gemini didn't
accept this key. Copy the whole key and paste it again." The key never appears in the box
again; Settings shows only its last four characters (Key …a1B2).

### One line per service

Settings › AI lists the services in the order Marteloio tries them: **FreeLLMAPI**, **Google
Gemini**, then **Other AI services** (Groq and OpenRouter, used as a backup). The line above
them sums it up, for example "2 of 4 set up · tried in this order: FreeLLMAPI, Google Gemini".
Each service shows its state:

| State | Meaning |
| --- | --- |
| Ready | Set up and working |
| Not set up | No key yet |
| Off | Its **Use** switch is off |
| Test failed | Its last check didn't work; see the line's message, then **Test again** |
| Resting 40 s | Busy or out of reach; Marteloio tries it again after a short break |
| Key rejected | The service turned the key down; paste a new one |

Open a line to work with that service:

- **Save and test** saves a new key you pasted into the line's Key box, and tests it.
- **Test again** sends one tiny request to that service only and shows how fast it answered
  ("Working · it answered in 1.2 seconds") or what to fix. A test that works ends any rest.
- **Remove** deletes the key from this computer. It asks once more on the button itself: choose
  **Remove now** to delete it.
- The **Use** switch skips a service without removing its key.
- **Get a free key** (or **Get FreeLLMAPI**) opens the page where you get one.

### FreeLLMAPI

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) is a free app you run on your PC, or
on another computer on your home network. It spreads requests over many free AI services and
moves on when one is busy, so Marteloio tries it first once it is set up.

- **Found for you.** Until FreeLLMAPI is set up, Marteloio checks whether it is running on this
  computer each time the welcome setup or Settings › AI opens: its desktop app at
  `127.0.0.1:31415`, or port 3001 for Docker and Node. If it is, a card says "FreeLLMAPI is
  running on this computer." To use it, copy its key from the tray icon (**Show Compact
  Panel** › **Copy Key**), choose **Use FreeLLMAPI** and paste the key. Marteloio uses the
  address where it found FreeLLMAPI.
- **Find it again** (in the FreeLLMAPI line) looks again and fills in the Address, for example
  after you start FreeLLMAPI or when it moved to another port.
- **Address.** Normally `http://127.0.0.1:31415/v1`. It must be on this computer or your home
  network.
- **Patience.** FreeLLMAPI may try several services before it answers, so Marteloio waits up to
  110 seconds for it (60 seconds for a test) instead of 45.
- If it isn't running: "FreeLLMAPI isn't running on this computer. Start it, then choose Test
  again." If it has no keys of its own yet: "FreeLLMAPI is running but has no AI services yet.
  Add a key on its Keys page, then choose Test again."

### The AI button

The button at the top right of the page shows how AI stands: **Set up AI** (nothing connected,
or the saved keys can't be read), **AI ready**, **AI busy · 40 s** (too many requests) or
**AI offline · 30 s** (out of reach). **Set up
AI** opens the setup; otherwise the button opens Settings › AI. Point at it to see each
service's state.

## Messages

Messages appear at the bottom right (above the Generate bar on a phone), in plain words: what
happened and what to do next. Each has a title:

- **Working** shows only when a task takes more than a moment, counts the seconds after 10
  ("Still writing your listing… 14 s") and goes when the task ends.
- **Done** fades after 4 seconds, or 10 when it offers a button such as **Undo**.
- **Notice** fades after 8 seconds.
- **Problem** fades after 10 seconds, longer for a longer message (at most 20).

Pointing at a message, or moving keyboard focus into it, pauses it; a thin line shows the time
left, and × closes it. The same message again counts up (×2) instead of piling up, and at most
three show at once. Messages never take the keyboard focus, and screen readers hear each one
once.

A step that failed also keeps a one-line note in place until it is fixed, for example
"Couldn't write the listing: no AI service is connected yet.", often with the button that fixes
it: **Set up AI** or **Open Settings**.

## Settings

**Settings** at the top of the page has four tabs. **Close**, × or Esc close it.

- **AI**: the paste box and one line per AI service; see [Connecting AI](#connecting-ai).
- **Your shop**: Store or seller name, eBay username, Store logo web address, Feedback score,
  Positive % and Member since. They build the seller header at the top of each listing and are
  kept in this browser. eBay blocks pictures from other websites in descriptions, so upload
  your logo in any eBay listing draft and paste its `i.ebayimg.com` address.
- **eBay (optional)**: only needed for Look up, Find keywords and your feedback numbers; see
  [Connecting eBay](#connecting-ebay).
- **About**: the Version and Build (useful in bug reports), the Data folder with **Copy**, links
  to the **User guide**, **Report a problem** and the **License**, and **Quit Marteloio**. Quit
  stops Marteloio on this computer; your drafts stay saved in this browser. The page then says
  "Marteloio has stopped." and how to open it again.

## Describing an item

Start with **Product name or model**, the make and model buyers search for. Then describe the
item the way you would tell a friend: the actual model, included items, what you tested, and
every flaw. Select a condition only when you can confirm it:

- **Untested** means untested; the listing will not claim it works or is broken.
- **For parts** is never upgraded to working.
- An empty condition stays unspecified; the AI is told not to infer one.
- **Condition notes** are copied into the listing as you wrote them.

In **What's included**, type one thing, then press Enter or type a comma: charger, box, manual.
Text you typed without pressing Enter is added when you leave the box or generate.

The returns choice defaults to "see the eBay listing settings"; explicit accepted and
no-returns options are under **More options**, with the optional barcode and the layout.

**New listing** (beside "Describe your item", in the Drafts menu, or Alt+N / Option+N)
starts fresh without a question: the current draft goes to Recent drafts and a message
offers Undo. Seller details, theme, layout and the returns choice are kept. After you
copy or download a listing, "Done with this one?" offers the same once.

## Bundles and lots

Switch to **Bundle / lot** and describe the whole lot in one box. With **Make a bundle item
from each line or bullet of the description** ticked (the default, remembered per browser),
each line or bullet becomes an item card as you type, with no AI request:

- A line with several sentences is a note about the lot, not an item, and a short heading
  ending in a colon ("Games:") is skipped.
- No condition is ever set for you; cards show **Needs condition** until you choose one.
- Each named card also appears as a What's included chip.
- Cards and chips filled in this way are marked (dashed, **Auto**). Edit a card and it
  is yours: later typing never changes or removes it. A card you delete stays deleted.

Filled cards fold to a single line showing the name, brand and condition. Click a row
(or press Enter on it) to open it; Escape folds it again. With three or more cards,
**Expand all** and **Collapse filled** appear above the list.

Each card has an optional **Brand**. It is filled for you only when the card's name
starts with a brand you already typed or accepted. **Brand(s)** summarises the card
brands: one shared brand becomes the listing's Brand; with several, Brand is left out
unless you type an override or choose Multi-brand, Mixed lot or Unbranded.

If conditions differ between items, tick **Conditions vary across items** so no overall
rating is implied; the listing updates straight away. Each item keeps its own condition and
brand when you add or delete cards later.

## References and keyword suggestions

**Look up** and **Find keywords** are optional. They need free eBay developer keys; without
them Marteloio says so and you can just describe the item.

**Look up** searches other sellers' eBay listings by product name, or by the barcode
under **More options** when one is entered (8, 12, 13 or 14 digits; spaces and hyphens
are removed, leading zeros kept). If a barcode is entered while More options is folded,
Marteloio opens it and asks first, so it never searches a barcode you can't see. Results open
as a collapsible list with its own scrollbar.

1. Choose **Review specifications** on a result to see the specifications that seller
   listed, with the source link and retrieval time.
2. Choose **Accept reference** to use it, or **Dismiss**.

Accepting never fills in or changes your notes, brand, condition, accessories, flaws or
policies. The reference reaches the AI as a separately labelled block, not as your own
facts. The list then folds to one line naming the accepted listing, with **Remove
reference**; reopening it shows the accepted listing first. Choosing another result
replaces the reference and needs accepting again; renaming the item or changing its
barcode clears it. Bundle cards have the same **Lookup details** flow.

Only product identifiers and technical attributes are retrieved. Descriptions,
condition, included items and seller policies are left out. An empty or failed search
never falls back to AI guesses. These are other sellers' claims: check variants and
specifications against the item in your hands.

**Find keywords** collects the words other sellers use in their listing titles. Expand
**Keywords from other sellers** to see the source listings. They are suggestions, not
search-volume data or facts about your item, and the AI is told so.

See [Connecting eBay](#connecting-ebay) for the keys. Editing the product name or barcode
cancels searches still in progress.

## Reviewing and editing the listing

After **Generate listing**:

- **Title.** The ruler shows the length against eBay's 80-character limit. If the AI's
  title was too long it is shortened and a notice says so. Clearing the title leaves it
  blank and turns off title copying.
- **Edit content** opens the description, condition notes, item specifics and lists as
  plain text. **Apply changes** checks and rebuilds the preview. Limits are explained
  rather than silently enforced: 4,000 characters per paragraph, list entry or condition
  note; 100 per item-specific name and 1,000 per value. Condition notes you apply here are
  copied back to the form, so changing the Condition later keeps them. Other edits change
  the output only; a new generation still starts from your notes.
- **Regenerate…** rewrites only the title, the description or the highlights with one
  short request, and offers Undo. It is unavailable while the HTML is hand-edited or
  content edits are unapplied.
- **HTML code** lets you edit the HTML directly. Your edited HTML then becomes what is
  copied and downloaded; the app marks this mode (**Manually edited**) and asks before a new
  generation replaces it.
- **Shuffle look** picks another layout and colour theme; the layout can also be chosen
  under **More options**. **Simple HTML** is an inline-only layout without remote images.

Choosing **Generate listing** again replaces the listing. If you had edited it, your edited
version is saved to Recent drafts first and a message offers **Undo**. A condition you change
while the AI is writing is used in the new listing.

eBay doesn't allow contact details in listings. The AI is told never to write web addresses,
emails, phone numbers or social media handles; if the listing still contains a web address or
an email, **Copy HTML** and **Download HTML** say so first and offer **Copy anyway** or
**Download anyway**.

Every layout starts with eBay's mobile description summary (plain text, at most 800
characters) and contains no scripts, forms, links or web fonts. Styled layouts include a
`<style>` block with only the active theme. To paste, switch eBay's description box to HTML
(the < > button). Always check the result in eBay's editor and its desktop and mobile preview
before publishing; eBay's rules and rendering can change.

## Templates and fewer AI requests

Save a generated listing as a template from the Drafts menu, or when the app offers it
after your first generation. Templates never store condition, condition notes or barcode;
you choose those for each item. The description is saved, so check it for the old item's
flaws.

While you describe a new item, a template whose name, brand or title matches is suggested
beside Generate. Matching is local, and a template is never applied without your click.
**Use it (no AI request)** keeps your own notes and condition; only an empty product name or
brand is taken from the template.

## Drafts, history and backups

Your current draft autosaves in this browser's local storage, together with the last ten
drafts and your templates. Storage belongs to the address you open: `localhost` and
`127.0.0.1`, different ports and different browser profiles each keep separate drafts.
Marteloio opens `http://localhost:8080`. Clearing browser data removes them.

- **Restore** from Recent drafts saves your current work to history first; if that fails,
  nothing is replaced. Each listing appears there once.
- **Duplicate** saves a copy to history and keeps you editing.
- **Back up draft** downloads a JSON file with the notes, editable listing, pending edits,
  references and saved HTML. Keys and seller account preferences are excluded. The file
  is not encrypted.
- **Restore draft file** accepts these backups up to 2 MB and saves your current work to
  Recent drafts first. Invalid files leave the current draft untouched. A file whose HTML was
  edited by hand opens in that mode, and a notice says that title, condition and layout
  changes won't reach Copy HTML until you choose **Back to structured editing**.

Autosave flushes pending edits when the page is hidden or closed, but cannot guarantee
recovery after a crash or when storage is unavailable. Keep exported copies of important
listings.

## Where your data lives

| What | Installed with Marteloio-Setup.exe | ZIP or source copy |
| --- | --- | --- |
| The program | `%LOCALAPPDATA%\Programs\Marteloio`, replaced by every update | The folder you unzipped or cloned |
| AI and eBay keys | `.marteloio-secrets.enc` in `%LOCALAPPDATA%\Marteloio` | `.marteloio-secrets.enc` in that folder on Windows; `.env` in plain text on macOS and Linux |
| Use switches | `settings.json` in `%LOCALAPPDATA%\Marteloio` | `settings.json` in that folder |
| Log | `relay.log` in `%LOCALAPPDATA%\Marteloio` | `relay.log` in that folder |
| Optional `.env` (for example `PORT`) | `%LOCALAPPDATA%\Marteloio\.env` | `.env` in that folder |
| Drafts, Recent drafts, templates, shop details and first-run progress | This browser, for `http://localhost:8080` | The same |

Settings › About shows the data folder and has a **Copy** button. An installed copy never
keeps your data in the program folder and ignores a `.env` there. When `relay.log` is over
1 MB, Marteloio renames it `relay.log.1` the next time it starts, so one older log is kept.

## Keys and credential storage

- **On Windows**, keys saved in Marteloio (AI keys, eBay application keys and eBay sign-in
  tokens) are encrypted with DPAPI for your Windows account in `.marteloio-secrets.enc` in the
  data folder. Programs running as your account can still decrypt them. A store that cannot
  be read, for example after moving to another PC or Windows account, is reported, not treated
  as empty. When you paste a key again, Marteloio keeps the unreadable file under a new name
  (`.marteloio-secrets.unreadable-<date>.enc`) and starts a new store; it never deletes it.
- Keys typed directly into `.env` stay in plain text until you paste them into Marteloio,
  which moves them into the encrypted store and removes them from `.env`. Saved settings,
  including removals, take precedence over `.env`.
- **Without DPAPI** (macOS, Linux), keys use plain-text `.env` and eBay tokens use
  `.ebay_token.json`. `.gitignore` keeps these out of commits; it is not encryption.
- Seller details (store name, logo address, statistics, RuName) are stored in the browser.
  Keys never are.
- To replace an AI key, paste the new one; to delete it, use **Remove** on its line in
  Settings › AI. For eBay keys, leave a box empty to keep what's saved.

Outbound requests never follow redirects, so a key can't be forwarded to an unexpected
address, and responses larger than 4 MB are refused. Each key is sent only to its own
service, and FreeLLMAPI's address must be on this computer or your home network. Errors from
AI services are kept with keys redacted and are not shown in the browser.

## Connecting eBay

1. Create a free account at [eBay Developers](https://developer.ebay.com/) and an
   application with production keys.
2. In Settings › eBay, enter the Client ID and Client Secret and choose **Save eBay keys**.
   Look up and Find keywords now work.
3. For your feedback numbers, also enter the application's RuName and choose **Connect
   eBay**, then **Open the eBay sign-in page**. Approve on eBay, copy the whole web address
   you land on, paste it into the box and choose **Finish connecting**. **Get my feedback
   numbers** then fills them in under Settings › Your shop.

A new connection replaces the previous account's tokens. Refreshing keeps the existing
refresh token when eBay doesn't return a new one. The full sign-in flow should be checked
with your own account before you rely on it.

## How AI services are chosen

Services with a key are tried in the order FreeLLMAPI, Google Gemini, Groq, OpenRouter. A
service whose **Use** switch is off is skipped, and with one key only that service is used.

- A rate-limited service rests for the time it asks for (5 seconds to an hour; a minute if it
  doesn't say). One that can't be reached or didn't answer in time rests for 30 seconds, and
  one that sent an answer Marteloio can't use rests for 15 seconds. FreeLLMAPI picks its own
  models, so it rests for only 5 seconds after a slow or unusable answer.
- A key that was turned down stays off until you change it.
- An answer that was cut off counts as failed, and the next service is tried.
- If a service retires its model, its listed fallbacks and then its other models are tried.
  OpenRouter only ever moves to another free model.

Each request may take up to 45 seconds, or 110 seconds for FreeLLMAPI, which may try several
services itself. One listing stops trying after 160 seconds in all; the page waits up to 180
seconds before it reports a problem. Your draft is kept either way.

At most three AI requests run at once across all tabs; an extra one gets a local message
("Marteloio is already writing three things. Wait for one to finish, then try again.")
without contacting any service. **Test again** in Settings › AI tries one service on its own,
whatever the order.

## Moving from the ZIP version

If you ran Marteloio from the ZIP with `start-all.bat`, move to the installed version like
this. Both use the address `http://localhost:8080`, so only one can run at a time.

1. Stop the ZIP copy: Start menu › **Stop Marteloio** (if you made its shortcuts), or
   `stop.bat` in its folder.
2. Install with Marteloio-Setup.exe. Its Start menu shortcuts, and its desktop shortcut if you
   keep it, replace the old ones of the same name. When the welcome setup opens, you can choose
   **Skip setup** if you'll bring your old keys.
3. Bring your keys: copy `.marteloio-secrets.enc` from the old folder into
   `%LOCALAPPDATA%\Marteloio` (type that into the File Explorer address bar), then reload the
   Marteloio page. This works for the same Windows account on the same PC. If you had typed
   keys into a `.env` file, copy it too. Or simply paste your keys again in Settings › AI and
   Settings › eBay.
4. Your drafts, templates and shop details are already there: they live in your browser at
   the same address.
5. When everything works, run `create-shortcuts.bat /remove` in the old folder (it only removes
   shortcuts that point at that folder), then delete the folder.

## Updating

Download the newer Marteloio-Setup.exe and run it, even while Marteloio is open. Setup stops
the running copy first, replaces the program and keeps your keys, settings and log; your
drafts stay in your browser. Then it opens the new version. If an open Marteloio page says
"Marteloio was started again. Reload this page, then try again.", reload it. Settings › About
shows the version you have, and the [changelog](../CHANGELOG.md) lists what changed.

For a ZIP or source copy, replace the files (or `git pull`) and keep `.env` and
`.marteloio-secrets.enc`, then start it again (`relaunch.bat` on Windows).

## Uninstalling

- **Windows 11:** Settings › Apps › Installed apps, then **…** beside Marteloio › **Uninstall**.
- **Windows 10:** Settings › Apps › Apps & features › Marteloio › **Uninstall**.

Uninstalling stops Marteloio and removes the program and its shortcuts. It then asks "Also
remove your saved keys and settings?". **No** (the default) keeps `%LOCALAPPDATA%\Marteloio` for
the next time you install Marteloio; **Yes** deletes it. Drafts and templates stay in your
browser: back up what you want with **Back up draft**, then clear the browser's site data for
`localhost:8080` to remove them.

For a ZIP or source copy, stop the app, run `create-shortcuts.bat /remove` if you added
shortcuts, and delete the folder. That removes the app, `.env`, the encrypted key store and
the log.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The browser won't keep the download | Keep it: in Edge **…** › **Keep** › **Show more** › **Keep anyway**. Download only from the official sources. |
| "Windows protected your PC" | Choose **More info**, then **Run anyway**. The installer isn't code-signed yet; you can [check its SHA-256](../SECURITY.md#checking-the-installer) first. |
| Setup didn't finish | Setup keeps a log in your temporary folder (`%TEMP%`, a file named "Setup Log" and the date). Check it for personal details before attaching it to a bug report. |
| Nothing seems to happen when you open Marteloio | It runs without a window; give it a few seconds to open your browser. If it says "Marteloio is taking longer than usual to start.", wait a minute and open it again; `relay.log` in the data folder says why. |
| "Marteloio is running, but your browser didn't open." | Open `http://localhost:8080` in your browser yourself. |
| "Another copy of Marteloio is already running from a different folder." | Usually the ZIP version is still running. Stop it with `stop.bat` in its folder, then open Marteloio again. |
| "Marteloio couldn't start because another program is using port 8080." | Close that program, then open Marteloio again. Marteloio never stops a program just because it uses the port. To use another port, put `PORT=8081` in a file named `.env` in the data folder; drafts saved at the old address stay there. |
| The app doesn't start from source | Read `relay.log`. Check that Python 3.10 or newer is installed and the port is free. |
| **Set up AI** stays on, or "Connect an AI service first." | Paste a key in Settings › AI, or follow the steps to get a free Google key. |
| "Marteloio couldn't read your saved keys." | This happens after moving to another PC or Windows account. Paste your keys again in Settings › AI (and Settings › eBay). The unreadable file is kept under a new name, not deleted. |
| "… didn't accept this key." or **Key rejected** | Copy the whole key again and paste it. Check on the service's own site that the key still exists. |
| "The AI services are busy right now." | Wait as the message says, or add another service's key. Your draft is kept. |
| "FreeLLMAPI isn't running on this computer." | Start FreeLLMAPI, then choose **Test again** (or **Find it again**) in Settings › AI. |
| "FreeLLMAPI is running but has no AI services yet." | Add a key on FreeLLMAPI's Keys page, then choose **Test again**. |
| "Marteloio was started again. Reload this page, then try again." | Marteloio restarted, for example after an update. Reload the page. |
| "Marteloio isn't responding." | Open Marteloio again from the Start menu, then reload the page. |
| Look up or Find keywords doesn't work | They are optional and need eBay keys in Settings › eBay. You can still generate from your own notes. |
| A shortcut does nothing (ZIP copy) | The folder was probably moved or renamed. Run `create-shortcuts.bat` again from its new place. |
| Drafts disappeared | Check you opened the same address (`http://localhost:8080`) and browser profile. Restore from a draft backup if you have one. |

When reporting a problem, include the Version and Build from Settings › About, and see
[SECURITY.md](../SECURITY.md) for what not to share.
