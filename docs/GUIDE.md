# Marteloio user guide

This guide covers everything past the [README](../README.md): how each part of the
app behaves, where your data lives, and what to do when something goes wrong.

- [Describing an item](#describing-an-item)
- [Bundles and lots](#bundles-and-lots)
- [References and keyword suggestions](#references-and-keyword-suggestions)
- [Reviewing and editing the listing](#reviewing-and-editing-the-listing)
- [Templates and fewer AI requests](#templates-and-fewer-ai-requests)
- [Drafts, history and backups](#drafts-history-and-backups)
- [Keys and credential storage](#keys-and-credential-storage)
- [Connecting eBay](#connecting-ebay)
- [How providers are chosen](#how-providers-are-chosen)
- [Troubleshooting](#troubleshooting)

## Describing an item

Enter the actual model, included items, what you tested, and every flaw. Select a
condition only when you can confirm it:

- **Untested** means untested; the listing will not claim it works or is broken.
- **For parts** is never upgraded to working.
- An empty condition stays unspecified; the AI is told not to infer one.
- **Condition notes** are copied into the listing as you wrote them.

The returns choice defaults to "see the eBay listing settings"; explicit accepted and
no-returns options are under **More options**, with the optional barcode and the layout.

**New listing** (beside "Describe your item", in the Drafts menu, or Alt+N / Option+N)
starts fresh without a question: the current draft goes to Recent drafts and a toast
offers Undo. Seller details, theme, layout and the returns choice are kept. After you
copy or download a listing, "Done with this one?" offers the same once.

## Bundles and lots

Switch to **Bundle / lot** and describe the whole lot in one box. With **Fill the bundle
items from this description** ticked (the default, remembered per browser), the text is
split locally, with no AI request, into item cards as you type:

- Lines, bullets and sentences become items; note-like fragments are skipped.
- No condition is ever set for you; cards show **Needs condition** until you choose one.
- Each named card also appears as a What's included chip.
- Cards and chips filled in this way are marked (dashed, **Auto**). Edit a card and it
  is yours: later parsing never changes or removes it.

Filled cards fold to a single line showing the name, brand and condition. Click a row
(or press Enter on it) to open it; Escape folds it again. With three or more cards,
**Expand all** and **Collapse filled** appear above the list.

Each card has an optional **Brand**. It is filled for you only when the card's name
starts with a brand you already typed or accepted. **Brand(s)** summarises the card
brands: one shared brand becomes the listing's Brand; with several, Brand is left out
unless you type an override or choose Multi-brand, Mixed lot or Unbranded.

If conditions differ between items, tick **Conditions vary across items** so no overall
rating is implied.

## References and keyword suggestions

**Look up** searches other sellers' eBay listings by product name, or by the barcode
under **More options** when one is entered (8, 12, 13 or 14 digits; spaces and hyphens
are removed, leading zeros kept). Results open as a collapsible list with its own
scrollbar.

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

Both features need eBay application keys; see [Connecting eBay](#connecting-ebay).
Editing the product name or barcode cancels searches still in progress.

## Reviewing and editing the listing

After **Generate listing**:

- **Title.** The ruler shows the length against eBay's 80-character limit. If the AI's
  title was too long it is shortened and a notice says so. Clearing the title leaves it
  blank and turns off title copying.
- **Edit content** opens the description, condition notes, item specifics and lists as
  plain text. **Apply changes** checks and rebuilds the preview. Limits are explained
  rather than silently enforced: 4,000 characters per paragraph, list entry or condition
  note; 100 per item-specific name and 1,000 per value. These edits change the output
  only; a new generation still starts from your notes.
- **Regenerate…** rewrites only the title, the description or the highlights with one
  short request, and offers Undo. It is unavailable while the HTML is hand-edited or
  content edits are unapplied.
- **HTML code** lets you edit the HTML directly. Your edited HTML then becomes what is
  copied and downloaded; the app marks this mode and asks before a new generation
  replaces it.
- **Shuffle look** picks another layout and colour theme; the layout can also be chosen
  under **More options**. **Simple HTML** is an inline-only layout without remote images.

Every layout starts with eBay's mobile description summary (plain text, at most 800
characters) and contains no scripts, forms, links or web fonts. Styled layouts include a
`<style>` block with only the active theme. Always check the result in eBay's editor and
its desktop and mobile preview before publishing; eBay's rules and rendering can change.

## Templates and fewer AI requests

Save a generated listing as a template from the Drafts menu, or when the app offers it
after your first generation. Templates never store condition, condition notes or barcode;
you choose those for each item.

While you describe a new item, a template whose name, brand or title matches is suggested
beside Generate. Matching is local, and a template is never applied without your click.
Using one makes no AI request.

## Drafts, history and backups

Your current draft autosaves in this browser's local storage, together with the last ten
drafts and your templates. Storage belongs to the address you open: `localhost` and
`127.0.0.1`, different ports and different browser profiles each keep separate drafts.
Clearing browser data removes them.

- **Restore** from Recent drafts saves your current work to history first; if that fails,
  nothing is replaced.
- **Duplicate** saves a copy to history and keeps you editing.
- **Back up draft** downloads a JSON file with the notes, editable listing, pending edits,
  references and saved HTML. Keys and seller account preferences are excluded. The file
  is not encrypted.
- **Restore draft file** accepts these backups up to 2 MB and saves your current work to
  Recent drafts first. Invalid files leave the current draft untouched.

Autosave flushes pending edits when the page is hidden or closed, but cannot guarantee
recovery after a crash or when storage is unavailable. Keep exported copies of important
listings.

## Keys and credential storage

- **On Windows**, keys saved in Settings (AI providers, eBay application keys and eBay
  sign-in tokens) are encrypted with DPAPI for your Windows account in
  `.marteloio-secrets.enc` in the project folder. Programs running as your account can
  still decrypt them. A store that cannot be read is reported, not treated as empty.
- Keys typed directly into `.env` stay in plain text until you enter and save them in
  Settings, which moves them into the encrypted store and removes them from `.env`.
  Saved settings, including removals, take precedence over `.env`.
- **Without DPAPI** (macOS, Linux), keys use plain-text `.env` and eBay tokens use
  `.ebay_token.json`. `.gitignore` keeps these out of commits; it is not encryption.
- Seller details (store name, logo URL, statistics, RuName) are stored in the browser.
  Keys never are.
- Leaving a key field blank keeps the saved key. To remove one, choose **Remove saved
  key** and save.

Outbound requests never follow redirects, so a key can't be forwarded to an unexpected
address, and responses larger than 4 MB are refused. Each key is sent only to its own
provider. Provider errors are kept with keys redacted and are not shown in the browser.

## Connecting eBay

1. Create a free account at [eBay Developers](https://developer.ebay.com/) and an
   application with production keys.
2. In **Settings**, enter the Client ID and Client Secret and save. Look up and Find
   keywords now work.
3. For seller statistics, also enter the application's RuName, choose **Connect eBay**,
   then **Open eBay consent page**. Approve in eBay, copy the whole address you are
   redirected to, paste it into the code field and choose **Exchange**.

A new connection replaces the previous account's tokens. Refreshing keeps the existing
refresh token when eBay doesn't return a new one. The full sign-in flow should be checked
with your own account before you rely on it.

## How providers are chosen

Providers with a key are tried in the order Gemini, Groq, OpenRouter; with one key, only
that provider is used. A rate-limited provider is skipped for the time it asks for (5
seconds to an hour), an unavailable one for 30 seconds, and a rejected key until it is
changed. If a provider retires its model, its listed fallbacks and then its other models
are tried. One generation stops trying after 90 seconds.

At most three AI requests run at once across all tabs; extra ones get a local "busy"
message without contacting a provider. `GET /ai/status` shows each provider's state.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The app doesn't start | Read `relay.log`. Check that Python 3.10+ is installed and the port is free. The launcher opens the browser only once the app is ready. |
| Port already in use | Read the message. Marteloio never stops a program just because it uses the port; stop the other program or set `PORT` in `.env`. |
| AI status shows offline | Add or check a key in Settings. A rate-limited provider shows when it will be retried. |
| Generation reports 429 or 503 | Wait as suggested or add another provider's key. Your draft is kept. |
| A key is rejected | Paste a fresh key in Settings and save. |
| Saved keys can't be read | Use the Windows account that saved them, or restore a known-good copy of `.marteloio-secrets.enc`. Don't delete a store you might recover. |
| Look up or Find keywords fails | Check the eBay application keys in Settings. You can still generate from your own notes. |
| A shortcut does nothing | The folder was probably moved or renamed. Run `create-shortcuts.bat` again from its new place. |
| Drafts disappeared | Check you opened the same address and browser profile. Restore from a draft backup if you have one. |

When reporting a problem, see [SECURITY.md](../SECURITY.md) for what not to share.
