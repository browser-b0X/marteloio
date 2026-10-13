/* Shared validation used by the browser and offline regression checks. */
(function (root) {
  "use strict";
  const conditionLabels = Object.freeze({
    NEW: "New", OPEN_BOX: "Open box", USED: "Used",
    UNTESTED: "Untested", FOR_PARTS: "For parts or not working",
    NWT: "New with tags (NWT)", NWOT: "New without tags (NWOT)",
    EUC: "Excellent Used Condition (EUC)", VGUC: "Very Good Used Condition (VGUC)",
    GUC: "Good Used Condition (GUC)"
  });
  function sellerCondition(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(conditionLabels, value) ? value : "";
  }
  const CONDITION_CLASS = Object.freeze({
    NEW: "elb-cond-new", NWT: "elb-cond-new", NWOT: "elb-cond-new",
    OPEN_BOX: "elb-cond-exc", EUC: "elb-cond-exc", VGUC: "elb-cond-exc",
    USED: "elb-cond-good", GUC: "elb-cond-good", FOR_PARTS: "elb-cond-parts",
    UNTESTED: "elb-cond-na"
  });
  const CLASS_BY_LABEL = Object.freeze(Object.fromEntries(
    Object.entries(conditionLabels).map(([code, label]) => [label, CONDITION_CLASS[code]])));
  // Accepts either a code or its label: seller conditions arrive as labels,
  // raw model output as codes, and restored drafts as whichever was stored.
  function conditionClass(value) {
    const text = String(value || "");
    return CLASS_BY_LABEL[text] || CONDITION_CLASS[sellerCondition(text)] || "elb-cond-na";
  }
  // Pairs each model bundle item with the seller card it describes, or null.
  // The model rewrites item names, so position is the signal that survives.
  // Unequal counts mean it dropped or invented an item; withholding is safer
  // than attaching the wrong item's seller facts for a buyer.
  function pairByPosition(items, sources) {
    const key = value => String(value || "").trim().toLowerCase();
    const positional = items.length === sources.length;
    return items.map((item, i) => {
      const hits = positional ? [sources[i]] : sources.filter(source => key(source.name) === key(item.name));
      return hits.length === 1 ? hits[0] : null;
    });
  }
  // Records the card each item was paired with when the listing was generated.
  function linkBundleCards(data, cards) {
    pairByPosition(data.bundle_items, cards || []).forEach((hit, i) => {
      data.bundle_items[i].card_id = hit && typeof hit.id === "string" ? hit.id : "";
    });
    return data;
  }
  // Linked items are matched by card id only, so adding, removing or reordering
  // cards later never moves a condition or brand onto another item. undefined:
  // the item's card has been removed since, so the item keeps what it has.
  function pairBundleItems(items, sources) {
    if (!items.length || !items.every(item => typeof item.card_id === "string")) return pairByPosition(items, sources);
    return items.map(item => item.card_id ? sources.find(source => source && source.id === item.card_id) : null);
  }
  function applySellerCondition(data, snapshot) {
    data.condition_rating = sellerCondition(snapshot.condition);
    data.condition_notes = snapshot.notes || "";
    // Condition is displayed separately using seller input, never model specs.
    data.item_specifics = Object.fromEntries(Object.entries(data.item_specifics)
      .filter(([key]) => !/\bcondition\b/i.test(key)));
    pairBundleItems(data.bundle_items, snapshot.items).forEach((hit, i) => {
      if (hit === undefined) return;
      const code = hit ? sellerCondition(hit.condition) : "";
      data.bundle_items[i].condition = code ? conditionLabels[code] : "Condition not specified";
    });
    return data;
  }
  function cleanBrand(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
  }
  /* Bundle brands come from the seller's cards, never from the model. Each
     item gets its card's brand (or none), and the Brand item specific is the
     seller's brand for the whole lot, or left out when there is none. */
  function applySellerBrands(data, snapshot) {
    pairBundleItems(data.bundle_items, snapshot.items || []).forEach((hit, i) => {
      if (hit !== undefined) data.bundle_items[i].brand = hit ? cleanBrand(hit.brand) : "";
    });
    const brand = cleanBrand(snapshot.brand);
    const others = Object.entries(data.item_specifics).filter(([key]) => !/^\s*brands?\s*$/i.test(key));
    const entries = brand ? [["Brand", brand], ...others] : others;
    data.item_specifics = Object.fromEntries(entries.slice(0, LIMITS.specifics));
    return data;
  }
  // Unique card brands (first spelling wins), the one brand every named card
  // shares (or ""), and how many named cards have no brand.
  function bundleBrandSummary(items) {
    const named = (items || []).filter(item => item && String(item.name || "").trim());
    const brands = [], seen = new Set();
    let unbranded = 0;
    for (const item of named) {
      const brand = cleanBrand(item.brand);
      if (!brand) { unbranded++; continue; }
      if (!seen.has(brand.toLowerCase())) { seen.add(brand.toLowerCase()); brands.push(brand); }
    }
    return {brands, shared: brands.length === 1 && !unbranded ? brands[0] : "", unbranded};
  }
  const matchText = value => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  // The longest known brand the name starts with, as whole words; "" otherwise.
  function detectBrand(name, knownBrands) {
    const text = matchText(name);
    let best = "", bestLength = 0;
    for (const brand of knownBrands || []) {
      const key = matchText(brand);
      if (!key || key.length <= bestLength || !text.startsWith(key)) continue;
      const next = text.slice(key.length, key.length + 1);
      if (next && /[\p{L}\p{N}]/u.test(next)) continue;
      best = cleanBrand(brand); bestLength = key.length;
    }
    return best;
  }
  /* Bundle description -> item names. Deterministic and conservative: one
     item per line or bullet, never split on commas or sentences. A line that
     reads like a note about the item (several sentences, a verb such as
     "works" or "missing", more than eight words) is skipped rather than
     guessed at. Condition is never read from the text. */
  const ITEM_LIMIT = 50;
  const SEPARATOR_BULLETS = "•▪‣◦●■►▶·";
  const LEADING_BULLET = /^(?:[•▪‣◦●○■□►▶·]\s*|[-*–—>]+\s+|\d{1,2}[.)]\s+|\(\d{1,2}\)\s+)/u;
  const LABEL = /^(?:(?:this|the)\s+)?(?:bundle|lot|job\s+lot|set|kit|collection|items?|contents?|what['’]?s\s+included|included|includes|including|contains)\s*:\s*/i;
  const FILLER = /^(?:(?:this|the)\s+)?(?:(?:bundle|lot|job\s+lot|set|kit|collection)\s+(?:of|includes?|including|contains?|comes\s+with|has)|includes?|including|contains?|comes\s+with|consists\s+of|and|plus|also|with)\s+/i;
  const TRAILING_FILLER = /\s+(?:included|incl\.?|etc\.?|and\s+more|&\s+more|\.\.\.|…)$/i;
  const NOTE_WORDS = new RegExp("(?<![\\p{L}\\p{N}])(?:" + ["works", "working", "worked", "tested", "untested", "missing", "broken", "damaged",
    "cracked", "scratched", "scratches", "scuffed", "scuffs", "faded", "stained", "torn", "chipped", "dented", "is", "are", "was", "were",
    "been", "has", "have", "had", "does", "doesn['’]t", "don['’]t", "didn['’]t", "isn['’]t", "aren['’]t", "wasn['’]t", "not", "no", "without",
    "excluding", "except", "i", "i['’]m", "i['’]ve", "my", "me", "we", "our", "you", "your", "they", "their", "comes", "see", "please",
    "condition", "shape", "shipping", "ships", "shipped", "postage", "smoke", "smoke-free", "pictured", "photos", "pics", "selling",
    "sold", "bought", "bundle", "lot"].join("|") + ")(?![\\p{L}\\p{N}])", "iu");
  // "Camera • Lens • Strap": bullets written inside a line mark items too.
  function splitBullets(line) {
    const parts = [];
    let depth = 0, current = "";
    for (const ch of line) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch) && depth) depth--;
      if (!depth && SEPARATOR_BULLETS.includes(ch)) { parts.push(current); current = ""; } else current += ch;
    }
    parts.push(current);
    return parts;
  }
  // Finds the sentences in "all games tested. Mario Kart 8", keeping "Dr. Mario",
  // "No. 5" and initials together.
  const ABBREVIATIONS = /(?:^|\s)(?:dr|mr|mrs|ms|st|no|nr|vol|vs|mk|mt|jr|sr|ft|inc|co|ltd|approx|[a-z])$/i;
  function splitSentences(line) {
    const out = []; let start = 0;
    const re = /[.!?]\s+(?=[\p{Lu}\p{N}"'])/gu; let m;
    while ((m = re.exec(line))) {
      if (ABBREVIATIONS.test(line.slice(start, m.index))) continue;
      out.push(line.slice(start, m.index + 1)); start = m.index + m[0].length;
    }
    out.push(line.slice(start));
    return out;
  }
  // Title Case fragments ("No Man's Sky", "Untested Gameboy Advance") are names,
  // not seller notes, even when they contain a note word.
  function looksLikeTitle(text) {
    const words = text.split(" ").filter(w => /\p{L}/u.test(w));
    return words.length > 1 && words.filter(w => /^[\p{Lu}\p{N}]/u.test(w)).length / words.length >= 0.6;
  }
  function cleanItemFragment(fragment) {
    let text = fragment.replace(/\s+/g, " ").trim(), previous;
    do {
      previous = text;
      text = text.replace(LEADING_BULLET, "").replace(LABEL, "").replace(FILLER, "")
        .replace(TRAILING_FILLER, "").replace(/^[\s,;:.!?]+|[\s,;:.!?]+$/gu, "").trim();
    } while (text !== previous);
    // Quantities stay part of the name, written as "2x".
    let count = "";
    text = text.replace(/^(\d{1,3})\s*[x×](?=\s|$)\s*/i, (_, n) => { count = n; return ""; })
      .replace(/^[x×]\s*(\d{1,3})(?=\s|$)\s*/i, (_, n) => { count = count || n; return ""; })
      .replace(/(?:^|\s)\(?[x×]\s*(\d{1,3})\)?$/i, (_, n) => { count = count || n; return ""; })
      .replace(/\s(\d{1,3})\s*[x×]$/i, (_, n) => { count = count || n; return ""; }).trim();
    if (!text || !/\p{L}/u.test(text) || Array.from(text).length < 2 || /^(?:etc|and more|more|others?|misc)$/i.test(text)) return "";
    // A lone colour or finish ("chrome", "black") describes the previous item.
    if (/^(?:black|white|silver|chrome|grey|gray|red|blue|green|yellow|orange|pink|purple|gold|brown|beige|clear|matte|glossy|boxed|loose|new|used)$/.test(text)) return "";
    // Long names are fine ("Nintendo Switch OLED console with dock and original box");
    // long lowercase prose is a note.
    const words = text.split(" ").length;
    if (words > 14 || (words > 8 && !/^[\p{Lu}\p{N}]/u.test(text)) || (NOTE_WORDS.test(text) && !looksLikeTitle(text)) || /[!?]\s+\S/.test(text)) return "";
    return (count ? count + "x " : "") + text;
  }
  function parseBundleItems(text) {
    if (typeof text !== "string" || !text.trim()) return [];
    const result = [], seen = new Set();
    for (const rawLine of text.normalize("NFC").split(/\r\n|[\r\n\u2028\u2029]/)) {
      const line = rawLine.replace(/\s+/g, " ").trim().replace(LEADING_BULLET, "");
      // A short line ending in a colon ("Games:") is a heading, not an item.
      if (!line || (/:$/.test(line) && line.split(" ").length <= 4)) continue;
      // "Lot of 3 games: Halo 3, Forza" - a short heading before a colon is not an item.
      const body = line.replace(/^([^:,;]{1,40}):\s+(?=\S)/, (all, head) =>
        head.trim().split(/\s+/).length <= 4 && !/\b(?:not|no|condition|missing|excluding|except)\b/i.test(head) ? "" : all);
      for (const fragment of splitBullets(body)) {
        // Several sentences ("Nikon FM2 body, chrome. Shutter fires.") are a note about the bundle.
        if (splitSentences(fragment.trim()).length > 1) continue;
        const name = cleanItemFragment(fragment).slice(0, 120).trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        result.push(name);
        if (result.length >= ITEM_LIMIT) return result;
      }
    }
    return result;
  }
  function canonicalTitle(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= 80) return text;
    let cut = text.slice(0, 80);
    // A space at index 80 means the prefix already ends on a word boundary.
    const space = text[80] === " " ? -1 : cut.lastIndexOf(" ");
    if (space > 60) cut = cut.slice(0, space);
    cut = cut.replace(/[\uD800-\uDBFF]$/, "").trim();
    // A shortened title should not end on a dangling separator or joining word ("..., Pentax K1000," or "... lens and").
    let previous;
    do {
      previous = cut;
      cut = cut.replace(/(?:\s*[,;:\/|+&]|\s+[-\u2013\u2014]|\s+(?:and|with|or|plus|for|in|of))$/i, "").trim();
    } while (cut !== previous && cut.length > 40);
    return cut;
  }
  // What's included as typed: "Charger, lens cap; strap" is three items. Commas
  // inside brackets or between digits ("Cable (USB-C, 1m)", "1,000 pieces") stay.
  function splitListItems(text) {
    const value = String(text || ""), items = [];
    let depth = 0, current = "";
    const push = () => { const item = current.replace(/\s+/g, " ").trim(); if (item) items.push(item); current = ""; };
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === "\n" || ch === "\r") { depth = 0; push(); continue; }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch) && depth) depth--;
      if (!depth && (ch === ";" || (ch === "," && !(/\d/.test(value[i - 1] || "") && /\d/.test(value[i + 1] || ""))))) push();
      else current += ch;
    }
    push();
    return items;
  }
  // eBay does not allow links or contact details in a listing. The first web
  // address or email address in the text, or "".
  const CONTACT_DETAIL = new RegExp("[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+|\\bhttps?://[^\\s<>\"']+|\\bwww\\.[^\\s<>\"']+|" +
    "\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.(?:com|net|org|info|biz|io|co|me|tv|shop|store|online|site|app|ly|uk|us|ca|au|de|fr|eu)\\b(?:/[^\\s<>\"']*)?", "i");
  function findContactDetail(text) {
    const match = String(text || "").match(CONTACT_DETAIL);
    return match ? match[0].replace(/[.,;:!?)\]]+$/, "") : "";
  }
  // Seller header facts typed by hand; "" when they cannot be right. eBay opened in 1995.
  function memberSinceText(value, currentYear) {
    const text = String(value || "").trim();
    const years = currentYear - Number(text);
    if (!/^\d{4}$/.test(text) || Number(text) < 1995 || years < 0) return "";
    return years === 0 ? "Member since " + text : "Member for " + years + (years === 1 ? " year" : " years");
  }
  function positivePercent(value) {
    const text = String(value || "").trim().replace(/\s*%$/, "");
    return /^\d{1,3}(?:\.\d+)?$/.test(text) && Number(text) <= 100 ? text : "";
  }
  function normalizeBarcode(value) {
    if (typeof value !== 'string' || value.length > 32) throw new Error('Enter a barcode with 8, 12, 13 or 14 digits.');
    const code = value.trim().replace(/[ -]/g, '');
    if (value.trim() && !/^(?:[0-9]{8}|[0-9]{12,14})$/.test(code)) throw new Error('Enter a barcode with 8, 12, 13 or 14 digits, including leading zeros.');
    return code;
  }
  function titleKeywords(items, stopwords, limit = 15) {
    const frequency = new Map();
    for (const item of items) {
      const tokens = String(item.title || "").toLowerCase().match(/[a-z0-9]+(?:[-./][a-z0-9]+)*/g) || [];
      for (const token of new Set(tokens)) {
        if ((token.length < 3 && !(/[a-z]/.test(token) && /[0-9]/.test(token))) || stopwords.has(token)) continue;
        frequency.set(token, (frequency.get(token) || 0) + 1);
      }
    }
    return [...frequency].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([token]) => token);
  }
  // Shared with the content editor so seller edits are checked up front.
  const LIMITS = Object.freeze({list: 40, specifics: 30, text: 4000, specificLabel: 100, specificValue: 1000});
  function strings(value, field, max = LIMITS.list) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== "string")) {
      throw new Error("Invalid " + field + ": expected a list of text values. Please retry.");
    }
    return value.map(v => v.trim().slice(0, 4000)).filter(Boolean);
  }
  function textMap(value, field, max, keyLimit, valueLimit) {
    if (value == null) return {};
    if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > max) {
      throw new Error("Invalid " + field + ". Please retry.");
    }
    const result = {};
    for (const [rawKey, val] of Object.entries(value)) {
      const key = rawKey.trim().slice(0, keyLimit);
      if (!key || typeof val !== "string" || Object.prototype.hasOwnProperty.call(result, key)) {
        throw new Error("Invalid " + field + " entry. Please retry.");
      }
      Object.defineProperty(result, key, {value: val.trim().slice(0, valueLimit), enumerable: true});
    }
    return result;
  }
  function normalizeReference(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Lookup returned an invalid product reference. Please retry.");
    }
    const result = {};
    for (const field of ["product_name", "brand", "release_year", "summary"]) {
      if (value[field] != null && typeof value[field] !== "string") {
        throw new Error("Invalid reference " + field + ". Please retry.");
      }
      result[field] = (value[field] || "").trim().slice(0, field === "summary" ? 4000 : 300);
    }
    result.key_specs = textMap(value.key_specs, "reference specs", 30, 100, 1000);
    if (!result.product_name && !result.summary) {
      throw new Error("Lookup returned an empty product reference. Please retry.");
    }
    return result;
  }
  function normalizeCandidates(items) {
    if (!Array.isArray(items)) throw new Error("Invalid eBay search response.");
    return items.slice(0, 20).flatMap(item => {
      if (!item || typeof item.item_id !== 'string' || !/^v1\|[0-9]{1,20}\|[0-9]{1,20}$/.test(item.item_id || '')) return [];
      const links = normalizeSearchSources([item]);
      return links.length && new URL(links[0].url).pathname.split('/').filter(Boolean).at(-1) === item.item_id.split('|')[1] ? [{...links[0], item_id:item.item_id}] : [];
    });
  }
  function normalizeSourcedReference(ref) {
    const source = normalizeCandidates(ref && ref.source ? [{...ref.source, item_id:ref.source.item_id}] : [])[0];
    if (!ref || ref.kind !== 'ebay-listing' || !source || typeof ref.at !== 'string' || !Number.isFinite(Date.parse(ref.at)))
      throw new Error("Marteloio couldn't check where these details came from. Pick the listing again.");
    const allowed = new Set(['brand','model','mpn','gtin','upc','ean','isbn','color','colour','material','type','connectivity','storage capacity','screen size','processor','ram size','maximum resolution','mount','focal length','maximum aperture','compatible brand','compatible model']);
    const specs = Object.fromEntries(Object.entries(textMap(ref.data && ref.data.key_specs, "reference specs", 30, 100, 1000)).filter(([key]) => allowed.has(key.toLowerCase())));
    if (!Object.keys(specs).length) throw new Error("This listing has no product details Marteloio can use. Pick another one, or just describe the item.");
    return {kind:'ebay-listing', source, at:ref.at, data:{product_name:'', key_specs:specs}, accepted:ref.accepted === true};
  }
  // The callout template prints its own "PLEASE NOTE:" label, so a model that
  // prefixes one too renders it twice. A separator is required after the label
  // word so "Notebook stand is included" and "Importantly, no charger" survive.
  // A bare "Note"/"Important" can be real content ("Note 9 case is not
  // included"), so single-word labels need a colon or dash; phrases may not.
  // A plain hyphen needs a space beside it so "Note-taking kit" also survives.
  const NOTE_LABEL = /^\s*(?:(?:please\s+(?:note|be\s+aware)|kindly\s+note)(?:\s*[:—–]\s*|\s+-\s*|\s*-\s+|\s+|$)|(?:important|note)(?:\s*[:—–]\s*|\s+-\s*|\s*-\s+|\s*$))/i;
  function stripNoteLabel(value) {
    let text = String(value || ""), previous;
    do { previous = text; text = text.replace(NOTE_LABEL, "").trim(); } while (text !== previous);
    return text;
  }
  function normalizeListing(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.title !== "string" || !value.title.trim()) {
      throw new Error("The model returned an incomplete listing. Please retry.");
    }
    const result = { title: canonicalTitle(value.title) };
    // How long the model's own title was, kept across re-normalization so the
    // app can say when it was shortened.
    const rawLength = value.title.replace(/\s+/g, " ").trim().length;
    const kept = Number.isSafeInteger(value.model_title_length) && value.model_title_length > 0 && value.model_title_length <= 4000 ? value.model_title_length : 0;
    result.model_title_length = Math.max(rawLength, kept);
    for (const field of ["subtitle", "condition_rating", "condition_notes", "note", "features_title", "highlights_title"]) {
      if (value[field] != null && typeof value[field] !== "string") throw new Error("Invalid " + field + ". Please retry.");
      result[field] = (value[field] || "").slice(0, 4000);
    }
    result.note = stripNoteLabel(result.note);
    for (const field of ["description_paragraphs", "included_items", "not_included", "buyer_notes", "keywords"]) {
      result[field] = strings(value[field], field);
    }
    if (!result.description_paragraphs.length) throw new Error("The model returned no description. Please retry.");
    result.item_specifics = textMap(value.item_specifics, "item specifics", LIMITS.specifics, LIMITS.specificLabel, LIMITS.specificValue);
    for (const [field, keys] of [["highlights", ["stat", "label", "caption"]], ["bundle_items", ["name", "condition", "description", "brand"]]]) {
      const list = value[field] == null ? [] : value[field];
      if (!Array.isArray(list) || list.length > 50) throw new Error("Invalid " + field + ". Please retry.");
      result[field] = list.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid " + field + ". Please retry.");
        const out = {};
        for (const key of keys) {
          if (item[key] != null && typeof item[key] !== "string") throw new Error("Invalid " + field + ". Please retry.");
          out[key] = (item[key] || "").slice(0, 4000);
        }
        // The seller card a bundle item was generated from (see linkBundleCards).
        if (field === "bundle_items" && item.card_id != null) {
          if (typeof item.card_id !== "string") throw new Error("Invalid " + field + ". Please retry.");
          out.card_id = item.card_id.slice(0, 64);
        }
        return out;
      });
    }
    return result;
  }
  function normalizeSearchSources(items) {
    if (!Array.isArray(items)) return [];
    const result = [], seen = new Set();
    for (const item of items.slice(0, 20)) {
      if (!item || typeof item.title !== "string" || !item.title.trim() || typeof item.url !== "string" || item.url.length > 2000) continue;
      try {
        const url = new URL(item.url);
        if (url.protocol !== "https:" || !["www.ebay.com", "ebay.com"].includes(url.hostname) || url.username || url.password || url.port || !url.pathname.startsWith("/itm/")) continue;
        url.search = ""; url.hash = "";
        if (seen.has(url.href)) continue;
        seen.add(url.href);
        result.push({title: item.title.trim().slice(0, 250), url: url.href});
      } catch (_) { /* Ignore malformed or unsafe links; keep useful keyword data. */ }
    }
    return result;
  }
  /* ---- Messages in plain words (SPEC 4.4) ----
     One table for every error kind the app shows. The server's own text is
     already plain and is preferred (see plainError); this table covers older
     servers, failures found in the browser, and the one-line step notes.
     fix: the button that solves it, "ai" (Set up AI), "aiSettings" (Set up AI, straight to
     Settings › AI, where the switches are) or "ebay" (Open Settings). note: a short form of
     text for the line a failed step keeps (errorNote). */
  const SAVE_FAILED = "Marteloio couldn't save this. Check that its folder isn't read-only or full, then try again.";
  const ERROR_MESSAGES = Object.freeze({
    no_provider: {fix: "ai", text: "Connect an AI service first. It takes about 2 minutes with a free Google key.",
      note: "Couldn't write the listing: no AI service is connected yet."},
    all_disabled: {fix: "aiSettings", text: "Every AI service is switched off. Turn one on in Settings › AI."},
    freellmapi_not_running: {text: "FreeLLMAPI isn't running on this computer. Start it, then try again."},
    freellmapi_no_services: {text: "FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then try again."},
    provider_auth: {fix: "ai", text: "Your AI key was turned down. Open Settings › AI and paste a new key.",
      note: "Couldn't write the listing: your AI key was turned down."},
    provider_storage: {fix: "ai", text: "Marteloio couldn't read your saved keys. This happens after moving to another PC or Windows account. Paste your key again in Settings › AI.",
      note: "Couldn't write the listing: Marteloio couldn't read your saved keys."},
    provider_busy: {text: "The AI services are busy right now. Your draft is safe. Try again in a moment.",
      note: "Couldn't write the listing: the AI services are busy. Try again in a moment."},
    provider_timeout: {text: "The AI took too long to answer. Your draft is safe. Try again in a moment.",
      note: "Couldn't write the listing: the AI took too long to answer."},
    provider_request: {text: "The AI couldn't write this listing. Your draft is safe. Try again; if it keeps happening, shorten your notes.",
      note: "Couldn't write the listing: the AI couldn't use these notes. Try again."},
    bad_answer: {text: "The AI's answer was incomplete, so nothing was changed. Try again.",
      note: "Couldn't write the listing: the AI's answer was incomplete. Try again."},
    local_busy: {text: "Marteloio is already writing three things. Wait for one to finish, then try again.",
      note: "Couldn't write the listing: Marteloio is already writing three things."},
    notes_too_long: {text: "These notes are too long for one listing (over 40,000 characters). Shorten them and try again.",
      note: "Couldn't write the listing: the notes are over 40,000 characters."},
    ebay_not_configured: {fix: "ebay", text: "Look up needs an eBay key (optional). Add one in Settings › eBay, or just describe the item.",
      note: "Look up and Find keywords need an eBay key (optional)."},
    ebay_auth: {fix: "ebay", text: "eBay didn't accept your eBay keys. Check the Client ID and Client Secret in Settings › eBay.",
      note: "eBay didn't accept your eBay keys."},
    ebay_storage: {fix: "ebay", text: "Marteloio couldn't read your saved eBay keys. This happens after moving to another PC or Windows account. Enter them again in Settings › eBay.",
      note: "Marteloio couldn't read your saved eBay keys."},
    ebay_not_connected: {fix: "ebay", text: "Connect your eBay account in Settings › eBay first."},
    ebay_unavailable: {text: "eBay couldn't be reached. Try again in a minute, or just describe the item.",
      note: "eBay couldn't be reached. Try again in a minute."},
    ebay_timeout: {text: "eBay took too long to answer. Try again in a minute, or just describe the item.",
      note: "eBay took too long to answer. Try again in a minute."},
    ebay_busy: {text: "Marteloio is already looking up several items. Wait a moment, then try again.",
      note: "Marteloio is already looking up several items. Try again in a moment."},
    ebay_listing_gone: {text: "This listing is no longer on eBay. Pick another one."},
    ebay_no_details: {text: "This listing has no product details Marteloio can use. Pick another one, or just describe the item."},
    ebay_connect_failed: {text: "eBay didn't finish connecting your account. Choose Connect eBay and try again."},
    invalid_barcode: {text: "Check the barcode: it should have 8, 12, 13 or 14 digits."},
    provider_storage_write: {text: SAVE_FAILED},
    ebay_storage_write: {text: SAVE_FAILED},
    unknown_key: {text: "Marteloio doesn't recognise this key. Copy the whole key from Google AI Studio, Groq, OpenRouter or FreeLLMAPI, then paste it again."},
    invalid_key: {text: "This key looks incomplete. Copy the whole key, then paste it again."},
    invalid_url: {text: "Use the FreeLLMAPI address from this computer or your home network. It starts with http://."},
    nothing_to_save: {text: "Paste a key first."},
    session_expired: {text: "Marteloio was started again. Reload this page, then try again."},
    forbidden: {text: "Marteloio turned this down. Reload this page, then try again."},
    not_found: {text: "This copy of Marteloio can't do that yet. Close Marteloio, open it again, then reload this page."},
    invalid_request: {text: "Marteloio couldn't use that. Reload this page, then try again."},
    server_error: {text: "Marteloio couldn't finish this. Try again in a minute."},
    offline: {text: "Marteloio isn't responding. Restart Marteloio (close it and open it again), then reload this page."}
  });
  // Words a seller should never have to read: setting names, codes and technical terms
  // ("http://" at the start of an address is fine; HTTP as a word is not).
  const JARGON_TERMS = /\b(?:HTTP|API|JSON|OAuth|DPAPI|NaN)\b(?!:\/\/)/;
  const JARGON_WORDS = /\w_\w|\b(?:endpoints?|providers?|tokens?|relay|keyset|credentials?|null|undefined|field types)\b|\.env\b/i;
  function hasJargon(text) {
    return JARGON_TERMS.test(String(text)) || JARGON_WORDS.test(String(text));
  }
  // Server messages are plain sentences; anything else (an older server, a browser error) is replaced.
  function isPlainMessage(text) {
    return typeof text === "string" && text.length <= 400 && /^(?:[A-Z0-9“"]|eBay\b)/.test(text) && /[.!?”")]$/.test(text) && !hasJargon(text);
  }
  function plainError(kind, serverText, fallbackKind) {
    const text = typeof serverText === "string" ? serverText.replace(/\s+/g, " ").trim() : "";
    if (isPlainMessage(text)) return text;
    const entry = ERROR_MESSAGES[kind] || ERROR_MESSAGES[fallbackKind] || ERROR_MESSAGES.server_error;
    return entry.text;
  }
  /* The line a failed step keeps; it says what the message said. A kind's own note is a short
     form of the kind's own text; any other text (the server's words for this failure) is kept,
     after the step's name (context), without "Your draft is safe." and with "in a moment" for a
     countdown, which would be wrong once the message has gone. */
  function errorNote(kind, text, context) {
    const entry = ERROR_MESSAGES[kind];
    const message = plainError(kind, text);
    if (entry && entry.note && message === entry.text) return entry.note;
    const said = message.replace(/\s*Your draft is safe\./g, "").replace(/\bin \d+ seconds?(?=[.!,]|$)/g, "in a moment").replace(/\s+/g, " ").trim();
    return (context ? context + ". " : "") + said;
  }
  function errorFix(kind) {
    const entry = ERROR_MESSAGES[kind];
    return entry && entry.fix ? entry.fix : "";
  }

  /* ---- One-box AI key setup: what was pasted (mirrors ai_providers.recognise) ---- */
  const AI_LABELS = Object.freeze({freellmapi: "FreeLLMAPI", gemini: "Google Gemini", groq: "Groq", openrouter: "OpenRouter"});
  const KEY_PREFIXES = [["gemini", ["AIza"]], ["groq", ["gsk_"]], ["openrouter", ["sk-or-"]], ["freellmapi", ["freellmapi-", "sk-cp-"]]];
  const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;
  // Without surrounding spaces or quotes and without a leading "Bearer ".
  function cleanPastedKey(text) {
    let value = String(text == null ? "" : text);
    for (let i = 0; i < 2; i++) {
      value = value.trim().replace(QUOTES, "").trim();
      if (value.slice(0, 7).toLowerCase() === "bearer ") value = value.slice(7);
    }
    return value.trim();
  }
  // {id, label, kind: "key" | "address"} for pasted text, or null.
  function recognizeKey(text) {
    const value = cleanPastedKey(text);
    if (/^https?:\/\//i.test(value) && value.includes("/v1/t/flmurl_")) return {id: "freellmapi", label: AI_LABELS.freellmapi, kind: "address"};
    for (const [id, prefixes] of KEY_PREFIXES) {
      if (prefixes.some(prefix => value.startsWith(prefix))) return {id, label: AI_LABELS[id], kind: "key"};
    }
    return null;
  }

  /* ---- How long a message stays (ms) ----
     Working shows after busyDelay and only while its task runs; after busyElapsed
     it says how long it has waited, updated every tick. Done fades after ok
     (okAction when it offers Undo or similar), Notice after note, Problem after
     err plus reading time for text past readFrom characters, at most errMax. Screen readers
     are told one message at a time, at least sayGap apart, so two at once are both heard. */
  const TOAST_TIMES = Object.freeze({busyDelay: 400, busyElapsed: 10000, tick: 1000, ok: 4000, okAction: 10000,
    note: 8000, err: 10000, errMax: 20000, readFrom: 120, perChar: 60, sayGap: 900});
  function toastLife(kind, text, hasAction, times) {
    const t = times || TOAST_TIMES;
    if (kind === "busy") return 0; // until its task ends
    if (kind === "ok") return hasAction ? t.okAction : t.ok;
    if (kind === "note") return t.note;
    const extra = Math.max(0, String(text || "").length - t.readFrom) * t.perChar;
    return Math.min(t.errMax, t.err + extra);
  }

  /* ---- The guided first run (SPEC 3.2) ----
     What this browser remembers about the first run (one localStorage record,
     nothing is sent anywhere), what the first AI status answer means for it,
     which form of the "Get set up" guide shows, the header AI button, and where
     a floating box (tip, tooltip, tour card) goes so it is never cut off.
     "AI connected" always comes from /ai/status, never from this record. */
  const GUIDE_DEFAULTS = Object.freeze({welcome: "", tour: "", generated: false, copied: false, checklist: "auto",
    startHereDismissed: false, tipsShown: Object.freeze([]), tourNotice: false});
  // welcome/tour: "" (never), "done" or "skipped"; checklist: "auto" (until the first copy),
  // "hidden" (the seller hid it) or "shown" (asked for again under Help).
  function normalizeGuide(value) {
    const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const pick = (field, allowed) => allowed.includes(v[field]) ? v[field] : GUIDE_DEFAULTS[field];
    const tips = Array.isArray(v.tipsShown) ? v.tipsShown.filter(tip => typeof tip === "string" && /^[A-Za-z]{1,30}$/.test(tip)) : [];
    return {
      welcome: pick("welcome", ["", "done", "skipped"]),
      tour: pick("tour", ["", "done", "skipped"]),
      generated: v.generated === true,
      copied: v.copied === true,
      checklist: pick("checklist", ["auto", "hidden", "shown"]),
      startHereDismissed: v.startHereDismissed === true,
      tipsShown: [...new Set(tips)].slice(0, 30),
      tourNotice: v.tourNotice === true
    };
  }
  /* One AI service (an /ai/status providers[] entry) is connected when it is set up,
     switched on, its key wasn't turned down and its last check didn't fail
     ("checked": "ok" | "failed" | "", "" until it is tested or used). It may be resting. */
  function serviceConnected(p) {
    return Boolean(p && typeof p === "object" && p.configured === true && p.enabled !== false && p.state !== "disabled" &&
      p.state !== "key_rejected" && p.checked !== "failed");
  }
  // Some AI service is connected (serviceConnected); an error answer has none.
  function aiConnected(status) {
    return Boolean(status && typeof status === "object" && Array.isArray(status.providers) && status.providers.some(serviceConnected));
  }
  /* One service in plain words, as its chip in Settings › AI says it (tone "ready" | "warn" |
     "err" | ""): Ready, Not set up, Off, Key rejected, Test failed or Resting 40 s. */
  function aiServiceState(p) {
    const s = p && typeof p === "object" ? p : {};
    if (s.configured !== true || s.state === "off") return {text: "Not set up", tone: ""};
    if (s.enabled === false || s.state === "disabled") return {text: "Off", tone: ""};
    if (s.state === "key_rejected") return {text: "Key rejected", tone: "err"};
    if (s.state === "ready") return s.checked === "failed" ? {text: "Test failed", tone: "err"} : {text: "Ready", tone: "ready"};
    const wait = Number.isSafeInteger(s.retry_in) && s.retry_in > 0 ? s.retry_in : 0;
    return {text: wait ? "Resting " + wait + " s" : "Resting", tone: "warn"};
  }
  /* The first /ai/status answer of a page load. Nothing connected and the welcome
     never finished or skipped: open the welcome. Already connected (an upgrade from
     v0.1, or keys set up another way): never the welcome; the tour once as a Notice
     unless it was taken or skipped; no checklist when there are Recent drafts. */
  function firstRunPlan(guide, status, hasDrafts) {
    const g = normalizeGuide(guide);
    if (g.welcome) return {welcome: false, notice: false, patch: {}};
    if (!aiConnected(status)) return {welcome: true, notice: false, patch: {}};
    const patch = {welcome: "skipped"};
    const notice = !g.tour && !g.tourNotice;
    if (notice) patch.tourNotice = true;
    if (hasDrafts && g.checklist === "auto") patch.checklist = "hidden";
    return {welcome: false, notice, patch};
  }
  // "full" (the checklist in place of the empty state), "strip" (one line above a
  // listing that isn't copied yet) or "none".
  function guideMode(guide, hasListing, touring) {
    const g = normalizeGuide(guide);
    if (touring || g.checklist === "hidden") return "none";
    if (g.checklist === "shown") return "full";
    if (g.copied) return "none";
    return hasListing ? "strip" : "full";
  }
  // The four checklist steps, each ticked from real state; now = the first one not done (-1: all done).
  function setupSteps(facts) {
    const f = facts || {};
    const copied = f.copied === true, generated = copied || f.generated === true;
    const done = [f.connected === true, generated || f.described === true, generated, copied];
    return {done, now: done.indexOf(false)};
  }
  /* The header AI button. setup: it starts the AI setup (nothing connected, the saved
     keys can't be read, or every service is switched off); otherwise it opens Settings › AI.
     AI ready: a connected service is ready now. Otherwise the soonest connected service
     to come back says how long: AI busy · 30 s when it was too busy (a rate limit), AI
     offline · 30 s when it couldn't be reached or took too long. */
  function aiPill(status) {
    if (!status || typeof status !== "object") return {tone: "off", text: "AI offline", setup: false};
    const usable = Array.isArray(status.providers) ? status.providers.filter(serviceConnected) : [];
    if (!usable.length) return {tone: "setup", text: "Set up AI", setup: true};
    if (usable.some(p => p.state === "ready")) return {tone: "ready", text: "AI ready", setup: false};
    const waitOf = p => Number.isSafeInteger(p.retry_in) && p.retry_in > 0 ? p.retry_in : 0;
    const resting = usable.filter(waitOf).sort((a, b) => waitOf(a) - waitOf(b));
    const soonest = resting[0];
    const wait = soonest ? waitOf(soonest) : Number.isSafeInteger(status.retry_in) && status.retry_in > 0 ? status.retry_in : 0;
    const busy = soonest ? soonest.state === "rate_limited" : usable.some(p => p.state === "rate_limited");
    if (busy && wait) return {tone: "busy", text: "AI busy · " + wait + " s", setup: false};
    return {tone: "off", text: "AI offline" + (wait ? " · " + wait + " s" : ""), setup: false};
  }
  /* Where a box of `size` goes beside `anchor` (a rect) inside `viewport`: the first
     side in `order` with room, else the side with the most room; then moved along
     that side so it stays `margin` inside the viewport. align "start" puts the arrow
     near the box's start instead of centring the box. arrow: the anchor's centre,
     measured from the box's left (above/below) or top (left/right) edge. */
  function placeFloating(anchor, size, viewport, options) {
    const o = options || {};
    const gap = o.gap == null ? 10 : o.gap, margin = o.margin == null ? 8 : o.margin, inset = o.arrowInset == null ? 16 : o.arrowInset;
    const order = Array.isArray(o.order) && o.order.length ? o.order : ["below", "above", "right", "left"];
    const room = {
      below: viewport.height - anchor.bottom - gap - margin, above: anchor.top - gap - margin,
      right: viewport.width - anchor.right - gap - margin, left: anchor.left - gap - margin
    };
    const fits = side => room[side] - (side === "below" || side === "above" ? size.height : size.width);
    const side = order.find(s => fits(s) >= 0) || order.reduce((best, s) => fits(s) > fits(best) ? s : best, order[0]);
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    let left, top, arrow;
    if (side === "below" || side === "above") {
      const centre = (anchor.left + anchor.right) / 2;
      left = clamp(o.align === "start" ? centre - inset - 8 : centre - size.width / 2, margin, viewport.width - margin - size.width);
      top = clamp(side === "below" ? anchor.bottom + gap : anchor.top - gap - size.height, margin, viewport.height - margin - size.height);
      arrow = clamp(centre - left, inset, size.width - inset);
    } else {
      const middle = (anchor.top + anchor.bottom) / 2;
      left = clamp(side === "right" ? anchor.right + gap : anchor.left - gap - size.width, margin, viewport.width - margin - size.width);
      top = clamp(middle - size.height / 2, margin, viewport.height - margin - size.height);
      arrow = clamp(middle - top, inset, size.height - inset);
    }
    return {side, left: Math.round(left), top: Math.round(top), arrow: Math.round(arrow)};
  }
  /* The approved tip texts (owner-approved, v0.2.0). Field tips open from an (i)
     button beside the label; button tips show on hover and keyboard focus. */
  const GUIDE_TIPS = Object.freeze({
    startHere: {title: "Start here", text: "Start here: type what you're selling, like “Canon AE-1 camera”. This marker goes once you type."},
    product: {title: "Product name or model", text: "The make and model buyers search for. Used in the title and by Look up."},
    lookup: {title: "Look up", text: "Optional. Finds other sellers' eBay listings for this product so you can borrow their specs. Needs a free eBay developer key (Settings › eBay). You can skip it."},
    keywords: {title: "Find keywords", text: "Optional. Shows the words other sellers put in their titles. Needs the same eBay key."},
    describe: {title: "Describe the item", text: "Write it the way you'd tell a friend: what it is, what you tested, what's wrong with it. The AI never adds flaws or claims you didn't write."},
    included: {title: "What's included", text: "Type one thing, then press Enter or a comma: charger, box, manual."},
    condition: {title: "Condition", text: "Pick only what you've checked. Untested stays untested. EUC, VGUC and GUC mean excellent, very good and good used condition."},
    conditionNotes: {title: "Condition notes", text: "The exact flaws. Copied into the listing word for word."},
    brand: {title: "Brand", text: "Leave it empty if you're not sure."},
    bundle: {title: "Bundle / lot", text: "Selling several things together? Describe the lot; each line becomes an item card you can check."},
    newListing: {title: "New listing", text: "Clears every field and starts a fresh listing. The one you're on is saved in Drafts › Recent drafts, and Undo brings it back."},
    generate: {title: "Generate listing", text: "Writes the title and description from your notes, usually in 10–30 seconds."},
    copyHtml: {title: "Copy HTML", text: "In eBay's listing form, switch the description box to HTML (the < > button), paste, then check the preview."},
    regenerate: {title: "Regenerate…", text: "Rewrites only the title, the description or the highlights. Ready after your first listing."},
    editContent: {title: "Edit content", text: "Fix any wording yourself; the layout rebuilds around it."},
    shuffle: {title: "Shuffle look", text: "Tries another layout and colours."},
    drafts: {title: "Drafts", text: "Your last 10 listings and your templates, kept in this browser on this computer."},
    aiStatus: {title: "AI status", text: "Shows whether an AI service is connected. Click to set one up or check it."}
  });
  // The six tour stops, in order (the targets live in index.html).
  const TOUR_STOPS = Object.freeze([
    {id: "start", title: "Start here", text: "Type what you're selling, like “Canon AE-1 camera”. Look up and Find keywords next to it are optional."},
    {id: "describe", title: "Describe the item", text: "Write it the way you'd tell a friend: what it is, what you tested, what's wrong with it."},
    {id: "condition", title: "Condition", text: "Pick only what you've checked. Untested stays untested."},
    {id: "generate", title: "Generate listing", text: "Writes the title and description from your notes, usually in 10–30 seconds."},
    {id: "review", title: "Review", text: "Check every detail. Edit the title here, or use Edit content to fix any wording."},
    {id: "copy", title: "Copy into eBay", text: "In eBay's listing form, switch the description box to HTML (the < > button), paste, then check the preview."}
  ].map(Object.freeze));

  const api = {LIMITS, normalizeCandidates, normalizeSourcedReference, canonicalTitle, normalizeBarcode, normalizeListing, normalizeReference, conditionLabels, conditionClass, applySellerCondition, applySellerBrands, linkBundleCards, bundleBrandSummary, detectBrand, parseBundleItems, splitListItems, findContactDetail, memberSinceText, positivePercent, titleKeywords, normalizeSearchSources,
    ERROR_MESSAGES, hasJargon, isPlainMessage, plainError, errorNote, errorFix, AI_LABELS, cleanPastedKey, recognizeKey, TOAST_TIMES, toastLife,
    GUIDE_DEFAULTS, normalizeGuide, serviceConnected, aiConnected, aiServiceState, firstRunPlan, guideMode, setupSteps, aiPill, placeFloating, GUIDE_TIPS, TOUR_STOPS};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ListingCore = api;
})(typeof window !== "undefined" ? window : globalThis);
