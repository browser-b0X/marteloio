/* Test-only fixture: network is replaced BEFORE the real application starts.
   Deliberately ignore AbortSignal to prove stale-result checks independently.
   Only served by serve_frontend_checks.py, never by the production relay. */
(() => {
  const pending = [];
  let holdSession = false;
  let holdSettings = false;
  let aiStatus = {ready: true, retry_in: 0, providers: [{id: "groq", label: "Groq", configured: true, state: "ready", retry_in: 0, model: "fixture-model"}]};
  const reply = data => ({ok: true, status: 200, json: async () => data});
  window.fetch = async (path, opts = {}) => {
    if (path === "/session") {
      if (holdSession) { holdSession = false; return new Promise(resolve => pending.push({path, opts, resolve})); }
      return reply({token: "fixture-only"});
    }
    if (path === "/ai/status") return reply(aiStatus);
    if (path === "/settings" && opts.method !== "POST") {
      if (holdSettings) { holdSettings = false; return new Promise(resolve => pending.push({path, opts, resolve})); }
      return reply({});
    }
    if ((path === "/settings" || path === "/settings/ebay") && opts.method === "POST") return new Promise(resolve => pending.push({path, opts, resolve}));
    if (path.startsWith('/ebay/authorize-url?') || path === '/ebay/token-user' || path === '/ebay/userstats') return new Promise(resolve => pending.push({path, opts, resolve}));
    if (path === "/llm/chat/completions" || path.startsWith("/ebay/search?") || path.startsWith("/ebay/reference?")) {
      return new Promise(resolve => pending.push({path, opts, resolve}));
    }
    throw new Error("Fixture blocked unexpected request: " + path);
  };
  // This is an ephemeral test origin, never the user's app origin.
  const barcodeReload = new URLSearchParams(location.search).has("barcode-reload");
  const barcodeReloadStage = barcodeReload ? sessionStorage.getItem("fixture.barcodeReload") : null;
  const themeReload = new URLSearchParams(location.search).has("theme-reload");
  const themeReloadStage = themeReload ? sessionStorage.getItem("fixture.themeReload") : null;
  if (!barcodeReloadStage && !themeReloadStage) {
    localStorage.clear();
    localStorage.setItem("eb.appTheme", "dark");
    localStorage.setItem("eb.draft.v1", JSON.stringify({version: 1, inputs: {notes: "Restored fixture draft"}}));
  }
  const blockedStorageBoot = new URLSearchParams(location.search).has("storage-blocked");
  if (blockedStorageBoot) {
    for (const name of ["getItem", "setItem", "removeItem"]) Storage.prototype[name] = function() { throw new DOMException("Fixture blocked storage", "SecurityError"); };
  }
  window.confirm = () => true;
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const listing = title => ({title, description_paragraphs: ["Seller observed light wear."], item_specifics: {Brand: "Fixture"}});
  const complete = (request, data) => request.resolve(reply({model: "fixture", choices: [{message: {content: JSON.stringify(data)}}]}));

  document.addEventListener("DOMContentLoaded", async () => {
    const panel = document.createElement("section");
    panel.id = "regression-results";
    panel.style.cssText = "position:relative;z-index:10000;background:white;color:#111;padding:24px;border:4px solid #2563eb;margin:20px";
    document.body.prepend(panel);
    const title = document.createElement("h2");
    title.textContent = "Regression checks running";
    panel.append(title);
    let passed = 0;
    function check(condition, label) {
      if (!condition) throw new Error(label);
      passed++;
      const line = document.createElement("p"); line.textContent = "PASS: " + label; panel.append(line);
    }
    async function nextRequest() {
      for (let i = 0; i < 30 && !pending.length; i++) await tick();
      if (!pending.length) throw new Error("Expected a pending fixture request");
      return pending.shift();
    }
    function setupBundle(names) {
      applyDraft({inputs: {}, mode: "bundle", bundleItems: names.map(name => ({name, notes: "Original " + name}))});
      renderDraft();
    }
    try {
      if (themeReload) {
        const stages = ["dark", "light", "system"];
        const index = themeReloadStage ? Number(themeReloadStage) : 0;
        const expected = stages[index] === "dark" ? "dark" : "light";
        check(document.documentElement.dataset.theme === expected && $("appTheme").value === expected,
          "Real reload restores " + stages[index] + " as " + expected);
        const logo = document.querySelector(".brand-artwork img"); await logo.decode();
        check(getComputedStyle(logo).display !== "none" && logo.naturalWidth === 256 &&
          $("brandIcon").getAttribute("href").endsWith("marteloio-" + expected + "-64.png"),
          "Real reload loads the approved mark and matching favicon");
        if (index < 2) {
          if (index === 0) $("themeToggle").click();
          else localStorage.setItem(APP_THEME_KEY, "system");
          sessionStorage.setItem("fixture.themeReload", String(index + 1));
          location.reload(); return;
        }
        sessionStorage.removeItem("fixture.themeReload");
        title.textContent = "6 theme/logo reload checks passed across dark, light and legacy System";
        panel.dataset.result = "pass"; return;
      }
      if (barcodeReload) {
        if (!barcodeReloadStage) {
          newListing();
          $("productBarcode").value = "027242923232";
          $("productBarcode").dispatchEvent(new Event("input", {bubbles:true}));
          await new Promise(resolve => setTimeout(resolve, 650));
          check(JSON.parse(localStorage.getItem(DRAFT_KEY)).inputs.productBarcode === "027242923232",
            "Reload fixture first saves a populated barcode");
          sessionStorage.setItem("fixture.barcodeReload", "populated");
          location.reload();
          return;
        }
        if (barcodeReloadStage === "populated") {
          check($("productBarcode").value === "027242923232", "Populated barcode survives a real reload");
          $("productBarcode").value = "";
          $("productBarcode").dispatchEvent(new Event("input", {bubbles:true}));
          sessionStorage.setItem("fixture.barcodeReload", "cleared");
          // Intentionally reload before the debounce: page lifecycle must save.
          location.reload();
          return;
        }
        check(barcodeReloadStage === "cleared", "Reload fixture reached the final stage");
        check(JSON.parse(localStorage.getItem(DRAFT_KEY)).inputs.productBarcode === "",
          "Real reload persists the cleared barcode before debounce");
        check($("productBarcode").value === "" && !draftHasContent(),
          "Real reload restores an empty final barcode without stale input");
        sessionStorage.removeItem("fixture.barcodeReload");
        title.textContent = passed + " barcode reload checks passed";
        panel.dataset.result = "pass";
        return;
      }
      if (blockedStorageBoot) {
        check($("appTheme").value === "light", "Blocked theme storage defaults to Light");
        $("appTheme").value = "light";
        $("appTheme").dispatchEvent(new Event("change"));
        check(document.documentElement.dataset.theme === "light", "Blocked theme writes preserve the current selection in session");
        check($("condition").value === "" && $("styleChoice").value === "auto", "App initializes defaults when all localStorage access is blocked");
        $("notes").value = "Session-only notes"; $("notes").dispatchEvent(new Event("input", {bubbles:true}));
        flushDraft();
        check($("notes").value === "Session-only notes" && !$("generateBtn").disabled, "Blocked storage preserves in-session work and usable controls");
        title.textContent = passed + " blocked-storage browser checks passed";
        panel.dataset.result = "pass";
        return;
      }
      const brandSample = ListingCore.normalizeListing({
        title: "Aurora camera kit <seller title>",
        description_paragraphs: ["Seller observed light wear. <script>text only</script>"],
        condition_rating: "USED", condition_notes: "Small scratch on the base.",
        item_specifics: {Brand:"Aurora", Model:"C1 & C2"},
        included_items:["Camera body", "Strap"], not_included:["Battery"],
        buyer_notes:["Review the seller photos."],
        bundle_items:[{name:"Camera body", condition:"Used", description:"Small scratch."},
          {name:"Strap", condition:"Used", description:"Light wear."}]
      });
      if (new URLSearchParams(location.search).has("brand-review")) {
        document.querySelector("main").style.display = "none";
        document.querySelector("header").after(panel);
        panel.replaceChildren();
        panel.style.cssText = "margin:20px auto;padding:16px;max-width:980px;background:var(--surface);color:var(--ink)";
        const choice = document.createElement("select"); choice.id = "reviewStyle"; choice.setAttribute("aria-label", "Review style");
        choice.innerHTML = [...STYLE_ARCHES, {id:"simple",label:"Simple HTML"}].map(x => '<option value="'+x.id+'">'+x.label+'</option>').join('');
        const mode = document.createElement("select"); mode.id="reviewMode"; mode.setAttribute("aria-label","Review mode");
        mode.innerHTML='<option value="single">Single item</option><option value="bundle">Bundle</option>';
        const width = document.createElement("select"); width.id="reviewWidth"; width.setAttribute("aria-label","Review width");
        width.innerHTML='<option value="920">Desktop 920px</option><option value="390">Mobile 390px</option>';
        const frame = document.createElement("iframe"); frame.id="brandReviewFrame"; frame.title="Branded export review";
        frame.style.cssText="display:block;max-width:100%;height:1500px;border:0;margin-top:12px";
        frame.onload = () => { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 20 + "px"; };
        const render = () => {
          $("styleChoice").value=choice.value; state.mode=mode.value; state.styleSeed=0;
          frame.style.width=width.value+'px'; frame.style.height='1px';
          frame.srcdoc=buildListingHTML(brandSample,"Example seller",brandSample.title,{},"listing");
        };
        for (const control of [choice,mode,width]) control.addEventListener("change",render);
        panel.append(choice,mode,width,frame); render(); return;
      }
      check($("notes").value === "Restored fixture draft", "Saved draft boots after all helpers initialize");
      const originalMotion = Object.getOwnPropertyDescriptor(motionMedia, "matches");
      const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
      Object.defineProperty(document, "hidden", {configurable:true, value:false});
      const setMotion = reduced => {
        Object.defineProperty(motionMedia, "matches", {configurable:true, value:reduced});
        motionMedia.dispatchEvent(new Event("change"));
      };
      try {
        setMotion(true);
        check(!starsEnabled && !starInitRaf && !warpRaf && !document.getElementById("starStyle"), "Reduced motion cancels star work and removes generated particles");
        window.dispatchEvent(new Event("resize"));
        check(!starResizeTimer, "Resizing under reduced motion schedules no star work");
        setMotion(false);
        check(starsEnabled && document.querySelectorAll("#starStyle").length === 1, "Disabling reduced motion initializes stars without refresh");
        const pendingStarInit = starInitRaf;
        setMotion(false);
        check(starInitRaf === pendingStarInit && document.querySelectorAll("#starStyle").length === 1, "Repeated motion events do not duplicate initialization");
        window.dispatchEvent(new Event("resize"));
        setMotion(true);
        check(!starResizeTimer && !starInitRaf && !warpRaf, "Motion toggle cancels pending resize and animation callbacks");
        setMotion(false);
        window.dispatchEvent(new Event("resize"));
        Object.defineProperty(document, "hidden", {configurable:true, value:true});
        document.dispatchEvent(new Event("visibilitychange"));
        check(!starsEnabled && !starResizeTimer && !starInitRaf && !warpRaf &&
          document.documentElement.dataset.pageHidden === "true", "Hidden page stops star work and marks decorative CSS paused");
        Object.defineProperty(document, "hidden", {configurable:true, value:false});
        document.dispatchEvent(new Event("visibilitychange"));
        check(starsEnabled && document.documentElement.dataset.pageHidden === "false", "Visible page resumes stars when motion is allowed");
        setMotion(true);
        document.dispatchEvent(new Event("visibilitychange"));
        check(!starsEnabled, "Returning to the page respects reduced motion");
      } finally {
        if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
        else delete document.hidden;
        if (originalMotion) Object.defineProperty(motionMedia, "matches", originalMotion);
        else delete motionMedia.matches;
        motionMedia.dispatchEvent(new Event("change"));
      }
      check($("appTheme").value === "dark" && document.documentElement.dataset.theme === "dark", "Saved theme restores during app startup");
      check($("themeToggle").getAttribute("aria-checked") === "true", "Theme switch announces restored dark appearance");
      $("themeToggle").click();
      check(localStorage.getItem(APP_THEME_KEY) === "light" && $("themeToggle").getAttribute("aria-checked") === "false", "Sun/moon switch changes and saves light appearance");
      $("themeToggle").click();
      check(localStorage.getItem(APP_THEME_KEY) === "dark", "Sun/moon switch changes and saves dark appearance");
      check(!$("themeSystem") && document.querySelectorAll(".theme-control button").length === 1, "Only the manual Light/Dark switch remains");
      $("appTheme").value = "light";
      $("appTheme").dispatchEvent(new Event("change"));
      check(localStorage.getItem(APP_THEME_KEY) === "light", "Theme selection saves independently of the draft");
      restoreAppTheme();
      check($("appTheme").value === "light" && document.documentElement.dataset.theme === "light", "Saved light theme restores correctly");
      for (const legacy of ["system", "unexpected"]) {
        localStorage.setItem(APP_THEME_KEY, legacy); restoreAppTheme();
        check($("appTheme").value === "light" && document.documentElement.dataset.theme === "light",
          legacy + " stored preference safely falls back to explicit Light");
      }
      $("appTheme").value = "dark"; $("appTheme").dispatchEvent(new Event("change"));
      window.matchMedia("(prefers-color-scheme: dark)").dispatchEvent(new Event("change"));
      check(document.documentElement.dataset.theme === "dark", "OS theme event cannot override manual choice");
      localStorage.setItem(APP_THEME_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", {key:APP_THEME_KEY, newValue:"light", storageArea:localStorage}));
      check($("appTheme").value === "dark", "Cross-tab theme sync reads current storage rather than stale event data");
      localStorage.removeItem(APP_THEME_KEY);
      window.dispatchEvent(new StorageEvent("storage", {key:null, storageArea:localStorage}));
      check($("appTheme").value === "light", "Cross-tab storage clearing restores Light theme");
      localStorage.setItem(APP_THEME_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", {key:APP_THEME_KEY, storageArea:sessionStorage}));
      check($("appTheme").value === "light", "Session storage events cannot change app appearance");
      check($("returnsPolicy").value === "listing", "Returns defaults to eBay listing settings");
      $("notes").value = "Last edit before leaving";
      $("notes").dispatchEvent(new Event("input", {bubbles:true}));
      window.dispatchEvent(new Event("pagehide"));
      check(JSON.parse(localStorage.getItem(DRAFT_KEY)).inputs.notes === "Last edit before leaving" && draftTimer === 0, "Leaving flushes pending autosave immediately");
      $("notes").value = "An unscheduled test change";
      window.dispatchEvent(new Event("pagehide"));
      check(JSON.parse(localStorage.getItem(DRAFT_KEY)).inputs.notes === "Last edit before leaving", "Lifecycle event without pending edits does not rewrite saved draft");
      newListing();
      $("titleIn").value = "Title-only draft"; $("titleIn").dispatchEvent(new Event("input", {bubbles:true}));
      newListing();
      check(loadHistory()[0].draft.inputs.titleIn === "Title-only draft", "New listing preserves title-only work in history");
      $("htmlOut").value = "<p>Manually written draft</p>"; $("htmlOut").dispatchEvent(new Event("input", {bubbles:true}));
      newListing();
      const manual = loadHistory()[0].draft;
      check(manual.html === "<p>Manually written draft</p>" && manual.data === null, "New listing preserves HTML-only work in history");
      applyDraft(manual); renderDraft();
      check($("htmlOut").value === manual.html && $("preview").srcdoc === manual.html && !$("copyHtmlBtn").disabled, "HTML-only history restores editor, preview and exports");
      applyDraft({inputs:{notes:"Recover these notes",productSearch:"Camera"}, data:{title:"Broken", description_paragraphs:{}}, html:"<p>Recover this HTML</p>", reference:{q:"Camera",data:{product_name:[]}}});
      renderDraft();
      check(state.data === null && state.edited && $("notes").value === "Recover these notes" && $("htmlOut").value === "<p>Recover this HTML</p>", "Invalid saved listing recovers input and HTML without rendering failure");
      check(state.reference === null && $("restructureBtn").style.display === "none", "Invalid saved reference is discarded and unavailable rebuild is hidden");
      const historyBefore = localStorage.getItem(HISTORY_KEY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify([null, 5, [], {draft:[]}, {draft:manual,title:"Recovered entry"}]));
      renderHistory();
      check(loadHistory().length === 1 && $("historyList").textContent.includes("Recovered entry"), "Malformed history entries do not hide valid recoverable drafts");
      localStorage.setItem(HISTORY_KEY, historyBefore || "[]");
      check(applyDraft([]) === false && $("notes").value === "Recover these notes", "Invalid draft root cannot erase current work");
      const originalStorageWrite = Storage.prototype.setItem;
      const historySnapshot = localStorage.getItem(HISTORY_KEY);
      Storage.prototype.setItem = function(key, value) {
        if (key === HISTORY_KEY) throw new DOMException("Fixture quota", "QuotaExceededError");
        return originalStorageWrite.call(this, key, value);
      };
      try {
        newListing();
        check($("notes").value === "Recover these notes" && state.html === "<p>Recover this HTML</p>", "Failed history save prevents New listing from clearing current work");
        duplicateDraft();
        const failedHistoryToasts = document.querySelectorAll(".toast.err p");
        check(failedHistoryToasts[failedHistoryToasts.length - 1].textContent.includes("Could not save to Recent drafts"), "Duplicate reports history save failure");
        check(localStorage.getItem(HISTORY_KEY) === historySnapshot, "Failed history writes preserve previously saved history");
      } finally {
        Storage.prototype.setItem = originalStorageWrite;
        if (historySnapshot === null) localStorage.removeItem(HISTORY_KEY);
        else localStorage.setItem(HISTORY_KEY, historySnapshot);
      }
      Storage.prototype.setItem = function() { throw new DOMException("Fixture blocked storage", "SecurityError"); };
      try {
        check(persistDraft("fixture") === false, "Unavailable storage terminates autosave recovery instead of looping");
      } finally { Storage.prototype.setItem = originalStorageWrite; }
      const quotaHistory = JSON.stringify([{draft:{inputs:{notes:'newer history'}},title:'Newer'}, {draft:{inputs:{notes:'older history'}},title:'Older'}]);
      localStorage.setItem(HISTORY_KEY, quotaHistory);
      const draftBeforeQuota = localStorage.getItem(DRAFT_KEY);
      Storage.prototype.setItem = function(key, value) {
        if (key === DRAFT_KEY) throw new DOMException('Fixture oversized draft', 'QuotaExceededError');
        return originalStorageWrite.call(this, key, value);
      };
      try {
        check(!persistDraft('too large') && localStorage.getItem(HISTORY_KEY) === quotaHistory && localStorage.getItem(DRAFT_KEY) === draftBeforeQuota, "An unsavable draft restores evicted history and preserves the previous autosave");
      } finally { Storage.prototype.setItem = originalStorageWrite; }
      Storage.prototype.setItem = function(key, value) {
        if (key === DRAFT_KEY && loadHistory().length > 1) throw new DOMException('Fixture needs space', 'QuotaExceededError');
        return originalStorageWrite.call(this, key, value);
      };
      try {
        check(persistDraft('fits after eviction') && loadHistory().length === 1 && loadHistory()[0].title === 'Newer', "Quota recovery removes only as much old history as needed for a successful save");
        check([...document.querySelectorAll('.toast.note p')].at(-1)?.textContent.includes('oldest Recent draft was removed'), "Quota recovery tells the seller that an old Recent draft was removed");
      } finally { Storage.prototype.setItem = originalStorageWrite; }
      const retainedHistory = localStorage.getItem(HISTORY_KEY);
      let draftWriteAttempts = 0;
      const otherTabHistory = JSON.stringify([{draft:{inputs:{notes:'Other tab work'}},title:'Other tab'}]);
      Storage.prototype.setItem = function(key, value) {
        if (key === DRAFT_KEY) {
          if (++draftWriteAttempts === 2) originalStorageWrite.call(this, HISTORY_KEY, otherTabHistory);
          throw new DOMException('Fixture quota', 'QuotaExceededError');
        }
        return originalStorageWrite.call(this, key, value);
      };
      try {
        check(!persistDraft('still too large') && localStorage.getItem(HISTORY_KEY) === otherTabHistory, "Failed autosave does not roll back over a detected history change from another tab");
      } finally {
        Storage.prototype.setItem = originalStorageWrite;
        localStorage.setItem(HISTORY_KEY, retainedHistory);
      }
      Storage.prototype.setItem = function(key, value) {
        if (key === DRAFT_KEY) throw new DOMException('Fixture policy', 'SecurityError');
        return originalStorageWrite.call(this, key, value);
      };
      try {
        check(!persistDraft('blocked') && localStorage.getItem(HISTORY_KEY) === retainedHistory, "Non-quota storage failures do not evict history");
      } finally { Storage.prototype.setItem = originalStorageWrite; }
      $("notes").value = 'Current work before history restore';
      check(restoreHistoryDraft({inputs:{notes:'Selected history draft'}}) && $("notes").value === 'Selected history draft' && loadHistory()[0].draft.inputs.notes === 'Current work before history restore', "History restore saves the current draft before replacing it");
      Storage.prototype.setItem = function(key, value) {
        if (key === HISTORY_KEY) throw new DOMException('Fixture quota', 'QuotaExceededError');
        return originalStorageWrite.call(this, key, value);
      };
      try {
        check(!restoreHistoryDraft({inputs:{notes:'Must not replace'}}) && $("notes").value === 'Selected history draft', "Failed history preservation blocks replacement of current work");
      } finally { Storage.prototype.setItem = originalStorageWrite; }
      newListing(); $("notes").value = "Restored fixture draft";
      check($("copyHtmlBtn").disabled && $("downloadBtn").disabled && $("copyTitleBtn").disabled, "Empty draft disables export controls");
      $("modeBundle").click();
      check($("modeBundle").getAttribute("aria-pressed") === "true" && $("modeSingle").getAttribute("aria-pressed") === "false", "Bundle selection announces pressed state");
      $("modeSingle").click();
      check($("modeSingle").getAttribute("aria-pressed") === "true" && $("modeBundle").getAttribute("aria-pressed") === "false", "Single selection announces pressed state");
      check(document.querySelector('label[for="includedInput"]').control === $("includedInput"), "Included label targets its input");
      const overlay = $("settingsOverlay"); overlay.classList.add("open");
      const link = document.createElement("a"); link.href = "#fixture"; link.textContent = "Fixture last link"; overlay.querySelector(".modal").append(link);
      link.focus(); link.dispatchEvent(new KeyboardEvent("keydown", {key:"Tab", bubbles:true, cancelable:true}));
      check(document.activeElement === $("closeSettingsX"), "Settings keyboard loop wraps from final link");
      $("closeSettingsX").dispatchEvent(new KeyboardEvent("keydown", {key:"Tab", shiftKey:true, bubbles:true, cancelable:true}));
      check(document.activeElement === link, "Settings reverse keyboard loop includes links");
      link.remove(); closeSettings();

      const first = generate(); const old = await nextRequest();
      newListing();
      check(old.opts.signal.aborted && !$("generateBtn").disabled, "New listing cancels generation and releases controls");
      $("notes").value = "Newer item";
      const second = generate(); const newer = await nextRequest();
      complete(old, listing("Obsolete listing")); await first;
      check(state.data === null && $("generateBtn").disabled, "Old result and cleanup cannot affect newer generation");
      complete(newer, listing("Current listing")); await second;
      check(state.data.title === "Current listing" && !$("generateBtn").disabled, "Current generation completes normally");
      check(!$("copyHtmlBtn").disabled && !$("downloadBtn").disabled && !$("copyTitleBtn").disabled, "Generated draft enables export controls");
      $("titleIn").value = ''; $("titleIn").dispatchEvent(new Event('input', {bubbles:true}));
      check(listingTitle() === '' && $("copyTitleBtn").disabled && !state.html.includes('class="elb-title"'), "Clearing the title disables title copy and removes the old generated heading");
      const clearedTitleDraft = JSON.parse(JSON.stringify(snapshotDraft()));
      applyDraft(clearedTitleDraft); renderDraft();
      check($("titleIn").value === '' && listingTitle() === '' && $("copyTitleBtn").disabled, "An intentionally blank title stays blank after draft restoration");
      const legacyTitleDraft = JSON.parse(JSON.stringify(clearedTitleDraft)); delete legacyTitleDraft.inputs.titleIn;
      applyDraft(legacyTitleDraft); renderDraft();
      check($("titleIn").value === 'Current listing' && !$("copyTitleBtn").disabled, "Legacy drafts without a title field recover their structured title visibly");
      check(!buildSimpleHTML(state.data, '', '', 'listing').includes('<h1>'), "Simple HTML also respects an explicitly cleared title");
      flushDraft();
      applyStyleChange(() => { state.styleSeed = 7654321; });
      check(Boolean(draftTimer), "Changing the listing look schedules autosave without another text edit");
      flushDraft();
      const savedLook = JSON.parse(localStorage.getItem(DRAFT_KEY));
      const lookHTML = state.html;
      state.styleSeed = 1;
      applyDraft(savedLook); renderDraft();
      check(state.styleSeed === 7654321 && state.html === lookHTML, "A shuffled look survives saved-draft restoration");
      check(!$("contentEditor").hidden && $("editDescription").value.includes("light wear"), "Generated content opens in plain-text editor");
      $("editDescription").value = "Seller correction <script>literal text</script>\n\nSecond paragraph";
      $("editDescription").dispatchEvent(new Event("input", {bubbles:true}));
      const pendingContent = JSON.parse(JSON.stringify(snapshotDraft()));
      applyDraft(pendingContent); renderDraft();
      check($("editDescription").value.includes("Seller correction") && !state.html.includes("Seller correction"), "Unapplied content survives restoration without silently changing exports");
      $("applyContentBtn").click();
      check(state.data.description_paragraphs.length === 2 && state.html.includes("&lt;script&gt;literal text&lt;/script&gt;") && state.contentEdits === null, "Content apply updates escaped preview and clears pending changes");
      const validContent = state.html;
      $("editDescription").value = 'x'.repeat(4001); $("editDescription").dispatchEvent(new Event('input', {bubbles:true}));
      $("applyContentBtn").click();
      check(state.html === validContent && state.contentEdits.editDescription.length === 4001 && $("contentEditStatus").textContent.includes('4,000'), "Overlong seller paragraphs are preserved as pending edits instead of silently truncated");
      $("resetContentBtn").click();
      $("editSpecifics").value = 'Model: ' + 'x'.repeat(1001); $("editSpecifics").dispatchEvent(new Event('input', {bubbles:true}));
      $("applyContentBtn").click();
      check(state.html === validContent && state.contentEdits.editSpecifics.length === 1008 && $("contentEditStatus").textContent.includes('1,000'), "Overlong seller specifics cannot silently change the exported content");
      $("resetContentBtn").click();
      $("editDescription").value = " "; $("editDescription").dispatchEvent(new Event("input", {bubbles:true}));
      $("applyContentBtn").click();
      check(state.html === validContent && $("contentEditStatus").textContent.includes("no description"), "Invalid content preserves last valid output with clear feedback");
      $("resetContentBtn").click();
      check($("editDescription").value.includes("Seller correction") && state.contentEdits === null, "Discard restores last applied content");
      const outputRace = generate(); const outputRaceRequest = await nextRequest();
      $("editDescription").value = "Seller edit during generation"; $("editDescription").dispatchEvent(new Event("input", {bubbles:true}));
      complete(outputRaceRequest, listing("Late overwrite")); await outputRace;
      check(outputRaceRequest.opts.signal.aborted && state.data.title === "Current listing" && state.contentEdits.editDescription === "Seller edit during generation" && !$("generateBtn").disabled, "Output editing cancels generation and ignores a late result");
      $("resetContentBtn").click();
      $("htmlOut").value = "<p>Manual version</p>"; $("htmlOut").dispatchEvent(new Event("input", {bubbles:true}));
      $("editIncluded").value = "Camera\nCable"; $("editIncluded").dispatchEvent(new Event("input", {bubbles:true}));
      const previousConfirm = window.confirm; window.confirm = () => false;
      try { $("applyContentBtn").click(); } finally { window.confirm = previousConfirm; }
      check(state.html === "<p>Manual version</p>" && state.contentEdits !== null, "Cancelling content apply protects manual HTML");
      $("applyContentBtn").click();
      check(state.data.included_items.join(",") === "Camera,Cable" && !state.edited, "Confirmed content apply rebuilds from edited lists");
      $("editSpecifics").value = "Brand: Confirmed brand\nModel: Verified model";
      $("editSpecifics").dispatchEvent(new Event("input", {bubbles:true})); $("applyContentBtn").click();
      check(state.data.item_specifics.Model === "Verified model" && state.html.includes("Confirmed brand"), "Item specifics can be corrected without editing HTML");
      $("editSpecifics").value = "Brand: First\nbrand: Conflicting";
      $("editSpecifics").dispatchEvent(new Event("input", {bubbles:true})); $("applyContentBtn").click();
      check(state.data.item_specifics.Brand === "Confirmed brand" && $("contentEditStatus").textContent.includes("duplicate"), "Duplicate specific labels are rejected without replacing valid content");
      $("resetContentBtn").click();
      $("htmlOut").value = "   "; $("htmlOut").dispatchEvent(new Event("input", {bubbles:true}));
      check($("copyHtmlBtn").disabled && $("downloadBtn").disabled, "Blank manual HTML disables HTML exports");
      check($("contentEditStatus").textContent.includes('Manual HTML is active'), "Content editor status reflects manual HTML changes without resetting fields");
      state.edited = false; renderPreview();

      for (const status of [429, 503]) {
        const attempt = generate(); const failure = await nextRequest();
        failure.resolve({ok: false, status, json: async () => ({kind: "provider_busy", error: "Providers are busy. Wait 30 seconds, then retry."})});
        await attempt;
        check(state.data.title === "Current listing" && !$("generateBtn").disabled, "Provider " + status + " preserves draft and releases controls");
        const errors = document.querySelectorAll(".toast.err p");
        const message = errors[errors.length - 1].textContent;
        check(message.includes("Wait 30 seconds") && !message.includes("Checklist"), "Provider " + status + " shows wait guidance without key checklist");
      }

      const busyGeneration = generate(); const capacityRequest = await nextRequest();
      capacityRequest.resolve({ok:false,status:429,json:async()=>({kind:'local_busy',error:'Three AI requests are already running. Wait for a current lookup or generation to finish.'})}); await busyGeneration;
      const localBusyMessage = [...document.querySelectorAll('.toast.err p')].at(-1).textContent;
      check(state.data.title === 'Current listing' && !$("generateBtn").disabled && localBusyMessage.includes('Three AI requests') && !localBusyMessage.includes('provider keys'), "Local AI capacity rejection preserves the draft and shows wait guidance without suggesting key changes");
      const invalidGeneration = generate(); const blank = await nextRequest();
      complete(blank, {title: "Invalid replacement", description_paragraphs: ["  "]}); await invalidGeneration;
      check(state.data.title === "Current listing" && !$("generateBtn").disabled, "Blank generated description preserves previous draft");

      $("condition").value = "UNTESTED"; $("condNotes").value = "Cracked casing; not tested";
      const conditionRun = generate(); const conditionRequest = await nextRequest();
      $("condition").value = "NEW"; $("condNotes").value = "Edited while waiting";
      complete(conditionRequest, {...listing("Current listing"), condition_rating:"NWT", condition_notes:"Works perfectly", item_specifics:{Condition:"New"}}); await conditionRun;
      check(state.data.condition_rating === "UNTESTED" && state.data.condition_notes === "Cracked casing; not tested", "Generation uses seller condition snapshot instead of AI grade or later edits");
      check(state.html.includes("Untested") && state.html.includes("Cracked casing; not tested") && !state.html.includes("Works perfectly"), "Preview includes authoritative condition and disclosed flaws");
      $("condition").value = ""; $("condNotes").value = "";
      const unknownRun = generate(); const unknownRequest = await nextRequest();
      complete(unknownRequest, {...listing("Current listing"), condition_rating:"EUC", condition_notes:"Minor wear"}); await unknownRun;
      check(state.data.condition_rating === "" && state.html.includes("Condition not specified") && !state.html.includes("Minor wear"), "Unknown condition never defaults to Used or an AI grade");
      check(Array.from($("condition").options).some(o => o.value === "FOR_PARTS") && !$("condition").textContent.includes("Let AI judge"), "Seller condition choices include for parts and no AI judgment");

      const third = generate(); const beforeRestore = await nextRequest();
      applyDraft({inputs: {notes: "History notes", titleIn: "History title"}, data: ListingCore.normalizeListing(listing("History title"))});
      renderDraft("History restored");
      complete(beforeRestore, listing("Wrong replacement")); await third;
      check(state.data.title === "History title" && $("modelMeta").textContent === "History restored", "History restoration survives a late generation response");

      const candidate = {item_id:'v1|123|0', title:'Camera source', url:'https://www.ebay.com/itm/123'};
      const sourceRef = (model = 'Camera') => ({kind:'ebay-listing', source:candidate, at:'2026-09-10T12:00:00Z', data:{key_specs:{Model:model}}, accepted:false});
      setupBundle(['A','B','C']);
      document.querySelectorAll('.bi-lookup')[1].click(); const moved = await nextRequest();
      document.querySelectorAll('.remove-card')[0].click();
      check(document.querySelectorAll('.bi-lookup')[0].disabled, 'Moved item retains lookup busy state');
      moved.resolve(reply({items:[candidate]})); await tick(); await tick();
      check(!state.bundleItems[0].reference && document.querySelectorAll('.ref-select').length === 1 && !document.querySelectorAll('.bi-lookup')[0].disabled, 'Bundle search follows item identity and requires explicit selection');
      document.querySelector('.ref-select').click(); const detail = await nextRequest();
      check(detail.path.startsWith('/ebay/reference?item_id='), 'Selected listing fetches eBay details without AI');
      detail.resolve(reply(sourceRef('Reference for B'))); await tick(); await tick();
      check(state.bundleItems[0].notes === 'Original B' && !buildUserMessage().includes('Reference for B'), 'Pending reference stays out of seller notes and generation');
      const saved = JSON.parse(JSON.stringify(snapshotDraft())); applyDraft(saved); renderDraft();
      check(state.bundleItems[0].reference.source.item_id === candidate.item_id && document.querySelector('.bi-reference a').href === candidate.url, 'Pending reference restores source provenance and safe link');
      const notes = document.querySelector('.bundle-card textarea'); notes.value = "Seller's latest observation"; notes.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('.bi-accept').click();
      check(state.bundleItems[0].notes === "Seller's latest observation" && buildUserMessage().includes('Reference for B') && buildUserMessage().includes(candidate.url), 'Accepted bundle reference stays separate from observations with provenance in generation');
      const accepted = JSON.parse(JSON.stringify(snapshotDraft())); applyDraft(accepted); renderDraft();
      check(state.bundleItems[0].reference.accepted && state.bundleItems[0].reference.at === '2026-09-10T12:00:00Z' && document.querySelector('.bi-accept').disabled, 'Acceptance and retrieval date survive restoration without duplicate acceptance');
      document.querySelector('.bi-dismiss').click();
      check(!state.bundleItems[0].reference && state.bundleItems[0].notes === "Seller's latest observation" && !buildUserMessage().includes('Reference for B'), 'Explicit removal preserves observations and removes generation reference');
      setupBundle(['D','E']); document.querySelector('.bi-lookup').click(); const removed = await nextRequest();
      document.querySelector('.remove-card').click(); removed.resolve(reply({items:[candidate]})); await tick(); await tick();
      check(removed.opts.signal.aborted && !state.bundleItems[0].reference && !state.bundleItems[0].lookupCandidates, 'Removed item search cannot attach to a replacement card');
      document.querySelector('.bi-lookup').click(); const renameSearch = await nextRequest(); renameSearch.resolve(reply({items:[candidate]})); await tick(); await tick();
      document.querySelector('.ref-select').click(); const staleDetail = await nextRequest();
      const name = document.querySelector('.bundle-card input'); name.value = 'Renamed'; name.dispatchEvent(new Event('input',{bubbles:true}));
      staleDetail.resolve(reply(sourceRef())); await tick(); await tick();
      check(staleDetail.opts.signal.aborted && !state.bundleItems[0].reference && !document.querySelector('.ref-select'), 'Renaming invalidates selected details and candidates');
      applyDraft({mode:'bundle',bundleItems:[{name:'Legacy',notes:'Preserved old accepted notes',reference:{q:'Legacy',data:{product_name:'Old AI'},accepted:true}}]}); renderDraft();
      check(state.bundleItems[0].notes === 'Preserved old accepted notes' && document.querySelector('.bi-reference').textContent.includes('Legacy AI') && document.querySelector('.bi-accept').disabled, 'Legacy AI stays labelled and cannot be newly accepted as sourced data');

      const setBundleConditions = codes => document.querySelectorAll('.bundle-card select')
        .forEach((select, i) => { select.value = codes[i]; select.dispatchEvent(new Event('change', {bubbles:true})); });
      const bundleCardsOf = () => [...new DOMParser().parseFromString(state.html, 'text/html').querySelectorAll('.elb-bundle-item')];
      const badgeClasses = () => bundleCardsOf().map(card => card.querySelector('.elb-bundle-cond').className.replace('elb-bundle-cond ', '')).join(',');
      setupBundle(['Camera body', 'Battery grip', 'Charger']);
      setBundleConditions(['USED', 'NEW', 'FOR_PARTS']);
      check(state.bundleItems.map(b => b.condition).join() === 'USED,NEW,FOR_PARTS', 'Each bundle card records its own seller condition');
      const bundleRun = generate(); const bundleRequest = await nextRequest();
      const bundlePrompt = JSON.parse(bundleRequest.opts.body).messages.at(-1).content;
      check(/1\. Camera body \[USED\][\s\S]*2\. Battery grip \[NEW\][\s\S]*3\. Charger \[FOR_PARTS\]/.test(bundlePrompt),
        'The model receives bundle cards numbered in seller order');
      complete(bundleRequest, {...listing('Bundle fixture'), note: 'PLEASE NOTE: no box or manuals',
        bundle_items: [{name:'Camera body', condition:'Used', description:'Light wear.'},
          {name:'BG-5D battery grip', condition:'New', description:'Unused.'},
          {name:'OEM charger', condition:'For parts', description:'Sold as untested.'}]});
      await bundleRun;
      check(state.data.note === 'no box or manuals' && (state.html.match(/PLEASE NOTE:/g) || []).length === 1,
        'A model that repeats the note label still renders one PLEASE NOTE callout');
      check(state.data.bundle_items.map(b => b.condition).join() === 'Used,New,For parts or not working',
        'Renamed bundle items keep the seller condition of the card they came from');
      check(badgeClasses() === 'elb-cond-good,elb-cond-new,elb-cond-parts',
        'Bundle condition badges use the colour of the label printed beside them');
      check(bundleCardsOf().every(card => !card.textContent.includes('Condition not specified')),
        'No bundle card falls back to Condition not specified');
      $("editDescription").value = "Seller correction after bundling";
      $("editDescription").dispatchEvent(new Event("input", {bubbles:true}));
      $("applyContentBtn").click();
      check(!$("contentEditor").hidden && state.data.description_paragraphs.join() === 'Seller correction after bundling' &&
        state.data.bundle_items.map(b => b.condition).join() === 'Used,New,For parts or not working' &&
        badgeClasses() === 'elb-cond-good,elb-cond-new,elb-cond-parts' &&
        (state.html.match(/PLEASE NOTE:/g) || []).length === 1,
        'Content edits rebuild the listing without losing bundle conditions, badge colours or the single note label');
      setupBundle(['', 'Cable', 'Cable']);
      setBundleConditions(['', 'NEW', 'USED']);
      const blankRun = generate(); const blankRequest = await nextRequest();
      const blankPrompt = JSON.parse(blankRequest.opts.body).messages.at(-1).content;
      check(blankPrompt.includes('1. Cable [NEW]') && blankPrompt.includes('2. Cable [USED]') && !blankPrompt.includes('3. '),
        'A blank-named card is left out of the numbered list the model receives');
      complete(blankRequest, {...listing('Blank card fixture'),
        bundle_items: [{name:'USB cable', condition:'', description:'First cable.'},
          {name:'Power cable', condition:'', description:'Second cable.'}]});
      await blankRun;
      check(state.data.bundle_items.map(b => b.condition).join() === 'New,Used',
        'A blank-named card cannot shift later bundle conditions onto the wrong item');
      newListing(); $('productSearch').value = 'Fast reference';
      const fastLookup = lookupProduct(); const fastRef = await nextRequest(); const slowMine = await nextRequest();
      check(fastRef.path.startsWith('/ebay/search?') && slowMine.path.startsWith('/ebay/search?'), 'Lookup and keywords use eBay search without AI recall');
      fastRef.resolve(reply({items:[candidate]})); await fastLookup;
      check(!state.reference && !$('lookupBtn').disabled && $('mineBtn').disabled, 'Candidates finish independently of mining without automatic selection');
      $('referenceCandidates').querySelector('.ref-select').click(); const selected = await nextRequest(); selected.resolve(reply(sourceRef('Reviewed camera'))); await tick(); await tick();
      check(!hasGenerationInput(), 'Unaccepted selected reference cannot enable generation');
      $('refAcceptBtn').click();
      check(hasGenerationInput() && !$('notes').value, 'Accepted separate reference retains lookup-to-generation behavior without creating seller notes');
      state.reference.accepted = false; renderReference();
      $('notes').value = 'My observation'; $('brand').value = 'My brand'; $('condition').value = 'UNTESTED'; $('condNotes').value = 'My flaw';
      const sellerBefore = ['notes','brand','condition','condNotes','returnsPolicy'].map(id => $(id).value);
      check(!buildUserMessage().includes('Reviewed camera'), 'Selection alone does not accept specifications into generation');
      $('refAcceptBtn').click();
      check(JSON.stringify(sellerBefore) === JSON.stringify(['notes','brand','condition','condNotes','returnsPolicy'].map(id => $(id).value)) && buildUserMessage().includes('Reviewed camera') && buildUserMessage().includes('ACCEPTED SELLER-LISTING REFERENCE') && buildUserMessage().includes('2026-09-10T12:00:00Z'), 'Single acceptance preserves seller fields with a separate dated source block');
      slowMine.resolve(reply({items:[{title:'Camera lens camera'}]})); await tick(); await tick();
      const restoredSingle = JSON.parse(JSON.stringify(snapshotDraft())); applyDraft(restoredSingle); renderDraft();
      check(state.reference.accepted && state.reference.source.url === candidate.url && $('notes').value === 'My observation', 'Single provenance and separation survive draft restoration');
      const emptySearch = lookupProduct(); const emptyRequests = [await nextRequest(), await nextRequest()];
      emptyRequests.forEach(r => r.resolve(reply({items:[]}))); await emptySearch; await tick();
      check(state.reference.accepted && !$('referenceCandidates').querySelector('.ref-select'), 'Empty search keeps an accepted reference and never auto-selects or falls back to AI');
      $('productSearch').value = ''; $('productSearch').dispatchEvent(new Event('input',{bubbles:true}));
      $('productBarcode').value = '0 12345-678905'; $('productBarcode').dispatchEvent(new Event('input',{bubbles:true}));
      const idSearch = lookupProduct(); const idRequests = [await nextRequest(), await nextRequest()];
      check(idRequests.every(r => r.path.includes('gtin=012345678905') && !r.path.includes('keywords=')), 'Barcode-only reference search preserves normalized identifier without name broadening');
      idRequests.forEach(r => r.resolve(reply({items:[candidate]}))); await idSearch; await tick();
      $('referenceCandidates').querySelector('.ref-select').click(); const mismatch = await nextRequest();
      mismatch.resolve(reply({...sourceRef(),source:{...candidate,item_id:'v1|999|0'}})); await tick(); await tick();
      check(!state.reference, 'Mismatched selected detail cannot become a reference');
      $('referenceCandidates').querySelector('.ref-select').click(); const idDetail = await nextRequest(); idDetail.resolve(reply(sourceRef())); await tick(); await tick();
      $('refAcceptBtn').click(); const acceptedBarcode = state.reference;
      $('notes').value = 'Barcode item observation'; $('notes').dispatchEvent(new Event('input',{bubbles:true}));
      check(state.reference === acceptedBarcode && state.reference.accepted, 'Editing seller observations preserves a barcode-only accepted reference');
      $('referenceCandidates').querySelector('.ref-select').click(); const changedDetail = await nextRequest();
      $('productBarcode').value = '00123456789012'; $('productBarcode').dispatchEvent(new Event('input',{bubbles:true}));
      changedDetail.resolve(reply(sourceRef())); await tick(); await tick();
      check(!state.reference && changedDetail.opts.signal.aborted && !$('referenceCandidates').querySelector('.ref-select'), 'Barcode edit invalidates accepted identity and pending selected details');
      $('productSearch').value = 'Fast reference'; $('productBarcode').value = ''; state.minedKeywords = ['camera'];
      state.minedAspects = {Capacity:["UNVERIFIED_CAPACITY"]};
      check(!buildUserMessage().includes("UNVERIFIED_CAPACITY") && buildUserMessage().includes("not verified facts about this item"), "Aggregate eBay aspects do not become listing facts and keywords remain suggestions");
      for (const failure of [
        {ok:false,status:503,json:async()=>({error:"eBay is temporarily unavailable",fallback:true})},
        {ok:true,status:200,json:async()=>({items:[null]})},
        {ok:false,status:502,json:async()=>null}
      ]) {
        state.minedKeywords = ["stale-keyword"]; state.minedAspects = {Capacity:["old"]};
        const failedMining = mineKeywords("Fast reference"); const failedRequest = await nextRequest();
        failedRequest.resolve(failure); await failedMining; flushDraft();
        const savedMining = JSON.parse(localStorage.getItem(DRAFT_KEY));
        check(state.minedKeywords.length === 0 && savedMining.minedKeywords.length === 0 && !Object.hasOwn(savedMining, "minedAspects") && !$("mineBtn").disabled, "Failed/malformed mining clears stale keywords and omits unused saved aspects: " + failure.status);
        const miningErrors = document.querySelectorAll(".toast.err p");
        const miningMessage = miningErrors[miningErrors.length - 1].textContent;
        check(miningMessage.includes("own item notes") && !miningMessage.includes("keyset likely"), "Mining failure offers accurate recovery without guessing credentials: " + failure.status);
      }

      newListing(); $("productSearch").value = "Camera";
      state.reference = {data: ListingCore.normalizeReference({product_name: "Previous reference"}), at: new Date().toISOString()};
      const invalidLookup = lookupProduct();
      const requests = [await nextRequest(), await nextRequest()];
      requests[0].resolve(reply({items:null})); requests[1].resolve(reply({items:[]}));
      await invalidLookup;
      check(state.reference.data.product_name === "Previous reference" && !$("lookupBtn").disabled, "Invalid single reference preserves previous reference and releases lookup");
      check(!$("notes").value && !$("brand").value, "Invalid lookup cannot populate notes or brand");

      newListing(); $("notes").value = "Fallback search";
      const mining = mineKeywords($("notes").value); const oldMining = await nextRequest();
      $("notes").value = "Different search"; $("notes").dispatchEvent(new Event("input", {bubbles: true}));
      oldMining.resolve(reply({items: [{title: "Wrong keywords"}]})); await mining;
      check(state.minedKeywords.length === 0, "Editing fallback search notes drops stale keywords");

      newListing(); $("productSearch").value = "Source camera";
      const sourceMining = mineKeywords("Source camera"); const sourceRequest = await nextRequest();
      sourceRequest.resolve(reply({items:[
        {title:'<b>Camera listing</b>', url:'https://www.ebay.com/itm/123?tracking=secret'},
        {title:'Unsafe link', url:'javascript:alert(1)'}
      ]})); await sourceMining; flushDraft();
      const sourceLink = $("minedSourceList").querySelector('a');
      check(sourceLink && sourceLink.textContent === '<b>Camera listing</b>' && !$("minedSourceList").querySelector('b') && sourceLink.href === 'https://www.ebay.com/itm/123' && sourceLink.rel.includes('noreferrer'), "Mining sources render escaped titles and safe item links only");
      const savedSources = JSON.parse(localStorage.getItem(DRAFT_KEY));
      check(savedSources.minedSources.length === 1 && savedSources.minedSourceQuery === 'Source camera', "Source listings persist with the draft query");
      $("productSearch").value = 'Other camera'; $("productSearch").dispatchEvent(new Event('input', {bubbles:true}));
      check(state.minedSources.length === 0 && $("minedSources").hidden, "Product edits clear unrelated search sources");
      $("productBarcode").value = '0 12345-678905'; $("productBarcode").dispatchEvent(new Event('input', {bubbles:true}));
      const barcodeSearch = mineKeywords('name must not broaden'); const barcodeRequest = await nextRequest();
      check(barcodeRequest.path.includes('gtin=012345678905') && !barcodeRequest.path.includes('keywords='), "Barcode search sends only the normalized barcode to eBay");
      barcodeRequest.resolve(reply({items:[{title:'Barcode camera model',url:'https://www.ebay.com/itm/123'}],cached:true})); await barcodeSearch;
      check(state.minedSourceQuery === 'Barcode 012345678905' && state.minedSources.length === 1, "Barcode source results retain their search identity");
      const barcodeDraft = JSON.parse(JSON.stringify(snapshotDraft()));
      applyDraft(barcodeDraft); renderDraft();
      check($("productBarcode").value === '0 12345-678905' && state.minedSourceQuery === 'Barcode 012345678905', "Barcode and source identity survive draft restoration");
      $("productBarcode").value = 'invalid'; $("productBarcode").dispatchEvent(new Event('input', {bubbles:true}));
      await mineKeywords('Camera');
      check(!pending.length && !state.minedSources.length, "Invalid barcodes block network calls and cannot fall back to a broader name search");
      check($("productBarcode").getAttribute("aria-invalid") === "true" &&
        $("productBarcode").getAttribute("aria-describedby").includes("barcodeError") &&
        !$("barcodeError").hidden && $("barcodeError").textContent.length > 0,
        "Invalid barcode has persistent feedback associated with its field");
      applyDraft(barcodeDraft); renderDraft();
      check($("barcodeError").hidden && !$("productBarcode").hasAttribute("aria-invalid"),
        "Restoring a draft clears validation feedback from the previous barcode");
      $("productBarcode").value = 'invalid';
      await mineKeywords('Camera');
      newListing();
      check($("barcodeError").hidden && !$("productBarcode").hasAttribute("aria-invalid"),
        "New listing clears stale barcode validation feedback");
      $("productBarcode").value = 'invalid';
      await mineKeywords('Camera');
      $("productBarcode").value = '012345678905'; $("productBarcode").dispatchEvent(new Event('input', {bubbles:true}));
      check($("barcodeError").hidden && !$("barcodeError").textContent &&
        !$("productBarcode").hasAttribute("aria-invalid") && $("productBarcode").getAttribute("aria-describedby") === "barcodeHint",
        "Editing barcode clears the old error and preserves usage guidance");
      const lateBarcode = mineKeywords(''); const lateBarcodeRequest = await nextRequest();
      $("productBarcode").value = '00123456789012'; $("productBarcode").dispatchEvent(new Event('input', {bubbles:true}));
      lateBarcodeRequest.resolve(reply({items:[{title:'Old barcode result',url:'https://www.ebay.com/itm/456'}]})); await lateBarcode;
      check(!state.minedSources.length && !$("mineBtn").disabled, "Editing a barcode prevents late results from attaching to the new item");
      const emptyBarcode = mineKeywords(''); const emptyBarcodeRequest = await nextRequest();
      emptyBarcodeRequest.resolve(reply({items:[]})); await emptyBarcode;
      check(!pending.length && !state.minedKeywords.length && [...document.querySelectorAll('.toast.ok p')].at(-1).textContent.includes('No eBay listings'), "An empty barcode result gives recovery guidance without an automatic broad search");
      $("productBarcode").value = ''; $("productBarcode").dispatchEvent(new Event('input', {bubbles:true}));
      savedSources.minedSources.push({title:'Restored unsafe link',url:'https://evil.test/itm/123'});
      applyDraft(savedSources); renderDraft();
      check(state.minedSources.length === 1 && !$("minedSources").hidden, "Draft restore revalidates source links");
      newListing();
      check(state.minedSources.length === 0 && $("minedSources").hidden, "New listing clears previous sources");

      $("productSearch").value = 'Earlier camera';
      const earlierLookup = lookupProduct();
      const earlierLookupRequests = [await nextRequest(), await nextRequest()];
      $("productSearch").value = 'New camera'; $("productSearch").dispatchEvent(new Event('input', {bubbles:true}));
      check(earlierLookupRequests.every(request => request.opts.signal.aborted) && !$("lookupBtn").disabled && !$("mineBtn").disabled, "Editing the product immediately cancels obsolete requests and releases search controls");
      const newerLookup = lookupProduct();
      const newerLookupRequests = [await nextRequest(), await nextRequest()];
      for (const request of earlierLookupRequests) {
        if (request.path.startsWith('/ebay/search?')) request.resolve(reply({items:[]}));
        else complete(request, {product_name:'Old camera',summary:'Obsolete'});
      }
      await earlierLookup; await tick();
      check($("lookupBtn").disabled && $("mineBtn").disabled && !state.reference, "Obsolete search cleanup cannot release controls owned by the new search");
      for (const request of newerLookupRequests) {
        if (request.path.startsWith('/ebay/search?')) request.resolve(reply({items:[]}));
        else complete(request, {product_name:'New camera',summary:'Current reference'});
      }
      await newerLookup; await tick();
      check(state.lookupCandidates && !state.reference && !$("lookupBtn").disabled && !$("mineBtn").disabled, "The new product search can complete without waiting for obsolete results");

      await openSettings();
      renderKeyStatus({provider_storage:'windows_encrypted',provider_plaintext_present:true});
      check($("providerStorageHint").textContent.includes('encrypted') && $("providerStorageHint").textContent.includes('Older keys remain'), "Settings explain encrypted saves and remaining legacy plaintext");
      renderKeyStatus({provider_storage:'plaintext'});
      check($("providerStorageHint").textContent.includes('plain text'), "Settings truthfully describe plaintext storage fallback");
      renderKeyStatus({ebay:{storage:'plaintext'}});
      check($("ebayStorageHint").textContent.includes('plain text'), "eBay Settings do not claim encryption on plaintext systems");
      $("groqKey").value = 'fixture-new-key';
      $("groqRemove").checked = true; $("groqRemove").dispatchEvent(new Event('change'));
      check($("groqKey").disabled && $("groqKey").value === 'fixture-new-key', "Key removal disables replacement without discarding typed text");
      const removingKey = saveKeys(); const settingsRequest = await nextRequest();
      const settingsPayload = JSON.parse(settingsRequest.opts.body);
      check(settingsPayload.groq_api_key === '' && settingsPayload.remove_keys.join() === 'groq_api_key', "Saving removal sends explicit selection without the replacement key");
      check($("saveKeysBtn").textContent === 'Saving keys\u2026', "Saving keys shows its own busy label without restart wording");
      settingsRequest.resolve(reply({saved:['groq_api_key'],applied:true,cleanup_pending:false,message:'Fixture settings saved'})); await removingKey;
      check(!$("groqRemove").checked && !$("groqKey").disabled && !$("groqKey").value && !$("saveKeysBtn").disabled, "Successful removal resets controls and clears transient keys");
      check($("saveKeysBtn").textContent === 'Save keys' && !/restart/i.test($("settingsOverlay").textContent), "Settings no longer mention restarting a router");
      $("groqKey").value = 'fixture-visible-key';
      const eye = document.querySelector('.key-eye[data-for="groqKey"]'); eye.click();
      check($("groqKey").type === 'text' && eye.getAttribute('aria-pressed') === 'true', "Key visibility control explicitly reveals the typed value");
      closeSettings();
      check(!$("groqKey").value && $("groqKey").type === 'password' && eye.getAttribute('aria-pressed') === 'false', "Closing Settings clears transient secrets and restores masking");
      await openSettings();
      check($("groqKey").type === 'password' && !$("groqKey").value, "Reopening Settings cannot retain a revealed key field");
      $("groqKey").value = 'first-fixture-key';
      const slowKeySave = saveKeys(); const slowKeyRequest = await nextRequest();
      $("groqKey").value = 'newer-unsaved-fixture';
      slowKeyRequest.resolve(reply({saved:['groq_api_key'],applied:true,cleanup_pending:false,message:'Saved earlier values'})); await slowKeySave;
      check($("groqKey").value === 'newer-unsaved-fixture', "A late settings save cannot clear newer typed keys");
      const cleanupSave = saveKeys(); const cleanupRequest = await nextRequest();
      cleanupRequest.resolve(reply({saved:['groq_api_key'],applied:true,cleanup_pending:true,message:'Encrypted save needs plaintext cleanup'})); await cleanupSave;
      check($("groqKey").value === 'newer-unsaved-fixture' && !$("saveKeysBtn").disabled, "Plaintext cleanup warning preserves entered keys for retry");
      closeSettings();

      await openSettings();
      $("ebayClientId").value = 'earlier-ebay-fixture';
      const ebaySave = saveEbayCreds(); const ebayRequest = await nextRequest();
      await saveEbayCreds();
      check(!pending.length, "A repeated eBay save cannot submit a second request while busy");
      $("ebayClientId").value = 'newer-ebay-fixture';
      ebayRequest.resolve(reply({message:'Saved'})); await ebaySave;
      check($("ebayClientId").value === 'newer-ebay-fixture' && !$("saveEbayCredsBtn").disabled, "A late eBay save preserves newer typed credentials");
      const reopenedSave = saveEbayCreds(); const reopenedRequest = await nextRequest();
      closeSettings(); await openSettings(); $("ebayClientSecret").value = 'reopened-secret-fixture';
      reopenedRequest.resolve(reply({message:'Saved'})); await reopenedSave;
      check($("ebayClientSecret").value === 'reopened-secret-fixture', "A save from a closed Settings session cannot clear the reopened form");
      const rejectedSave = saveEbayCreds(); const rejectedRequest = await nextRequest();
      rejectedRequest.resolve({ok:false,status:503,json:async()=>({})}); await rejectedSave;
      check($("ebayClientSecret").value === 'reopened-secret-fixture' && !$("saveEbayCredsBtn").disabled, "An unsuccessful HTTP save preserves credentials and releases the button");
      holdSettings = true;
      const earlierOpen = openSettings(); const earlierRead = await nextRequest();
      closeSettings(); await openSettings();
      earlierRead.resolve(reply({groq:{set:true,masked:'STALE-FIXTURE'}})); await earlierOpen;
      check(!$("groqCurrent").textContent.includes('STALE-FIXTURE'), "Late status from a closed Settings session cannot overwrite current status");
      holdSettings = true;
      const expiredRead = settingsJSON('/settings', {}, 1).catch(error => error);
      const expiredRequest = await nextRequest(); await new Promise(resolve => setTimeout(resolve, 10));
      check(expiredRequest.opts.signal.aborted, "Settings deadlines abort the underlying request");
      expiredRequest.resolve(reply({}));
      check((await expiredRead).message.includes('too long'), "A response arriving after the Settings deadline is rejected");
      $("ruName").value = 'fixture-redirect';
      const connecting = connectEbay(); const consentRequest = await nextRequest();
      await connectEbay();
      check(!pending.length, "Repeated Connect clicks cannot request overlapping consent states");
      consentRequest.resolve(reply({url:'https://auth.ebay.com/oauth2/authorize?state=fixture-state',state:'fixture-state'})); await connecting;
      check(!$("ebayConsentLink").hidden && $("ebayConsentLink").rel.includes('noopener') && oauthState === 'fixture-state', "Connect exposes a safe explicit consent link without relying on popups");
      $("authCode").value = 'https://example.test/callback?code=fixture-code';
      await exchangeEbay();
      check(!pending.length && !$("exchangeBtn").disabled, "A pasted redirect without state cannot borrow the current consent state");
      $("authCode").value = 'https://example.test/callback?code=fixture-code&state=fixture-state';
      const exchanging = exchangeEbay(); const tokenRequest = await nextRequest(); await exchangeEbay();
      check(JSON.parse(tokenRequest.opts.body).state === 'fixture-state' && !pending.length, "Exchange sends the redirect state once and blocks duplicate submissions");
      $("authCode").value = 'newer-code-fixture';
      tokenRequest.resolve(reply({connected:true})); await exchanging;
      const autoStats = await nextRequest(); autoStats.resolve(reply({})); await tick();
      check($("authCode").value === 'newer-code-fixture' && !$("exchangeBtn").disabled, "A completed exchange preserves a newer pasted code");
      const unsafeConnect = connectEbay(); const unsafeRequest = await nextRequest();
      unsafeRequest.resolve(reply({url:'https://unrelated.example/?state=bad',state:'bad'})); await unsafeConnect;
      check($("ebayConsentLink").hidden && !oauthState && !$("connectBtn").disabled, "Unrelated consent URLs cannot become active links");
      $("fbScore").value = '99'; $("fbPct").value = '99.8';
      const zeroStats = fetchStats(); const zeroRequest = await nextRequest();
      zeroRequest.resolve(reply({feedback_score:0,positive_pct:0})); await zeroStats;
      check($("fbScore").value === '0' && $("fbPct").value === '0', "Valid zero eBay statistics replace older values");
      const lateStats = fetchStats(); const lateStatsRequest = await nextRequest();
      $("fbScore").value = '25';
      lateStatsRequest.resolve(reply({feedback_score:999,positive_pct:100})); await lateStats;
      check($("fbScore").value === '25' && $("fbPct").value === '100' && !$("fetchStatsBtn").disabled, "Delayed statistics preserve newer seller edits while updating untouched fields");
      const disconnectedStats = fetchStats(); const disconnectedRequest = await nextRequest();
      disconnectedRequest.resolve(reply({error:'not connected - complete the OAuth flow first',fallback:true}));
      await disconnectedStats;
      check($("fbScore").value === '25' && $("fbPct").value === '100' && !$("fetchStatsBtn").disabled &&
        [...document.querySelectorAll('.toast.err p')].at(-1).textContent.includes('not connected'),
        "Disconnected stats preserve seller values and report failure instead of success");
      closeSettings();
      check(!$("authCode").value, "Closing Settings clears the transient authorization code");

      appToken = ''; holdSession = true;
      const sessionController = new AbortController();
      const cancelledSession = relayFetch('/llm/chat/completions', {signal:sessionController.signal}).catch(error => error);
      const waitingSession = await nextRequest(); sessionController.abort();
      check(waitingSession.path === '/session' && waitingSession.opts.signal.aborted, "Request cancellation reaches pending session-token acquisition");
      waitingSession.resolve(reply({token:'late-session-fixture'}));
      const sessionError = await cancelledSession;
      check(sessionError.name === 'AbortError' && !appToken && !pending.length, "Late session response cannot send a cancelled protected request");
      holdSession = true;
      const invalidSession = ensureToken().catch(error => error); const malformedSession = await nextRequest();
      malformedSession.resolve(reply({token:{invalid:true}}));
      check((await invalidSession).message.includes('invalid session') && !appToken, "Malformed session tokens are rejected before use");
      await ensureToken();

      applyDraft({version:1,inputs:{notes:'Backup fixture notes',titleIn:'Backup title'}, mode:'single',
                  html:'<p>Original saved HTML</p>',data:listing('Backup title'),includedItems:[],bundleItems:[]});
      $("groqKey").value = 'never-export-this-fixture-key';
      const backupText = draftBackupText();
      check(JSON.parse(backupText).format === 'marteloio-draft' && !backupText.includes('never-export-this-fixture-key'), "Draft backups contain the listing and exclude account key fields");
      $("groqKey").value = '';
      $("notes").value = 'Current work before importing';
      const imported = await importDraftFile(new File([backupText], 'fixture-draft.json', {type:'application/json'}));
      check(imported && $("notes").value === 'Backup fixture notes' && state.data.title === 'Backup title' && state.html === '<p>Original saved HTML</p>' && state.edited, "Draft restore recovers editable content and preserves the original HTML snapshot");
      check(loadHistory().some(item => item.draft.inputs.notes === 'Current work before importing'), "Import saves current work into Recent drafts before replacement");
      const legacyBackup = JSON.parse(backupText); legacyBackup.format = 'lanzalister-draft';
      legacyBackup.draft.inputs.notes = 'Legacy backup notes';
      check(await importDraftFile(new File([JSON.stringify(legacyBackup)], 'lanzalister-draft.json')) && $("notes").value === 'Legacy backup notes',
        "Backups written before the rename still restore");
      const beforeBadImport = JSON.stringify(snapshotDraft().inputs);
      check(!await importDraftFile(new File(['{"unrelated":true}'], 'not-a-draft.json')) && JSON.stringify(snapshotDraft().inputs) === beforeBadImport, "Unrelated JSON cannot erase the current draft");
      const hugeFile = {size:MAX_DRAFT_FILE + 1, text:() => {throw new Error('Oversized file should not be read');}};
      check(!await importDraftFile(hugeFile) && JSON.stringify(snapshotDraft().inputs) === beforeBadImport, "Oversized draft files are rejected before reading or changing work");
      const brokenBackup = JSON.parse(backupText); brokenBackup.draft.data = {title:'Bad',description_paragraphs:[]};
      check(!await importDraftFile(new File([JSON.stringify(brokenBackup)], 'broken.json')) && state.data.title === 'Backup title', "Malformed listing content in a backup preserves current work");
      const beforeImportSetter = Storage.prototype.setItem;
      Storage.prototype.setItem = function() { throw new DOMException('Fixture blocked storage', 'QuotaExceededError'); };
      try {
        check(!await importDraftFile(new File([backupText], 'fixture-draft.json')) && state.data.title === 'Backup title', "Import refuses replacement when current work cannot be saved to history");
      } finally { Storage.prototype.setItem = beforeImportSetter; }

      let finishOldImport;
      const oldImport = importDraftFile({size:100,text:()=>new Promise(resolve => {finishOldImport = resolve;})});
      await importDraftFile(new File([backupText], 'newer-draft.json'));
      $("notes").value = 'Work after the newer import';
      finishOldImport(backupText);
      check(!await oldImport && $("notes").value === 'Work after the newer import', "A delayed older file cannot overwrite a newer import");
      let finishCancelledImport;
      const cancelledImport = importDraftFile({size:100,text:()=>new Promise(resolve => {finishCancelledImport = resolve;})});
      newListing(); $("notes").value = 'Fresh work after New listing';
      finishCancelledImport(backupText);
      check(!await cancelledImport && $("notes").value === 'Fresh work after New listing', "New listing invalidates a file restore that is still being read");

      // Exercise real input wiring and both save paths; an empty final field
      // must overwrite the previous draft just like a populated field does.
      newListing();
      $("productBarcode").value = "027242923232";
      $("productBarcode").dispatchEvent(new Event("input", {bubbles:true}));
      await new Promise(resolve => setTimeout(resolve, 650));
      check(JSON.parse(localStorage.getItem(DRAFT_KEY)).inputs.productBarcode === "027242923232",
        "Barcode input autosaves without another field changing");
      $("productBarcode").value = "";
      $("productBarcode").dispatchEvent(new Event("input", {bubbles:true}));
      await new Promise(resolve => setTimeout(resolve, 650));
      check(JSON.parse(localStorage.getItem(DRAFT_KEY)).inputs.productBarcode === "" && !draftHasContent(),
        "Clearing the final barcode autosaves an empty draft");
      $("productBarcode").value = "stale DOM value";
      restoreDraft();
      check($("productBarcode").value === "" && !draftHasContent(),
        "Startup restoration keeps an intentionally empty barcode empty");
      $("productBarcode").value = "027242923232";
      $("productBarcode").dispatchEvent(new Event("input", {bubbles:true}));
      window.dispatchEvent(new Event("pagehide"));
      $("productBarcode").value = "";
      $("productBarcode").dispatchEvent(new Event("input", {bubbles:true}));
      window.dispatchEvent(new Event("pagehide"));
      $("productBarcode").value = "stale DOM value";
      restoreDraft();
      check($("productBarcode").value === "" && !draftTimer && !draftHasContent(),
        "Leaving before debounce flushes a cleared barcode for restoration");

      state.reference = {q:"Fixture camera", ...sourceRef()};
      renderReference();
      $("refAcceptBtn").focus(); $("refAcceptBtn").click();
      check(document.activeElement === $("refDismissBtn"), "Accepting a focused reference moves focus to its removal control");
      $("refDismissBtn").focus(); $("refDismissBtn").click();
      check(document.activeElement === $("productSearch"), "Dismissing a focused reference returns focus to product lookup");
      setupBundle(["First", "Second"]);
      const focusItem = state.bundleItems[0];
      focusItem.reference = {q:"First", ...sourceRef()};
      renderBundleReference(focusItem);
      let focusCard = $("bundleCards").firstElementChild;
      focusCard.querySelector(".bi-accept").focus(); focusCard.querySelector(".bi-accept").click();
      check(document.activeElement === focusCard.querySelector(".bi-dismiss"), "Accepting a bundle reference focuses its removal control");
      focusCard.querySelector(".bi-dismiss").focus(); focusCard.querySelector(".bi-dismiss").click();
      check(document.activeElement === focusCard.querySelector("input"), "Dismissing a bundle reference focuses that item's name");
      focusCard.querySelector(".remove-card").focus(); focusCard.querySelector(".remove-card").click();
      check(document.activeElement === $("bundleCards").querySelector("input") && document.activeElement.value === "Second",
        "Removing a focused bundle item focuses the next remaining item");
      focusCard = $("bundleCards").firstElementChild;
      focusCard.querySelector(".remove-card").focus(); focusCard.querySelector(".remove-card").click();
      check(document.activeElement === $("addBundleItemBtn"), "Removing the final bundle item focuses Add item");
      setupBundle(["Keep", "Remove"]);
      focusCard = $("bundleCards").lastElementChild;
      focusCard.querySelector(".remove-card").focus(); focusCard.querySelector(".remove-card").click();
      check(document.activeElement === $("bundleCards").querySelector("input") && document.activeElement.value === "Keep",
        "Removing the last of several bundle items focuses the previous item");
      newListing();
      state.reference = {q:"Fixture camera", ...sourceRef()};
      renderReference(); $("brand").focus(); acceptReference(); dismissReference();
      check(document.activeElement === $("brand"), "Reference updates do not move focus from an unrelated field");

      // ---- Reproduced bug regressions: each fails on the code before its fix ----
      const lastToast = kind => [...document.querySelectorAll('.toast.' + kind + ' p')].at(-1)?.textContent || '';
      const hangingBody = request => ({ok:true, status:200, json:() => new Promise((_, reject) =>
        request.opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))});
      newListing(); $("notes").value = "Timeout body fixture";
      const slowBody = generate(); const slowBodyRequest = await nextRequest();
      slowBodyRequest.resolve(hangingBody(slowBodyRequest)); await tick(); await tick();
      inflight.generate.timedOut = true; inflight.generate.abort(); await slowBody;
      check(!busyToast && lastToast('err').includes('Generation timed out') && !$("generateBtn").disabled,
        "A deadline while the generation body is read reports a timeout instead of a stuck busy toast");
      const slowMineBody = mineKeywords("Timeout body fixture"); const slowMineRequest = await nextRequest();
      slowMineRequest.resolve(hangingBody(slowMineRequest)); await tick(); await tick();
      inflight.mine.timedOut = true; inflight.mine.abort(); await slowMineBody;
      check(lastToast('err').includes('Mining timed out') && !$("mineBtn").disabled,
        "A deadline while the keyword body is read reports a timeout");

      newListing(); $("notes").value = "Single camera";
      state.condVaries = true;
      check(!buildUserMessage().includes("Conditions vary"), "A hidden bundle 'Conditions vary' choice is not sent for a single item");
      state.data = ListingCore.normalizeListing(listing("Single fixture")); state.dataMode = "single"; state.edited = false;
      for (const style of ["auto", "simple"]) {
        $("styleChoice").value = style; renderPreview();
        check(!/Conditions vary/i.test(state.html), "A hidden bundle 'Conditions vary' choice stays out of single-item buyer HTML: " + style);
      }
      $("styleChoice").value = "auto"; state.condVaries = false;

      setupBundle(["Lens", "Cap"]); $("notes").value = "Bundle mode fixture";
      const modeRun = generate(); const modeRequest = await nextRequest();
      $("modeSingle").click();
      complete(modeRequest, {...listing("Mode fixture"), bundle_items:[{name:"Lens"}, {name:"Cap"}]}); await modeRun;
      check(state.html.includes('class="elb-section elb-sec-bundle"'), "A bundle generation still renders as a bundle after switching to Single");
      $("shuffleStyleBtn").click();
      check(state.html.includes('class="elb-section elb-sec-bundle"'), "Re-rendering uses the generation mode, not the current form mode");
      const modeDraft = JSON.parse(JSON.stringify(snapshotDraft())); applyDraft(modeDraft); renderDraft();
      check(state.dataMode === "bundle" && state.mode === "single" && state.html.includes('class="elb-section elb-sec-bundle"'), "The generation mode survives draft restoration");

      for (const badSeed of [-5, 1.5]) {
        applyDraft({inputs:{notes:"Seed fixture"}, data:listing("Seed fixture"), styleSeed:badSeed});
        let threw = false;
        try { renderDraft(); } catch { threw = true; }
        check(!threw && Number.isSafeInteger(state.styleSeed) && state.styleSeed >= 0 && state.html.includes("Seed fixture"),
          "An imported style seed of " + badSeed + " is replaced instead of breaking rendering");
      }

      newListing(); $("notes").value = "a".repeat(59) + "\u{1F4F7} camera body";
      $("mineBtn").click(); const emojiRequest = await nextRequest();
      check(emojiRequest.path.includes(encodeURIComponent("a".repeat(59) + "\u{1F4F7}")), "Fallback keyword query never splits an emoji");
      emojiRequest.resolve(reply({items:[]})); await tick(); await tick();

      setupBundle(["", " "]); $("notes").value = "Bundle overall";
      check(!buildUserMessage().includes("BUNDLE ITEMS"), "Blank bundle cards do not send an empty BUNDLE ITEMS header");

      setupBundle(["Lookup A"]); document.querySelector('.bi-lookup').click(); const removedLookup = await nextRequest();
      check(busyToast, "Bundle lookup shows its busy toast");
      document.querySelector('.remove-card').click();
      check(!busyToast && !Object.keys(inflight).length, "Removing a bundle card mid-lookup clears the busy toast");
      removedLookup.resolve(reply({items:[]})); await tick(); await tick();
      setupBundle(["Lookup B"]); document.querySelector('.bi-lookup').click(); const renamedLookup = await nextRequest();
      const lookupName = document.querySelector('.bundle-card input'); lookupName.value = "Renamed B"; lookupName.dispatchEvent(new Event('input', {bubbles:true}));
      check(!busyToast, "Renaming a bundle card mid-lookup clears the busy toast");
      renamedLookup.resolve(reply({items:[]})); await tick(); await tick();

      newListing(); $('productSearch').value = 'Lookup busy fixture';
      const busyLookup = lookupProduct(); const busyLookupRequest = await nextRequest(); const busyLookupMine = await nextRequest();
      busyLookupMine.resolve(reply({items:[{title:'Camera lens', url:'https://www.ebay.com/itm/9'}]})); await tick(); await tick();
      check(busyToast && busyToast.textContent.includes('Searching eBay'), "Keywords found during Lookup keep Lookup's busy toast");
      busyLookupRequest.resolve(reply({items:[]})); await busyLookup;
      check(!busyToast, "Lookup's busy toast ends when Lookup finishes");

      state.data = ListingCore.normalizeListing(listing("Limits fixture")); state.dataMode = "single";
      state.contentEdits = null; renderAll();
      const limitHTML = state.html;
      $("editIncluded").value = Array.from({length:41}, (_, i) => "Item " + i).join("\n");
      $("editIncluded").dispatchEvent(new Event("input", {bubbles:true})); $("applyContentBtn").click();
      check(state.html === limitHTML && $("contentEditStatus").textContent.includes("at most 40") && !$("contentEditStatus").textContent.includes("Please retry"),
        "Too many included items get seller-facing guidance and keep the edits");
      $("resetContentBtn").click();
      $("editSpecifics").value = Array.from({length:31}, (_, i) => "Label " + i + ": value").join("\n");
      $("editSpecifics").dispatchEvent(new Event("input", {bubbles:true})); $("applyContentBtn").click();
      check(state.html === limitHTML && $("contentEditStatus").textContent.includes("at most 30") && state.contentEdits !== null,
        "Too many item specifics get seller-facing guidance and keep the edits");
      $("resetContentBtn").click();

      newListing(); $("notes").value = "This tab's work"; $("notes").dispatchEvent(new Event("input", {bubbles:true})); flushDraft();
      const otherTabDraft = JSON.stringify({version:1, inputs:{notes:"Other tab's work"}});
      localStorage.setItem(DRAFT_KEY, otherTabDraft);
      const otherTabEvent = () => window.dispatchEvent(new StorageEvent("storage", {key:DRAFT_KEY, newValue:otherTabDraft, storageArea:localStorage}));
      otherTabEvent();
      check(loadHistory()[0].draft.inputs.notes === "This tab's work" && lastToast('note').includes('another tab'),
        "A draft written by another tab keeps this tab's version in Recent drafts with a notice");
      const historyLength = loadHistory().length;
      otherTabEvent();
      check(loadHistory().length === historyLength, "Repeated other-tab writes without new local edits do not flood Recent drafts");

      const blockedSetter = Storage.prototype.setItem, realSetStatus = window.setStatus;
      let saveFailureReports = 0;
      window.setStatus = (kind, message, opts) => { if (/could not save the draft/.test(message)) saveFailureReports++; return realSetStatus(kind, message, opts); };
      Storage.prototype.setItem = function() { throw new DOMException("Fixture blocked storage", "SecurityError"); };
      try {
        for (let i = 0; i < 3; i++) { $("notes").value = "Blocked " + i; $("notes").dispatchEvent(new Event("input", {bubbles:true})); flushDraft(); }
        check(saveFailureReports === 1, "Blocked storage reports one autosave error, not one per autosave");
        Storage.prototype.setItem = blockedSetter;
        $("notes").dispatchEvent(new Event("input", {bubbles:true})); flushDraft();
        Storage.prototype.setItem = function() { throw new DOMException("Fixture blocked storage", "SecurityError"); };
        $("notes").dispatchEvent(new Event("input", {bubbles:true})); flushDraft();
        check(saveFailureReports === 2, "A new autosave failure after a successful save is reported again");
      } finally { Storage.prototype.setItem = blockedSetter; window.setStatus = realSetStatus; }
      $("notes").dispatchEvent(new Event("input", {bubbles:true})); flushDraft();
      newListing();

      // ---- Marteloio layout, header and status ----
      check(document.title === "Marteloio — Details, drafted." && !document.querySelector('link[href*="googleapis"], link[href*="gstatic"]') &&
        [...document.querySelector("style").sheet.cssRules].filter(rule => rule instanceof CSSFontFaceRule).length === 4,
        "Marteloio title with self-hosted Manrope and Space Grotesk faces");
      setStatus("ok", "Fixture toast");
      check(document.querySelector('#toastPanel .toast-title') && !document.querySelector('#toastPanel h1, #toastPanel h2, #toastPanel h3'),
        "Toast titles are not headings");
      check(!$("preview").hasAttribute("role") && $("previewPanel").getAttribute("role") === "tabpanel" && $("tabPreview").getAttribute("aria-controls") === "previewPanel" &&
        $("htmlPanel").getAttribute("role") === "tabpanel" && $("tabHtml").getAttribute("aria-controls") === "htmlPanel" && !$("htmlOut").hasAttribute("role"),
        "The preview iframe and HTML editor are wrapped by real tab panels");
      for (const [status, text] of [
        [{ready:true, retry_in:0, providers:[{id:'groq', label:'Groq', configured:true, state:'ready', retry_in:0, model:'fixture-model'}]}, 'AI ready'],
        [{ready:false, retry_in:12, providers:[{id:'groq', label:'Groq', configured:true, state:'rate_limited', retry_in:12, model:'fixture-model'}]}, 'AI busy — retry in 12s'],
        [{ready:false, retry_in:0, providers:[{id:'groq', label:'Groq', configured:false, state:'off', retry_in:0, model:''}]}, 'No AI key'],
        [{ready:false, retry_in:0, providers:[{id:'groq', label:'Groq', configured:true, state:'unavailable', retry_in:0, model:'fixture-model'}]}, 'AI offline']]) {
        aiStatus = status; await checkHealth();
        check($("statusText").textContent === text && $("aiStatus").title.includes('Groq'), "AI status pill reads " + text + " with providers in its tooltip");
      }
      aiStatus = {ready:true, retry_in:0, providers:[{id:'groq', label:'Groq', configured:true, state:'ready', retry_in:0, model:'fixture-model'}]};
      await checkHealth(); clearTimeout(healthRetryTimer);
      check(["newListingBtn", "duplicateBtn", "historyList", "backupDraftBtn", "importDraftBtn"].every(id => $("draftsPanel").contains($(id))) &&
        !$("outputCard").contains($("newListingBtn")), "Draft commands live in the header Drafts menu");
      $("draftsBtn").focus(); $("draftsBtn").click();
      check(!$("draftsPanel").hidden && $("draftsBtn").getAttribute("aria-expanded") === "true" && $("draftsCount").textContent === String(loadHistory().length),
        "Drafts menu opens and shows the Recent drafts count");
      $("duplicateBtn").focus();
      $("duplicateBtn").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true}));
      check($("draftsPanel").hidden && $("draftsBtn").getAttribute("aria-expanded") === "false" && document.activeElement === $("draftsBtn"),
        "Escape closes the Drafts menu and returns focus to its button");

      newListing();
      const steps = () => [...$("courseSteps").children].map(li => li.className).join(",");
      check($("previewShell").classList.contains("empty") && getComputedStyle($("emptyState")).display !== "none" && getComputedStyle($("previewPanel")).display === "none",
        "Before a listing exists the preview shows the three-step empty state");
      check(steps() === "now,,," && $("editContentBtn").disabled && $("shuffleStyleBtn").disabled, "Course starts at Describe with listing-only actions unavailable");
      const disabledStyle = getComputedStyle($("copyHtmlBtn")), surfaceSample = document.createElement("span");
      surfaceSample.style.background = "var(--surface-2)"; document.body.append(surfaceSample);
      check(disabledStyle.backgroundColor === getComputedStyle(surfaceSample).backgroundColor, "Unavailable primary actions are neutral grey, not pale orange");
      surfaceSample.remove();
      const pendingBeforeSample = pending.length;
      $("sampleBtn").click();
      check($("notes").value.startsWith("SAMPLE ITEM") && state.includedItems.length === 3 && !state.data && !$("condition").value &&
        pending.length === pendingBeforeSample && !inflight.generate, "Try a sample item fills synthetic notes without generating or choosing a condition");
      check(steps() === "done,now,,", "Course marks Describe done once there is something to generate from");
      const longTitle = "Vintage 35mm film camera body silver with body cap and neck strap tested shutter and meter";
      $("notes").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", ctrlKey:true, bubbles:true, cancelable:true}));
      const courseRequest = await nextRequest();
      check(courseRequest.path === "/llm/chat/completions" && $("generateBtn").disabled && !busyToast && steps() === "done,now,,",
        "Ctrl+Enter in the form generates, with the button as the one busy indicator");
      complete(courseRequest, {...listing(longTitle), condition_rating:"USED"}); await tick(); await tick();
      check(steps() === "done,done,now," && state.data.model_title_length === longTitle.length && !$("titleShortenedNotice").hidden &&
        $("titleShortenedNotice").textContent.includes("was " + longTitle.length + " characters"),
        "After generation the course is at Review and a shortened model title is explained");
      {
        // Waypoint landing: never runs with an end off screen; when it runs it cleans up after itself.
        await tick(); await tick();
        for (let i = 0; i < 40 && document.querySelector(".course-flight"); i++) await new Promise(r => setTimeout(r, 75));
        window.scrollTo(0, document.documentElement.scrollHeight);
        const offscreen = $("rulerWaypoint").getBoundingClientRect().bottom < 0 || $("generateBtn").getBoundingClientRect().top > innerHeight;
        check(!offscreen || (courseLanding() === false && !document.querySelector(".course-flight") && $("rulerWaypoint").style.opacity === ""),
          "The waypoint landing is skipped when its landing spot is off screen");
        $("rulerWaypoint").scrollIntoView({block: "center"});
        const ran = courseLanding();
        check(ran === false ? !document.querySelector(".course-flight") :
          document.querySelectorAll(".course-flight").length === 1 && document.querySelector(".course-flight").getAttribute("aria-hidden") === "true",
          "The waypoint landing adds one decorative, hidden-from-readers layer when it runs");
        if (ran) {
          for (let i = 0; i < 40 && document.querySelector(".course-flight"); i++) await new Promise(r => setTimeout(r, 75));
          check(!document.querySelector(".course-flight") && $("rulerWaypoint").style.opacity === "" && $("rulerWaypoint").classList.contains("landing"),
            "After landing, the flight layer is removed and the ruler waypoint is visible again");
        }
        window.scrollTo(0, 0);
      }
      check(state.html.includes('elb-cond-unknown') && state.data.condition_rating === "", "A sample with no seller condition renders the neutral condition panel");
      $("downloadBtn").click();
      check(steps() === "done,done,done,done", "Downloading the HTML completes the Copy step");
      $("titleIn").value = "x".repeat(40); $("titleIn").dispatchEvent(new Event("input", {bubbles:true}));
      check($("rulerWaypoint").style.left === "50%" && $("rulerFill").style.width === "50%" && $("titleCounter").textContent === "40 / 80" &&
        $("shortenTitleBtn").hidden && !$("titleRuler").classList.contains("over"), "The bearing ruler puts the waypoint at the current title length");
      $("titleIn").value = "word ".repeat(20).trim(); $("titleIn").dispatchEvent(new Event("input", {bubbles:true}));
      check($("titleRuler").classList.contains("over") && !$("shortenTitleBtn").hidden && $("rulerWaypoint").style.left === "100%" && $("titleCounter").classList.contains("over"),
        "Over 80 characters the waypoint warns and Shorten to 80 is offered");
      $("shortenTitleBtn").click();
      check($("titleIn").value.length <= 80 && $("shortenTitleBtn").hidden, "Shorten to 80 clears the warning");
      $("titleIn").value = "Line one\nline two"; $("titleIn").dispatchEvent(new Event("input", {bubbles:true}));
      check($("titleIn").value === "Line one line two", "The two-line title field never stores a line break");
      showTab("preview");
      await new Promise(resolve => { $("preview").addEventListener("load", resolve, {once:true}); state.edited = false; renderPreview(); });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const frameDoc = $("preview").contentDocument;
      check(Math.abs($("preview").offsetHeight - Math.max(320, frameDoc.documentElement.scrollHeight)) <= 2,
        "The preview frame grows to its content height");
      $("viewMobile").click(); await new Promise(resolve => requestAnimationFrame(resolve));
      check($("preview").offsetWidth === 375 && $("viewMobile").getAttribute("aria-pressed") === "true",
        "Mobile preview renders the listing 375px wide");
      $("viewDesktop").click();
      for (const style of STYLE_ARCHES.map(x => x.id)) {
        $("styleChoice").value = style;
        const unknownDoc = new DOMParser().parseFromString(buildListingHTML({...state.data, condition_rating:""}, "", "Tint", {}, "listing"), "text/html");
        const knownDoc = new DOMParser().parseFromString(buildListingHTML({...state.data, condition_rating:"USED"}, "", "Tint", {}, "listing"), "text/html");
        check(unknownDoc.querySelector(".elb-cond").classList.contains("elb-cond-unknown") && !knownDoc.querySelector(".elb-cond").classList.contains("elb-cond-unknown") &&
          unknownDoc.querySelector("style").textContent.includes(".elb-cond.elb-cond-unknown{background:#efefec"),
          style + " uses a neutral condition panel only when the condition is not specified");
      }
      $("styleChoice").value = "auto";
      $("moreOptions").open = false;
      applyDraft({inputs:{notes:"Barcode option", productBarcode:"012345678905"}}); renderDraft();
      check($("moreOptions").open, "More options opens itself when it holds a non-default value");
      newListing();

      /* ---- listing template v2 checks ---- */
      {
        // Each check is evaluated defensively so the block can also run in soft mode against older code.
        const v2 = (fn, label) => { let ok = false; try { ok = Boolean(fn()); } catch (_) { ok = false; } check(ok, label); };
        const v2Saved = {mode:state.mode, seed:state.styleSeed, style:$("styleChoice").value, varies:state.condVaries};
        const v2Sample = ListingCore.normalizeListing({
          title: "Aurora camera kit", subtitle: "Mirrorless body with strap",
          description_paragraphs: ["First paragraph about the Aurora kit.", "Second paragraph & more detail."],
          condition_rating: "USED", condition_notes: "Small scratch on the base.", note: "Battery not included.",
          item_specifics: {Brand:"Aurora", Model:"C1", Type:"Mirrorless", Color:"Black", Mount:"A-mount"},
          highlights_title: "Key Numbers", highlights: [{stat:"24 MP", label:"Sensor", caption:"Full frame."}],
          included_items: ["Camera body"], not_included: ["Battery"], buyer_notes: [],
          bundle_items: [{name:"Camera body", condition:"Used", description:"Small scratch."},
            {name:"Strap", condition:"For parts or not working", description:"Frayed."}]
        });
        const v2Html = (data, mode, policy = "accepted") => buildListingHTML(data, "Example seller", data.title, {username:"example-seller"}, policy, mode);
        const v2Doc = html => new DOMParser().parseFromString(html, "text/html");
        const v2Span = html => (html.match(/<div[^>]*vocab="https:\/\/schema\.org\/"[^>]*typeof="Product"[^>]*><span property="description">([\s\S]*?)<\/span><\/div>/) || [])[1];
        const v2Order = {
          classic: ["overview", "bundle", "specs", "highlights", "condition", "included", "notes", "policies"],
          story: ["overview", "highlights", "specs", "bundle", "condition", "included", "notes", "policies"],
          spec: ["specs", "overview", "highlights", "bundle", "condition", "included", "notes", "policies"],
          minimal: ["overview", "bundle", "specs", "highlights", "condition", "included", "notes", "policies"]
        };
        const v2Sections = doc => [...doc.querySelectorAll(".elb-section")].map(el => [...el.classList].find(c => c.startsWith("elb-sec-")).slice(8));
        const v2Count = (text, re) => (text.match(re) || []).length;
        const v2Contrast = (a, b) => {
          const lum = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; })
            .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const x = lum(a), y = lum(b);
          return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
        };
        v2(() => !/uppercase section heading|label \(uppercase\)|short uppercase heading|"BEFORE YOU BUY"/.test(SYSTEM_PROMPT) &&
          /features_title: short Title Case/.test(SYSTEM_PROMPT) && /highlights_title is a short Title Case heading/.test(SYSTEM_PROMPT),
          "The prompt asks for Title Case section titles, not uppercase");
        for (const mode of ["single", "bundle"]) {
          state.mode = mode; state.condVaries = mode === "bundle";
          for (const style of [...STYLE_ARCHES.map(x => x.id), "auto", "simple"]) {
            $("styleChoice").value = style; state.styleSeed = 9;
            const html = v2Html(v2Sample, mode), doc = v2Doc(html), text = doc.body.textContent, tag = style + "/" + mode;
            const arch = style === "auto" ? STYLE_ARCHES[9 % STYLE_ARCHES.length].id : style;
            const inner = v2Span(html) || "";
            v2(() => doc.querySelectorAll('[vocab="https://schema.org/"][typeof="Product"] > span[property="description"]').length === 1 &&
              inner.length > 0 && inner.length <= 800 && !/<(?!br>)/i.test(inner) && !inner.includes("<!--") &&
              inner.includes("Mirrorless body with strap") && inner.includes("First paragraph about the Aurora kit.") &&
              inner.includes("Condition: Used") && inner.includes("Brand: Aurora") && inner.includes("Color: Black") && !inner.includes("Mount"),
              tag + " has one eBay mobile summary of plain text and <br> within 800 characters");
            const summaryBox = doc.querySelector('[vocab="https://schema.org/"]');
            const firstHeading = doc.querySelector("h2");
            v2(() => summaryBox.compareDocumentPosition(firstHeading) & Node.DOCUMENT_POSITION_FOLLOWING &&
              v2Count(text, /First paragraph about the Aurora kit/g) === 1 && v2Count(text, /Mirrorless body with strap/g) === 1 &&
              text.includes("Second paragraph & more detail."),
              tag + " shows the mobile summary near the top as the intro, without repeating it");
            v2(() => doc.querySelectorAll("table th[scope=row]").length === 5 && doc.querySelectorAll("table tr").length === 5 &&
              [...doc.querySelectorAll("table tr")].every(tr => tr.children.length === 2 && tr.children[0].matches("th[scope=row]") && tr.children[1].matches("td")) &&
              doc.querySelector("table th[scope=row]").textContent === "Brand" && !doc.querySelector(".elb-spec-row"),
              tag + " renders item specifics as a table with row headers");
            v2(() => !doc.querySelector("input, label, select, textarea, button, form") && !/type="radio"|elb-tab|Store policies|About us/i.test(html) &&
              v2Count(text, /Shipping & returns/g) === 1 && text.includes("See the shipping details in this listing") &&
              text.includes("Returns accepted — see the return policy in this listing for details."),
              tag + " has one compact Shipping & returns section and no form controls");
            v2(() => v2Count(text, /photo/gi) === 1 && v2Count(text, /only the items shown/gi) === 1 &&
              v2Count(text, /questions/gi) === 1 && v2Count(text, /before purchasing/gi) === 1 && !/Thank you for shopping/i.test(html) &&
              (style === "simple" || ["photo", "Only the items shown", "questions"].every(p => doc.querySelector(".elb-sec-notes").textContent.includes(p))),
              tag + " states each buyer guidance line once, in Before you buy");
            v2(() => !/<script|<iframe|<meta|<link|<a\s|cookie|replace\(|http:\/\/|@import|data:|url\(|expression\(/i.test(html) &&
              (html.match(/https:\/\/[^"'\s)<]*/g) || []).every(url => url === "https://schema.org/"),
              tag + " contains no strings eBay rejects or flags and no external resources");
            if (style !== "simple") {
              const css = doc.querySelector("style").textContent, theme = STYLE_THEMES[Math.floor(9 / STYLE_ARCHES.length) % STYLE_THEMES.length];
              v2(() => v2Count(css, /--brand:/g) === 1 && css.includes("--brand:" + theme.brand) && css.includes("--paper:" + theme.paper) &&
                !/\.elb-theme-\d/.test(css) && STYLE_ARCHES.every(a => a.id === arch || !css.includes(".elb-arch-" + a.id)) &&
                !/(^|[;{\s])order\s*:/.test(css) && (mode === "bundle") === css.includes(".elb-bundle-item{"),
                tag + " emits only the active theme's and layout's CSS");
              v2(() => JSON.stringify(v2Sections(doc)) === JSON.stringify(v2Order[arch].filter(key => key !== "bundle" || mode === "bundle")) &&
                doc.querySelector(".ebay-listing").firstElementChild.tagName === "STYLE" &&
                doc.querySelector(".elb-titleblock").contains(summaryBox),
                tag + " builds sections in the " + arch + " order in the DOM");
              v2(() => /\.elb-h2::before\{[^}]*background:var\(--accent\)/.test(css) && !/::before\{[^}]*#FF5A1F/i.test(css),
                tag + " heading accent bar follows the theme accent");
            }
          }
        }
        // Long text stays within eBay's 800-character summary limit and is repeated in full below.
        $("styleChoice").value = "classic"; state.mode = "single"; state.styleSeed = 0;
        const v2Long = {...v2Sample, subtitle: "Sub & title ".repeat(40), description_paragraphs: ["Tom's <b>kit</b> & lens ".repeat(150), "Tail."],
          item_specifics: Object.fromEntries(["Brand", "Model", "Type", "Color"].map(k => [k, "Value & more '" .repeat(20)]))};
        for (const style of ["classic", "simple"]) {
          $("styleChoice").value = style;
          const html = v2Html(v2Long, "single"), inner = v2Span(html) || "", doc = v2Doc(html);
          v2(() => inner.length <= 800 && inner.includes("…") && !/&[a-z#0-9]*…/i.test(inner) && !/<(?!br>)/i.test(inner) &&
            doc.body.textContent.includes(v2Long.description_paragraphs[0].trim()),
            style + " shortens an over-long mobile summary on a word boundary and keeps the full paragraph in the listing");
        }
        // Rendered checks: font sizes, overflow, visual order, theme accent and no-CSS table.
        const v2Frame = document.createElement("iframe");
        v2Frame.style.cssText = "height:900px;border:0;display:block";
        panel.append(v2Frame);
        const v2Load = async (html, width) => {
          v2Frame.style.width = width + "px";
          const loaded = new Promise(resolve => v2Frame.onload = resolve);
          v2Frame.srcdoc = html; await loaded;
          return [v2Frame.contentDocument, v2Frame.contentWindow];
        };
        for (const mode of ["single", "bundle"]) {
          state.mode = mode; state.condVaries = mode === "bundle";
          for (const style of [...STYLE_ARCHES.map(x => x.id), "simple"]) {
            for (const theme of style === "simple" ? [0] : [0, 6]) {
              $("styleChoice").value = style; state.styleSeed = theme * STYLE_ARCHES.length;
              const html = v2Html(v2Sample, mode), tag = style + "/" + mode + "/theme " + theme;
              for (const width of [375, 320]) {
                let doc, win;
                try { [doc, win] = await v2Load(html, width); } catch (_) { doc = null; }
                const sizes = [];
                if (doc) {
                  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
                  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                    if (!n.textContent.trim()) continue;
                    const cs = win.getComputedStyle(n.parentElement);
                    if (cs.display !== "none" && cs.visibility !== "hidden") sizes.push(parseFloat(cs.fontSize));
                  }
                }
                v2(() => sizes.length > 20 && Math.min(...sizes) >= 14 && doc.documentElement.scrollWidth <= width &&
                  parseFloat(win.getComputedStyle(doc.body.firstElementChild).fontSize) === 16,
                  tag + " at " + width + "px uses a 16px base, no buyer text under 14px and no overflow");
                if (width === 375 && style !== "simple") {
                  const tops = [doc.querySelector(".elb-titleblock"), ...doc.querySelectorAll(".elb-section"), doc.querySelector(".elb-brand-signature")]
                    .map(el => el.getBoundingClientRect().top);
                  v2(() => tops.every((top, i) => i === 0 || top > tops[i - 1]),
                    tag + " visual section order matches DOM order");
                  const probe = doc.createElement("i"); probe.style.color = "var(--accent)";
                  doc.querySelector(".ebay-listing").append(probe);
                  v2(() => win.getComputedStyle(doc.querySelector(".elb-h2"), "::before").backgroundColor === win.getComputedStyle(probe).color,
                    tag + " heading accent bar matches the theme accent");
                  probe.remove();
                  const th = doc.querySelector(".elb-specs th"), td = doc.querySelector(".elb-specs td");
                  v2(() => [th, td].every(cell => { const cs = win.getComputedStyle(cell); let el = cell, bg = "rgba(0, 0, 0, 0)";
                    while (el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = win.getComputedStyle(el).backgroundColor; el = el.parentElement; }
                    return v2Contrast(cs.color, /rgba\(0, 0, 0, 0\)/.test(bg) ? "rgb(255, 255, 255)" : bg) >= 4.5; }),
                    tag + " item specifics table text keeps 4.5:1 contrast");
                }
              }
              if (style !== "simple") {
                const [doc] = await v2Load(html.replace(/<style>[\s\S]*?<\/style>/, ""), 375);
                v2(() => [...doc.querySelectorAll("table tr")].map(tr => tr.textContent).join("|") === "BrandAurora|ModelC1|TypeMirrorless|ColorBlack|MountA-mount" &&
                  v2Frame.contentWindow.getComputedStyle(doc.querySelector("table tr")).display === "table-row" &&
                  doc.querySelector("th").getBoundingClientRect().right <= doc.querySelector("td").getBoundingClientRect().left,
                  tag + " item specifics still read as label/value rows with the style block removed");
              }
            }
          }
        }
        v2Frame.remove();
        state.mode = v2Saved.mode; state.styleSeed = v2Saved.seed; $("styleChoice").value = v2Saved.style; state.condVaries = v2Saved.varies;
      }

      // ---- Templates: reuse a generated listing without an AI request ----
      localStorage.removeItem(TEMPLATES_KEY); renderTemplates();
      check($("saveTemplateBtn").disabled && $("templateList").textContent.includes("No templates"), "Save as template needs a generated listing");
      $("notes").value = "Template source notes"; $("brand").value = "Example brand";
      $("condition").value = "USED"; $("condNotes").value = "Scratch on lens"; $("productBarcode").value = "012345678905";
      state.includedItems = ["Camera body"];
      const templateRun = generate(); const templateRequest = await nextRequest();
      complete(templateRequest, {...listing("Template camera title"), condition_rating:"USED", condition_notes:"Scratch on lens"}); await templateRun;
      check(!$("saveTemplateBtn").disabled && state.data.condition_rating === "USED", "A generated listing can be saved as a template");
      $("groqKey").value = "never-in-template-fixture"; $("ebayClientSecret").value = "never-in-template-secret";
      $("draftsBtn").click(); $("saveTemplateBtn").click();
      check(!$("templateForm").hidden && $("templateNameInput").value === "Template camera title" && document.activeElement === $("templateNameInput"),
        "Save as template asks for a name inline, defaulting to the title");
      $("templateNameInput").value = "Camera template"; $("templateForm").requestSubmit();
      const templateRaw = localStorage.getItem(TEMPLATES_KEY), savedTemplate = loadTemplates()[0];
      check(loadTemplates().length === 1 && savedTemplate.name === "Camera template" && $("templateForm").hidden &&
        savedTemplate.data.condition_rating === "" && savedTemplate.data.condition_notes === "" && savedTemplate.inputs.notes === "Template source notes" &&
        savedTemplate.includedItems.join() === "Camera body" && Number.isSafeInteger(savedTemplate.styleSeed) &&
        !/Scratch on lens|012345678905|never-in-template|USED|condNotes|productBarcode|groq|ebay/i.test(templateRaw),
        "A template keeps the listing and inputs but no condition, barcode, settings or keys");
      $("groqKey").value = ""; $("ebayClientSecret").value = "";
      $("notes").value = "Different current work"; $("notes").dispatchEvent(new Event("input", {bubbles:true}));
      const pendingBeforeTemplate = pending.length;
      { const stored = JSON.parse(localStorage.getItem(TEMPLATES_KEY)); stored[0].data.model_title_length = 120; localStorage.setItem(TEMPLATES_KEY, JSON.stringify(stored)); renderTemplates(); }
      document.querySelector(".template-use").click();
      check(pending.length === pendingBeforeTemplate && !inflight.generate && state.data.title === "Template camera title" &&
        $("notes").value === "Template source notes" && $("brand").value === "Example brand" && $("titleIn").value === "Template camera title",
        "Using a template renders its listing locally with no AI request");
      check($("titleShortenedNotice").hidden && !(state.data.model_title_length > 80), "A template draft does not repeat the source model's title-shortened notice");
      check($("condition").value === "" && $("condNotes").value === "" && $("productBarcode").value === "" && state.data.condition_rating === "" &&
        state.html.includes("Condition not specified") && state.html.includes("elb-cond-unknown") && !state.html.includes("Scratch on lens"),
        "Using a template clears condition, condition notes and barcode for the seller to choose");
      check(loadHistory()[0].draft.inputs.notes === "Different current work", "Using a template saves the current draft to Recent drafts first");
      check(!$("templateNotice").hidden && $("templateNotice").textContent.includes("Started from template “Camera template”") &&
        $("templateNotice").textContent.includes("condition"), "A persistent notice says the draft started from a template");
      $("condition").value = "FOR_PARTS"; $("condition").dispatchEvent(new Event("change", {bubbles:true}));
      $("condNotes").value = "Shutter sticks"; $("condNotes").dispatchEvent(new Event("input", {bubbles:true}));
      check(state.data.condition_rating === "FOR_PARTS" && state.html.includes("For parts or not working") && state.html.includes("Shutter sticks"),
        "The seller's chosen condition is applied to a template draft");
      const templateDraft = JSON.parse(JSON.stringify(snapshotDraft())); applyDraft(templateDraft); renderDraft();
      check(!$("templateNotice").hidden && state.template.name === "Camera template", "The template notice survives draft restoration");
      document.querySelector(".template-rename").click();
      $("templateNameInput").value = "Renamed template"; $("templateForm").requestSubmit();
      check(loadTemplates()[0].name === "Renamed template" && $("templateList").textContent.includes("Renamed template"), "Templates can be renamed");
      const freshRun = generate(); const freshRequest = await nextRequest();
      complete(freshRequest, listing("Fresh AI title")); await freshRun;
      check(state.template === null && $("templateNotice").hidden, "Generate listing still makes a fresh AI draft and clears the template origin");
      // Seller-owned condition fields stay live after a normal AI generation.
      const conditionNotice = "Condition updated in the listing. Check the description doesn't mention the old condition.";
      document.querySelectorAll('.toast-item').forEach(item => item.dataset.seen = '1');
      const newToasts = kind => [...document.querySelectorAll('.toast-item:not([data-seen]) .toast.' + kind + ' p')];
      const noticeCount = () => newToasts('note').filter(p => p.textContent === conditionNotice).length;
      const pendingBeforeCondition = pending.length;
      const proseBeforeCondition = JSON.stringify(state.data.description_paragraphs);
      check(state.data.condition_rating === "FOR_PARTS" && state.html.includes("Shutter sticks") && noticeCount() === 0,
        "A fresh AI draft starts with the condition that was sent");
      $("condition").value = "USED"; $("condition").dispatchEvent(new Event("input", {bubbles:true})); $("condition").dispatchEvent(new Event("change", {bubbles:true}));
      $("condNotes").value = "Motor hums"; $("condNotes").dispatchEvent(new Event("input", {bubbles:true}));
      $("condNotes").value = "Motor hums but does not spin"; $("condNotes").dispatchEvent(new Event("input", {bubbles:true}));
      { const condDoc = new DOMParser().parseFromString(state.html, "text/html");
        check(pending.length === pendingBeforeCondition && !inflight.generate && state.data.condition_rating === "USED" &&
          state.data.condition_notes === "Motor hums but does not spin" && $("htmlOut").value === state.html &&
          condDoc.querySelector(".elb-cond").textContent.includes("Used. Motor hums but does not spin") && !state.html.includes("Shutter sticks") &&
          condDoc.querySelector(".elb-cond").classList.contains(ListingCore.conditionClass("USED")) &&
          JSON.stringify(state.data.description_paragraphs) === proseBeforeCondition,
          "Changing condition and notes after AI generation updates the listing locally, with no AI request or prose change"); }
      check(noticeCount() === 1 && !newToasts('err').length,
        "One non-error notice asks the seller to check the description for the old condition");
      $("condNotes").value = ""; $("condNotes").dispatchEvent(new Event("input", {bubbles:true}));
      check(state.data.condition_notes === "" && noticeCount() === 1, "Later condition edits apply without repeating the notice");
      localStorage.setItem(TEMPLATES_KEY, JSON.stringify(Array.from({length:30}, (_, i) => ({...savedTemplate, id:"cap-" + i, name:"T" + i}))));
      check(!saveTemplate("One too many") && loadTemplates().length === 30 && lastToast("err").includes("30 templates"),
        "Templates are capped at 30 without silently deleting one");
      localStorage.setItem(TEMPLATES_KEY, "[]");
      const templateSetter = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === TEMPLATES_KEY) throw new DOMException("Fixture quota", "QuotaExceededError");
        return templateSetter.call(this, key, value);
      };
      try {
        check(!saveTemplate("Blocked template") && lastToast("err").includes("Could not save templates") && loadTemplates().length === 0,
          "A template that cannot be stored is reported");
      } finally { Storage.prototype.setItem = templateSetter; }
      check(saveTemplate("To delete") && loadTemplates().length === 1, "A template can be saved again after a failure");
      document.querySelector(".template-delete").click();
      check(loadTemplates().length === 0 && $("templateList").textContent.includes("No templates"), "Templates can be deleted");
      localStorage.removeItem(TEMPLATES_KEY);
      newListing();

      const normalized = ListingCore.normalizeListing(listing("Policy example"));
      for (const policy of ["listing", "accepted", "none"]) {
        const html = buildListingHTML(normalized, "", "Policy example", {}, policy);
        check(!/Top-rated service|Fast dispatch|1 business day|includes tracking|Combined shipping is available|Every item is inspected|buyer.s responsibility|We carefully package|photos are of the actual/i.test(html), "No unsupported seller promises: " + policy);
        if (policy === "listing") {
          check(!html.includes('<div class="elb-header">'), "No empty seller banner when no profile or policy is set");
        }
      }
      check(![...$("returnsPolicy").options].some(o => /\d/.test(o.textContent)), "The returns choices claim no day count");
      for (const style of [...STYLE_ARCHES.map(x => x.id), "simple"]) {
        $("styleChoice").value = style;
        for (const policy of ["listing", "accepted", "none"]) {
          const policyDoc = new DOMParser().parseFromString(buildListingHTML(normalized, "", "Policy example", {}, policy), "text/html"), text = policyDoc.body.textContent;
          check(!/\d+[- ]?days?\b/i.test(text) &&
            (policy !== "accepted" || text.includes("Returns accepted — see the return policy in this listing for details.") && (style === "simple" || policyDoc.querySelector(".elb-vp")?.textContent === "Returns accepted")) &&
            (policy !== "none" || text.includes("does not accept returns")) && (policy !== "listing" || !text.includes("Returns accepted")),
            style + "/" + policy + " returns wording makes no day-count claim");
        }
      }
      $("styleChoice").value = "auto";
      state.data = normalized; renderAll();
      const beforeKeyboardHTML = state.html;
      showTab("preview");
      $("tabPreview").focus();
      for (const [key, expected] of [["End", "html"], ["Home", "preview"],
        ["ArrowLeft", "html"], ["ArrowRight", "preview"]]) {
        document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles:true, cancelable:true}));
        const active = $(expected === "html" ? "tabHtml" : "tabPreview");
        const other = $(expected === "html" ? "tabPreview" : "tabHtml");
        check(document.activeElement === active && active.tabIndex === 0 && other.tabIndex === -1 &&
          active.getAttribute("aria-selected") === "true" && other.getAttribute("aria-selected") === "false" &&
          getComputedStyle($(expected === "html" ? "htmlOut" : "preview")).display !== "none" &&
          getComputedStyle($(expected === "html" ? "preview" : "htmlOut")).display === "none",
          key + " keeps output tab focus, selection and panel synchronized");
      }
      const untouchedTabKey = new KeyboardEvent("keydown", {key:"Tab", bubbles:true, cancelable:true});
      $("tabPreview").dispatchEvent(untouchedTabKey);
      check(!untouchedTabKey.defaultPrevented && state.html === beforeKeyboardHTML,
        "Output tab navigation preserves HTML and lets Tab leave normally");
      const beforeThemeHTML = buildListingHTML(normalized, "", "Theme independence", {}, "listing");
      const brandState = {mode:state.mode, seed:state.styleSeed, style:$("styleChoice").value};
      const originalBrandFacts = JSON.stringify(brandSample);
      for (const mode of ["single", "bundle"]) {
        state.mode = mode;
        for (const style of ["auto", ...STYLE_ARCHES.map(x=>x.id), "simple"]) {
          $("styleChoice").value = style;
          for (let theme=0; theme<STYLE_THEMES.length; theme++) {
            state.styleSeed = theme*STYLE_ARCHES.length;
            const html = buildListingHTML(brandSample,"Example seller",brandSample.title,{},"listing");
            const doc = new DOMParser().parseFromString(html,"text/html");
            const signature = doc.querySelector('.elb-brand-signature');
            check(doc.querySelectorAll('.elb-brand-signature').length === 1 &&
              signature.textContent === 'Listing created with MarteloioLocal, open-source listing software' &&
              signature.innerText.split(/\s+/).filter(Boolean).length <= 10 && signature.textContent.split(/\s+/).length <= 10 &&
              !/https?:|www\.|\.(com|net|org|io|dev)\b|github|@/i.test(signature.innerHTML) && signature.dataset.brand === 'Marteloio' &&
              signature.querySelector('strong').style.color === 'rgb(255, 90, 31)' &&
              signature.lastElementChild.style.color === 'rgb(116, 121, 130)' &&
              signature === doc.body.firstElementChild.lastElementChild,
              mode + '/' + style + '/' + theme + ' has one final approved text signature');
            check(doc.querySelector('h1').textContent === brandSample.title &&
              doc.body.textContent.includes(brandSample.description_paragraphs[0]) &&
              doc.body.textContent.includes('Small scratch on the base.') &&
              doc.body.textContent.includes('Battery') &&
              !doc.querySelector('script, .sky, #starfield, #themeToggle, .elb-brand-signature img') &&
              !/animation:|@import|List\. Launch\. Sell\.|Montserrat|LanzaLister|Space Grotesk|Manrope/.test(html),
              mode + '/' + style + '/' + theme + ' preserves escaped facts and portable static branding');
          }
        }
      }
      check(JSON.stringify(brandSample) === originalBrandFacts, "Brand rendering does not mutate seller data");
      state.mode=brandState.mode; state.styleSeed=brandState.seed; $("styleChoice").value=brandState.style;
      const contrast = (a, b) => {
        const lum = rgb => {
          const v = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => {
            n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
          });
          return v[0] * .2126 + v[1] * .7152 + v[2] * .0722;
        };
        const x = lum(a), y = lum(b);
        return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
      };
      const exportFrame = document.createElement("iframe");
      exportFrame.style.cssText = "height:1700px;border:0;display:block";
      panel.append(exportFrame);
      for (const mode of ["single", "bundle"]) {
        state.mode = mode;
        for (const style of [...STYLE_ARCHES.map(x=>x.id), "simple"]) {
          $("styleChoice").value = style; state.styleSeed = 0;
          for (const width of [920, 390]) {
            exportFrame.style.width = width + "px";
            const loaded = new Promise(resolve => exportFrame.onload = resolve);
            exportFrame.srcdoc = buildListingHTML(brandSample,"Example seller",brandSample.title,{},"listing");
            await loaded;
            const doc = exportFrame.contentDocument, win = exportFrame.contentWindow;
            const signature = doc.querySelector('.elb-brand-signature');
            const rect = signature.getBoundingClientRect();
            const siblings = [...signature.parentElement.children].filter(el => el !== signature && el.tagName !== 'STYLE');
            check(doc.documentElement.scrollWidth <= width && rect.left >= 0 && rect.right <= width &&
              siblings.every(el => el.getBoundingClientRect().bottom <= rect.top + 1),
              mode + '/' + style + '/' + width + ' renders the signature below all seller sections without overflow');
            check(contrast(win.getComputedStyle(signature.lastElementChild).color, win.getComputedStyle(signature).backgroundColor) >= 4.5 &&
              parseFloat(win.getComputedStyle(doc.querySelector('h1')).fontSize) > parseFloat(win.getComputedStyle(signature.querySelector('strong')).fontSize),
              mode + '/' + style + '/' + width + ' keeps the slogan readable and product title dominant');
          }
        }
      }
      // Condition panel tint per seller condition, and archetype titles at phone width.
      state.mode = "single"; exportFrame.style.width = "390px";
      for (const style of STYLE_ARCHES.map(x => x.id)) {
        $("styleChoice").value = style; state.styleSeed = 0;
        const panels = {};
        for (const code of ["NEW", "EUC", "USED", "GUC", "FOR_PARTS", "UNTESTED", ""]) {
          const loaded = new Promise(resolve => exportFrame.onload = resolve);
          exportFrame.srcdoc = buildListingHTML({...brandSample, condition_rating: code}, "Example seller", brandSample.title, {}, "accepted", "single");
          await loaded;
          const doc = exportFrame.contentDocument, win = exportFrame.contentWindow;
          const condPanel = doc.querySelector(".elb-cond"), cs = win.getComputedStyle(condPanel);
          panels[code] = cs.backgroundColor;
          check(["strong", "p"].every(sel => contrast(win.getComputedStyle(condPanel.querySelector(sel)).color, cs.backgroundColor) >= 4.5) &&
            cs.borderLeftWidth === "4px", style + "/" + (code || "unknown") + " condition panel text is readable on its tint");
          if (code === "") {
            check(parseFloat(win.getComputedStyle(doc.querySelector("h1")).fontSize) <= 21 &&
              (style !== "story" || parseFloat(win.getComputedStyle(doc.querySelector(".elb-titleblock")).paddingLeft) <= 14),
              style + " uses the mobile title size and padding at 390px");
          }
        }
        check(panels.NEW === "rgb(232, 248, 239)" && panels.EUC === panels.NEW && panels.GUC === panels.USED &&
          new Set([panels.NEW, panels.USED, panels.FOR_PARTS, panels.UNTESTED]).size === 4 && panels.UNTESTED === panels[""],
          style + " tints the condition panel per condition: green, neutral-warm, amber for parts, grey for untested and unknown");
        const loaded = new Promise(resolve => exportFrame.onload = resolve);
        exportFrame.srcdoc = buildListingHTML({...brandSample, bundle_items: ["New", "Used", "For parts or not working", "Untested", "Condition not specified"]
          .map(condition => ({name: condition, condition, description: "Seller item."}))}, "", brandSample.title, {}, "listing", "bundle");
        await loaded;
        check([...exportFrame.contentDocument.querySelectorAll(".elb-bundle-cond")].every(badge => {
          const bs = exportFrame.contentWindow.getComputedStyle(badge); return contrast(bs.color, bs.backgroundColor) >= 4.5;
        }), style + " bundle condition badges stay readable");
      }
      exportFrame.remove();
      state.mode=brandState.mode; state.styleSeed=brandState.seed; $("styleChoice").value=brandState.style;
      check(!document.querySelector("header .brand-mark, header #llGrad"), "Production header omits superseded placeholder artwork");
      check(document.querySelectorAll("#starfield").length === 1 &&
        document.querySelectorAll("#starfield > i").length === 3 && $("starfield").getAttribute("aria-hidden") === "true",
        "Approved decorative starfield remains with all three layers");
      check(["inputCard", "outputCard"].every(id => {
        const sky = $(id).querySelector(".sky");
        return sky && sky.getAttribute("aria-hidden") === "true" && sky.querySelectorAll("i").length === 3;
      }), "Approved shooting-star markup remains on both cards");
      const driftRule = [...document.querySelector("style").sheet.cssRules].find(rule => rule.name === "starDrift");
      check(driftRule && driftRule.cssRules[1].style.transform === "translate3d(0px, -2400px, 0px)" &&
        getComputedStyle($("starL1"), "::after").top === "2400px",
        "Upward starfield drift has a matching seamless repeat offset");
      check(STAR_RGB.join(";") === "255,90,31;39,194,129;116,121,130" && document.querySelector(".sky i"),
        "Approved starfield palette and shooting-star elements remain");
      for (const theme of ["light", "dark"]) {
        $("appTheme").value = theme;
        $("appTheme").dispatchEvent(new Event("change"));
        const visibleLogo = document.querySelector(".brand-artwork img");
        await visibleLogo.decode();
        check(getComputedStyle(visibleLogo).display !== "none" && visibleLogo.naturalWidth === 256 &&
          visibleLogo.getAttribute("src").endsWith("marteloio-dark.png") &&
          $("brandIcon").getAttribute("href").endsWith("marteloio-" + theme + "-64.png"),
          theme + " shows the dark-background mark on the night header and the matching favicon");
        const rootStyle = getComputedStyle(document.documentElement);
        const buttonStyle = getComputedStyle($("generateBtn"));
        const cardStyle = getComputedStyle($("inputCard"));
        const hintStyle = getComputedStyle(document.querySelector(".hint"));
        const editorStyle = getComputedStyle($("htmlOut"));
        const badgeStyle = getComputedStyle(document.querySelector(".edit-badge"));
        check(contrast(editorStyle.color, editorStyle.backgroundColor) >= 4.5,
          theme + " HTML editor uses readable theme surfaces");
        check(contrast(badgeStyle.color, badgeStyle.backgroundColor) >= 4.5,
          theme + " manual-edit badge uses readable palette colors");
        const referenceStamp = document.createElement("span");
        referenceStamp.className = "refpanel-stamp";
        const referenceLink = document.createElement("a");
        referenceLink.textContent = "Source listing";
        referenceStamp.append(referenceLink);
        referenceStamp.style.color = "var(--primary-active)";
        document.body.append(referenceStamp);
        check(contrast(getComputedStyle(referenceLink).color, cardStyle.backgroundColor) >= 4.5 &&
          getComputedStyle(referenceLink).color === getComputedStyle(referenceStamp).color,
          theme + " source links use the readable theme accent");
        referenceStamp.remove();
        check(rootStyle.colorScheme === theme && contrast(hintStyle.color, cardStyle.backgroundColor) >= 4.5,
          theme + " theme applies with readable supporting text");
        check(contrast(buttonStyle.color, buttonStyle.backgroundColor) >= 4.5,
          theme + " primary action text meets contrast");
        $("settingsBtn").focus();
        check(contrast(getComputedStyle($("settingsBtn")).outlineColor, "rgb(17,19,24)") >= 3,
          theme + " Settings keyboard focus contrasts with the night header");
        {
          const link = $("feedbackLink"), box = link.getBoundingClientRect();
          check(link.tagName === "A" && link.href === "https://github.com/browser-b0X/marteloio/issues/new/choose" &&
            link.target === "_blank" && /\bnoopener\b/.test(link.rel) && /\bnoreferrer\b/.test(link.rel) &&
            /report a bug/i.test(link.getAttribute("aria-label")) && link.closest(".header-actions") &&
            box.width >= 32 && box.height >= 32 && contrast(getComputedStyle(link).color, "rgb(17,19,24)") >= 4.5,
            theme + " the header GitHub button opens the bug and idea page in a new tab, labelled and readable");
          link.focus();
          check(contrast(getComputedStyle(link).outlineColor, "rgb(17,19,24)") >= 3, theme + " the GitHub button's keyboard focus is visible");
        }
        const sample = document.createElement("span");
        document.body.append(sample);
        for (const token of ["--ok", "--err", "--info"]) {
          sample.style.color = "var(" + token + ")";
          check(contrast(getComputedStyle(sample).color, cardStyle.backgroundColor) >= 4.5,
            theme + " status text contrast: " + token);
        }
        sample.remove();
        const modalStyle = getComputedStyle(document.querySelector(".modal"));
        const modalLabelStyle = getComputedStyle(document.querySelector(".modal label"));
        check(contrast(modalLabelStyle.color, modalStyle.backgroundColor) >= 4.5,
          theme + " Settings labels remain readable");
        check(buildListingHTML(normalized, "", "Theme independence", {}, "listing") === beforeThemeHTML,
          theme + " app theme leaves seller export unchanged");
      }
      $("appTheme").value = "light";
      $("appTheme").dispatchEvent(new Event("change"));
      $("styleChoice").value = "simple";
      const simpleOutput = buildListingHTML({...normalized, description_paragraphs:["Text <script>not executable</script>"], included_items:["Camera"]}, "Example store", "Simple title", {}, "listing");
      check(!/<(?:style|script|input|svg|iframe|img|a)\b/i.test(simpleOutput) && simpleOutput.includes("&lt;script&gt;"), "Simple HTML omits interactive and remote elements and escapes text");
      check(simpleOutput.includes("Simple title") && simpleOutput.includes("Camera") && simpleOutput.includes("See the return details on this eBay listing"), "Simple HTML retains content and explicit default policy");
      $("styleChoice").value = "auto";
      check($("generateBtn").textContent.includes("Generate listing") && $("mineBtn").textContent === "Find keywords", "Primary actions use clear task names");
      state.lookupCandidates = {q:'Camera', barcode:'', items:[{...candidate,title:'Long reference title '.repeat(10)}]};
      state.reference = {q:'Camera',...sourceRef()}; renderReference();
      const mobile = document.createElement("iframe");
      mobile.style.cssText = "width:390px;height:700px;border:0;display:block";
      const mobileLoaded = new Promise(resolve => mobile.onload = resolve);
      mobile.srcdoc = '<!doctype html><html><head><style>' + document.querySelector("style").textContent + '</style></head><body>' + document.querySelector("header").outerHTML + '<main><div>' + $("inputCard").outerHTML + '</div></main></body></html>';
      panel.append(mobile); await mobileLoaded;
      const mobileDoc = mobile.contentDocument;
      for (const theme of ["light", "dark"]) {
        mobileDoc.documentElement.dataset.theme = theme;
        check(mobileDoc.documentElement.scrollWidth <= 390, theme + " input layout fits a 390px viewport without horizontal scrolling");
        check(mobileDoc.getElementById("themeToggle").getBoundingClientRect().right <= 390 &&
        mobileDoc.querySelector("header").getBoundingClientRect().height < 220,
        theme + " mobile brand header keeps theme controls within a compact layout");
      const mobileQuery = mobileDoc.getElementById("productSearch").getBoundingClientRect();
      const mobileKeywords = mobileDoc.getElementById("mineBtn").getBoundingClientRect();
        check(mobileKeywords.height >= 44 && mobileKeywords.top >= mobileQuery.bottom, theme + " mobile lookup input has its own row and usable button height");
        const mobileStyle = mobile.contentWindow.getComputedStyle(mobileDoc.getElementById("inputCard"));
        check(contrast(mobileStyle.color, mobileStyle.backgroundColor) >= 4.5,
          theme + " mobile card text remains readable at 390px");
      }
      for (const theme of ["light", "dark"]) {
        mobileDoc.documentElement.dataset.theme = theme;
        const logo = mobileDoc.querySelector(".brand-artwork img"); await logo.decode();
        const r = logo.getBoundingClientRect();
        check(r.width === r.height && r.width >= 40 && r.right <= 390,
          theme + " approved mobile artwork keeps its full square aspect ratio");
      }
      // Exercise the real accessibility rules without changing the user's OS preferences.
      const accessibilityCSS = mobileDoc.createElement("style");
      accessibilityCSS.textContent = [...document.querySelector("style").sheet.cssRules]
        .filter(rule => /forced-colors: active|prefers-reduced-motion: reduce/.test(rule.conditionText || ""))
        .map(rule => [...rule.cssRules].map(child => child.cssText).join("\n")).join("\n");
      mobileDoc.head.append(accessibilityCSS);
      for (const theme of ["light", "dark"]) {
        mobileDoc.documentElement.dataset.theme = theme;
        const toggle = mobileDoc.getElementById("themeToggle");
        toggle.setAttribute("aria-checked", String(theme === "dark")); toggle.focus();
        const style = mobile.contentWindow.getComputedStyle(toggle, "::before");
        check(style.backgroundImage === "none" && parseFloat(style.transitionDuration) <= .00001 &&
          mobile.contentWindow.getComputedStyle(toggle).outlineStyle !== "none" &&
          mobileDoc.activeElement === toggle,
          theme + " forced-color/reduced-motion CSS preserves a visible focusable theme switch");
      }
      mobile.remove();
      /* ---- AI budget checks ---- */
      {
        const budgetCases = [];
        const budgetCase = (name, run) => budgetCases.push([name, run]);
        pending.splice(0); // Earlier checks may leave held fixture requests; these checks count their own.
        const typeInto = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event("input", {bubbles:true})); };
        const settle = () => new Promise(resolve => setTimeout(resolve, 450));
        const aiRequests = () => pending.filter(request => request.path === "/llm/chat/completions").length;
        const bodyOf = request => JSON.parse(request.opts.body);
        const promptChars = body => body.messages.reduce((total, message) => total + message.content.length, 0);
        const suggestion = () => $("templateSuggest").hidden ? "" : $("templateSuggestText").textContent;
        const failWith = (request, status, data) => request.resolve({ok:false, status, json: async () => data});
        const without = (data, fields) => JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => !fields.includes(key))));
        const fullListing = title => ({...listing(title), subtitle: "Fixture subtitle", note: "Lens not included.",
          description_paragraphs: ["Original paragraph one.", "Original paragraph two."], included_items: ["Camera body", "Strap"],
          buyer_notes: ["Original buyer note."], features_title: "FIXTURE FEATURES", item_specifics: {Brand: "Canon", Model: "AE-1 Program", Format: "35mm"},
          highlights_title: "ORIGINAL HIGHLIGHTS", highlights: [1, 2, 3].map(n => ({stat: n + "x", label: "STAT " + n, caption: "Caption " + n + "."})),
          keywords: ["canon", "ae-1"]});
        let savedTemplate = null;

        budgetCase("template keys and match", async () => {
          newListing(); localStorage.removeItem(TEMPLATES_KEY);
          $("productSearch").value = "Canon AE-1 Program"; $("brand").value = "Canon"; $("notes").value = "Canon AE-1 Program body. Shutter fires.";
          $("productBarcode").value = "012345678905"; $("condition").value = "USED";
          const run = generate(); const request = await nextRequest();
          complete(request, listing("Canon AE-1 Program 35mm SLR Film Camera Body")); await run;
          check(saveTemplate("Canon AE-1 body"), "Budget fixture saves a template");
          savedTemplate = loadTemplates()[0];
          check(savedTemplate.match && savedTemplate.match.product === "canon ae-1 program" && savedTemplate.match.brand === "canon" &&
            savedTemplate.match.title === "canon ae-1 program 35mm slr film camera body" && !/012345678905|barcode|condition_rating":"[^"]/i.test(JSON.stringify(savedTemplate)),
            "A template stores normalized product, brand and title match keys, and still no barcode or condition");
          const legacy = {...savedTemplate, id: "legacy-sony", name: "Sony headphones",
            inputs: {productSearch: "Sony WH-1000XM4", notes: "", brand: "Sony", titleIn: "Sony WH-1000XM4 Wireless Headphones"},
            data: {...savedTemplate.data, title: "Sony WH-1000XM4 Wireless Headphones"}};
          delete legacy.match;
          localStorage.setItem(TEMPLATES_KEY, JSON.stringify([savedTemplate, legacy])); renderTemplates();
          newListing();
          const before = aiRequests();
          check($("templateSuggest").hidden, "No template suggestion on an empty draft");
          typeInto("productSearch", "  canon   AE-1 ");
          check($("templateSuggest").hidden, "The template suggestion waits for typing to pause");
          await settle();
          check(suggestion() === "A saved template looks similar: “Canon AE-1 body”." && $("templateSuggest").closest(".gen-bar") &&
            $("templateSuggestUse").textContent === "Use it (no AI request)" && $("templateSuggestDismiss").textContent === "Dismiss" && aiRequests() === before,
            "A matching saved template is suggested next to Generate, case and spacing ignored, with no AI request");
          check(state.data === null && $("notes").value === "" && $("productSearch").value === "  canon   AE-1 ", "A suggestion never applies the template by itself");
          newListing(); typeInto("notes", "Selling my Canon AE-1 Program, shutter fires at every speed."); await settle();
          check(suggestion().includes("Canon AE-1 body"), "Seller notes that name the template's product also match");
          newListing(); typeInto("productSearch", "sony wh-1000xm4"); await settle();
          check(suggestion().includes("Sony headphones"), "An older template without match keys matches on its saved inputs and title");
        });

        budgetCase("no suggestion without a match", async () => {
          for (const [product, brand, label] of [["Nikon F3 HP", "", "a different product"], ["AE-1 Program", "Minolta", "a different brand"],
            ["Canon EOS R5", "", "only one shared word"], ["", "Canon", "a brand alone"]]) {
            newListing(); typeInto("productSearch", product); typeInto("brand", brand); await settle();
            check($("templateSuggest").hidden, "No template suggestion for " + label);
          }
        });

        budgetCase("dismiss", async () => {
          newListing(); typeInto("productSearch", "Canon AE-1"); await settle();
          check(!$("templateSuggest").hidden, "Dismiss fixture shows a suggestion");
          $("templateSuggestDismiss").click();
          check($("templateSuggest").hidden && document.activeElement === $("generateBtn"), "Dismiss hides the suggestion and keeps focus near Generate");
          typeInto("productSearch", "Canon AE-1 Program"); await settle();
          check($("templateSuggest").hidden, "A dismissed template is not suggested again in the same draft");
          newListing(); typeInto("productSearch", "Canon AE-1"); await settle();
          check(suggestion().includes("Canon AE-1 body"), "A new draft can suggest the dismissed template again");
        });

        budgetCase("use makes no AI request", async () => {
          newListing(); typeInto("productSearch", "Canon AE-1"); $("condition").value = "FOR_PARTS"; await settle();
          const before = pending.length;
          $("templateSuggestUse").click();
          check(pending.length === before && !inflight.generate && !inflight.section && state.template && state.template.name === "Canon AE-1 body" &&
            state.data.title === "Canon AE-1 Program 35mm SLR Film Camera Body" && $("condition").value === "" && $("productBarcode").value === "" &&
            $("templateSuggest").hidden && !$("templateNotice").hidden && loadHistory()[0].draft.inputs.productSearch === "Canon AE-1",
            "Using the suggestion starts from the template through the normal flow, with zero AI requests and condition cleared");
          typeInto("productSearch", "Canon AE-1 Program"); await settle();
          check($("templateSuggest").hidden, "No template suggestion once the draft has a listing");
        });

        budgetCase("save prompt after generate", async () => {
          newListing(); localStorage.setItem(TEMPLATES_KEY, "[]"); renderTemplates();
          $("notes").value = "Save prompt fixture";
          check($("saveTemplatePrompt").hidden, "No save-as-template prompt before a listing exists");
          let run = generate(); complete(await nextRequest(), listing("Save prompt title")); await run;
          check(!$("saveTemplatePrompt").hidden && $("saveTemplatePrompt").textContent.includes("Selling more like this?") &&
            $("saveTemplatePrompt").closest("#outputCard"), "A successful generation offers to save the listing as a template");
          $("saveTemplatePromptBtn").click();
          check(!$("draftsPanel").hidden && !$("templateForm").hidden && $("templateForm").dataset.mode === "save" &&
            $("templateNameInput").value === "Save prompt title" && document.activeElement === $("templateNameInput") && $("saveTemplatePrompt").hidden,
            "The prompt opens the existing save-template form");
          $("templateFormCancel").click(); setDraftsMenu(false, false);
          run = generate(); complete(await nextRequest(), listing("Second generation")); await run;
          check($("saveTemplatePrompt").hidden, "The save prompt appears once per draft");
          newListing(); $("notes").value = "Second draft";
          run = generate(); complete(await nextRequest(), listing("Second draft title")); await run;
          check(!$("saveTemplatePrompt").hidden, "A new draft offers the save prompt again");
          $("saveTemplatePromptDismiss").click();
          check($("saveTemplatePrompt").hidden && loadTemplates().length === 0, "The save prompt can be dismissed without saving");
          newListing(); $("notes").value = "Third draft";
          run = generate(); complete(await nextRequest(), listing("Third draft title")); await run;
          check(saveTemplate("From the menu") && $("saveTemplatePrompt").hidden, "Saving a template another way hides the prompt");
          localStorage.removeItem(TEMPLATES_KEY); renderTemplates();
        });

        let fullBody = null;
        const sectionSizes = {};
        async function regenFixture() {
          newListing();
          $("notes").value = "Canon AE-1 Program 35mm film camera body, chrome. Shutter fires at every speed, meter responds. Light seals replaced. Small dent on the rewind knob. Comes with body cap and strap; no lens.";
          $("brand").value = "Canon"; $("condition").value = "USED"; $("condNotes").value = "Light wear on the top plate";
          state.includedItems = ["Camera body", "Body cap", "Strap"];
          state.minedKeywords = ["canon", "ae-1", "program", "35mm", "slr", "film", "camera", "chrome"];
          state.reference = {...sourceRef("AE-1 Program"), accepted: true};
          const run = generate(); const request = await nextRequest();
          fullBody = bodyOf(request);
          complete(request, fullListing("Canon AE-1 Program 35mm SLR Film Camera Body Chrome")); await run;
          $("editBuyerNotes").value = "Seller edited buyer note."; $("editBuyerNotes").dispatchEvent(new Event("input", {bubbles:true}));
          $("applyContentBtn").click();
          typeInto("titleIn", "Seller typed title");
          setStatus("ok", "fixture"); // close any earlier busy toast
        }
        async function startSection(section) {
          $("regenBtn").click();
          const before = aiRequests();
          document.querySelector('.regen-item[data-section="' + section + '"]').click();
          const request = await nextRequest();
          check(aiRequests() === before && request.path === "/llm/chat/completions", section + " regenerate sends exactly one AI request");
          return request;
        }

        budgetCase("regenerate title", async () => {
          await regenFixture();
          check(fullBody && fullBody.max_tokens === undefined && state.data.buyer_notes.join() === "Seller edited buyer note.", "Full generation keeps the server's full answer budget");
          check(!$("regenBtn").disabled && $("regenBtn").textContent === "Regenerate…" && $("regenPanel").hidden && $("regenBtn").closest(".actions"),
            "Regenerate… sits in the output actions when a listing exists");
          $("regenBtn").click();
          check(!$("regenPanel").hidden && $("regenBtn").getAttribute("aria-expanded") === "true" && document.activeElement.dataset.section === "title" &&
            [...document.querySelectorAll(".regen-item")].map(item => item.textContent).join() === "Title,Description,Highlights",
            "The Regenerate menu offers Title, Description and Highlights");
          $("regenPanel").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
          check($("regenPanel").hidden && document.activeElement === $("regenBtn"), "Escape closes the Regenerate menu and returns focus");
          const before = JSON.parse(JSON.stringify(state.data)), seed = state.styleSeed;
          const request = await startSection("title");
          const body = bodyOf(request);
          sectionSizes.title = promptChars(body);
          check(body.model === "listing-text" && body.max_tokens === 800 && body.messages.length === 2 && body.messages[0].role === "system" &&
            body.messages[0].content.includes(generationRule(1)) && !body.messages[0].content.includes("description_paragraphs") &&
            body.messages[1].content.includes("Shutter fires at every speed") && body.messages[1].content.includes("CURRENT TITLE (write a better one; keep every fact): Seller typed title"),
            "The title request sends a short prompt with the title rule, the seller notes and max_tokens 800");
          check($("regenBtn").disabled && $("regenBtn").textContent === "Regenerating title…" && $("regenPanel").hidden && inflight.section,
            "Regenerate shows it is busy while the section is written");
          regenerateSection("description");
          check(aiRequests() === 0 && pending.length === 0, "Only one section request runs at a time");
          const longTitle = "Canon AE-1 Program SLR 35mm Film Camera Body Chrome Manual Focus Classic Tested Shutter Meter";
          complete(request, {title: longTitle}); await tick(); await tick();
          check(state.data.title === ListingCore.canonicalTitle(longTitle) && $("titleIn").value === state.data.title && state.data.model_title_length === longTitle.length &&
            !$("titleShortenedNotice").hidden && state.html.includes(state.data.title.slice(0, 40)),
            "A new title replaces the title field and preview, with the shortened-title notice when needed");
          check(without(state.data, ["title", "model_title_length"]) === without(before, ["title", "model_title_length"]) &&
            state.data.condition_rating === "USED" && state.data.condition_notes === "Light wear on the top plate" && state.styleSeed === seed &&
            state.data.buyer_notes.join() === "Seller edited buyer note.",
            "Regenerating the title leaves every other field, the condition, seller edits and the look unchanged");
          check(!$("regenNotice").hidden && $("regenNoticeText").textContent.includes("New title") && !$("regenBtn").disabled && $("regenBtn").textContent === "Regenerate…",
            "The success notice offers Undo and Regenerate is available again");
          $("regenUndoBtn").click();
          check(JSON.stringify(state.data) === JSON.stringify(before) && $("titleIn").value === "Seller typed title" && $("regenNotice").hidden &&
            state.html.includes("Seller typed title") && lastToast("ok") === "Restored the previous title.",
            "Undo restores the previous title exactly");
        });

        budgetCase("regenerate description and highlights", async () => {
          const before = JSON.parse(JSON.stringify(state.data));
          let request = await startSection("description");
          let body = bodyOf(request);
          sectionSizes.description = promptChars(body);
          check(body.max_tokens === 800 && body.messages[0].content.includes(generationRule(4)) && body.messages[1].content.includes("CONDITION NOTES: Light wear on the top plate") &&
            body.messages[1].content.includes("WHAT'S INCLUDED: Camera body, Strap") && body.messages[1].content.includes("ACCEPTED SELLER-LISTING REFERENCE"),
            "The description request carries the description rule, condition notes, included items and the accepted reference");
          complete(request, {description_paragraphs: ["Fresh paragraph one.", "Fresh paragraph two.", "Fresh paragraph three."]}); await tick(); await tick();
          check(state.data.description_paragraphs.join("|") === "Fresh paragraph one.|Fresh paragraph two.|Fresh paragraph three." &&
            without(state.data, ["description_paragraphs"]) === without(before, ["description_paragraphs"]) && $("titleIn").value === "Seller typed title" &&
            $("editDescription").value.startsWith("Fresh paragraph one.") && state.html.includes("Fresh paragraph two."),
            "A new description replaces only the description, in the preview and the content editor");
          $("regenUndoBtn").click();
          check(JSON.stringify(state.data) === JSON.stringify(before) && $("editDescription").value.startsWith("Original paragraph one."), "Undo restores the previous description");
          request = await startSection("highlights");
          body = bodyOf(request);
          sectionSizes.highlights = promptChars(body);
          check(body.max_tokens === 800 && body.messages[0].content.includes(generationRule(8)) && body.messages[1].content.includes("ITEM SPECIFICS: Brand: Canon; Model: AE-1 Program"),
            "The highlights request carries the highlights rule and the listing's item specifics");
          complete(request, {highlights_title: "NEW HIGHLIGHTS", highlights: [1, 2, 3].map(n => ({stat: "N" + n, label: "NEW " + n, caption: "New caption."}))}); await tick(); await tick();
          check(state.data.highlights_title === "NEW HIGHLIGHTS" && state.data.highlights.map(h => h.stat).join() === "N1,N2,N3" &&
            without(state.data, ["highlights", "highlights_title"]) === without(before, ["highlights", "highlights_title"]) && state.html.includes("NEW HIGHLIGHTS"),
            "New highlights replace only the highlights");
          $("regenUndoBtn").click();
          check(JSON.stringify(state.data) === JSON.stringify(before), "Undo restores the previous highlights");
        });

        budgetCase("invalid replies and busy errors", async () => {
          const before = JSON.stringify(state.data), htmlBefore = state.html;
          for (const [section, reply, reason] of [["description", "not json at all", "not complete JSON"],
            ["description", {description_paragraphs: "One string, not a list"}, "did not include a new description"],
            ["description", {description_paragraphs: ["Fine", 7]}, "Invalid description_paragraphs"],
            ["title", {title: "  "}, "did not include a new title"],
            ["highlights", {highlights_title: "TWO", highlights: [{stat: "1", label: "A"}, {stat: "2", label: "B"}]}, "three complete highlights"]]) {
            const request = await startSection(section);
            request.resolve({ok:true, status:200, json: async () => ({model: "fixture", choices: [{message: {content: typeof reply === "string" ? reply : JSON.stringify(reply)}}]})});
            await tick(); await tick();
            const message = lastToast("err");
            check(JSON.stringify(state.data) === before && state.html === htmlBefore && message.startsWith("Could not regenerate the " + section + ".") &&
              message.includes(reason) && message.includes("Your listing was not changed.") && !message.includes("provider keys") &&
              !$("regenBtn").disabled && $("regenNotice").hidden,
              "An invalid " + section + " reply is rejected with a seller-facing message: " + reason);
          }
          for (const [status, data] of [[429, {error: "Three AI requests are already running in this app. Wait for a current lookup or generation to finish, then retry. Your draft is safe.", kind: "local_busy"}],
            [429, {error: "Every configured AI provider is busy. Your draft is safe.", kind: "provider_busy", retry_after: 30}]]) {
            const request = await startSection("title");
            failWith(request, status, data); await tick(); await tick();
            const message = lastToast("err");
            check(JSON.stringify(state.data) === before && message.includes(data.error) && !message.includes("provider keys") && !$("regenBtn").disabled,
              data.kind + " is reported with the server's guidance and the listing is unchanged");
          }
        });

        budgetCase("request lifecycle", async () => {
          const before = JSON.stringify(state.data);
          const stale = await startSection("description");
          const run = generate();
          const full = await nextRequest();
          check(!inflight.section && $("regenBtn").textContent === "Regenerate…" && $("regenBtn").disabled && $("templateSuggest").hidden,
            "Generate listing cancels a running section request and disables Regenerate while it runs");
          complete(full, fullListing("Fresh full listing")); await run;
          complete(stale, {description_paragraphs: ["Stale reply"]}); await tick(); await tick();
          check(state.data.title === "Fresh full listing" && !state.data.description_paragraphs.includes("Stale reply") && !$("regenBtn").disabled && $("regenNotice").hidden,
            "A cancelled section reply never lands on the newer listing");
          complete(await startSection("title"), {title: "Title before the next full generation"}); await tick(); await tick();
          check(!$("regenNotice").hidden, "Lifecycle fixture shows the Undo notice");
          const next = generate(); complete(await nextRequest(), fullListing("Fresh full listing")); await next;
          check($("regenNotice").hidden && state.data.title === "Fresh full listing", "A new full listing removes the old section Undo");
          typeInto("titleIn", "Seller title before reply");
          const conflict = await startSection("title");
          typeInto("titleIn", "Seller kept typing");
          complete(conflict, {title: "Model title"}); await tick(); await tick();
          check($("titleIn").value === "Seller kept typing" && state.data.title === "Fresh full listing" && lastToast("note").includes("was not used because the listing changed"),
            "A section reply that arrives after the seller edited that section is not applied");
          const dropped = await startSection("description");
          newListing();
          complete(dropped, {description_paragraphs: ["Old draft reply"]}); await tick(); await tick();
          check(state.data === null && $("regenBtn").disabled && $("regenBtn").textContent === "Regenerate…" && $("regenHint").hidden,
            "Starting a new listing drops a running section request; Regenerate needs a listing");
          void before;
        });

        budgetCase("disabled with reasons", async () => {
          await regenFixture();
          typeInto("htmlOut", "<p>Hand edited</p>");
          check($("regenBtn").disabled && !$("regenHint").hidden && $("regenHint").textContent.includes("hand-edited") &&
            $("regenBtn").getAttribute("aria-describedby") === "regenHint", "Regenerate is disabled with a reason while the HTML is hand-edited");
          const before = aiRequests();
          regenerateSection("title");
          check(aiRequests() === before && lastToast("err").includes("hand-edited"), "A hand-edited listing never sends a section request");
          $("restructureBtn").click();
          check(!$("regenBtn").disabled && $("regenHint").hidden, "Back to structured editing re-enables Regenerate");
          $("editDescription").value = "Unapplied"; $("editDescription").dispatchEvent(new Event("input", {bubbles:true}));
          check($("regenBtn").disabled && $("regenHint").textContent.includes("Apply or discard"), "Unapplied content edits pause Regenerate with a reason");
          $("resetContentBtn").click();
          check(!$("regenBtn").disabled, "Discarding content edits re-enables Regenerate");
          const run = generate(); const request = await nextRequest();
          check($("regenBtn").disabled && $("regenHint").hidden, "Regenerate is disabled while a full listing is generating");
          complete(request, fullListing("After lifecycle")); await run;
          check(!$("regenBtn").disabled, "Regenerate returns after generation");
        });

        budgetCase("phone Generate bar stays on top", async () => {
          const phone = document.createElement("iframe");
          phone.style.cssText = "width:390px;height:700px;border:0;display:block";
          const phoneLoaded = new Promise(resolve => phone.onload = resolve);
          phone.srcdoc = '<!doctype html><html data-theme="light"><head><style>' + document.querySelector("style").textContent + '</style></head><body><main>' +
            $("inputCard").outerHTML + $("outputCard").outerHTML + '</main></body></html>';
          panel.append(phone); await phoneLoaded;
          const doc = phone.contentDocument;
          doc.getElementById("templateSuggest").hidden = false;
          doc.getElementById("templateSuggestText").textContent = "A saved template looks similar: \u201cCanon AE-1 body\u201d.";
          doc.querySelectorAll(".card").forEach(card => card.style.animation = "none");
          const formBottom = doc.getElementById("inputCard").getBoundingClientRect().bottom + phone.contentWindow.scrollY;
          phone.contentWindow.scrollTo(0, formBottom - 350);
          const at = element => { const r = element.getBoundingClientRect(); return doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };
          check(doc.getElementById("outputCard").getBoundingClientRect().top < 600 &&
            doc.getElementById("generateBtn").contains(at(doc.getElementById("generateBtn"))) && at(doc.getElementById("templateSuggestUse")) === doc.getElementById("templateSuggestUse"),
            "At 390px the fixed Generate bar and its template suggestion stay above the output card");
          phone.remove();
        });

        budgetCase("prompt size", async () => {
          const full = promptChars(fullBody);
          const ratios = Object.fromEntries(Object.entries(sectionSizes).map(([section, size]) => [section, size / full]));
          check(Object.keys(ratios).length === 3 && Object.values(ratios).every(ratio => ratio < 0.4),
            "Prompt size (characters): full " + full + "; " + Object.entries(sectionSizes).map(([section, size]) =>
              section + " " + size + " (" + Math.round(ratios[section] * 100) + "%)").join(", ") + " - every section prompt is under 40% of the full prompt");
        });

        for (const [, run] of budgetCases) await run();
        newListing(); localStorage.removeItem(TEMPLATES_KEY); renderTemplates();
      }
      /* ---- new listing checks ---- */
      {
        pending.splice(0);
        const typeInto = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event("input", {bubbles:true})); };
        const settle = () => new Promise(resolve => setTimeout(resolve, 450));
        const shown = element => Boolean(element) && !element.hidden && !element.closest("[hidden]") && element.getClientRects().length > 0;
        const liveToasts = kind => [...document.querySelectorAll("#toastPanel .toast-item:not(.leaving) .toast." + kind)];
        const altN = (target, extra = {}) => {
          const event = new KeyboardEvent("keydown", {key: "n", code: "KeyN", altKey: true, bubbles: true, cancelable: true, ...extra});
          target.dispatchEvent(event); return event;
        };
        let confirms = 0;
        const fixtureConfirm = window.confirm;
        window.confirm = () => { confirms++; return true; };
        const sellerFields = {storeName: "Fixture Camera Store", ebUsername: "fixture_seller", fbScore: "512", fbPct: "99.8", memberYear: "2014"};
        const savedSeller = Object.fromEntries(Object.keys(sellerFields).map(id => [id, $(id).value]));
        const savedPrefs = {style: $("styleChoice").value, returns: $("returnsPolicy").value, theme: document.documentElement.dataset.theme};
        try {
          setDraftsMenu(false, false);
          newListing(); localStorage.setItem(TEMPLATES_KEY, "[]"); renderTemplates();
          const formButton = $("formNewListingBtn");
          check(shown(formButton) && !$("draftsPanel").contains(formButton) && formButton.closest(".form-head")?.contains($("inputHeading")) &&
            formButton.textContent.trim() === "New listing" && formButton.querySelector("svg[aria-hidden='true']") &&
            formButton.getAttribute("aria-keyshortcuts") === "Alt+N" && /\((Alt|Option)\+N\)/.test(formButton.title),
            "A visible New listing button sits in the Describe your item header, outside the Drafts menu, with Alt+N in its tooltip");
          check($("draftsPanel").contains($("newListingBtn")) && /\((Alt|Option)\+N\)/.test($("newListingBtn").title),
            "The Drafts menu keeps its New listing entry");

          for (const [id, value] of Object.entries(sellerFields)) $(id).value = value;
          $("styleChoice").value = "story"; $("returnsPolicy").value = "accepted";
          typeInto("productSearch", "Pentax K1000"); typeInto("notes", "New listing fixture: Pentax K1000 body, meter works.");
          state.includedItems = ["Body cap"]; renderIncludedChips(); saveDraft();
          confirms = 0;
          formButton?.click();
          let saved = loadHistory()[0];
          check(confirms === 0 && $("notes").value === "" && $("productSearch").value === "" && !state.includedItems.length &&
            saved?.draft.inputs.notes === "New listing fixture: Pentax K1000 body, meter works." && saved.draft.includedItems.join() === "Body cap" &&
            document.activeElement === $("productSearch"),
            "The visible button starts a new listing with no confirm dialog, saving the previous draft to Recent drafts first");
          let undoToast = liveToasts("ok").at(-1);
          check(undoToast?.querySelector("p").textContent === "Started a new listing. The previous one is in Drafts → Recent drafts." &&
            undoToast.querySelector("button.toast-action")?.textContent === "Undo", "The New listing toast says where the previous draft went and offers Undo");
          undoToast?.querySelector("button.toast-action")?.click();
          check(confirms === 0 && $("notes").value === "New listing fixture: Pentax K1000 body, meter works." && $("productSearch").value === "Pentax K1000" &&
            state.includedItems.join() === "Body cap" && undoToast?.closest(".toast-item")?.classList.contains("leaving"),
            "Undo restores the previous draft from its Recent drafts entry");

          formButton?.click();
          typeInto("notes", "Typed into the new draft before Undo");
          liveToasts("ok").find(card => card.querySelector(".toast-action"))?.querySelector(".toast-action").click();
          check(confirms === 0 && $("productSearch").value === "Pentax K1000" && loadHistory()[0].draft.inputs.notes === "Typed into the new draft before Undo",
            "Undo after typing in the new draft keeps that typing in Recent drafts, still without a confirm dialog");

          const keyEvent = altN($("notes"));
          check(keyEvent.defaultPrevented && confirms === 0 && $("notes").value === "" && $("productSearch").value === "" &&
            loadHistory()[0].draft.inputs.productSearch === "Pentax K1000", "Alt+N starts a new listing, even from a text field");
          typeInto("notes", "Shortcut guard fixture");
          const ignored = [altN($("notes"), {isComposing: true}), altN($("notes"), {keyCode: 229}), altN($("notes"), {ctrlKey: true}),
            altN($("notes"), {key: "Dead"}), altN(document.body, {altKey: false}), altN(document.body, {metaKey: true}), altN(document.body, {shiftKey: true})];
          check($("notes").value === "Shortcut guard fixture" && ignored.every(event => !event.defaultPrevented),
            "Alt+N is ignored during IME composition, with AltGr (Ctrl+Alt), when it types an accent in a field, and without Alt alone");
          check(altN(document.body, {key: "Dead"}).defaultPrevented && $("notes").value === "", "Option+N outside a field (a dead key on a Mac) still starts a new listing");

          // Build a draft that uses every recent per-draft feature, then clear it.
          const fm2 = {...listing("Nikon FM2 35mm SLR Film Camera Body"), subtitle: "Manual classic", item_specifics: {Brand: "Nikon", Model: "FM2"},
            highlights_title: "AT A GLANCE", highlights: [1, 2, 3].map(n => ({stat: n + "x", label: "STAT " + n, caption: "Caption."})), keywords: ["nikon", "fm2", "slr"]};
          typeInto("productSearch", "Nikon FM2"); typeInto("notes", "Nikon FM2 body.");
          let run = generate(); complete(await nextRequest(), fm2); await run;
          localStorage.setItem(TEMPLATES_KEY, JSON.stringify([buildTemplate("Nikon FM2 body")])); renderTemplates();
          newListing();
          typeInto("productSearch", "Nikon FM2"); await settle();
          check(!$("templateSuggest").hidden, "Reset fixture: the matching template is suggested");
          $("templateSuggestDismiss").click();
          typeInto("notes", "Nikon FM2 body, chrome. Shutter fires at every speed."); $("condition").value = "USED";
          state.minedKeywords = ["nikon", "fm2", "slr"]; state.reference = {...sourceRef("FM2"), accepted: true}; renderChips(); renderReference();
          run = generate(); complete(await nextRequest(), fm2); await run;
          const section = (() => { $("regenBtn").click(); document.querySelector('.regen-item[data-section="title"]').click(); return nextRequest(); })();
          complete(await section, {title: "Nikon FM2 35mm SLR Film Camera Body Chrome Manual Focus Tested Shutter Meter Working Classic Light Seals"});
          await tick(); await tick();
          $("condition").value = "FOR_PARTS"; $("condition").dispatchEvent(new Event("change", {bubbles:true}));
          $("modeBundle").click(); $("addBundleItemBtn").click();
          $("editContentBtn").click(); $("minedPanel").open = true; $("kwPanel").open = true;
          $("viewMobile").click(); $("tabHtml").click();
          const flight = document.createElement("div"); flight.className = "course-flight"; document.body.append(flight);
          $("rulerWaypoint").style.opacity = "0"; $("rulerWaypoint").classList.add("landing");
          const copyTarget = navigator.clipboard, originalWrite = copyTarget && copyTarget.writeText;
          if (copyTarget) copyTarget.writeText = async () => {};
          try { $("copyHtmlBtn").click(); await tick(); await tick(); } finally { if (copyTarget) copyTarget.writeText = originalWrite; }
          check(state.copied && !$("saveTemplatePrompt").hidden && !$("regenNotice").hidden && budget.undo && budget.dismissed.size === 1 &&
            !$("titleShortenedNotice").hidden && conditionNoticeShown && liveToasts("note").length && state.reference?.accepted &&
            $("kwChips").children.length === 3 && $("minedChips").children.length === 3 && document.querySelectorAll("#bundleCards .bundle-card").length === 1 &&
            $("contentEditor").open && $("htmlPanel").hidden === false && $("previewPanel").classList.contains("mobile") &&
            [...$("courseSteps").children].map(li => li.className).join() === "done,done,done,done",
            "Reset fixture: every per-draft notice, prompt, panel and view is active before New listing");
          check(shown($("nextListingNudge")) && $("nextListingNudge").textContent.includes("Done with this one?") &&
            $("nextListingBtn")?.textContent === "Start a new listing" && $("nextListingNudge").closest("#outputCard"),
            "After Copy HTML the output column offers “Done with this one? Start a new listing”");
          $("mineBtn").click();
          const staleSearch = await nextRequest();
          $("regenBtn").click(); document.querySelector('.regen-item[data-section="description"]').click();
          for (let i = 0; i < 5; i++) await tick();
          const sectionInFlight = pending.splice(pending.findIndex(request => request.path === "/llm/chat/completions") >>> 0, 1)[0];
          check(staleSearch.path.startsWith("/ebay/search?") && sectionInFlight && inflight.section && inflight.mine, "Reset fixture: a keyword search and a section regenerate are in flight");
          confirms = 0;
          $("nextListingBtn")?.click();
          const steps = [...$("courseSteps").children].map(li => li.className).join();
          check(confirms === 0 && state.data === null && loadHistory()[0].draft.data?.title.startsWith("Nikon FM2") && loadHistory()[0].draft.inputs.productSearch === "Nikon FM2",
            "The nudge starts a new listing and the copied draft is in Recent drafts");
          check(!Object.keys(inflight).length && $("regenBtn").textContent === "Regenerate…" && !$("regenBtn").hasAttribute("aria-busy") &&
            !$("mineBtn").disabled && !$("lookupBtn").disabled, "New listing cancels the keyword search and the section regenerate");
          if (sectionInFlight) complete(sectionInFlight, {description_paragraphs: ["Stale section reply"]});
          staleSearch.resolve(reply({keywords: ["stale"], sources: []}));
          await tick(); await tick(); await tick();
          check(state.data === null && !state.minedKeywords.length && !$("minedChips").children.length, "Replies to cancelled requests never land on the new listing");
          check(state.data === null && state.html === "" && !state.edited && state.contentEdits === null && state.template === null && state.reference === null &&
            !state.copied && state.mode === "single" && !state.bundleItems.length && !state.includedItems.length && !state.minedKeywords.length &&
            !state.minedSources.length && state.lookupCandidates === null && !conditionNoticeShown && budget.dismissed.size === 0 && !budget.savePromptShown && budget.undo === null,
            "New listing resets the draft state, template dismissals, save-prompt flag, section Undo and condition notice flag");
          check(["titleShortenedNotice", "templateNotice", "saveTemplatePrompt", "regenNotice", "regenHint", "templateSuggest", "nextListingNudge"].every(id => $(id)?.hidden) &&
            !liveToasts("note").length && !$("refPanel").classList.contains("visible") && !$("referenceCandidates").children.length && !$("editBadge").classList.contains("visible"),
            "New listing hides the shortened-title, template, save-as-template, regenerate, condition and copy notices and the reference panel");
          check(!$("minedPanel").open && !$("kwPanel").open && $("minedCount").textContent === "" && $("kwCount").textContent === "" && !$("kwChips").children.length &&
            !$("contentEditor").open && $("contentEditor").hidden && $("editContentBtn").getAttribute("aria-expanded") === "false" &&
            !$("bundleSection").classList.contains("visible") && !$("bundleCards").children.length && $("modeSingle").getAttribute("aria-pressed") === "true" && $("includedInput").value === "",
            "New listing closes the keyword disclosures and content editor, and clears keyword ideas and bundle cards");
          check(!$("previewPanel").hidden && $("htmlPanel").hidden && $("tabPreview").getAttribute("aria-selected") === "true" && !$("previewPanel").classList.contains("mobile") &&
            $("viewDesktop").getAttribute("aria-pressed") === "true" && !document.querySelector(".course-flight") && $("rulerWaypoint").style.opacity === "" &&
            !$("rulerWaypoint").classList.contains("landing"), "New listing returns the preview to Desktop and removes a waypoint still in flight");
          check(steps === "now,,," && $("previewShell").classList.contains("empty") && getComputedStyle($("emptyState")).display !== "none" &&
            $("emptyState").querySelectorAll(".empty-steps li").length === 3 && shown($("sampleBtn")) && $("titleIn").value === "" && $("htmlOut").value === "" &&
            $("modelMeta").textContent === "No listing generated yet." && !$("outputCard").classList.contains("glow-brand") && $("copyHtmlBtn").disabled && $("regenBtn").disabled,
            "The output column is back to its empty state: three steps and Try a sample item");
          check(Object.entries(sellerFields).every(([id, value]) => $(id).value === value) && $("styleChoice").value === "story" && $("returnsPolicy").value === "accepted" &&
            document.documentElement.dataset.theme === savedPrefs.theme, "Seller details, layout style, returns choice and theme are kept");
          typeInto("productSearch", "Nikon FM2"); await settle();
          check(!$("templateSuggest").hidden, "A template dismissed in the previous draft can be suggested again");

          // Template notice, nudge once per draft, and a running generation.
          $("templateSuggestUse").click(); // Using a template asks its own (unchanged) confirm question.
          check(!$("templateNotice").hidden && state.template, "Reset fixture: a template draft shows its notice");
          $("downloadBtn").click();
          check(shown($("nextListingNudge")), "Download HTML also offers the next listing");
          $("nextListingDismiss")?.click();
          check($("nextListingNudge")?.hidden && document.activeElement === $("copyHtmlBtn"), "The nudge can be dismissed, returning focus to Copy HTML");
          $("downloadBtn").click();
          check($("nextListingNudge")?.hidden, "The nudge appears once per draft");
          confirms = 0;
          formButton?.click();
          check($("templateNotice").hidden && state.template === null, "New listing clears the template notice");
          typeInto("notes", "Generation in flight fixture");
          run = generate(); const generating = await nextRequest();
          altN(document.body);
          complete(generating, listing("Stale generation")); await run;
          check(state.data === null && !inflight.generate && !$("generateBtn").disabled && !$("inputCard").classList.contains("working") && $("notes").value === "",
            "New listing cancels a running generation and its reply is ignored");
          check(confirms === 0, "New listing never opened a confirm dialog");
        } finally {
          window.confirm = fixtureConfirm;
          for (const [id, value] of Object.entries(savedSeller)) $(id).value = value;
          $("styleChoice").value = savedPrefs.style; $("returnsPolicy").value = savedPrefs.returns;
          localStorage.removeItem(TEMPLATES_KEY); renderTemplates();
        }
      }

      /* ---- lookup panel & bundle automation checks ---- */
      {
        // ?soft records failures instead of stopping, so this block can be run against older code.
        const soft = new URLSearchParams(location.search).has("soft");
        const softFailures = [];
        const lc = (fn, label) => {
          let ok = false;
          try { ok = Boolean(fn()); } catch (_) { ok = false; }
          if (ok || !soft) check(ok, label); else softFailures.push(label);
        };
        const act = async fn => { try { await fn(); } catch (_) { /* the outcome is checked next */ } };
        const typeInto = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", {bubbles:true})); };
        const pressEnter = el => el.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
        const settle = () => new Promise(resolve => setTimeout(resolve, 480));
        const cards = () => [...document.querySelectorAll("#bundleCards .bundle-card")];
        const cardNames = () => cards().map(card => card.querySelector("input").value).join("|");
        const chips = () => [...document.querySelectorAll("#includedChips .inc-chip")].map(chip => (chip.classList.contains("auto") ? "auto:" : "") + chip.firstChild.textContent);
        const realFetch = window.fetch;
        let aiCalls = 0, explicitGenerations = 0;
        window.fetch = (path, opts) => { if (String(path).startsWith("/llm/")) aiCalls++; return realFetch(path, opts); };
        pending.splice(0);
        try {
          // 1. Lookup results: collapsible, scrolling, selected first, explicit accept.
          newListing();
          typeInto($("productSearch"), "Panel camera");
          const many = Array.from({length: 14}, (_, i) => ({item_id: "v1|77" + i + "|0", title: "Panel camera listing " + i, url: "https://www.ebay.com/itm/77" + i}));
          await act(async () => {
            const run = lookupProduct(); const requests = [await nextRequest(), await nextRequest()];
            requests.forEach(request => request.resolve(reply({items: many}))); await run; await tick();
          });
          const box = () => $("referenceCandidates").querySelector(".ref-results");
          const toggle = () => box().querySelector(".ref-results-toggle");
          const list = () => box().querySelector(".ref-results-body");
          lc(() => toggle().tagName === "BUTTON" && toggle().getAttribute("aria-expanded") === "true" && toggle().textContent.includes("14 matching listings") &&
            !list().hidden && toggle().getAttribute("aria-controls") === list().id, "Lookup results open as a disclosure whose header counts the matching listings");
          lc(() => { const css = getComputedStyle(list()); return css.overflowY === "auto" && css.overscrollBehaviorY === "contain" && css.maxHeight === "320px" &&
            list().scrollHeight > list().clientHeight && list().getBoundingClientRect().height <= 321; }, "The results scroll inside a 320px panel with overscroll contained");
          lc(() => list().tabIndex === 0 && list().getAttribute("role") === "region" && /matching listings/.test(list().getAttribute("aria-label")),
            "The results panel is a labelled region that can be scrolled from the keyboard");
          lc(() => /@media \(max-width: 720px\) \{ \.ref-results-body \{ max-height: 50vh; \} \}/.test(document.querySelector("style").textContent),
            "On phones the results panel is at most half the screen tall");
          await act(() => toggle().click());
          lc(() => list().hidden && toggle().getAttribute("aria-expanded") === "false", "The header collapses the results");
          await act(() => toggle().click());
          await act(async () => {
            list().querySelectorAll(".ref-select")[5].click(); const detail = await nextRequest();
            detail.resolve(reply({...sourceRef("Panel model"), source: many[5]})); await tick(); await tick();
          });
          lc(() => state.reference && !state.reference.accepted && !list().hidden && list().querySelector(".ref-row").classList.contains("selected") &&
            list().querySelector(".ref-row a").textContent === many[5].title, "A listing under review moves to the top, marked Selected, and is not accepted yet");
          await act(() => $("refAcceptBtn").click());
          lc(() => state.reference.accepted && list().hidden && toggle().getAttribute("aria-expanded") === "false" && box().classList.contains("accepted") &&
            toggle().textContent.includes(many[5].title) && box().querySelector(".ref-remove").textContent === "Remove reference",
            "Accepting collapses the results to a header naming the accepted listing, with Remove reference");
          await act(() => toggle().click());
          lc(() => { const rows = [...list().querySelectorAll(".ref-row")]; return !list().hidden && rows.length === 14 && rows[0].classList.contains("selected") &&
            rows[0].querySelector(".ref-tag").textContent === "Selected" && rows[0].querySelector("a").textContent === many[5].title &&
            rows.filter(row => row.classList.contains("selected")).length === 1 && rows[1].querySelector("a").textContent === many[0].title; },
            "Re-expanding shows the accepted listing first, marked Selected, then the others in order");
          await act(() => box().querySelector(".ref-remove").click());
          lc(() => state.reference === null && !list().hidden && toggle().getAttribute("aria-expanded") === "true" && !box().classList.contains("accepted") &&
            !list().querySelector(".ref-row.selected") && document.activeElement === toggle() && !$("refPanel").classList.contains("visible"),
            "Remove reference clears the accepted reference and opens the results again");
          setupBundle(["Shared lookup card"]);
          const cardBox = () => document.querySelector(".bi-candidates .ref-results");
          await act(async () => {
            document.querySelector(".bi-lookup").click(); const search = await nextRequest();
            search.resolve(reply({items: many.slice(0, 3)})); await tick(); await tick();
          });
          lc(() => cardBox().querySelector(".ref-results-toggle").textContent.includes("3 matching listings") && cardBox().querySelector(".ref-results-body").id !== "lookup-results",
            "Bundle Lookup details uses the same collapsible results, with its own id");
          await act(async () => {
            cardBox().querySelectorAll(".ref-select")[2].click(); const detail = await nextRequest();
            detail.resolve(reply({...sourceRef("Card model"), source: many[2]})); await tick(); await tick();
            document.querySelector(".bi-accept").click();
          });
          lc(() => state.bundleItems[0].reference.accepted && cardBox().querySelector(".ref-results-body").hidden && cardBox().querySelector(".ref-remove"),
            "Accepting a bundle card reference collapses that card's results");
          await act(() => cardBox().querySelector(".ref-remove").click());
          lc(() => !state.bundleItems[0].reference && !cardBox().querySelector(".ref-results-body").hidden, "The card's Remove reference opens its results again");

          // 2. What's included follows the bundle cards.
          newListing();
          await act(() => { $("modeBundle").click(); $("addBundleItemBtn").click(); $("addBundleItemBtn").click(); });
          await act(() => { typeInto(cards()[0].querySelector("input"), "Console"); typeInto(cards()[1].querySelector("input"), "Controller"); });
          lc(() => chips().join() === "auto:Console,auto:Controller" && document.querySelector("#includedChips .inc-chip.auto").title === "From bundle items",
            "Each named card becomes an auto included chip, in card order, with the tooltip From bundle items");
          await act(() => { $("includedInput").value = "Charging cable"; pressEnter($("includedInput")); });
          await act(() => { $("addBundleItemBtn").click(); typeInto(cards()[2].querySelector("input"), "Game"); typeInto(cards()[0].querySelector("input"), "Console OLED"); });
          lc(() => chips().join() === "auto:Console OLED,auto:Controller,auto:Game,Charging cable" &&
            state.includedItems.join() === "Charging cable", "Auto chips follow added and renamed cards; the manual chip is untouched");
          await act(() => cards()[1].querySelector(".remove-card").click());
          lc(() => chips().join() === "auto:Console OLED,auto:Game,Charging cable", "Removing a card removes its chip");
          await act(() => [...document.querySelectorAll("#includedChips .inc-chip.auto")].find(chip => chip.textContent.startsWith("Game")).querySelector("button").click());
          lc(() => chips().join() === "auto:Console OLED,Charging cable" && state.includedRemoved.length === 1 && state.bundleItems[1].name === "Game",
            "Removing an auto chip keeps its card");
          await act(() => { typeInto(cards()[1].querySelector("input"), "Game cartridge"); typeInto(cards()[0].querySelector("input"), "Console OLED 64GB"); });
          lc(() => chips().join() === "auto:Console OLED 64GB,Charging cable", "A removed auto chip stays removed for its card, even after a rename");
          lc(() => buildUserMessage().includes("WHAT'S INCLUDED (list exactly these items in included_items): Console OLED 64GB, Charging cable"),
            "The prompt lists the auto chips, then the seller's own");
          await act(() => { $("includedInput").value = "game CARTRIDGE"; pressEnter($("includedInput")); });
          lc(() => chips().join() === "auto:Console OLED 64GB,auto:Game cartridge,Charging cable" && !state.includedRemoved.length && state.includedItems.join() === "Charging cable",
            "Typing a removed card's name brings its auto chip back");
          await act(() => $("modeSingle").click());
          lc(() => chips().join() === "Charging cable" && !buildUserMessage().includes("Console OLED"), "Switching to single item removes the auto chips and keeps the manual one");
          await act(() => $("modeBundle").click());
          lc(() => chips().join() === "auto:Console OLED 64GB,auto:Game cartridge,Charging cable", "Switching back to bundle brings the card chips back");

          // 3. Description -> items -> what's included.
          newListing();
          await act(() => $("modeBundle").click());
          lc(() => !$("descItemsRow").hidden && $("descToItems").checked && $("descToItems").labels[0].textContent === "Fill the bundle items from this description",
            "Bundle mode offers Fill the bundle items from this description, ticked by default");
          await act(() => typeInto($("notes"), "Bundle of:\n- Nintendo Switch console\n- 2x Joy-Con\n- Mario Kart 8\nEverything works, tested this week."));
          lc(() => $("descItemsCount").textContent === "3 items found" && !cards().length, "The count updates live; cards wait until typing pauses");
          await settle();
          lc(() => cardNames() === "Nintendo Switch console|2x Joy-Con|Mario Kart 8" && cards().every(card => card.classList.contains("auto") && card.querySelector(".bi-auto-tag")) &&
            state.bundleItems.every(item => item.auto && item.condition === "" && item.notes === "" && item.brand === "") && cards().every(card => card.querySelector("select").value === ""),
            "Typing the description creates auto cards, never with a condition");
          lc(() => chips().join() === "auto:Nintendo Switch console,auto:2x Joy-Con,auto:Mario Kart 8", "Auto cards feed What's included");
          await act(() => typeInto(cards()[1].querySelector("textarea"), "Left stick drifts"));
          lc(() => !state.bundleItems[1].auto && !cards()[1].classList.contains("auto") && !cards()[1].querySelector(".bi-auto-tag"), "Editing a card's notes makes it the seller's");
          await act(() => { const select = cards()[2].querySelector("select"); select.value = "USED"; select.dispatchEvent(new Event("change", {bubbles: true})); });
          lc(() => !state.bundleItems[2].auto, "Choosing a card's condition makes it the seller's");
          await act(() => typeInto($("notes"), "- Nintendo Switch OLED console\n- Mario Kart 8\n- Zelda BOTW"));
          await settle();
          lc(() => cardNames() === "Nintendo Switch OLED console|2x Joy-Con|Mario Kart 8|Zelda BOTW" && state.bundleItems[1].notes === "Left stick drifts" &&
            state.bundleItems[2].condition === "USED" && state.bundleItems[0].auto && state.bundleItems[3].auto && !state.bundleItems[1].auto,
            "Re-parsing renames and adds auto cards and never changes, duplicates or removes the seller's cards");
          await act(() => typeInto($("notes"), "- Mario Kart 8"));
          await settle();
          lc(() => cardNames() === "2x Joy-Con|Mario Kart 8" && $("descItemsCount").textContent === "1 item found", "Auto cards whose name left the description are removed");
          await act(() => typeInto($("notes"), "Pikmin 4, Splatoon 3"));
          await settle();
          lc(() => cardNames() === "2x Joy-Con|Mario Kart 8|Pikmin 4|Splatoon 3", "New description items are added after the seller's cards");
          await act(() => $("descToItems").click());
          lc(() => cards().length === 4 && state.bundleItems.every(item => !item.auto) && !document.querySelector(".bundle-card.auto") && $("descItemsCount").textContent === "" &&
            localStorage.getItem("eb.bundleFromDescription") === "0", "Unticking keeps every card, now the seller's own, and remembers the choice in this browser");
          await act(() => typeInto($("notes"), "Completely different text, Something else"));
          await settle();
          lc(() => cardNames() === "2x Joy-Con|Mario Kart 8|Pikmin 4|Splatoon 3", "With the box unticked, typing never changes the cards");
          newListing();
          lc(() => state.descToItems === false && $("descToItems").checked === false, "A new listing starts with the remembered choice");
          await act(() => { $("modeBundle").click(); $("descToItems").click(); });
          lc(() => state.descToItems && localStorage.getItem("eb.bundleFromDescription") === "1", "Ticking it again is remembered too");

          // 4. Brands in bundles.
          newListing();
          await act(() => { $("modeBundle").click(); typeInto($("notes"), "Nintendo Switch console, Nintendo Switch Pro Controller, Mario Kart 8"); });
          await settle();
          lc(() => $("singleBrandField").hidden && !$("bundleBrandField").hidden && $("bundleBrandField").querySelector("label").textContent === "Brand(s)" &&
            cards().every(card => card.querySelector(".bi-brand") && card.querySelector(".bi-brand").value === "") && state.bundleItems.every(item => !item.brand),
            "Bundle mode replaces Brand with Brand(s); each card has its own Brand field and none is guessed");
          lc(() => $("brandSummary").textContent === "From items: none yet" && $("brandHint").hidden, "With no card brands the summary says so");
          await act(() => typeInto(cards()[0].querySelector(".bi-brand"), "Nintendo"));
          lc(() => state.bundleItems[0].brandSource === "seller" && !state.bundleItems[0].auto && state.bundleItems[1].brand === "Nintendo" &&
            state.bundleItems[1].brandSource === "auto" && cards()[1].querySelector(".bi-brand").value === "Nintendo" && cards()[1].querySelector(".bi-brand").classList.contains("auto") &&
            /Nintendo/.test(cards()[1].querySelector(".bi-brand").title) && state.bundleItems[2].brand === "",
            "Only a card whose name starts with a brand the seller typed gets it, marked auto; Mario Kart stays blank");
          lc(() => $("brandSummary").textContent === "From items: Nintendo · 1 item without a brand" && listingBrand() === "" && $("brandHint").hidden,
            "The summary lists the card brands and counts cards without one");
          await act(() => typeInto(cards()[2].querySelector(".bi-brand"), "Nintendo"));
          lc(() => listingBrand() === "Nintendo" && $("brandSummary").textContent === "From items: Nintendo" && buildUserMessage().includes("BRAND: Nintendo") &&
            buildUserMessage().includes("3. Mario Kart 8 [Condition not specified] [Brand: Nintendo]"), "One brand on every card is the listing's Brand, and each item's brand goes to the model");
          lc(() => SYSTEM_PROMPT.includes("never invent a single brand for a multi-brand bundle"), "The prompt tells the model never to invent a single brand for a multi-brand bundle");
          const aiBeforeGenerate = aiCalls;
          await act(async () => {
            const run = generate(); explicitGenerations++;
            complete(await nextRequest(), {...listing("Brand fixture"), item_specifics: {Platform: "Switch", Brand: "Invented"},
              bundle_items: ["Nintendo Switch console", "Nintendo Switch Pro Controller", "Mario Kart 8"].map(name => ({name, brand: "Model brand", description: "Seller item."}))});
            await run;
          });
          lc(() => aiCalls === aiBeforeGenerate + 1 && state.data.item_specifics.Brand === "Nintendo" && Object.keys(state.data.item_specifics)[0] === "Brand" &&
            state.data.bundle_items.every(item => item.brand === "Nintendo") && state.html.includes("Nintendo — Mario Kart 8") && !state.html.includes("Nintendo — Nintendo Switch") &&
            !state.html.includes("Model brand") && !state.html.includes("Invented"), "Single-brand bundle: the listing's Brand and item brands are the seller's, shown as Nintendo — Mario Kart 8");
          await act(() => typeInto($("notes"), "Nintendo Switch console, Nintendo Switch Pro Controller, Mario Kart 8, Sony DualSense"));
          await settle();
          await act(() => typeInto(cards()[3].querySelector(".bi-brand"), "Sony"));
          lc(() => listingBrand() === "" && !$("brandHint").hidden && $("brandSummary").textContent.startsWith("From items: Nintendo, Sony") &&
            [...document.querySelectorAll(".brand-option")].map(button => button.textContent + ":" + button.getAttribute("aria-pressed")).join() === "Multi-brand:false,Mixed lot:false,Unbranded:false" &&
            state.brandOverride === "", "Several brands: no Brand is set, and Multi-brand, Mixed lot and Unbranded are offered but none is chosen");
          lc(() => !("Brand" in state.data.item_specifics) && state.data.item_specifics.Platform === "Switch" && !/<th scope="row">Brand<\/th>/.test(state.html),
            "The existing listing drops its Brand specific locally once the brands differ");
          lc(() => buildUserMessage().includes("BRANDS IN THIS BUNDLE (seller-provided, per item): Nintendo, Sony") && buildUserMessage().includes("do not choose or invent a single brand") &&
            !/\nBRAND: /.test(buildUserMessage()) && buildUserMessage().includes("4. Sony DualSense [Condition not specified] [Brand: Sony]"), "The model is told the bundle mixes brands and gets each item's brand");
          await act(() => [...document.querySelectorAll(".brand-option")].find(button => button.dataset.brand === "Mixed lot").click());
          lc(() => state.brandOverride === "Mixed lot" && $("brandOverride").value === "Mixed lot" && listingBrand() === "Mixed lot" && state.data.item_specifics.Brand === "Mixed lot" &&
            document.querySelector('.brand-option[data-brand="Mixed lot"]').getAttribute("aria-pressed") === "true" && /your override is used/.test($("brandSummary").textContent),
            "Clicking Mixed lot sets it as the seller's Brand(s) override");
          await act(() => document.querySelector('.brand-option[data-brand="Mixed lot"]').click());
          lc(() => state.brandOverride === "" && listingBrand() === "" && !("Brand" in state.data.item_specifics), "Clicking it again clears the override");
          await act(() => typeInto($("brandOverride"), "Retro gaming"));
          lc(() => listingBrand() === "Retro gaming" && buildUserMessage().includes("BRAND: Retro gaming"), "A typed override becomes the Brand for the whole lot");
          await act(() => typeInto(cards()[1].querySelector(".bi-brand"), ""));
          await act(() => typeInto(cards()[0].querySelector("input"), "Nintendo Switch console OLED"));
          lc(() => state.bundleItems[1].brand === "" && state.bundleItems[1].brandSource === "seller" && cards()[1].querySelector(".bi-brand").value === "",
            "A brand the seller cleared is never filled in again");
          await act(() => {
            state.reference = {...sourceRef(), data: {key_specs: {Brand: "Aurora"}}, accepted: true};
            $("addBundleItemBtn").click(); typeInto(cards().at(-1).querySelector("input"), "Aurora lens cap");
          });
          lc(() => state.bundleItems.at(-1).brand === "Aurora" && state.bundleItems.at(-1).brandSource === "auto", "A brand from an accepted reference can be matched too");
          state.reference = null;

          // 5. Persistence: draft, history, template and backup keep the new state; old drafts still load.
          await act(() => { $("descToItems").click(); $("descToItems").click(); });
          await act(() => [...document.querySelectorAll("#includedChips .inc-chip.auto")].find(chip => chip.textContent.startsWith("Mario")).querySelector("button").click());
          await act(() => { $("includedInput").value = "Carry case"; pressEnter($("includedInput")); });
          await act(() => { const select = cards()[0].querySelector("select"); select.value = "USED"; select.dispatchEvent(new Event("change", {bubbles: true})); });
          const fingerprint = () => JSON.stringify({mode: state.mode, items: state.bundleItems.map(b => [b.id, b.name, b.brand, b.brandSource, Boolean(b.auto)]),
            removed: state.includedRemoved, override: state.brandOverride, desc: state.descToItems, manual: state.includedItems, chips: chips(),
            summary: $("brandSummary").textContent, box: $("descToItems").checked, field: $("brandOverride").value, autoCards: cards().map(card => card.classList.contains("auto")).join()});
          let before = "unavailable";
          await act(() => { before = fingerprint(); });
          lc(() => state.includedRemoved.length === 1 && state.brandOverride === "Retro gaming" && state.bundleItems.some(item => item.auto) && state.bundleItems.some(item => item.brandSource === "auto"),
            "Persistence fixture: removed chip, override, auto cards and auto brands are all present");
          let snap = {};
          await act(() => { snap = JSON.parse(JSON.stringify(snapshotDraft())); });
          lc(() => snap.bundleItems.every(item => typeof item.id === "string" && "brand" in item && "brandSource" in item && "auto" in item) &&
            snap.includedRemoved.length === 1 && snap.brandOverride === "Retro gaming" && snap.descToItems === true, "The draft saves card ids, brands, provenance, removed chips, override and the checkbox");
          await act(() => { saveDraft(); flushDraft(); });
          await act(() => { applyDraft(JSON.parse(localStorage.getItem(DRAFT_KEY))); renderDraft(); });
          lc(() => fingerprint() === before, "The autosaved draft restores all of it");
          await act(() => { pushHistory(snapshotDraft()); newListing(); });
          lc(() => !state.includedRemoved.length && state.brandOverride === "" && $("brandOverride").value === "" && !state.bundleItems.length && state.mode === "single" &&
            $("brandSummary").textContent === "From items: none yet" && state.descToItems === true, "New listing resets the removed chips, override, cards and checkbox");
          await act(() => restoreHistoryDraft(loadHistory().find(entry => entry.draft.brandOverride === "Retro gaming").draft, true));
          lc(() => fingerprint() === before, "Recent drafts restore all of it");
          let backupText = "";
          await act(() => { backupText = draftBackupText(); newListing(); const restored = readDraftBackup(backupText); applyDraft(restored); renderDraft(); });
          lc(() => fingerprint() === before && JSON.parse(backupText).draft.bundleItems.every(item => typeof item.id === "string"), "A backup file restores all of it");
          for (const bad of [{includedRemoved: "x"}, {brandOverride: 4}, {descToItems: "yes"}, {bundleItems: [{name: "A", notes: "", condition: "", auto: "yes"}]}, {bundleItems: [{name: "A", notes: "", condition: "", brand: 5}]}]) {
            const file = JSON.parse(backupText); Object.assign(file.draft, bad);
            lc(() => { try { readDraftBackup(JSON.stringify(file)); return false; } catch (error) { return /invalid fields/.test(error.message); } }, "Backups with a malformed new field are refused: " + JSON.stringify(bad).slice(1, 60));
          }
          await act(() => {
            applyDraft({...snapshotDraft(), data: ListingCore.normalizeListing({...listing("Template brands"), bundle_items: state.bundleItems.map(item => ({name: item.name}))})});
            renderDraft();
          });
          let template = {};
          await act(() => { template = buildTemplate("Brands template"); });
          lc(() => template.bundleItems.every(item => item.condition === "") && !("condition" in template.inputs) && !("condNotes" in template.inputs) && !("productBarcode" in template.inputs) &&
            template.data.condition_rating === "" && template.bundleItems.some(item => item.brand === "Nintendo") && template.includedRemoved.length === 1 &&
            template.brandOverride === "Retro gaming" && template.descToItems === true, "Templates keep brands, provenance and the override but still never store condition or barcode");
          await act(() => { localStorage.setItem(TEMPLATES_KEY, JSON.stringify([template])); renderTemplates(); });
          await act(() => { newListing(); useTemplate(template.id); });
          lc(() => fingerprint() === before && state.bundleItems.every(item => item.condition === "") && state.data.item_specifics.Brand === "Retro gaming" &&
            state.html.includes("Nintendo — Mario Kart 8"), "Using the template restores the cards, brands, chips and override, with conditions cleared");
          await act(() => { applyDraft({version: 1, inputs: {notes: "Old draft"}, mode: "bundle", includedItems: ["Old manual"],
            bundleItems: [{name: "Old card", notes: "", condition: "NEW"}]}); renderDraft(); });
          lc(() => state.bundleItems.length === 1 && typeof state.bundleItems[0].id === "string" && !state.bundleItems[0].auto && state.bundleItems[0].brand === "" &&
            state.bundleItems[0].condition === "NEW" && !state.includedRemoved.length && state.brandOverride === "" && chips().join() === "auto:Old card,Old manual",
            "A draft saved before these fields existed still loads, with its cards as the seller's own");
          lc(() => aiCalls === explicitGenerations && explicitGenerations === 1 && !pending.some(request => request.path.startsWith("/llm/")),
            "No AI request was made by the lookup panel or any bundle automation; only the explicit Generate called the model");
        } finally {
          window.fetch = realFetch;
          localStorage.removeItem(TEMPLATES_KEY); renderTemplates();
          newListing();
          if (soft) {
            const note = document.createElement("p");
            note.id = "soft-failures";
            note.dataset.count = String(softFailures.length);
            note.textContent = "SOFT FAILURES (" + softFailures.length + "): " + softFailures.join(" | ");
            panel.append(note);
          }
        }
      }

      /* ---- collapsible bundle cards ---- */
      {
        // ?soft records failures instead of stopping, so this block can be run against older code.
        const soft = new URLSearchParams(location.search).has("soft");
        const softFailures = [];
        const lc = (fn, label) => {
          let ok = false;
          try { ok = Boolean(fn()); } catch (_) { ok = false; }
          if (ok || !soft) check(ok, label); else softFailures.push(label);
        };
        const act = async fn => { try { await fn(); } catch (_) { /* the outcome is checked next */ } };
        const typeInto = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", {bubbles: true})); };
        const setCond = (card, code) => { const select = card.querySelector("select"); select.value = code; select.dispatchEvent(new Event("change", {bubbles: true})); };
        const settle = () => new Promise(resolve => setTimeout(resolve, 480));
        const cards = () => [...document.querySelectorAll("#bundleCards .bundle-card")];
        const summaryOf = card => card.querySelector(".bi-summary");
        const folded = card => Boolean(card && card.classList.contains("collapsed") && summaryOf(card) && !summaryOf(card).hidden &&
          card.querySelector(".bi-body") && card.querySelector(".bi-body").hidden);
        const open = card => Boolean(card && !card.classList.contains("collapsed") && summaryOf(card) && summaryOf(card).hidden &&
          card.querySelector("select").getClientRects().length > 0);
        const leave = async () => { $("condVaries").focus(); await tick(); await tick(); };
        const pattern = () => cards().map(card => folded(card) ? "F" : open(card) ? "O" : "?").join("");
        const realFetch = window.fetch;
        let aiCalls = 0;
        window.fetch = (path, opts) => { if (String(path).startsWith("/llm/")) aiCalls++; return realFetch(path, opts); };
        pending.splice(0);
        try {
          newListing();
          await act(() => { $("modeBundle").click(); if (!$("descToItems").checked) $("descToItems").click(); $("addBundleItemBtn").click(); });
          const first = () => cards()[0];
          lc(() => open(first()) && state.bundleItems[0].collapsed === false && $("bundleBulk").hidden, "Add item starts expanded; Expand all / Collapse filled wait for 3 cards");
          const longName = "Nintendo Switch OLED console, white, boxed with dock, grip, both Joy-Con, HDMI cable, power adapter and every original insert";
          await act(async () => {
            first().querySelector(".bi-name").focus();
            typeInto(first().querySelector(".bi-name"), longName);
            typeInto(first().querySelector(".bi-brand"), "Nintendo");
            setCond(first(), "USED");
            first().querySelector("textarea").focus();
            typeInto(first().querySelector("textarea"), "Small scratch on the back panel");
            await tick(); await tick();
          });
          lc(() => open(first()) && first().contains(document.activeElement), "A filled card never folds while the seller is typing in it");
          await act(leave);
          lc(() => folded(first()) && state.bundleItems[0].collapsed === true, "Leaving a filled card (name and condition) folds it to one summary row");
          lc(() => { const h = first().getBoundingClientRect().height; return h >= 40 && h <= 48; }, "The folded row is about 44px tall");
          const sum = () => summaryOf(first());
          lc(() => sum().tagName === "BUTTON" && sum().type === "button" && sum().getAttribute("aria-expanded") === "false" &&
            document.getElementById(sum().getAttribute("aria-controls")) === first().querySelector(".bi-body"),
            "The summary row is a native button (Enter and Space expand it) with aria-expanded and aria-controls");
          lc(() => { const name = sum().querySelector(".bi-sum-name"); return name.textContent === longName && getComputedStyle(name).textOverflow === "ellipsis" &&
            name.scrollWidth > name.clientWidth; }, "The summary shows the name, truncated with an ellipsis");
          lc(() => { const brand = sum().querySelector(".bi-sum-brand"); return brand.textContent === "Nintendo" &&
            getComputedStyle(brand).color !== getComputedStyle(sum().querySelector(".bi-sum-name")).color; }, "The summary shows the brand, muted");
          lc(() => sum().querySelector(".bi-sum-main").getBoundingClientRect().width >= 140,
            "The name and brand keep at least 140px; on a narrow card the badges wrap below instead of squeezing the name");
          lc(() => { const badge = sum().querySelector(".bi-cond"); return badge.textContent === "Used" && badge.classList.contains(ListingCore.conditionClass("USED")) &&
            getComputedStyle(badge).backgroundColor !== "rgba(0, 0, 0, 0)" && !sum().querySelector(".bi-needs"); },
            "The summary shows the condition as a badge with the listing's per-condition colour class");
          lc(() => { const notes = sum().querySelector(".bi-sum-notes"); return notes.title === "Small scratch on the back panel" && notes.querySelector("svg") &&
            notes.textContent === "Has notes"; }, "A notes icon appears when the card has notes; its tooltip shows them");
          lc(() => sum().querySelector(".bi-sum-edit").textContent === "Edit" && !sum().querySelector(".bi-auto-tag") &&
            first().querySelector(".remove-card").getClientRects().length > 0 && !sum().contains(first().querySelector(".remove-card")),
            "The row ends with Edit, and the remove button stays beside it");
          await act(() => sum().click());
          lc(() => open(first()) && document.activeElement === first().querySelector(".bi-name") && !state.bundleItems[0].collapsed,
            "Clicking the row expands the card and focuses its name");
          await act(() => first().querySelector(".bi-name").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true})));
          lc(() => folded(first()) && document.activeElement === sum(), "Escape inside an expanded filled card folds it and focuses the row");
          await act(() => { sum().focus(); sum().click(); });
          lc(() => open(first()) && document.activeElement === first().querySelector(".bi-name"), "Activating the focused row from the keyboard expands it and focuses the name");

          // Unfilled cards stay expanded.
          await act(async () => {
            $("addBundleItemBtn").click(); $("addBundleItemBtn").click();
            const [, second, third] = cards();
            second.querySelector(".bi-name").focus(); typeInto(second.querySelector(".bi-name"), "Carry case");
            third.querySelector("select").focus(); setCond(third, "NEW");
            await leave();
          });
          lc(() => pattern() === "FOO", "Cards with only a name, or only a condition, stay expanded when focus leaves");
          await act(() => cards()[1].querySelector(".bi-name").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true})));
          lc(() => open(cards()[1]), "Escape does not fold a card that is not filled in");
          lc(() => !$("bundleBulk").hidden && $("expandCardsBtn").textContent === "Expand all" && $("collapseCardsBtn").textContent === "Collapse filled" &&
            $("bundleBulk").closest(".bundle-head").textContent.includes("Bundle items"), "With 3 cards the Bundle items header offers Expand all / Collapse filled");

          // A pointer press waits for its click before the card above folds.
          await act(async () => {
            summaryOf(first()).click();
            $("addBundleItemBtn").dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
            $("addBundleItemBtn").focus(); await tick(); await tick();
          });
          lc(() => open(first()), "A filled card does not fold while a pointer press elsewhere is still down");
          await act(async () => { $("addBundleItemBtn").dispatchEvent(new PointerEvent("pointerup", {bubbles: true})); await tick(); await tick(); });
          lc(() => folded(first()), "It folds once the press is released, so the click lands where it was aimed");

          // Lookups and invalid fields keep a card open.
          await act(async () => {
            summaryOf(first()).click();
            first().querySelector(".bi-lookup").focus(); first().querySelector(".bi-lookup").click();
            await leave();
          });
          const search = pending.find(request => request.path.startsWith("/ebay/search?"));
          lc(() => search && inflight[bundleKey(state.bundleItems[0])] && open(first()), "A card with Lookup details in flight stays expanded when focus leaves");
          await act(() => first().querySelector(".bi-name").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true})));
          lc(() => open(first()), "Escape does not fold a card while its lookup is running");
          await act(async () => {
            search.resolve(reply({items: [{item_id: "v1|880|0", title: "Switch OLED listing", url: "https://www.ebay.com/itm/880"}]}));
            pending.splice(pending.indexOf(search), 1);
            await tick(); await tick(); await tick();
            first().querySelector(".bi-name").focus(); await leave();
          });
          lc(() => open(first()) && !first().querySelector(".ref-results-body").hidden, "An open lookup results panel keeps the card expanded");
          await act(async () => { first().querySelector(".ref-results-toggle").click(); first().querySelector(".bi-name").focus(); await leave(); });
          lc(() => folded(first()), "Once the results are closed the filled card folds again");
          await act(async () => {
            summaryOf(first()).click();
            first().querySelector("textarea").setAttribute("aria-invalid", "true");
            await leave();
          });
          lc(() => open(first()), "A card with a field marked invalid stays expanded");
          await act(async () => { first().querySelector("textarea").removeAttribute("aria-invalid"); first().querySelector(".bi-name").focus(); await leave(); });

          // Description cards start as a compact Needs condition row.
          await act(() => typeInto($("notes"), "Bundle of:\n- Mario Kart 8 Deluxe\n- Pro Controller"));
          await settle();
          const autoCard = () => cards()[3];
          lc(() => cards().length === 5 && pattern() === "FOOFF" && autoCard().classList.contains("auto") &&
            summaryOf(autoCard()).querySelector(".bi-needs").textContent === "Needs condition" && summaryOf(autoCard()).querySelector(".bi-auto-tag").textContent === "Auto" &&
            summaryOf(autoCard()).querySelector(".bi-sum-name").textContent === "Mario Kart 8 Deluxe" && !summaryOf(autoCard()).querySelector(".bi-cond"),
            "Cards parsed from the description show as a compact row with a Needs condition chip and a short Auto tag");
          lc(() => getComputedStyle(summaryOf(autoCard()).querySelector(".bi-needs")).color === getComputedStyle($("expandCardsBtn")).color,
            "The Needs condition chip uses the orange accent");
          await act(() => summaryOf(autoCard()).click());
          lc(() => open(autoCard()) && document.activeElement === autoCard().querySelector(".bi-name") && autoCard().querySelector(".bi-body .bi-auto-tag"),
            "Clicking a Needs condition row expands it and focuses the name");
          await act(async () => { setCond(autoCard(), "FOR_PARTS"); await leave(); });
          lc(() => folded(autoCard()) && !state.bundleItems[3].auto && summaryOf(autoCard()).querySelector(".bi-cond").classList.contains("elb-cond-parts") &&
            !summaryOf(autoCard()).querySelector(".bi-needs") && !autoCard().querySelector(".bi-auto-tag"),
            "Choosing its condition makes it the seller's card, which folds with the condition badge");

          // Expand all / Collapse filled.
          await act(() => $("expandCardsBtn").click());
          lc(() => pattern() === "OOOOO" && state.bundleItems.every(item => !item.collapsed), "Expand all opens every card");
          await act(() => $("collapseCardsBtn").click());
          lc(() => pattern() === "FOOFF", "Collapse filled folds filled and untouched description cards, and leaves the others open");

          // Per-draft view state: saved with the draft, not in templates or backups' required fields.
          await act(() => { saveDraft(); flushDraft(); });
          const stored = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
          lc(() => stored.bundleItems.map(item => item.collapsed ? "F" : "O").join("") === "FOOFF", "The folded state is saved in the draft");
          await act(() => { state.bundleItems = []; renderBundleCards(); restoreDraft(); });
          lc(() => pattern() === "FOOFF" && summaryOf(cards()[0]).querySelector(".bi-sum-name").textContent === longName, "Reloading the draft keeps each card folded or open");
          let template = {};
          await act(() => { const data = state.data; state.data = ListingCore.normalizeListing(listing("Fold template")); try { template = buildTemplate("Fold"); } finally { state.data = data; } });
          lc(() => state.bundleItems.every(item => typeof item.collapsed === "boolean") && template.bundleItems.length === 5 && template.bundleItems.every(item => !("collapsed" in item)),
            "Templates do not store the folded state");
          lc(() => { const file = JSON.parse(draftBackupText()); file.draft.bundleItems.forEach(item => delete item.collapsed); readDraftBackup(JSON.stringify(file));
            file.draft.bundleItems[0].collapsed = "yes"; try { readDraftBackup(JSON.stringify(file)); return false; } catch (error) { return /invalid fields/.test(error.message); } },
            "Backups load without the folded state and refuse a malformed one");
          await act(() => { applyDraft({version: 1, inputs: {}, mode: "bundle", bundleItems: [{name: "Old card", notes: "", condition: "NEW"}, {name: "Old parsed", notes: "", condition: "", auto: true}]}); renderDraft(); });
          lc(() => pattern() === "OF" && !state.bundleItems[0].collapsed, "Drafts saved before folding load with seller cards open and untouched description cards folded");
          await act(() => newListing());
          await act(() => { $("modeBundle").click(); $("addBundleItemBtn").click(); });
          lc(() => cards().length === 1 && pattern() === "O" && !state.bundleItems[0].collapsed, "New listing starts with no folded cards");
          lc(() => aiCalls === 0 && !pending.some(request => request.path.startsWith("/llm/")), "Folding cards made no AI request");
        } finally {
          window.fetch = realFetch;
          pending.splice(0);
          newListing();
          if (soft) {
            const note = document.createElement("p");
            note.id = "fold-soft-failures";
            note.dataset.count = String(softFailures.length);
            note.textContent = "FOLD SOFT FAILURES (" + softFailures.length + "): " + softFailures.join(" | ");
            panel.append(note);
          }
        }
      }

      title.textContent = passed + " browser regression checks passed";
      panel.dataset.result = "pass";
      const rerun = document.createElement("button");
      rerun.textContent = "Run checks again";
      rerun.addEventListener("click", () => location.reload());
      panel.append(rerun);
    } catch (e) {
      title.textContent = "FAILED after " + passed + " checks: " + e.message;
      panel.dataset.result = "fail";
      console.error(e);
    }
  });
})();
