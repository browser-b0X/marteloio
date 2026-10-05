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
  function pairBundleItems(items, sources) {
    const key = value => String(value || "").trim().toLowerCase();
    const positional = items.length === sources.length;
    return items.map((item, i) => {
      const hits = positional ? [sources[i]] : sources.filter(source => key(source.name) === key(item.name));
      return hits.length === 1 ? hits[0] : null;
    });
  }
  function applySellerCondition(data, snapshot) {
    data.condition_rating = sellerCondition(snapshot.condition);
    data.condition_notes = snapshot.notes || "";
    // Condition is displayed separately using seller input, never model specs.
    data.item_specifics = Object.fromEntries(Object.entries(data.item_specifics)
      .filter(([key]) => !/\bcondition\b/i.test(key)));
    pairBundleItems(data.bundle_items, snapshot.items).forEach((hit, i) => {
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
      data.bundle_items[i].brand = hit ? cleanBrand(hit.brand) : "";
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
  /* Bundle description -> item names. Deterministic and conservative: a
     fragment that reads like a note about the item (a sentence, a verb such
     as "works" or "missing", more than eight words) is skipped rather than
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
  function splitItemFragments(line) {
    const parts = [];
    let depth = 0, current = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i], before = line[i - 1] || "", after = line[i + 1] || "";
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch) && depth) depth--;
      const separator = !depth && (ch === ";" || SEPARATOR_BULLETS.includes(ch) ||
        (ch === "," && !(/\d/.test(before) && /\d/.test(after))) ||
        (ch === "+" && /\s/.test(before) && /\s/.test(after)) ||
        (ch === "&" && /\s/.test(before) && /\s/.test(after) && ampersandSplits(line, i)));
      if (separator) { parts.push(current); current = ""; } else current += ch;
    }
    parts.push(current);
    return parts;
  }
  // "Mario & Luigi" is one title; "Zelda BOTW & Pro controller" is two items.
  function ampersandSplits(line, index) {
    const words = text => text.trim().split(/\s+/).filter(Boolean).length;
    const left = line.slice(0, index).split(/[;,+&\u2022\u00b7]/).pop(), right = line.slice(index + 1).split(/[;,+&\u2022\u00b7]/)[0];
    // Lowercase common nouns ("dock & charger") are separate items too.
    const lower = text => /^[\p{Ll}\p{N}]/u.test(text.trim());
    return (words(left) >= 2 && words(right) >= 2) || (lower(left.trim().split(/\s+/).pop() || "") && lower(right));
  }
  // Split "all games tested. Mario Kart 8" into sentences, keeping "Dr. Mario",
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
      const sentences = splitSentences(body);
      // In a multi-sentence line, a prose sentence ("Shutter fires at every speed.") is a note.
      const kept = sentences.length > 1 ? sentences.filter(x => x.includes(",") || looksLikeTitle(x.trim()) || x.trim().split(/\s+/).length < 4) : sentences;
      for (const fragment of kept.flatMap(splitItemFragments)) {
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
      throw new Error("Invalid reference provenance. Select the listing again.");
    const allowed = new Set(['brand','model','mpn','gtin','upc','ean','isbn','color','colour','material','type','connectivity','storage capacity','screen size','processor','ram size','maximum resolution','mount','focal length','maximum aperture','compatible brand','compatible model']);
    const specs = Object.fromEntries(Object.entries(textMap(ref.data && ref.data.key_specs, "reference specs", 30, 100, 1000)).filter(([key]) => allowed.has(key.toLowerCase())));
    if (!Object.keys(specs).length) throw new Error("No product specifications to review.");
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
  const api = {LIMITS, normalizeCandidates, normalizeSourcedReference, canonicalTitle, normalizeBarcode, normalizeListing, normalizeReference, conditionLabels, conditionClass, applySellerCondition, applySellerBrands, bundleBrandSummary, detectBrand, parseBundleItems, titleKeywords, normalizeSearchSources};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ListingCore = api;
})(typeof window !== "undefined" ? window : globalThis);
