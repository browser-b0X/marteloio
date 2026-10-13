/* Test-only fixture: network is replaced BEFORE the real application starts.
   Deliberately ignore AbortSignal to prove stale-result checks independently.
   Only served by serve_frontend_checks.py, never by the production relay. */
(() => {
  const pending = [];
  let holdSession = false;
  let holdSettings = false;
  /* The server's shapes (v0.2.0). /ai/status: {ready, retry_in, providers: [{id, label, configured, enabled, state, retry_in,
     model, key_hint, checked: "ok" | "failed" | "" (its last test or use; "" after a restart or a new key), base_url (FreeLLMAPI)}]}.
     POST /settings/ai: {saved, provider, label, test, status}; a pasted key the service turns down (test.kind "key_rejected")
     isn't saved: saved false, the previous key kept, status as before. Saving a key switches its service on. Generation
     errors: {error, kind}, kinds including freellmapi_not_running, freellmapi_no_services and all_disabled (503). */
  let aiStatus = {ready: true, retry_in: 0, providers: [{id: "groq", label: "Groq", configured: true, enabled: true, state: "ready", retry_in: 0, model: "fixture-model",
    key_hint: "WXYZ", checked: ""}]};
  // v0.2.0 routes. GETs answer at once (or are held once when asked); POSTs wait for the checks.
  let fixtureAppInfo = {version: "0.2.0", build: "0123456789ab", installed: true, data_dir: "C:\\Users\\Fixture\\AppData\\Local\\Marteloio", os: "windows", port: 8080};
  let detectReply = {found: false, ready: false, base_url: "", reason: "not_running"};
  let holdDetect = false, holdStatus = false;
  let settingsReply = {};
  const reply = data => ({ok: true, status: 200, json: async () => data});
  window.fetch = async (path, opts = {}) => {
    if (path === "/session") {
      if (holdSession) { holdSession = false; return new Promise(resolve => pending.push({path, opts, resolve})); }
      return reply({token: "fixture-only"});
    }
    if (path === "/ai/status") {
      if (holdStatus) { holdStatus = false; return new Promise(resolve => pending.push({path, opts, resolve})); }
      return reply(aiStatus);
    }
    if (path === "/app/info") return reply(fixtureAppInfo);
    if (path === "/ai/freellmapi/detect") {
      if (holdDetect) { holdDetect = false; return new Promise(resolve => pending.push({path, opts, resolve})); }
      return reply(detectReply);
    }
    if (["/settings/ai", "/ai/test", "/shutdown"].includes(path) && opts.method === "POST") return new Promise(resolve => pending.push({path, opts, resolve}));
    if (path === "/settings" && opts.method !== "POST") {
      if (holdSettings) { holdSettings = false; return new Promise(resolve => pending.push({path, opts, resolve})); }
      return reply(settingsReply);
    }
    if ((path === "/settings" || path === "/settings/ebay") && opts.method === "POST") return new Promise(resolve => pending.push({path, opts, resolve}));
    if (path.startsWith('/ebay/authorize-url?') || path === '/ebay/token-user' || path === '/ebay/userstats') return new Promise(resolve => pending.push({path, opts, resolve}));
    if (path === "/llm/chat/completions" || path.startsWith("/ebay/search?") || path.startsWith("/ebay/reference?")) {
      return new Promise(resolve => pending.push({path, opts, resolve}));
    }
    throw new Error("Fixture blocked unexpected request: " + path);
  };
  /* ?app-only: a bare copy of the app for the first-run checks (wave3Checks loads it in a frame).
     Its storage lives in memory, so the page running the checks keeps its own, and the query says
     what it starts from: ai=none (nothing set up), guide=<the first-run record as JSON>,
     drafts=<how many Recent drafts>, storage=throws (every storage call throws). No checks run here;
     window.__fixture lets the checks answer its requests and read its page errors. */
  const appParams = new URLSearchParams(location.search);
  if (appParams.has("app-only")) {
    const memory = new Map(), throws = appParams.get("storage") === "throws";
    const deny = () => { throw new DOMException("Fixture blocked storage", "SecurityError"); };
    Storage.prototype.getItem = function(key) { if (throws) deny(); return memory.has(String(key)) ? memory.get(String(key)) : null; };
    Storage.prototype.setItem = function(key, value) { if (throws) deny(); memory.set(String(key), String(value)); };
    Storage.prototype.removeItem = function(key) { if (throws) deny(); memory.delete(String(key)); };
    Storage.prototype.clear = function() { if (throws) deny(); memory.clear(); };
    memory.set("eb.appTheme", appParams.get("theme") === "dark" ? "dark" : "light");
    if (appParams.has("guide")) memory.set("marteloio.guide.v1", appParams.get("guide"));
    const drafts = Number(appParams.get("drafts") || 0);
    if (drafts > 0) memory.set("eb.history.v1", JSON.stringify(Array.from({length: drafts}, (_, i) => ({id: "fixture-" + i, savedAt: new Date().toISOString(),
      title: "Fixture draft " + (i + 1), draft: {version: 1, inputs: {notes: "Fixture draft " + (i + 1)}}}))));
    if (appParams.get("ai") === "none") {
      const off = (id, label) => ({id, label, configured: false, enabled: true, state: "off", retry_in: 0, key_hint: "", checked: ""});
      aiStatus = {ready: false, retry_in: 0, providers: [off("freellmapi", "FreeLLMAPI"), off("gemini", "Google Gemini"), off("groq", "Groq"), off("openrouter", "OpenRouter")]};
    }
    const errors = [];
    window.addEventListener("error", event => errors.push(String(event.message)));
    window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
    window.__fixture = {pending, reply, errors, memory, setStatus: status => { aiStatus = status; }};
    window.confirm = () => true;
    return;
  }
  // This is an ephemeral test origin, never the user's app origin.
  const barcodeReload = new URLSearchParams(location.search).has("barcode-reload");
  const barcodeReloadStage = barcodeReload ? sessionStorage.getItem("fixture.barcodeReload") : null;
  const themeReload = new URLSearchParams(location.search).has("theme-reload");
  const themeReloadStage = themeReload ? sessionStorage.getItem("fixture.themeReload") : null;
  // A seller who finished the first run: nothing from the guide pops up during the older checks.
  // The first-run checks (wave3Checks) reset it, and load fresh copies of the app with ?app-only.
  const GUIDE_DONE = {welcome: "done", tour: "done", generated: true, copied: true, checklist: "auto", startHereDismissed: true, tipsShown: ["copyHtml"], tourNotice: true};
  if (!barcodeReloadStage && !themeReloadStage) {
    localStorage.clear();
    localStorage.setItem("eb.appTheme", "dark");
    localStorage.setItem("eb.draft.v1", JSON.stringify({version: 1, inputs: {notes: "Restored fixture draft"}}));
    localStorage.setItem("marteloio.guide.v1", JSON.stringify(GUIDE_DONE));
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
    /* ---- v0.2.0 wave 2: messages that fade, plain errors with fixes, step notes, Settings ----
       Runs at the end of the suite, or alone with ?wave2. With ?soft it records failures instead
       of stopping, so it can be run against the code before this wave (each check must fail there). */
    async function wave2Checks() {
      const soft = new URLSearchParams(location.search).has("soft");
      const softFailures = [];
      const lc = (fn, label) => {
        let ok = false;
        try { ok = Boolean(fn()); } catch (_) { ok = false; }
        if (ok || !soft) check(ok, label); else softFailures.push(label);
      };
      const act = async fn => { try { await fn(); } catch (_) { /* the outcome is checked next */ } };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async (fn, ms = 2500) => {
        const end = performance.now() + ms;
        for (;;) {
          let ok = false;
          try { ok = Boolean(fn()); } catch (_) { ok = false; }
          if (ok) return true;
          if (performance.now() > end) return false;
          await wait(10);
        }
      };
      const settleUi = async () => { for (let i = 0; i < 8; i++) await tick(); };
      const typeInto = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", {bubbles: true})); };
      const failWith = (request, status, data) => request.resolve({ok: false, status, json: async () => data});
      const live = () => [...document.querySelectorAll("#toastPanel .toast-item:not(.leaving)")];
      const liveOf = kind => live().filter(item => item.querySelector(".toast." + kind));
      const textOf = item => (item && item.querySelector(".toast p") || {}).textContent || "";
      const titleOf = item => (item && item.querySelector(".toast-title > span") || {}).textContent || "";
      const actionOf = item => item && item.querySelector(".toast-action");
      const takeRequest = async path => {
        await until(() => pending.some(request => request.path === path));
        const at = pending.findIndex(request => request.path === path);
        return at < 0 ? null : pending.splice(at, 1)[0];
      };
      const clearToasts = () => {
        try { if (busyToast) dismissToast(busyToast); } catch (_) { /* older code */ }
        for (const item of [...document.querySelectorAll("#toastPanel .toast-item")]) {
          try { dismissToast(item); } catch (_) { /* older code */ }
          item.remove();
        }
      };
      const lum = color => {
        const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const contrastOf = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
      const provider = (id, label, extra = {}) => ({id, label, configured: false, enabled: true, state: "off", retry_in: 0, key_hint: "", checked: "",
        ...(id === "freellmapi" ? {base_url: "http://127.0.0.1:31415/v1"} : {}), ...extra});
      const noneSetUp = {ready: false, retry_in: 0, providers: [provider("freellmapi", "FreeLLMAPI"), provider("gemini", "Google Gemini"), provider("groq", "Groq"), provider("openrouter", "OpenRouter")]};
      const twoSetUp = {ready: true, retry_in: 0, providers: [provider("freellmapi", "FreeLLMAPI", {configured: true, state: "ready", key_hint: "9f3c", checked: "ok"}),
        provider("gemini", "Google Gemini", {configured: true, state: "ready", key_hint: "a1B2", checked: "ok"}), provider("groq", "Groq"), provider("openrouter", "OpenRouter")]};
      const NO_AI = "Connect an AI service first. It takes about 2 minutes with a free Google key.";
      const NO_EBAY = "Look up needs an eBay key (optional). Add one in Settings \u203a eBay, or just describe the item.";
      const FAST = {busyDelay: 80, busyElapsed: 320, tick: 60, ok: 450, okAction: 700, note: 500, err: 600, errMax: 1000, readFrom: 120, perChar: 2, sayGap: 60};
      let defaultTimes = null;
      try { defaultTimes = {...TOAST_TIMES}; } catch (_) { /* older code */ }
      const fast = () => { try { Object.assign(TOAST_TIMES, FAST); } catch (_) { /* older code */ } };
      const savedStatus = aiStatus, savedDetect = detectReply, savedInfo = fixtureAppInfo, savedTheme = document.documentElement.dataset.theme;
      const fixtureConfirm = window.confirm;
      let confirms = 0;
      window.confirm = () => { confirms++; return true; };
      pending.splice(0);
      try {
        await act(() => { closeSettings(); newListing(); });
        clearToasts();

        /* -- how long each message stays: one table (listing-core TOAST_TIMES) -- */
        let lives = null;
        await act(() => {
          const life = (kind, text, action) => toastInfo(toast(kind, text, action ? {action: {label: "Undo", run() {}}} : {})).life;
          lives = [life("ok", "Fixture done."), life("ok", "Fixture done with undo.", true), life("note", "Fixture notice."), life("err", "Fixture problem."),
            life("err", "Fixture problem with a long explanation to read. ".repeat(5)), life("err", "x".repeat(4000))];
        });
        lc(() => lives[0] === 4000 && lives[1] === 10000 && lives[2] === 8000 && lives[3] === 10000 && lives[4] > 10000 && lives[4] < 20000 && lives[5] === 20000,
          "Messages: Done stays 4 s (10 s with Undo), Notice 8 s, Problem 10 s plus reading time, at most 20 s");
        clearToasts();
        fast();

        /* -- Working -- */
        let early = null, later = null, quick = null;
        await act(async () => {
          const item = toast("busy", "Fixture working\u2026", {task: "fixture-task"});
          early = item.isConnected;
          await wait(FAST.busyDelay + 140);
          later = item.parentElement === $("toastPanel");
          dismissToast(item);
          const brief = toast("busy", "Quick fixture task\u2026");
          dismissToast(brief);
          await wait(FAST.busyDelay + 140);
          quick = brief.isConnected;
        });
        lc(() => early === false && later === true && quick === false && ListingCore.TOAST_TIMES.busyDelay === 400,
          "Messages: Working appears only if the task is still running after 0.4 s");
        let shownWhileWriting = false, waited = "", goneWhenReady = false, goneOnStop = false;
        await act(async () => {
          newListing(); typeInto($("notes"), "Working fixture camera");
          const run = generate(); const request = await nextRequest();
          await wait(FAST.busyDelay + 140);
          shownWhileWriting = Boolean(busyToast && busyToast.isConnected && textOf(busyToast) === "Writing your listing\u2026");
          await wait(FAST.busyElapsed + FAST.tick + 140);
          waited = textOf(busyToast);
          const item = busyToast;
          complete(request, listing("Working fixture title")); await run;
          goneWhenReady = !busyToast && (item.classList.contains("leaving") || !item.isConnected);
          typeInto($("notes"), "Working fixture stopped");
          const stopped = generate(); const stoppedRequest = await nextRequest();
          await wait(FAST.busyDelay + 140);
          const stoppedItem = busyToast;
          newListing();
          goneOnStop = Boolean(stoppedItem) && stoppedItem.classList.contains("leaving") && !busyToast;
          complete(stoppedRequest, listing("Never used")); await stopped;
        });
        lc(() => shownWhileWriting && goneWhenReady, "Messages: writing a listing shows Working while it runs, and it goes when the listing is ready");
        lc(() => goneOnStop, "Messages: Working also goes when its task is stopped (New listing)");
        lc(() => /^Still writing your listing\u2026 \d+ s$/.test(waited) && ListingCore.TOAST_TIMES.busyElapsed === 10000,
          "Messages: after 10 s Working says how long it has waited (Still writing your listing… 14 s)");

        /* -- fading, holding, the time-left line, repeats, at most three -- */
        clearToasts();
        let stillThere = false, allFaded = false;
        await act(async () => {
          const items = [toast("ok", "Fixture fades."), toast("note", "Fixture notice fades."), toast("err", "Fixture problem fades.")];
          await wait(40);
          stillThere = items.every(item => !item.classList.contains("leaving"));
          await until(() => items.every(item => item.classList.contains("leaving") || !item.isConnected), FAST.err + 1500);
          allFaded = items.every(item => item.classList.contains("leaving") || !item.isConnected);
        });
        lc(() => stillThere && allFaded, "Messages: Done, Notice and Problem fade on their own");
        let pointerHolds = false, pointerResumes = false, lineRuns = false, linePauses = false;
        await act(async () => {
          const item = toast("err", "Fixture held by the pointer.");
          const line = item.querySelector(".toast-life");
          lineRuns = line.getAnimations()[0].playState === "running";
          item.dispatchEvent(new PointerEvent("pointerenter"));
          linePauses = line.getAnimations()[0].playState === "paused";
          await wait(FAST.err + 160);
          pointerHolds = !item.classList.contains("leaving") && toastInfo(item).held;
          item.dispatchEvent(new PointerEvent("pointerleave"));
          await until(() => item.classList.contains("leaving") || !item.isConnected, FAST.err + 1500);
          pointerResumes = item.classList.contains("leaving") || !item.isConnected;
        });
        lc(() => pointerHolds && pointerResumes, "Messages: pointing at a message stops its time; it fades after the pointer leaves");
        lc(() => lineRuns && linePauses, "Messages: a thin line shows the time left and stops while the message is held");
        let focusHolds = false, focusResumes = false;
        await act(async () => {
          const item = toast("note", "Fixture held by focus.", {action: {label: "Fixture action", run() {}}});
          actionOf(item).focus();
          await wait(FAST.note + 160);
          focusHolds = !item.classList.contains("leaving") && toastInfo(item).held;
          $("notes").focus();
          await until(() => item.classList.contains("leaving") || !item.isConnected, FAST.note + 1500);
          focusResumes = item.classList.contains("leaving") || !item.isConnected;
        });
        lc(() => focusHolds && focusResumes, "Messages: keyboard focus inside a message stops its time; it fades once focus leaves");
        clearToasts();
        let once = false, twice = "", restarted = false, thrice = "";
        await act(async () => {
          const first = toast("err", "Fixture repeated problem.");
          await wait(150);
          const leftBefore = toastInfo(first).left;
          const second = toast("err", "Fixture repeated problem.");
          once = first === second && live().filter(item => textOf(item) === "Fixture repeated problem.").length === 1;
          twice = first.querySelector(".toast-count").hidden ? "" : first.querySelector(".toast-count [aria-hidden]").textContent;
          restarted = toastInfo(first).count === 2 && toastInfo(first).left > leftBefore + 100;
          toast("err", "Fixture repeated problem.");
          thrice = first.querySelector(".toast-count [aria-hidden]").textContent;
        });
        lc(() => once && twice === "\u00d72" && restarted && thrice === "\u00d73", "Messages: the same message again shows once with ×2 (×3…) and starts its time again");
        clearToasts();
        let capped = false;
        await act(() => {
          const items = ["one", "two", "three", "four"].map(n => toast("note", "Fixture message " + n + "."));
          capped = live().length === 3 && items[0].classList.contains("leaving") && items.slice(1).every(item => !item.classList.contains("leaving"));
        });
        lc(() => capped, "Messages: at most three show at once; the oldest leaves first");

        /* -- screen readers, focus, keyboard -- */
        clearToasts();
        let polite = "", assertive = "", regions = false, focusKept = false, workingHeardOnce = false;
        await act(async () => {
          $("notes").focus();
          await wait(FAST.sayGap + 40);
          toast("ok", "Fixture done for screen readers.");
          polite = $("toastAnnounce").textContent;
          toast("err", "Fixture problem for screen readers.", {action: {label: "Fixture fix", run() {}}});
          // It waits its turn, so both are heard.
          const waited = $("toastAlert").textContent === "";
          await until(() => $("toastAlert").textContent !== "", 1000);
          assertive = waited ? $("toastAlert").textContent : "";
          focusKept = document.activeElement === $("notes");
          await wait(FAST.sayGap + 40);
          regions = !$("toastPanel").hasAttribute("aria-live") && $("toastAnnounce").getAttribute("aria-live") === "polite" &&
            $("toastAlert").getAttribute("aria-live") === "assertive" && $("toastAnnounce").classList.contains("sr-only");
          const before = $("toastAnnounce").textContent;
          const item = toast("busy", "Fixture long task\u2026", {task: "fixture-long"});
          const silentFirst = $("toastAnnounce").textContent === before;
          await wait(FAST.busyDelay + 140);
          const heard = $("toastAnnounce").textContent;
          await wait(FAST.busyElapsed + FAST.tick * 2 + 140);
          workingHeardOnce = silentFirst && heard === "Working: Fixture long task\u2026" && $("toastAnnounce").textContent === heard &&
            textOf(item).startsWith("Still fixture long task\u2026");
          dismissToast(item);
        });
        lc(() => polite === "Done: Fixture done for screen readers." && assertive === "Problem: Fixture problem for screen readers." && regions && workingHeardOnce && focusKept,
          "Messages: screen readers hear each once (polite, or assertive for a Problem), never the countdown, and a message never takes focus");
        clearToasts();
        let backToNotes = false, escapeCloses = false;
        await act(() => {
          $("notes").focus();
          const item = toast("err", "Fixture closed from the keyboard.");
          const close = item.querySelector(".toast-close");
          close.focus();
          close.click();
          backToNotes = item.classList.contains("leaving") && document.activeElement === $("notes");
          $("brand").focus();
          const other = toast("note", "Fixture closed with Esc.");
          other.querySelector(".toast-close").focus();
          other.querySelector(".toast-close").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true}));
          escapeCloses = other.classList.contains("leaving") && document.activeElement === $("brand");
        });
        lc(() => backToNotes && escapeCloses, "Messages: closing one from the keyboard (or with Esc) puts focus back where the seller was, not on the page");
        lc(() => [...document.querySelector("style").sheet.cssRules].some(rule => rule instanceof CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(rule.conditionText) &&
          [...rule.cssRules].some(inner => inner.selectorText === ".toast-item:not(.leaving)" && inner.style.animationName === "none")),
          "Messages: with reduced motion they don't slide in (the time-left line stays)");

        /* -- where they sit: below dialogs, never over the Generate button or its bar -- */
        clearToasts();
        let belowDialog = false;
        await act(async () => {
          const item = toast("note", "Fixture under the dialog.");
          await openSettings("ai");
          const box = item.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          belowDialog = Number(getComputedStyle($("toastPanel")).zIndex) < Number(getComputedStyle($("settingsOverlay")).zIndex) && !$("toastPanel").contains(top);
          closeSettings();
        });
        lc(() => belowDialog, "Messages: they sit below dialogs");
        const layoutAt = async (width, height, measure) => {
          const frame = document.createElement("iframe");
          frame.style.cssText = "position:fixed;left:-20000px;top:0;border:0;width:" + width + "px;height:" + height + "px";
          const loaded = new Promise(resolve => { frame.onload = resolve; });
          frame.srcdoc = '<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
            document.querySelector("style").textContent + '</style><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body>' +
            document.querySelector("header").outerHTML + document.querySelector("main").outerHTML + $("toastPanel").outerHTML + '</body></html>';
          document.body.append(frame);
          await loaded;
          try { return measure(frame.contentDocument); } finally { frame.remove(); }
        };
        const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        let desktopClear = false, phoneClear = false;
        await act(async () => {
          clearToasts();
          toast("ok", "Started a new listing. The previous one is in Drafts \u203a Recent drafts.", {action: {label: "Undo", run() {}}});
          toast("err", NO_AI, {title: "Couldn't write the listing", action: {label: "Set up AI", run() {}, fix: true}});
          toast("note", "Condition updated in the listing. Check the description doesn't mention the old condition.");
          desktopClear = await layoutAt(1366, 768, doc => {
            const bar = doc.querySelector(".gen-bar").getBoundingClientRect(), button = doc.getElementById("generateBtn").getBoundingClientRect();
            const items = [...doc.querySelectorAll("#toastPanel .toast-item")].map(item => item.getBoundingClientRect());
            return items.length === 3 && items.every(box => !overlaps(box, bar) && !overlaps(box, button) && box.right <= 1366 && box.bottom <= 768 && box.top >= 0);
          });
          phoneClear = await layoutAt(390, 844, doc => {
            // The bar grows when it suggests a template; the messages must still clear it.
            doc.getElementById("templateSuggest").hidden = false;
            doc.getElementById("templateSuggestText").textContent = "A template matches this item: Canon AE-1 Program 35mm film camera body. Use it to skip the AI request.";
            const bar = doc.querySelector(".gen-bar");
            doc.documentElement.style.setProperty("--gen-bar-h", bar.offsetHeight + 8 + "px"); // what the app keeps it at
            const barBox = bar.getBoundingClientRect(), button = doc.getElementById("generateBtn").getBoundingClientRect();
            const items = [...doc.querySelectorAll("#toastPanel .toast-item")].map(item => item.getBoundingClientRect());
            return barBox.height > 100 && items.length === 3 && items.every(box => box.height > 40 && box.bottom <= barBox.top && !overlaps(box, button) && box.left >= 0 && box.right <= 390) &&
              doc.documentElement.scrollWidth <= 390;
          });
        });
        lc(() => desktopClear && phoneClear && getComputedStyle(document.documentElement).getPropertyValue("--gen-bar-h").trim() === document.querySelector(".gen-bar").offsetHeight + 8 + "px",
          "Messages: they never cover the Generate button or its bar, at 1366×768 or at 390×844 (all three shown, above the bar)");
        clearToasts();

        /* -- plain words and fix buttons (nothing set up, so status checks agree with the failures) -- */
        await act(() => { aiStatus = noneSetUp; applyAiStatus(noneSetUp); });
        const failures = {};
        for (const [kind, status] of [["no_provider", 503], ["provider_auth", 502], ["provider_storage", 503], ["provider_busy", 429]]) {
          await act(async () => {
            newListing(); typeInto($("notes"), "Fix fixture " + kind);
            const run = generate(); const request = await nextRequest();
            failWith(request, status, {kind, error: ListingCore.ERROR_MESSAGES[kind].text});
            await run;
            const item = liveOf("err").at(-1);
            failures[kind] = {action: (actionOf(item) || {}).textContent || "", primary: Boolean(actionOf(item) && actionOf(item).classList.contains("btn-primary")),
              title: titleOf(item), text: textOf(item)};
          });
        }
        lc(() => ["no_provider", "provider_auth", "provider_storage"].every(kind => failures[kind].action === "Set up AI" && failures[kind].primary) &&
          failures.provider_busy.action === "" && failures.no_provider.title === "Couldn't write the listing" && failures.no_provider.text === NO_AI,
          "Messages: an AI problem with a fix offers Set up AI (no service, key turned down, keys unreadable); a busy service doesn't");
        let aiOpened = false;
        await act(async () => {
          newListing(); typeInto($("notes"), "Set up AI fixture");
          const run = generate(); const request = await nextRequest();
          failWith(request, 503, {kind: "no_provider", error: NO_AI}); await run;
          actionOf(liveOf("err").at(-1)).click();
          await settleUi();
          aiOpened = $("settingsOverlay").classList.contains("open") && $("settingsTab-ai").getAttribute("aria-selected") === "true" && document.activeElement === keyPaste.input;
          closeSettings();
        });
        lc(() => aiOpened, "Set up AI opens Settings › AI with the paste box ready");
        let generateNote = "", generateFix = "", backToNoteFix = false;
        await act(async () => {
          generateNote = $("generateNote").hidden ? "" : $("generateNote").querySelector(".step-note-text").textContent;
          const fix = $("generateNote").querySelector(".step-note-fix");
          generateFix = fix.hidden ? "" : fix.textContent;
          fix.focus(); fix.click(); await settleUi();
          document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
          backToNoteFix = !$("settingsOverlay").classList.contains("open") && document.activeElement === fix;
        });
        lc(() => generateNote === "Couldn't write the listing: no AI service is connected yet." && generateFix === "Set up AI" && $("outputCard").contains($("generateNote")),
          "Step notes: a failed listing keeps a note under Review and copy, with Set up AI");
        lc(() => backToNoteFix, "Esc closes Settings and focus goes back to the button that opened it");
        await act(() => applyAiStatus(twoSetUp));
        lc(() => $("generateNote").hidden, "Step notes: the note goes as soon as an AI service is connected");
        let busyNote = false, clearedBySuccess = false, droppedOnNew = false, keptOnNew = false;
        await act(async () => {
          const busy = {kind: "provider_busy", error: "The AI services are busy right now. Your draft is safe. Try again in 30 seconds."};
          newListing(); typeInto($("notes"), "Busy note fixture");
          let run = generate(), request = await nextRequest();
          failWith(request, 429, busy); await run;
          busyNote = !$("generateNote").hidden && $("generateNote").querySelector(".step-note-text").textContent === "Couldn't write the listing. The AI services are busy right now. Try again in a moment." &&
            $("generateNote").querySelector(".step-note-fix").hidden;
          run = generate(); request = await nextRequest(); complete(request, listing("Busy note fixture title")); await run;
          clearedBySuccess = $("generateNote").hidden;
          run = generate(); request = await nextRequest(); failWith(request, 429, busy); await run;
          newListing();
          droppedOnNew = $("generateNote").hidden;
          typeInto($("notes"), "Setup note fixture");
          run = generate(); request = await nextRequest(); failWith(request, 503, {kind: "no_provider", error: NO_AI}); await run;
          const setupNote = !$("generateNote").hidden;
          newListing();
          keptOnNew = setupNote && $("generateNote").hidden;
          applyAiStatus(twoSetUp);
        });
        lc(() => busyNote && clearedBySuccess, "Step notes: a note without a fix says what its message said, and stays until the next listing is written");
        lc(() => droppedOnNew && keptOnNew, "Step notes: New listing clears them all, a note about a missing setup too");
        let lookupToasts = -1, lookupProblems = -1, lookupText = "", lookupAction = "", lookupNoLine = false, ebayOpened = false, authNote = "", noteGoneAfterKeys = false;
        await act(async () => {
          clearToasts(); newListing(); typeInto($("productSearch"), "Canon AE-1");
          const run = lookupProduct(); const requests = [await nextRequest(), await nextRequest()];
          for (const request of requests) request.resolve(reply({error: NO_EBAY, kind: "ebay_not_configured", fallback: true}));
          await run; await settleUi();
          lookupToasts = liveOf("note").length; lookupProblems = liveOf("err").length;
          const item = liveOf("note").at(-1);
          lookupText = textOf(item); lookupAction = (actionOf(item) || {}).textContent || "";
          lookupNoLine = $("lookupNote").hidden;
          actionOf(item).click(); await settleUi();
          ebayOpened = $("settingsOverlay").classList.contains("open") && $("settingsTab-ebay").getAttribute("aria-selected") === "true" && document.activeElement === $("ebayClientId");
          closeSettings();
          // eBay turning saved keys down is a Problem, and its line goes once eBay keys are saved.
          const AUTH = "eBay didn't accept your eBay keys. Check the Client ID and Client Secret in Settings \u203a eBay.";
          const again = lookupProduct(); const more = [await nextRequest(), await nextRequest()];
          for (const request of more) failWith(request, 502, {error: AUTH, kind: "ebay_auth", fallback: true});
          await again; await settleUi();
          authNote = $("lookupNote").hidden ? "" : $("lookupNote").querySelector(".step-note-text").textContent + "|" + $("lookupNote").querySelector(".step-note-fix").textContent;
          await openSettings("ebay");
          $("ebayClientId").value = "fixture-client-id";
          const save = saveEbayCreds(); const saveRequest = await nextRequest();
          saveRequest.resolve(reply({saved: ["EBAY_CLIENT_ID"], message: "Saved"})); await save;
          noteGoneAfterKeys = $("lookupNote").hidden;
          closeSettings();
        });
        lc(() => lookupToasts === 1 && lookupProblems === 0 && lookupText === NO_EBAY && lookupAction === "Open Settings",
          "Look up without eBay keys is a Notice (it's optional), said once in plain words, with Open Settings");
        lc(() => lookupNoLine, "Look up without eBay keys leaves no red line under Look up");
        lc(() => ebayOpened, "Open Settings opens the eBay tab at its first box");
        lc(() => authNote === "eBay didn't accept your eBay keys.|Open Settings" && noteGoneAfterKeys,
          "Step notes: eBay turning the keys down keeps a line with Open Settings, which goes once eBay keys are saved");
        lc(() => {
          const code = [...document.scripts].map(script => script.textContent).join("\n");
          return !/Generation failed|Lookup failed|Keyword mining unavailable|provider keys|EBAY_CLIENT_ID|OAuth exchange failed|Reference retrieval failed|Save failed: |"HTTP " \+/.test(code);
        }, "Plain words: no leftover technical messages (Generation failed, Lookup failed, provider keys…)");
        let startHere = "";
        await act(() => { newListing(); clearToasts(); generate(); startHere = textOf(live().at(-1)); });
        lc(() => startHere === "Start by describing the item." && document.activeElement === $("notes"), "Plain words: Generate with nothing to go on says Start by describing the item.");
        pending.splice(0);

        /* -- Settings: tabs -- */
        let tabsNamed = false, arrows = false, tabOpened = "";
        await act(async () => {
          await openSettings();
          const tabs = [...$("settingsTabs").querySelectorAll('[role="tab"]')];
          tabsNamed = $("settingsTabs").getAttribute("role") === "tablist" && tabs.map(tab => tab.textContent).join("|") === "AI|Your shop|eBayoptional|About" &&
            tabs.every(tab => $(tab.getAttribute("aria-controls")).getAttribute("role") === "tabpanel");
          const press = key => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true}));
          $("settingsTab-ai").focus(); press("ArrowRight");
          const a = document.activeElement === $("settingsTab-shop") && !$("settingsPane-shop").hidden && $("settingsPane-ai").hidden && $("settingsTab-shop").getAttribute("aria-selected") === "true";
          press("End"); const b = document.activeElement === $("settingsTab-about") && !$("settingsPane-about").hidden;
          press("ArrowRight"); const c = document.activeElement === $("settingsTab-ai");
          press("ArrowLeft"); const d = document.activeElement === $("settingsTab-about");
          press("Home"); const e = document.activeElement === $("settingsTab-ai") && $("settingsTab-ai").tabIndex === 0 && $("settingsTab-about").tabIndex === -1;
          arrows = a && b && c && d && e;
          closeSettings();
          await openSettings("about"); tabOpened = settingsTab + ":" + !$("settingsPane-about").hidden; closeSettings();
          await openSettings("shop"); tabOpened += "," + settingsTab; closeSettings();
        });
        lc(() => tabsNamed, "Settings has the tabs AI · Your shop · eBay (optional) · About");
        lc(() => arrows, "Settings tabs move with the arrow keys, Home and End");
        lc(() => tabOpened === "about:true,shop", "openSettings(tab) opens the tab asked for");

        /* -- Settings › AI: the paste box -- */
        const geminiKey = "AIzaSyFixtureGeminiKey0123456789a1B2";
        let aiLead = false, pasted = null, checking = "", boxEmpty = false, connected = "", neverShown = false, pillReady = false;
        await act(async () => {
          aiStatus = noneSetUp; applyAiStatus(noneSetUp);
          await openSettings("ai");
          aiLead = $("settingsPane-ai").querySelector(".settings-lead").textContent === "Paste a key from any supported service; Marteloio recognises it, saves it and tests it." &&
            $("settingsPane-ai").contains(keyPaste.input) && !document.querySelector("#groqRemove, #geminiRemove, #openrouterRemove") &&
            !/plain text|Remove saved/i.test($("settingsOverlay").textContent);
          const data = new DataTransfer(); data.setData("text/plain", "  " + geminiKey + "\n");
          const event = new ClipboardEvent("paste", {clipboardData: data, bubbles: true, cancelable: true});
          keyPaste.input.dispatchEvent(event);
          const request = await nextRequest();
          pasted = {path: request.path, body: JSON.parse(request.opts.body), prevented: event.defaultPrevented};
          checking = keyPaste.result.textContent;
          boxEmpty = keyPaste.input.value === "";
          const ready = {ready: true, retry_in: 0, providers: [provider("freellmapi", "FreeLLMAPI"), provider("gemini", "Google Gemini", {configured: true, state: "ready", key_hint: "a1B2"}),
            provider("groq", "Groq"), provider("openrouter", "OpenRouter")]};
          aiStatus = ready;
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini", test: {ok: true, ms: 1180, model: "gemini-flash-latest"}, status: ready}));
          await until(() => keyPaste.result.classList.contains("is-ok"));
          connected = keyPaste.result.textContent;
          neverShown = ![...document.querySelectorAll("input")].some(input => input.value.includes("FixtureGeminiKey")) && !document.body.innerHTML.includes("FixtureGeminiKey");
          pillReady = $("statusText").textContent === "AI ready";
        });
        lc(() => aiLead, "Settings › AI leads with one paste box; the old remove-when-saving boxes and plain-text note are gone");
        lc(() => pasted.path === "/settings/ai" && pasted.body.provider === "auto" && pasted.body.key === geminiKey && pasted.prevented &&
          checking === "Checking your Google Gemini key\u2026" && boxEmpty, "Pasting a key saves and tests it at once (provider auto), saying Checking your Google Gemini key…");
        lc(() => connected === "Google Gemini is connected \u00b7 it answered in 1.2 seconds" && neverShown,
          "The paste box then says Google Gemini is connected · it answered in 1.2 seconds, and never shows the key");
        lc(() => pillReady, "The status pill refreshes after a key is saved");
        const recognised = [];
        for (const [text, label, what] of [["gsk_fixtureGroqKey0123456789", "Groq", "key"], ["sk-or-v1-fixture0123456789", "OpenRouter", "key"],
          ["freellmapi-0a1b2c3d0a1b2c3d", "FreeLLMAPI", "key"], ["sk-cp-fixtureProfileKey0123", "FreeLLMAPI", "key"],
          ["http://127.0.0.1:31415/v1/t/flmurl_fixtureToken0123", "FreeLLMAPI", "address"]]) {
          await act(async () => {
            const save = keyPaste.save(text); const request = await nextRequest();
            recognised.push(keyPaste.result.textContent === "Checking your " + label + " " + what + "\u2026" && JSON.parse(request.opts.body).provider === "auto");
            request.resolve(reply({saved: true, provider: "x", label, test: null, status: aiStatus})); await save;
          });
        }
        lc(() => recognised.length === 5 && recognised.every(Boolean), "The paste box recognises Groq, OpenRouter and FreeLLMAPI keys and a FreeLLMAPI address by how they start");
        let failedTest = "";
        await act(async () => {
          const save = keyPaste.save(geminiKey.replace("0123", "9999")); const request = await nextRequest();
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini", status: aiStatus,
            test: {ok: false, kind: "key_rejected", message: "Google Gemini didn't accept this key. Copy the whole key and paste it again."}}));
          await save;
          failedTest = keyPaste.result.classList.contains("is-err") ? keyPaste.result.textContent : "";
        });
        lc(() => failedTest === "Google Gemini didn't accept this key. Copy the whole key and paste it again.", "A failed test shows the service's own plain reason");
        let refused = "";
        await act(async () => {
          keyPaste.input.value = "hello-this-is-not-a-key";
          keyPaste.input.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
          const request = await nextRequest();
          failWith(request, 400, {kind: "unknown_key", error: ListingCore.ERROR_MESSAGES.unknown_key.text});
          await until(() => keyPaste.result.classList.contains("is-err"));
          refused = keyPaste.result.textContent + "|" + keyPaste.input.value;
        });
        lc(() => refused === ListingCore.ERROR_MESSAGES.unknown_key.text + "|hello-this-is-not-a-key", "Text that isn't a key is refused in plain words and stays in the box to fix");
        let fromClipboard = false, askedForPaste = "";
        await act(async () => {
          keyPaste.input.value = "";
          const clipboard = navigator.clipboard, hadOwn = Object.prototype.hasOwnProperty.call(clipboard, "readText"), realRead = clipboard.readText;
          try {
            clipboard.readText = async () => "gsk_fixtureClipboardKey0123";
            keyPaste.button.click();
            const request = await nextRequest();
            fromClipboard = JSON.parse(request.opts.body).key === "gsk_fixtureClipboardKey0123";
            request.resolve(reply({saved: true, provider: "groq", label: "Groq", test: {ok: true, ms: 800}, status: aiStatus}));
            await until(() => !keyPaste.button.disabled);
            clipboard.readText = async () => { throw new DOMException("Fixture refused", "NotAllowedError"); };
            $("settingsTab-ai").focus();
            keyPaste.button.click();
            await until(() => /to paste/.test(keyPaste.result.textContent));
            askedForPaste = (document.activeElement === keyPaste.input) + "|" + keyPaste.result.textContent;
          } finally { if (hadOwn) clipboard.readText = realRead; else delete clipboard.readText; }
        });
        lc(() => fromClipboard && /^true\|Press (Ctrl\+V|\u2318V) to paste\.$/.test(askedForPaste), "Add key reads the clipboard, or puts focus in the box and says Press Ctrl+V to paste");
        let mounted = null;
        await act(async () => {
          const host = document.createElement("div"); document.body.append(host);
          let outcome = null;
          const box = mountKeyPaste(host, {button: "Paste", primary: true, hint: "Works with keys from Google Gemini, Groq, OpenRouter and FreeLLMAPI.", onResult: result => { outcome = result; }});
          const save = box.save("AIzaSyFixtureWelcomeKey0123456789ab"); const request = await nextRequest();
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini", test: {ok: true, ms: 1200}, status: aiStatus})); await save;
          mounted = {button: box.button.classList.contains("btn-primary") && box.button.textContent === "Paste", hint: (host.querySelector(".key-paste-hint") || {}).textContent, outcome};
          host.remove();
        });
        lc(() => typeof startAiSetup === "function" && mounted.button && mounted.hint === "Works with keys from Google Gemini, Groq, OpenRouter and FreeLLMAPI." &&
          mounted.outcome.ok && mounted.outcome.saved && mounted.outcome.provider === "gemini" && mounted.outcome.text === "Google Gemini is connected",
          "mountKeyPaste(container, options) makes another working paste box (for the welcome guide)");

        /* -- Settings › AI: one line per service -- */
        await act(() => { aiStatus = twoSetUp; applyAiStatus(twoSetUp); });
        lc(() => $("aiSummary").textContent === "2 of 4 set up \u00b7 tried in this order: FreeLLMAPI, Google Gemini",
          "The summary says 2 of 4 set up · tried in this order: FreeLLMAPI, Google Gemini");
        lc(() => {
          const rows = [...$("aiRows").children];
          return rows.length === 3 && rows[0].dataset.provider === "freellmapi" && rows[1].dataset.provider === "gemini" &&
            rows[1].querySelector(".ai-tag").textContent === "Easiest free key" && rows[2].querySelector(".ai-name").textContent === "Other AI services" &&
            $("aiOthers").hidden && [...$("aiOthers").children].map(row => row.dataset.provider).join() === "groq,openrouter";
        }, "One line per service in try order: FreeLLMAPI, Google Gemini (Easiest free key), then Groq and OpenRouter folded under Other AI services");
        lc(() => aiRowOf("gemini").querySelector(".ai-hint").textContent === "Key \u2026a1B2" && !aiRowOf("gemini").querySelector(".ai-use").hidden &&
          aiRowOf("gemini").querySelector('.ai-use[role="switch"]').getAttribute("aria-checked") === "true" && aiRowOf("groq").querySelector(".ai-use").hidden,
          "A service that is set up shows Key …a1B2 and a Use switch; one that isn't has no switch");
        let chips = "";
        await act(() => {
          applyAiStatus({ready: true, retry_in: 0, providers: [{...twoSetUp.providers[0], state: "rate_limited", retry_in: 40}, {...twoSetUp.providers[1], state: "key_rejected"},
            provider("groq", "Groq", {configured: true, enabled: false, state: "disabled", key_hint: "WXYZ"}), provider("openrouter", "OpenRouter")]});
          chips = AI_ORDER.map(id => aiRowOf(id).querySelector(".ai-chip").textContent).join("|");
          applyAiStatus(twoSetUp);
          chips += "|" + aiRowOf("gemini").querySelector(".ai-chip").textContent;
        });
        lc(() => chips === "Resting 40 s|Key rejected|Off|Not set up|Ready", "Status chips read Ready, Not set up, Resting 40 s, Key rejected and Off");
        await act(() => aiRowOf("gemini").querySelector(".ai-row-toggle").click());
        lc(() => {
          const row = aiRowOf("gemini"), link = row.querySelector(".ai-note a");
          return row.querySelector(".ai-row-toggle").getAttribute("aria-expanded") === "true" && !$("aiBody-gemini").hidden &&
            row.querySelector(".ai-note").textContent.startsWith("Google's free AI. The easiest key to get: sign in with a Google account and create one in about 2 minutes.") &&
            link.textContent === "Get a free key" && link.href === "https://aistudio.google.com/app/apikey" && link.target === "_blank" && /\bnoopener\b/.test(link.rel) &&
            row.querySelector("label[for='aiKey-gemini']") && !row.querySelector(".ai-save").hidden && !row.querySelector(".ai-test").hidden && !row.querySelector(".ai-remove").hidden;
        }, "Opening a line shows its note, Get a free key (in a new tab), its key box, Save and test, Test again and Remove");
        lc(() => {
          const href = id => aiRowOf(id).querySelector(".ai-note a").href, note = id => aiRowOf(id).querySelector(".ai-note").textContent;
          return href("groq") === "https://console.groq.com/keys" && href("openrouter") === "https://openrouter.ai/keys" && href("freellmapi") === "https://github.com/tashfeenahmed/freellmapi" &&
            note("groq").startsWith("Used as a backup when the others are busy.") && note("openrouter").startsWith("Used as a backup when the others are busy.") &&
            note("freellmapi").startsWith("A free app you run on this computer. It spreads requests over many free AI services and moves on when one is busy, so it's tried first.");
        }, "Each service has its own note and free-key link");
        let useBody = null, useOff = false;
        await act(async () => {
          aiRowOf("gemini").querySelector(".ai-use").click();
          const request = await nextRequest();
          useBody = JSON.parse(request.opts.body);
          const off = {...twoSetUp, providers: twoSetUp.providers.map(p => p.id === "gemini" ? {...p, enabled: false, state: "disabled"} : p)};
          aiStatus = off;
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini", test: null, status: off}));
          await until(() => aiRowOf("gemini").querySelector(".ai-chip").textContent === "Off");
          useOff = aiRowOf("gemini").querySelector(".ai-use").getAttribute("aria-checked") === "false" && $("aiSummary").textContent === "2 of 4 set up \u00b7 tried in this order: FreeLLMAPI";
        });
        lc(() => useBody.provider === "gemini" && useBody.enabled === false && Object.keys(useBody).length === 2 && useOff, "The Use switch posts enabled, and the line then reads Off");
        let tested = null, testedText = "";
        await act(async () => {
          aiRowOf("gemini").querySelector(".ai-test").click();
          const request = await nextRequest();
          tested = {path: request.path, body: JSON.parse(request.opts.body)};
          request.resolve(reply({ok: true, ms: 812, model: "gemini-flash-latest"}));
          await until(() => aiRowOf("gemini").querySelector(".key-result").classList.contains("is-ok"));
          testedText = aiRowOf("gemini").querySelector(".key-result").textContent;
        });
        lc(() => tested.path === "/ai/test" && tested.body.provider === "gemini" && testedText === "Working \u00b7 it answered in 0.8 seconds",
          "Test again tests that one service and says how fast it answered");
        let firstClickQuiet = false, removeBody = null, removedText = "";
        await act(async () => {
          confirms = 0;
          const before = pending.length, remove = aiRowOf("gemini").querySelector(".ai-remove");
          remove.click(); await settleUi();
          firstClickQuiet = pending.length === before && remove.textContent === "Remove now" && confirms === 0;
          remove.click();
          const request = await nextRequest();
          removeBody = JSON.parse(request.opts.body);
          const gone = {...twoSetUp, providers: twoSetUp.providers.map(p => p.id === "gemini" ? {...p, configured: false, state: "off", key_hint: ""} : p)};
          aiStatus = gone;
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini", test: null, status: gone}));
          await until(() => aiRowOf("gemini").querySelector(".key-result").classList.contains("is-ok"));
          removedText = aiRowOf("gemini").querySelector(".key-result").textContent + "|" + aiRowOf("gemini").querySelector(".ai-chip").textContent;
        });
        lc(() => firstClickQuiet && removeBody.provider === "gemini" && removeBody.remove === true && confirms === 0 && removedText === "Google Gemini is removed from this computer.|Not set up",
          "Remove asks again on its own button (no pop-up), then removes the key");
        let findPath = "", found = "", addressFilled = false, aloneText = "", withKey = null;
        await act(async () => {
          const row = aiRowOf("freellmapi"), address = $("aiAddress-freellmapi");
          setAiRowOpen(row, true);
          const before = address.value;
          holdDetect = true;
          row.querySelector(".ai-find").click();
          const request = await nextRequest();
          findPath = request.path;
          request.resolve(reply({found: true, ready: true, base_url: "http://127.0.0.1:3001/v1", reason: ""}));
          await until(() => row.querySelector(".key-result").classList.contains("is-ok"));
          found = row.querySelector(".key-result").textContent;
          addressFilled = before === "http://127.0.0.1:31415/v1" && address.value === "http://127.0.0.1:3001/v1";
          // A found address alone isn't sent (it could replace a saved address that carries its own access code)…
          const waiting = pending.length;
          row.querySelector(".ai-save").click(); await settleUi();
          aloneText = pending.length === waiting ? row.querySelector(".key-result").textContent : "sent";
          // …but it goes along with a new FreeLLMAPI key.
          row.querySelector(".ai-key").value = "freellmapi-0a1b2c3d0a1b2c3d";
          row.querySelector(".ai-save").click();
          const save = await nextRequest();
          withKey = JSON.parse(save.opts.body);
          save.resolve(reply({saved: true, provider: "freellmapi", label: "FreeLLMAPI", test: {ok: true, ms: 3100}, status: aiStatus}));
          await until(() => !row.querySelector(".ai-save").disabled);
        });
        lc(() => findPath === "/ai/freellmapi/detect" && found === "FreeLLMAPI is running \u00b7 at http://127.0.0.1:3001/v1" && addressFilled,
          "FreeLLMAPI's line has its address and Find it again, which looks for it on this computer");
        lc(() => aloneText === "Paste a key first." && withKey.provider === "freellmapi" && withKey.key === "freellmapi-0a1b2c3d0a1b2c3d" && withKey.base_url === "http://127.0.0.1:3001/v1",
          "A FreeLLMAPI address found by Find it again is only sent together with a new FreeLLMAPI key");
        let foundCard = "", cardToBox = false, emptyCard = "";
        await act(async () => {
          closeSettings();
          aiStatus = noneSetUp; applyAiStatus(noneSetUp);
          detectReply = {found: true, ready: true, base_url: "http://127.0.0.1:31415/v1", reason: ""};
          await openSettings("ai");
          await until(() => !$("aiFound").hidden);
          foundCard = $("aiFound").hidden ? "" : $("aiFoundText").textContent;
          $("aiFoundUse").click();
          cardToBox = document.activeElement === keyPaste.input;
          closeSettings();
          detectReply = {found: true, ready: false, base_url: "http://127.0.0.1:31415/v1", reason: "no_upstreams"};
          await openSettings("ai");
          await until(() => !$("aiFound").hidden && $("aiFoundText").textContent.includes("no AI services"));
          emptyCard = $("aiFound").hidden ? "" : $("aiFoundText").textContent;
          closeSettings();
          detectReply = savedDetect;
        });
        lc(() => foundCard === "FreeLLMAPI is running on this computer. To use it, copy its key from the tray icon: Show Compact Panel \u203a Copy Key." && cardToBox,
          "FreeLLMAPI running but not set up: a card says how to copy its key, and Use FreeLLMAPI goes to the paste box");
        lc(() => emptyCard.startsWith("FreeLLMAPI is running on this computer, but it has no AI services yet."), "The card says plainly when FreeLLMAPI has no AI services yet");

        /* -- Your shop, eBay, About, Quit -- */
        lc(() => ["storeName", "ebUsername", "logoUrl", "fbScore", "fbPct", "memberYear", "fbPctError", "memberYearError"].every(id => $("settingsPane-shop").contains($(id))) &&
          !$("settingsPane-ai").contains($("storeName")), "Your shop holds the seller details, with their hints");
        let ebayInline = false;
        await act(async () => {
          clearToasts();
          await openSettings("ebay");
          $("ebayClientId").value = ""; $("ebayClientSecret").value = "";
          await saveEbayCreds();
          ebayInline = $("ebayStatus").textContent === "Enter a Client ID or Client Secret first." && $("ebayStatus").classList.contains("is-err") && !live().length;
          closeSettings();
        });
        lc(() => $("settingsPane-ebay").querySelector(".settings-lead").textContent === "Optional. Only needed for Look up, Find keywords and your feedback numbers." &&
          ["ebayClientId", "ebayClientSecret", "saveEbayCredsBtn", "ruName", "connectBtn", "authCode", "exchangeBtn", "fetchStatsBtn"].every(id => $("settingsPane-ebay").contains($(id))) && ebayInline,
          "eBay (optional) says what it's for, keeps the keys and Connect eBay, and reports inside the dialog");
        let about = "";
        await act(async () => {
          fixtureAppInfo = {...savedInfo, build: "a1b2c3d4e5f6", data_dir: "C:\\Users\\Fixture\\AppData\\Local\\Marteloio"};
          await openSettings("about");
          await until(() => $("aboutBuild").textContent === "a1b2c3d4e5f6");
          about = [$("aboutVersion").textContent, $("aboutBuild").textContent, $("aboutDataDir").textContent].join("|");
          closeSettings();
        });
        lc(() => about === "0.2.0|a1b2c3d4e5f6|C:\\Users\\Fixture\\AppData\\Local\\Marteloio", "About shows the version, build and data folder");
        lc(() => {
          const links = [...$("settingsPane-about").querySelectorAll("a")], named = text => links.find(link => link.textContent === text);
          return named("User guide").href === "https://github.com/browser-b0X/marteloio/blob/main/docs/GUIDE.md" && named("Report a problem").href === $("feedbackLink").href &&
            named("License").href === "https://github.com/browser-b0X/marteloio/blob/main/LICENSE" && links.every(link => link.target === "_blank" && /\bnoopener\b/.test(link.rel));
        }, "About links to the user guide, Report a problem and the License");
        const quitWith = async installed => {
          const build = installed ? "111111111111" : "222222222222";
          fixtureAppInfo = {...savedInfo, installed, build};
          await openSettings("about");
          await until(() => $("aboutBuild").textContent === build);
          $("quitBtn").click();
          const request = await takeRequest("/shutdown");
          const body = request && request.opts.body;
          request.resolve(reply({ok: true}));
          await until(() => document.body.classList.contains("app-stopped"));
          const page = $("stoppedPage"), card = page && page.querySelector(".stopped-card").getBoundingClientRect();
          const result = {body, text: page ? page.textContent : "", heading: page && document.activeElement === page.querySelector("h1"), title: document.title,
            centred: Boolean(card) && Math.abs(card.left + card.width / 2 - document.documentElement.clientWidth / 2) < 3};
          // Back to the app for the remaining checks.
          if (page) page.remove();
          document.body.classList.remove("app-stopped");
          appStopped = false;
          healthTimer = setInterval(checkHealth, 30000);
          document.title = "Marteloio \u2014 Details, drafted.";
          return result;
        };
        let installedQuit = null, zipQuit = null;
        await act(async () => { installedQuit = await quitWith(true); });
        await act(async () => { zipQuit = await quitWith(false); });
        lc(() => installedQuit.body === "{}" && installedQuit.heading && installedQuit.centred && installedQuit.title === "Marteloio has stopped" &&
          installedQuit.text === "Marteloio has stopped.You can close this tab.To use it again, open Marteloio from the Start menu or the desktop.",
          "Quit Marteloio stops it and leaves a calm page: you can close this tab, open it again from the Start menu");
        lc(() => zipQuit.text.endsWith("To use it again, open the Marteloio folder and run start-all again."), "A copy that wasn't installed says to run start-all again");

        /* -- phone sheet, light and dark -- */
        let sheet = false;
        await act(async () => {
          await openSettings("ai");
          const frame = document.createElement("iframe");
          frame.style.cssText = "position:fixed;left:-20000px;top:0;border:0;width:390px;height:844px";
          const loaded = new Promise(resolve => { frame.onload = resolve; });
          frame.srcdoc = '<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + document.querySelector("style").textContent +
            '</style><style>*,*::before,*::after{animation:none!important}</style></head><body>' + $("settingsOverlay").outerHTML + '</body></html>';
          document.body.append(frame); await loaded;
          const doc = frame.contentDocument, modal = doc.querySelector(".settings-modal").getBoundingClientRect(), body = doc.querySelector(".settings-body");
          sheet = Math.round(modal.width) === 390 && Math.round(modal.height) === 844 && modal.left === 0 && modal.top === 0 &&
            doc.documentElement.scrollWidth <= 390 && body.scrollWidth <= body.clientWidth;
          frame.remove();
          closeSettings();
        });
        lc(() => sheet, "At 390px Settings is a full-screen sheet with nothing wider than the screen");
        const themes = {};
        for (const theme of ["light", "dark"]) {
          await act(async () => {
            $("appTheme").value = theme; $("appTheme").dispatchEvent(new Event("change"));
            clearToasts();
            const problem = toast("err", "Fixture contrast problem.", {action: {label: "Set up AI", run() {}, fix: true}});
            const done = toast("ok", "Fixture contrast done.", {action: {label: "Undo", run() {}}});
            await openSettings("ai");
            applyAiStatus(twoSetUp);
            setSettingsLine(keyPaste.result, "ok", "Google Gemini is connected", " \u00b7 it answered in 1.2 seconds");
            const fg = el => getComputedStyle(el).color, bg = el => getComputedStyle(el).backgroundColor;
            const pairs = [[problem.querySelector("p"), problem.querySelector(".toast")], [problem.querySelector(".toast-title"), problem.querySelector(".toast")],
              [actionOf(problem), actionOf(problem)], [done.querySelector("p"), done.querySelector(".toast")], [actionOf(done), actionOf(done)],
              [aiRowOf("gemini").querySelector(".ai-chip"), aiRowOf("gemini").querySelector(".ai-chip")], [keyPaste.result, keyPaste.result],
              [$("settingsTab-ai"), document.querySelector(".settings-modal")], [aiRowOf("gemini").querySelector(".ai-hint"), aiRowOf("gemini")],
              [$("settingsKeysNote"), document.querySelector(".settings-foot")], [aiRowOf("gemini").querySelector(".ai-tag"), aiRowOf("gemini").querySelector(".ai-tag")]];
            themes[theme] = pairs.every(([a, b]) => contrastOf(fg(a), bg(b)) >= 4.5);
            closeSettings(); clearToasts();
          });
        }
        lc(() => themes.light && themes.dark, "Messages and Settings stay readable in light and dark");
      } finally {
        try { Object.assign(TOAST_TIMES, defaultTimes || {}); } catch (_) { /* older code */ }
        window.confirm = fixtureConfirm;
        aiStatus = savedStatus; detectReply = savedDetect; fixtureAppInfo = savedInfo; holdDetect = false;
        try { closeSettings(); } catch (_) { /* older code */ }
        try { applyAiStatus(savedStatus); } catch (_) { /* older code */ }
        $("appTheme").value = savedTheme; $("appTheme").dispatchEvent(new Event("change"));
        pending.splice(0);
        clearToasts();
        newListing();
        if (soft) {
          const note = document.createElement("p");
          note.id = "wave2-soft-failures";
          note.dataset.count = String(softFailures.length);
          note.textContent = "WAVE 2 SOFT FAILURES (" + softFailures.length + "): " + softFailures.join(" | ");
          panel.append(note);
        }
      }
    }
    /* ---- v0.2.0 wave 3: the guided first run ----
       Welcome setup, the six-stop tour, Get set up, field tips and button tips, Start here, the AI
       button and Help. Runs at the end of the suite, or alone with ?wave3. With ?soft it records
       failures instead of stopping, so it can be run against the code before this wave (each check
       must fail there). A fresh first run is a real page load: a copy of the app in a frame
       (?app-only, see the top of this file), so this page's own storage is never touched by it. */
    async function wave3Checks() {
      const soft = new URLSearchParams(location.search).has("soft");
      const softFailures = [];
      const lc = (fn, label) => {
        let ok = false;
        try { ok = Boolean(fn()); } catch (_) { ok = false; }
        if (ok || !soft) check(ok, label); else softFailures.push(label);
      };
      const act = async fn => { try { await fn(); } catch (_) { /* the outcome is checked next */ } };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async (fn, ms = 2500) => {
        const end = performance.now() + ms;
        for (;;) {
          let ok = false;
          try { ok = Boolean(fn()); } catch (_) { ok = false; }
          if (ok) return true;
          if (performance.now() > end) return false;
          await wait(10);
        }
      };
      const settleUi = async () => { for (let i = 0; i < 8; i++) await tick(); };
      const frame2 = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const typeInto = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", {bubbles: true})); };
      const press = (key, extra = {}, target = document.activeElement) => {
        const event = new KeyboardEvent("keydown", {key, bubbles: true, cancelable: true, ...extra});
        (target || document.body).dispatchEvent(event);
        return event;
      };
      const hover = el => el.dispatchEvent(new PointerEvent("pointerover", {bubbles: true, pointerType: "mouse"}));
      const leave = el => el.dispatchEvent(new PointerEvent("pointerout", {bubbles: true, pointerType: "mouse", relatedTarget: document.body}));
      const words = el => (el && el.textContent || "").replace(/\s+/g, " ").trim();
      const shown = el => Boolean(el) && !el.closest("[hidden]") && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
      const live = () => [...document.querySelectorAll("#toastPanel .toast-item:not(.leaving)")];
      const liveOf = kind => live().filter(item => item.querySelector(".toast." + kind));
      const textOf = item => (item && item.querySelector(".toast p") || {}).textContent || "";
      const clearToasts = () => {
        try { if (busyToast) dismissToast(busyToast); } catch (_) { /* older code */ }
        for (const item of [...document.querySelectorAll("#toastPanel .toast-item")]) {
          try { dismissToast(item); } catch (_) { /* older code */ }
          item.remove();
        }
      };
      const rectOf = el => el.getBoundingClientRect();
      // The part of a target inside the window (the spotlight stays 4 px inside it).
      const clip = r => ({left: Math.max(4, r.left), top: Math.max(4, r.top), right: Math.min(document.documentElement.clientWidth - 4, r.right), bottom: Math.min(innerHeight - 4, r.bottom)});
      const inside = (inner, outer, slack = 3) => inner.left >= outer.left - slack && inner.top >= outer.top - slack && inner.right <= outer.right + slack && inner.bottom <= outer.bottom + slack;
      const overlaps = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const inView = (r, width = innerWidth, height = innerHeight) => r.left >= 0 && r.top >= 0 && r.right <= width && r.bottom <= height && r.width > 0;
      const provider = (id, label, extra = {}) => ({id, label, configured: false, enabled: true, state: "off", retry_in: 0, key_hint: "", checked: "", ...extra});
      const noneSetUp = {ready: false, retry_in: 0, providers: [provider("freellmapi", "FreeLLMAPI"), provider("gemini", "Google Gemini"), provider("groq", "Groq"), provider("openrouter", "OpenRouter")]};
      const geminiReady = {ready: true, retry_in: 0, providers: [provider("freellmapi", "FreeLLMAPI"), provider("gemini", "Google Gemini", {configured: true, state: "ready", key_hint: "a1B2", checked: "ok"}),
        provider("groq", "Groq"), provider("openrouter", "OpenRouter")]};
      const resting = {ready: false, retry_in: 40, providers: [provider("freellmapi", "FreeLLMAPI"), provider("gemini", "Google Gemini", {configured: true, state: "rate_limited", retry_in: 40, key_hint: "a1B2"}),
        provider("groq", "Groq"), provider("openrouter", "OpenRouter")]};
      const GUIDE_RECORD = "marteloio.guide.v1";
      const record = () => { try { return JSON.parse(localStorage.getItem(GUIDE_RECORD) || "null") || {}; } catch (_) { return {}; } };
      // A fresh first run ({}), or any other record; the app reads it again at once.
      const setRecord = value => { localStorage.setItem(GUIDE_RECORD, JSON.stringify(value)); try { loadGuide(); renderGuide(); } catch (_) { /* older code */ } };
      const setStatus = status => { aiStatus = status; try { applyAiStatus(status); } catch (_) { /* older code */ } };
      const tips = () => ListingCore.GUIDE_TIPS;
      const savedStatus = aiStatus, savedDetect = detectReply, savedSettings = settingsReply, savedTheme = document.documentElement.dataset.theme;
      const savedSeller = Object.fromEntries(["storeName", "memberYear", "fbPct"].map(id => [id, $(id).value]));
      const savedPrefs = Object.fromEntries([["eb.store", null], ["eb.memberYear", null], ["eb.fbPct", null]].map(([key]) => [key, localStorage.getItem(key)]));
      let savedTimes = null;
      try { savedTimes = {...GUIDE_TIMES}; } catch (_) { /* older code */ }
      const motionDescriptor = Object.getOwnPropertyDescriptor(motionMedia, "matches");
      const setMotion = reduced => Object.defineProperty(motionMedia, "matches", {configurable: true, value: reduced});
      const clipboard = navigator.clipboard, realWrite = clipboard && clipboard.writeText;
      if (clipboard) clipboard.writeText = async () => {};
      const frames = [];
      // Spotlight and card measured where they end up, not mid-slide.
      const still = document.createElement("style");
      still.textContent = ".tour-spot, .tour-card { transition: none !important; }";
      document.head.append(still);
      pending.splice(0);
      // A copy of the app, loaded fresh in a frame (see ?app-only at the top), after its first AI status answer.
      const loadApp = async (query, width = 1366, height = 768) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;left:-20000px;top:0;border:0;width:" + width + "px;height:" + height + "px";
        const loaded = new Promise(resolve => { frame.onload = resolve; });
        frame.src = "/?app-only&" + query;
        document.body.append(frame);
        frames.push(frame);
        await loaded;
        const doc = frame.contentDocument;
        // Measured where things end up, not mid-animation.
        const settled = doc.createElement("style");
        settled.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
        doc.head.append(settled);
        await until(() => doc.getElementById("statusText").textContent !== "Checking AI…", 4000);
        await wait(80);
        return {frame, win: frame.contentWindow, doc, $: id => doc.getElementById(id), fixture: frame.contentWindow.__fixture};
      };
      const memoryRecord = app => { try { return JSON.parse(app.fixture.memory.get(GUIDE_RECORD) || "{}"); } catch (_) { return {}; } };
      try {
        await act(() => { closeSettings(); newListing(); });
        clearToasts();

        /* -- On load: the welcome for a fresh first run, the tour Notice for an upgrade -- */
        let fresh = null;
        await act(async () => {
          const app = await loadApp("ai=none");
          const active = app.doc.activeElement;
          fresh = {open: !app.$("welcomeOverlay").hidden && app.$("welcome").getAttribute("role") === "dialog" && app.$("welcome").getAttribute("aria-modal") === "true",
            step: !app.$("welcomeStep0").hidden && app.$("welcomeStep1").hidden && app.$("welcomeStep2").hidden,
            focus: Boolean(active) && active.tagName === "INPUT" && app.$("welcomePasteMount").contains(active),
            course: [...app.$("welcomeCourse").children].map(li => li.className).join(), current: app.$("welcomeCourse").children[0].getAttribute("aria-current"),
            pill: [app.$("statusText").textContent, app.$("aiStatus").tagName, app.$("aiStatus").classList.contains("is-setup")].join("|"),
            errors: app.fixture.errors.length};
        });
        lc(() => fresh.open && fresh.step && fresh.focus && fresh.course === "is-now,," && fresh.current === "step" && fresh.errors === 0,
          "First run: with no AI service connected, the welcome opens on load at Connect AI with the paste box focused");
        lc(() => fresh.pill === "Set up AI|BUTTON|true", "First run: the header AI button is a button that says Set up AI");
        let upgrade = null;
        await act(async () => {
          const app = await loadApp("drafts=2");
          const notice = [...app.doc.querySelectorAll("#toastPanel .toast-item:not(.leaving)")].find(item => item.querySelector(".toast.note"));
          upgrade = {welcome: app.$("welcomeOverlay").hidden, saved: memoryRecord(app),
            notice: notice ? notice.querySelector("p").textContent + "|" + notice.querySelector(".toast-action").textContent : "",
            emptyState: app.$("setupGuide").hidden && getComputedStyle(app.$("emptyState")).display !== "none"};
          notice.querySelector(".toast-action").click();
          await wait(60);
          upgrade.tour = !app.$("tour").hidden && app.$("tourTitle").textContent === "Start here";
        });
        lc(() => upgrade.welcome && upgrade.notice === "New: a one-minute tour of Marteloio.|Take the tour" && upgrade.saved.welcome === "skipped" && upgrade.saved.tourNotice === true,
          "An upgrade with AI already connected never sees the welcome; a Notice offers the one-minute tour, once");
        lc(() => upgrade.emptyState && upgrade.saved.checklist === "hidden", "An upgrade with Recent drafts doesn't get the Get set up guide");
        lc(() => upgrade.tour, "The Notice's Take the tour starts the tour");
        let noDrafts = null;
        await act(async () => {
          const app = await loadApp("theme=light");
          noDrafts = {welcome: app.$("welcomeOverlay").hidden, guide: !app.$("setupGuide").hidden && app.$("outputCard").classList.contains("guide-full"),
            steps: [...app.$("setupSteps").children].map(li => li.className.trim()).join()};
        });
        lc(() => noDrafts.welcome && noDrafts.guide && noDrafts.steps === "is-done,is-now,,",
          "AI connected but no Recent drafts: Get set up shows in place of the empty state, with Connect AI already ticked");
        let tourTaken = null;
        await act(async () => {
          const app = await loadApp("guide=" + encodeURIComponent(JSON.stringify({tour: "skipped"})));
          tourTaken = {notes: app.doc.querySelectorAll("#toastPanel .toast-item:not(.leaving) .toast.note").length, saved: memoryRecord(app), welcome: app.$("welcomeOverlay").hidden};
        });
        lc(() => tourTaken.notes === 0 && tourTaken.welcome && tourTaken.saved.welcome === "skipped" && tourTaken.saved.tour === "skipped" && !tourTaken.saved.tourNotice,
          "The tour Notice only shows if the tour was never taken or skipped");
        let skipped = null;
        await act(async () => {
          const app = await loadApp("ai=none&guide=" + encodeURIComponent(JSON.stringify({welcome: "skipped"})));
          skipped = {welcome: app.$("welcomeOverlay").hidden, pill: app.$("statusText").textContent};
          app.$("aiStatus").click();
          await until(() => app.$("settingsOverlay").classList.contains("open"));
          await wait(30);
          skipped.settings = app.$("settingsOverlay").classList.contains("open") && app.$("settingsTab-ai").getAttribute("aria-selected") === "true" &&
            app.doc.activeElement === app.$("aiPasteMount").querySelector("input");
        });
        lc(() => skipped.welcome && skipped.pill === "Set up AI" && skipped.settings,
          "A welcome skipped before stays closed; then Set up AI opens Settings › AI with the paste box ready");
        let blocked = null;
        await act(async () => {
          const app = await loadApp("ai=none&storage=throws");
          blocked = {open: !app.$("welcomeOverlay").hidden};
          app.$("welcomeSkip").click();
          await wait(20);
          blocked.closed = app.$("welcomeOverlay").hidden && app.win.guideInfo().welcome === "skipped";
          app.win.startAiSetup();
          await until(() => app.$("settingsOverlay").classList.contains("open"));
          blocked.routed = app.$("welcomeOverlay").hidden && app.$("settingsOverlay").classList.contains("open");
          blocked.errors = app.fixture.errors.length + app.doc.querySelectorAll("#toastPanel .toast.err").length;
        });
        lc(() => blocked.open && blocked.closed && blocked.routed && blocked.errors === 0,
          "With storage blocked the first run still works: the welcome opens, Skip setup holds for this visit, and nothing fails");
        let phone = null;
        await act(async () => {
          const app = await loadApp("ai=none", 390, 844);
          const box = app.$("welcome").getBoundingClientRect(), ways = [...app.$("welcomeCourse").children].map(li => li.getBoundingClientRect());
          phone = {sheet: Math.round(box.width) === 390 && Math.round(box.height) === 844 && box.left === 0 && box.top === 0,
            row: ways.every(r => Math.abs(r.top - ways[0].top) < 4) && ways[2].left > ways[1].left && ways[1].left > ways[0].left &&
              app.doc.defaultView.getComputedStyle(app.doc.querySelector("#welcomeCourse .way-short")).display !== "none",
            keyboardDown: app.doc.activeElement === app.$("welcomeTitle"), wide: app.doc.documentElement.scrollWidth <= 390,
            words: app.$("statusText").textContent === "Set up AI" && app.$("statusText").getBoundingClientRect().width > 40 &&
              app.doc.defaultView.getComputedStyle(app.$("statusText")).position !== "absolute"};
          app.$("welcomeSkip").click();
          await wait(30);
          const guideBox = app.$("setupGuide").getBoundingClientRect();
          phone.guide = !app.$("setupGuide").hidden && guideBox.left >= 0 && guideBox.right <= 390 && app.doc.documentElement.scrollWidth <= 390 &&
            app.$("setupSteps").children[1].querySelector(".setup-text").innerText.startsWith("Start with the product name above,");
          // A field tip is full width on a phone.
          const tipButton = app.doc.querySelector('[data-field-tip="condition"]');
          tipButton.click();
          const pop = app.$(tipButton.getAttribute("aria-controls")).getBoundingClientRect();
          phone.tip = Math.round(pop.width) === 390 - 24 && Math.round(pop.left) === 12 && pop.top >= 0 && pop.bottom <= 844;
          app.doc.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
          // The tour card is a sheet at the bottom, and goes to the top for the fixed Generate bar.
          app.win.startTour();
          await wait(40);
          const card = app.$("tourCard").getBoundingClientRect(), spot = app.$("tourSpot").getBoundingClientRect();
          phone.sheet1 = Math.round(card.bottom) === 844 && Math.round(card.width) === 390 && card.left === 0 && spot.bottom <= card.top + 1 && app.$("tourCard").dataset.side === "sheet-bottom";
          for (let i = 0; i < 3; i++) app.$("tourNext").click();
          await wait(40);
          const top = app.$("tourCard").getBoundingClientRect(), gen = app.$("tourSpot").getBoundingClientRect();
          phone.sheet4 = app.$("tourTitle").textContent === "Generate listing" && Math.round(top.top) === 0 && gen.top >= top.bottom - 1 && app.$("tourCard").dataset.side === "sheet-top";
          phone.errors = app.fixture.errors.length;
        });
        lc(() => phone.sheet && phone.row && phone.keyboardDown && phone.wide && phone.errors === 0,
          "At 390px the welcome is a full-screen sheet with the course across the top, and the keyboard stays down");
        lc(() => phone.words, "On a phone the AI button shows its words (Set up AI), not just a dot");
        lc(() => phone.guide, "At 390px Get set up fits the screen (and says the product name is above)");
        lc(() => phone.tip, "On a phone a field tip is full width");
        lc(() => phone.sheet1 && phone.sheet4, "On a phone the tour card is a sheet at the bottom, and at the top for the Generate bar");
        for (const frame of frames.splice(0)) frame.remove();

        /* -- Welcome: Connect AI, Your shop, Quick tour -- */
        await act(() => { setStatus(noneSetUp); setRecord({}); newListing(); clearToasts(); });
        let welcome = null;
        await act(async () => {
          openWelcome();
          await settleUi();
          const link = $("welcomeKeySteps").querySelector("a");
          welcome = {head: words($("welcomeTitle")) + "|" + words($("welcomeLead")),
            course: [...$("welcomeCourse").children].map(li => words(li.querySelector(".way-long") || li.querySelector(".way-name")) + "/" + words(li.querySelector("small"))).join("|"),
            step: words($("welcomeStep0Title")) + "|" + words($("welcomeStep0").querySelector("p")),
            hint: words($("welcomePasteMount").querySelector(".key-paste-hint")),
            paste: welcomePaste.button.textContent + "|" + welcomePaste.button.classList.contains("btn-primary") + "|" + welcomePaste.input.placeholder,
            getKey: words($("welcomeGetKeyTitle")), steps: [...$("welcomeKeySteps").children].map(words),
            link: [link.href, link.target, /\bnoopener\b/.test(link.rel)].join("|"),
            foot: [words($("welcomeKeysNote")), words($("welcomeSkip")), words($("welcomeNext"))].join("|"),
            x: $("welcomeX").getAttribute("aria-label"), focus: document.activeElement === welcomePaste.input};
        });
        lc(() => welcome.head === "Welcome to Marteloio|Three short steps, then you're ready to write your first listing." &&
          welcome.course === "Connect AI/A free key, pasted once|Your shop/Optional|Quick tour/Six stops, one minute" && welcome.focus && welcome.x === "Close",
          "Welcome: the header and the course (Connect AI, Your shop, Quick tour), with × named Close");
        lc(() => welcome.step === "Connect a free AI service|Marteloio asks an AI service to write your listing. Paste a key and Marteloio works out which service it is and checks that it works." &&
          welcome.hint === "Works with keys from Google Gemini, Groq, OpenRouter and FreeLLMAPI." && welcome.paste === "Paste|true|Paste your key here",
          "Welcome step 1: Connect a free AI service, with one paste box");
        lc(() => welcome.getKey === "No key yet? Get a free Google key in about 2 minutes" && welcome.steps.length === 4 &&
          welcome.steps[0].startsWith("Open Google AI Studio") && welcome.steps[1] === "Sign in with your Google account and accept the terms if asked." &&
          welcome.steps[2] === "Choose Create API key (or copy the key that's already listed)." && welcome.steps[3] === "Come back here and paste it above." &&
          welcome.link === "https://aistudio.google.com/app/apikey|_blank|true", "Welcome step 1: No key yet? Four steps to a free Google key, opening Google AI Studio in a new tab");
        lc(() => welcome.foot === "Keys stay on this computer, encrypted for your Windows account.|Skip setup|Continue", "Welcome: the footer says where keys stay, with Skip setup and Continue");
        let pasted = null;
        await act(async () => {
          const data = new DataTransfer();
          data.setData("text/plain", "AIzaSyFixtureWelcomeKey0123456789a1B2");
          welcomePaste.input.dispatchEvent(new ClipboardEvent("paste", {clipboardData: data, bubbles: true, cancelable: true}));
          const request = await nextRequest();
          const body = JSON.parse(request.opts.body);
          aiStatus = geminiReady;
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini", test: {ok: true, ms: 1180, model: "gemini-flash-latest"}, status: geminiReady}));
          await until(() => welcomePaste.result.classList.contains("is-ok"));
          pasted = {path: request.path, provider: body.provider, result: words(welcomePaste.result), next: $("welcomeNext").classList.contains("btn-primary"),
            ghost: welcomePaste.button.classList.contains("btn-ghost") && !welcomePaste.button.classList.contains("btn-primary"), pill: $("statusText").textContent,
            course: $("welcomeCourse").children[0].className, shown: !document.body.innerHTML.includes("FixtureWelcomeKey")};
        });
        lc(() => pasted.path === "/settings/ai" && pasted.provider === "auto" && pasted.result === "Google Gemini is connected · it answered in 1.2 seconds" &&
          pasted.next && pasted.ghost && pasted.pill === "AI ready" && pasted.course === "is-now" && pasted.shown,
          "Welcome: a pasted key is saved and tested (Google Gemini is connected · it answered in 1.2 seconds) and Continue becomes the main button");
        let shop = null;
        await act(async () => {
          $("welcomeNext").click();
          await settleUi();
          shop = {step: !$("welcomeStep1").hidden && $("welcomeStep0").hidden, focus: document.activeElement === $("welcomeStep1Title"),
            course: [...$("welcomeCourse").children].map(li => li.className).join(), labels: [...$("welcomeStep1").querySelectorAll("label")].map(words).join("|"),
            lead: words($("welcomeStep1").querySelector("p")), noNote: $("welcomeNoAi").hidden, skip: words($("welcomeShopSkip"))};
          const year = new Date().getFullYear(), storeBefore = $("storeName").value, savedStore = localStorage.getItem("eb.store");
          typeInto($("welcomeStoreName"), "Fixture Welcome Store"); $("welcomeStoreName").dispatchEvent(new Event("change"));
          typeInto($("welcomeMemberYear"), "15");
          typeInto($("welcomeFbPct"), "150");
          // The hints Settings › Your shop shows for the same wrong values.
          shop.hints = !$("welcomeMemberYearError").hidden && words($("welcomeMemberYearError")) === "Member since: use the 4-digit year you joined eBay, from 1995 to " + year + ". Until then it's left out of the listing." &&
            !$("welcomeFbPctError").hidden && words($("welcomeFbPctError")) === "Positive %: use a number from 0 to 100, like 99.6. Until then it's left out of the listing." &&
            $("welcomeMemberYear").getAttribute("aria-invalid") === "true";
          // Nothing is saved while typing, and Continue with a wrong value stays, at that box.
          shop.notWhileTyping = $("storeName").value === storeBefore && localStorage.getItem("eb.store") === savedStore;
          $("welcomeNext").click();
          await settleUi();
          shop.stayed = !$("welcomeStep1").hidden && document.activeElement === $("welcomeMemberYear") && $("storeName").value === storeBefore &&
            localStorage.getItem("eb.store") === savedStore && localStorage.getItem("eb.memberYear") !== "15";
          typeInto($("welcomeMemberYear"), "2014");
          typeInto($("welcomeFbPct"), "99.6");
          $("welcomeNext").click();
          await settleUi();
          shop.saved = localStorage.getItem("eb.store") === "Fixture Welcome Store" && $("storeName").value === "Fixture Welcome Store" && $("memberYear").value === "2014" &&
            localStorage.getItem("eb.memberYear") === "2014" && localStorage.getItem("eb.fbPct") === "99.6" && $("welcomeMemberYearError").hidden && $("welcomeFbPctError").hidden &&
            !$("welcomeStep2").hidden;
          showWelcomeStep(1);
        });
        lc(() => shop.step && shop.focus && shop.course === "is-done,is-now," && shop.labels === "Store or seller name|Member since|Positive %" &&
          shop.lead.startsWith("Optional.") && shop.noNote && shop.skip === "Skip this step",
          "Welcome: Continue goes to Your shop (optional): store name, member since and positive %, with Skip this step");
        lc(() => shop.hints && shop.notWhileTyping && shop.stayed && shop.saved,
          "Welcome: Your shop has the hints of Settings › Your shop; nothing is saved while typing, and Continue saves the boxes once each one is right");
        let tourStep = null;
        await act(async () => {
          $("welcomeShopSkip").click();
          await settleUi();
          tourStep = {step: !$("welcomeStep2").hidden && $("welcomeStep1").hidden && document.activeElement === $("welcomeStep2Title"),
            buttons: words($("welcomeTourStart")) + "|" + words($("welcomeTourLater")), foot: $("welcomeNext").hidden && $("welcomeSkip").hidden,
            course: [...$("welcomeCourse").children].map(li => li.className).join(), text: words($("welcomeStep2").querySelector("p"))};
          $("welcomeTourLater").click();
          await settleUi();
          tourStep.closed = !welcomeOpen() && record().welcome === "done" && document.activeElement === $("productSearch") && $("tour").hidden;
        });
        lc(() => tourStep.step && tourStep.buttons === "Start the tour|Not now" && tourStep.foot && tourStep.course === "is-done,is-done,is-now" &&
          tourStep.text === "A one-minute tour of the real screen, in six stops: where to type, what Generate listing does and how to copy the listing into eBay.",
          "Welcome: Skip this step moves on to Quick tour, with Start the tour and Not now");
        lc(() => tourStep.closed, "Welcome: Not now finishes the setup (remembered as done) and focus goes to the product name");
        let fromWelcome = null;
        await act(async () => {
          setRecord({});
          openWelcome(2);
          $("welcomeTourStart").click();
          await settleUi();
          fromWelcome = !welcomeOpen() && record().welcome === "done" && tourActive() && $("tourTitle").textContent === "Start here";
          endTour("skipped");
        });
        lc(() => fromWelcome, "Welcome: Start the tour finishes the setup and starts the tour");
        let withoutKey = null;
        await act(async () => {
          setStatus(noneSetUp); setRecord({});
          openWelcome();
          $("welcomeNext").click();
          await settleUi();
          withoutKey = {moved: !$("welcomeStep1").hidden, note: $("welcomeNoAi").hidden ? "" : words($("welcomeNoAi")),
            first: $("welcomeCourse").children[0].className, primary: $("welcomeNext").classList.contains("btn-primary")};
          $("welcomeSkip").click();
        });
        lc(() => withoutKey.moved && withoutKey.note === "Not connected yet: choose Set up AI at the top of the page when you have a key." && withoutKey.first === "" && !withoutKey.primary,
          "Welcome: Continue without a key still moves on, with a note that Set up AI connects it later");
        const closings = [];
        for (const how of ["skip", "escape", "x"]) {
          await act(async () => {
            setRecord({});
            openWelcome();
            if (how === "skip") $("welcomeSkip").click();
            else if (how === "x") $("welcomeX").click();
            else press("Escape", {}, welcomePaste.input);
            await settleUi();
            closings.push(!welcomeOpen() && record().welcome === "skipped");
          });
        }
        lc(() => closings.length === 3 && closings.every(Boolean), "Welcome: Skip setup, Esc and × close it, remembered as skipped");
        let trap = false;
        await act(async () => {
          setRecord({});
          openWelcome();
          const focusables = [...$("welcome").querySelectorAll("button, input, a[href]")].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest("[hidden]"));
          const first = focusables[0], last = focusables[focusables.length - 1];
          last.focus(); const forward = press("Tab");
          const a = forward.defaultPrevented && document.activeElement === first && first === $("welcomeX");
          press("Tab", {shiftKey: true});
          const b = document.activeElement === last;
          $("welcomeTitle").focus(); press("Tab", {shiftKey: true});
          trap = a && b && document.activeElement === last;
          $("welcomeSkip").click();
        });
        lc(() => trap, "Welcome: keyboard focus stays inside the dialog (Tab and Shift+Tab wrap)");
        let routing = null;
        await act(async () => {
          closeSettings();
          setRecord({});
          startAiSetup();
          await settleUi();
          routing = {welcome: welcomeOpen() && !$("welcomeStep0").hidden && document.activeElement === welcomePaste.input && !$("settingsOverlay").classList.contains("open")};
          $("welcomeSkip").click();
          await startAiSetup();
          await settleUi();
          routing.settings = !welcomeOpen() && $("settingsOverlay").classList.contains("open") && settingsTab === "ai" && document.activeElement === keyPaste.input;
          closeSettings();
          setRecord({});
          $("aiStatus").click();
          await settleUi();
          routing.pill = welcomeOpen() && !$("welcomeStep0").hidden;
          $("welcomeSkip").click();
        });
        lc(() => routing.welcome && routing.settings && routing.pill,
          "Set up AI opens the welcome at its first step until it was finished or skipped; after that, Settings › AI with the paste box ready");
        let foundCard = "", foundUse = false;
        await act(async () => {
          setRecord({});
          detectReply = {found: true, ready: true, base_url: "http://127.0.0.1:31415/v1", reason: ""};
          openWelcome();
          await until(() => !$("welcomeFound").hidden);
          foundCard = words($("welcomeFoundText"));
          $("welcomeFoundUse").click();
          foundUse = document.activeElement === welcomePaste.input && words(welcomePaste.result) === "Paste the FreeLLMAPI key here.";
          detectReply = savedDetect;
          $("welcomeSkip").click();
        });
        lc(() => foundCard === "FreeLLMAPI is running on this computer. To use it, copy its key from the tray icon: Show Compact Panel › Copy Key." && foundUse,
          "Welcome: when FreeLLMAPI is running here, the same card as Settings offers it, and Use FreeLLMAPI goes to the paste box");
        let notes = [];
        for (const answer of [{provider_storage: "plaintext"}, {}]) {
          await act(async () => {
            settingsReply = answer;
            setRecord({});
            openWelcome();
            await until(() => (answer.provider_storage ? /\.env/ : /encrypted/).test($("welcomeKeysNote").textContent));
            notes.push(words($("welcomeKeysNote")));
            $("welcomeSkip").click();
          });
        }
        settingsReply = savedSettings;
        lc(() => notes.join("|") === "Keys stay on this computer, in the .env file in the Marteloio folder.|Keys stay on this computer, encrypted for your Windows account.",
          "Welcome: the footer says how keys are kept, as Settings does (encrypted on Windows, the .env file elsewhere)");

        /* -- Tour: six coach marks on the real screen -- */
        const TARGETS = [() => [$("productSearch").closest(".lookup-section").querySelector(".field-head"), document.querySelector("#lookupSection .lookup-row"), $("lookupHint")],
          () => [$("notes"), document.querySelector('label[for="notes"]')], () => [$("condition"), document.querySelector('label[for="condition"]')], () => [$("generateBtn")],
          () => [document.querySelector("#outputCard .title-box"), $("previewShell")], () => [$("copyHtmlBtn")]];
        let tourOpen = null;
        const stops = [];
        let snapshotBefore = "", snapshotAfter = "", pendingBefore = 0;
        await act(async () => {
          setMotion(true);
          setStatus(geminiReady);
          setRecord({});
          newListing(); clearToasts();
          typeInto($("productSearch"), "Tour fixture camera");
          snapshotBefore = JSON.stringify({...snapshotDraft(), savedAt: ""});
          pendingBefore = pending.length;
          const guideBefore = !$("setupGuide").hidden && $("outputCard").classList.contains("guide-full");
          $("helpBtn").focus();
          startTour();
          await settleUi();
          tourOpen = {visible: !$("tour").hidden, focus: document.activeElement === $("tourCard"), dialog: $("tourCard").getAttribute("role") === "dialog" && $("tourCard").getAttribute("aria-modal") === "true",
            aside: guideBefore && $("setupGuide").hidden && !$("outputCard").classList.contains("guide-full") && shown(document.querySelector("#outputCard .title-box"))};
          for (let i = 0; i < 6; i++) {
            await frame2();
            const spot = rectOf($("tourSpot")), card = rectOf($("tourCard"));
            stops.push({title: $("tourTitle").textContent, text: $("tourText").textContent, count: $("tourCount").textContent, back: !$("tourBack").hidden,
              next: $("tourNext").textContent, covered: TARGETS[i]().every(el => inside(clip(rectOf(el)), spot)), apart: !overlaps(card, spot), inView: inView(card, document.documentElement.clientWidth),
              dots: [...$("tourProgress").querySelectorAll("i")].map(dot => dot.classList.contains("on") ? 1 : 0).join("")});
            if (i < 5) $("tourNext").click();
          }
        });
        lc(() => tourOpen.visible && tourOpen.focus && tourOpen.dialog && tourOpen.aside,
          "Tour: it starts on the real screen with focus in its card, and Get set up steps aside so it can point at the real controls");
        lc(() => stops.length === 6 && stops.map(stop => stop.title).join("|") === "Start here|Describe the item|Condition|Generate listing|Review|Copy into eBay" &&
          stops.every((stop, i) => stop.text === ListingCore.TOUR_STOPS[i].text && stop.count === (i + 1) + " of 6" && stop.dots === "1".repeat(i + 1) + "0".repeat(5 - i)) &&
          stops[0].text === "Type what you're selling, like “Canon AE-1 camera”. Look up and Find keywords next to it are optional.",
          "Tour: six stops with the approved words, progress dots and 1 of 6 to 6 of 6");
        lc(() => stops.length === 6 && stops.every(stop => stop.covered),
          "Tour: each spotlight surrounds its target: the product name with Look up and Find keywords, Describe the item, Condition, Generate listing, the title and preview, Copy HTML");
        lc(() => stops.length === 6 && stops.every(stop => stop.apart && stop.inView), "Tour: the card sits beside the spotlight, inside the window");
        lc(() => stops.length === 6 && !stops[0].back && stops.slice(1).every(stop => stop.back) && stops[5].next === "Done" && stops.slice(0, 5).every(stop => stop.next === "Next"),
          "Tour: Back from the second stop on, Next, and Done on the last");
        let finished = null;
        await act(async () => {
          $("tourNext").click();
          await settleUi();
          snapshotAfter = JSON.stringify({...snapshotDraft(), savedAt: ""});
          finished = {closed: $("tour").hidden, done: record().tour === "done", focus: document.activeElement === $("helpBtn"),
            guideBack: !$("setupGuide").hidden, unchanged: snapshotAfter === snapshotBefore && pending.length === pendingBefore};
        });
        lc(() => finished.closed && finished.done && finished.focus && finished.guideBack, "Tour: Done finishes it (remembered as done), focus goes back to where it started and Get set up returns");
        lc(() => finished.unchanged && snapshotBefore.includes("Tour fixture camera"), "Tour: it never changes the draft");
        let keys = null;
        await act(async () => {
          setRecord({});
          $("productSearch").focus();
          startTour();
          await settleUi();
          const card = $("tourCard");
          press("ArrowRight", {}, card); const a = $("tourTitle").textContent === "Describe the item";
          press("ArrowLeft", {}, card); const b = $("tourTitle").textContent === "Start here";
          press("Enter", {}, card); const c = $("tourTitle").textContent === "Describe the item";
          $("tourNext").focus(); press("Tab", {}, $("tourNext")); const wrap = document.activeElement === $("tourBack");
          press("Escape", {}, document.activeElement);
          await settleUi();
          keys = {a, b, c, wrap, closed: $("tour").hidden, skipped: record().tour === "skipped", focus: document.activeElement === $("productSearch")};
        });
        lc(() => keys.a && keys.b && keys.c && keys.wrap, "Tour: → and Enter go on, ← goes back, and Tab stays in the card");
        lc(() => keys.closed && keys.skipped && keys.focus, "Tour: Esc skips it (remembered as skipped) and focus goes back");
        let follows = null;
        await act(async () => {
          window.scrollTo(0, 0);
          startTour();
          $("tourNext").click(); $("tourNext").click();
          await frame2();
          const before = rectOf($("tourSpot")).top, y = window.scrollY;
          window.scrollBy(0, y > 60 ? -40 : 40);
          await frame2(); await frame2();
          const moved = window.scrollY - y, after = rectOf($("tourSpot")).top;
          window.dispatchEvent(new Event("resize"));
          await frame2(); await frame2();
          follows = moved !== 0 && Math.abs(before - after - moved) <= 2 && inside(clip(rectOf($("condition"))), rectOf($("tourSpot")));
          endTour("skipped");
          window.scrollTo(0, 0);
        });
        lc(() => follows, "Tour: the spotlight follows its target when the page scrolls or the window resizes");
        let motion = null;
        await act(async () => {
          const calls = [], realScroll = Element.prototype.scrollIntoView;
          Element.prototype.scrollIntoView = function(options) { calls.push(options && options.behavior); return realScroll.call(this, {...(options || {}), behavior: "auto"}); };
          try {
            for (const reduced of [false, true]) { setMotion(reduced); startTour(); $("tourNext").click(); $("tourNext").click(); endTour("skipped"); }
          } finally { Element.prototype.scrollIntoView = realScroll; setMotion(true); }
          const rule = [...document.querySelector("style").sheet.cssRules].some(r => r instanceof CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(r.conditionText) &&
            [...r.cssRules].some(inner => /\.tour-spot/.test(inner.selectorText || "") && /\.tour-card/.test(inner.selectorText || "") && /none/.test(inner.style.transition || inner.style.transitionProperty || "")));
          motion = {smooth: calls.includes("smooth"), still: calls.slice(Math.floor(calls.length / 2)).every(behavior => behavior === "auto") && calls.length >= 4, rule};
        });
        lc(() => motion.smooth && motion.still && motion.rule, "Tour: it scrolls each stop into view, smoothly unless reduced motion is on (then nothing slides)");

        /* -- Get set up: in place of the empty state until the first copy -- */
        let guideView = null;
        await act(async () => {
          setStatus(noneSetUp); setRecord({}); newListing(); clearToasts();
          await settleUi();
          const steps = [...$("setupSteps").children];
          guideView = {shown: shown($("setupGuide")) && $("outputCard").classList.contains("guide-full") && !shown(document.querySelector("#outputCard .title-box")) &&
              !shown($("emptyState")) && !shown($("copyHtmlBtn")) && shown(document.querySelector(".out-head")),
            head: words($("setupGuideTitle")) + "|" + words($("setupGuide").querySelector(".setup-sub")),
            titles: steps.map(li => words(li.querySelector("b"))).join("|"),
            texts: steps.slice(1).map(li => li.querySelector(".setup-text").innerText.replace(/\s+/g, " ").trim()),
            first: words($("setupAiText")), classes: steps.map(li => li.className.trim()).join(), current: steps[0].getAttribute("aria-current"),
            paste: shown(setupPaste.input) && setupPaste.button.textContent === "Paste",
            foot: words($("setupSample")) + "|" + words($("setupHide"))};
        });
        lc(() => guideView.shown && guideView.head === "Get set up|Four steps to your first listing. This guide hides itself when you're done." &&
          guideView.titles === "Connect a free AI service|Describe your first item|Generate the listing|Copy it into eBay" &&
          guideView.texts.join("|") === "Start with the product name on the left, then say what works and what doesn't.|Takes 10–30 seconds. Check every detail it writes.|Switch eBay's description box to HTML (the < > button), then paste." &&
          guideView.foot === "Try a sample item|Hide this guide", "Get set up: four steps in place of the empty state, with Try a sample item and Hide this guide");
        lc(() => guideView.classes === "is-now,,," && guideView.current === "step" && guideView.paste &&
          guideView.first === "Paste a key from Google Gemini, Groq, OpenRouter or FreeLLMAPI. No key yet? Get a free Google key (about 2 minutes).",
          "Get set up: Connect a free AI service is the current step, with the paste box inline while nothing is connected");
        let getKey = null;
        await act(async () => {
          const before = $("setupKeySteps").hidden;
          $("setupGetKey").click();
          getKey = {before, opened: !$("setupKeySteps").hidden && $("setupGetKey").getAttribute("aria-expanded") === "true" && $("setupGetKey").getAttribute("aria-controls") === "setupKeySteps",
            steps: [...$("setupKeySteps").children].map(words), link: $("setupKeySteps").querySelector("a").href};
          $("setupGetKey").click();
          getKey.closed = $("setupKeySteps").hidden;
        });
        lc(() => getKey.before && getKey.opened && getKey.closed && getKey.steps.length === 4 && getKey.steps[3] === "Come back here and paste it above." &&
          getKey.link === "https://aistudio.google.com/app/apikey", "Get set up: No key yet? Get a free Google key opens the same four steps as the welcome");
        let ticks = null;
        await act(async () => {
          const save = setupPaste.save("AIzaSyFixtureGuideKey0123456789abcd");
          const request = await nextRequest();
          aiStatus = geminiReady;
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini", test: {ok: true, ms: 1200, model: "gemini-flash-latest"}, status: geminiReady}));
          await save;
          await settleUi();
          const steps = () => [...$("setupSteps").children].map(li => li.className.trim()).join();
          ticks = {connected: steps(), done: words($("setupAiDone")), pasteGone: !shown(setupPaste.input)};
          typeInto($("productSearch"), "Canon AE-1");
          typeInto($("notes"), "Guide fixture camera. Shutter works, light meter dead.");
          ticks.described = steps();
          const run = generate(); const request2 = await nextRequest();
          ticks.generating = steps();
          complete(request2, listing("Guide fixture listing")); await run;
          await settleUi();
          ticks.strip = shown($("setupStrip")) ? words($("setupStrip")) : "";
          ticks.full = !shown($("setupGuide")) && !$("outputCard").classList.contains("guide-full") && shown(document.querySelector("#outputCard .title-box"));
          ticks.generated = record().generated === true;
        });
        lc(() => ticks.connected === "is-done,is-now,," && ticks.done === "Google Gemini is connected · it answered in 1.2 seconds." && ticks.pasteGone,
          "Get set up: a key pasted in the guide ticks Connect AI, and says which service answered");
        lc(() => ticks.described === "is-done,is-done,is-now,", "Get set up: describing the item ticks Describe your first item");
        lc(() => ticks.strip === "Last step: copy it into eBay. Switch eBay's description box to HTML (the < > button), then paste. Hide" && ticks.full && ticks.generated,
          "Get set up: after the first listing only one line stays: Last step: copy it into eBay…, with Hide");
        let firstCopy = null;
        await act(async () => {
          clearToasts();
          $("copyHtmlBtn").click();
          await settleUi();
          const notice = liveOf("note").map(textOf), done = liveOf("ok").map(textOf);
          firstCopy = {gone: !shown($("setupStrip")) && !shown($("setupGuide")), saved: record().copied === true && (record().tipsShown || []).includes("copyHtml"),
            tip: notice.includes("In eBay's listing form, switch the description box to HTML (the < > button), paste, then check the preview."),
            done: done.includes("You're set up. Find the tour and this guide again under Help (?).")};
          clearToasts();
          $("copyHtmlBtn").click();
          await settleUi();
          firstCopy.once = !liveOf("note").length && !liveOf("ok").some(item => /set up/.test(textOf(item)));
        });
        lc(() => firstCopy.gone && firstCopy.saved && firstCopy.done, "First copy: the guide hides itself and a Done message says You're set up… under Help (?)");
        lc(() => firstCopy.tip && firstCopy.once, "First copy: the Copy HTML tip shows once as a Notice; a second copy shows neither again");
        let again = null;
        await act(async () => {
          $("helpBtn").click();
          const item = $("helpGuide");
          again = {offered: shown(item) && words(item) === "Show the Get set up guide"};
          item.click();
          await settleUi();
          again.shown = shown($("setupGuide")) && document.activeElement === $("setupGuideTitle") && [...$("setupSteps").children].every(li => li.classList.contains("is-done")) &&
            shown(document.querySelector("#outputCard .title-box")) && record().checklist === "shown";
        });
        lc(() => again.offered && again.shown, "Help › Show the Get set up guide brings it back after it hid itself, every step ticked");
        let hide = null;
        await act(async () => {
          clearToasts();
          $("setupHide").focus();
          $("setupHide").click();
          await settleUi();
          hide = {hidden: !shown($("setupGuide")) && record().checklist === "hidden", notice: liveOf("note").map(textOf).includes("Get set up is hidden. Help (?) at the top of the page shows it again."),
            focus: document.activeElement !== document.body && shown(document.activeElement)};
          $("helpBtn").click();
          hide.offered = shown($("helpGuide"));
          press("Escape", {}, document.activeElement);
        });
        lc(() => hide.hidden && hide.notice && hide.focus && hide.offered, "Hide this guide hides it (remembered), says where to find it again, and keeps focus on the page");
        let stripHide = null;
        await act(async () => {
          setRecord({generated: true});
          await settleUi();
          const before = shown($("setupStrip"));
          $("setupStripHide").click();
          await settleUi();
          stripHide = before && !shown($("setupStrip")) && record().checklist === "hidden";
        });
        lc(() => stripHide, "The one-line strip's Hide hides the guide too");
        let sample = null;
        await act(async () => {
          setRecord({}); newListing();
          await settleUi();
          $("setupSample").click();
          await settleUi();
          sample = $("notes").value.startsWith("SAMPLE ITEM") && [...$("setupSteps").children].map(li => li.className.trim()).join() === "is-done,is-done,is-now,";
        });
        lc(() => sample, "Get set up: Try a sample item fills the made-up item, and Describe your first item ticks");

        /* -- Field tips: an (i) beside six labels -- */
        const FIELDS = {product: "productSearch", describe: "notes", included: "includedInput", condition: "condition", conditionNotes: "condNotes", brand: "brand"};
        const fieldTips = [];
        await act(async () => {
          // The guide hidden, so the output column's own buttons are on screen for the tips below.
          setRecord({welcome: "done", tour: "done", checklist: "hidden", startHereDismissed: true}); newListing(); clearToasts();
          for (const [key, field] of Object.entries(FIELDS)) {
            const button = document.querySelector('[data-field-tip="' + key + '"]'), label = document.querySelector('label[for="' + field + '"]');
            const result = {key, beside: Boolean(button && label) && button.parentElement === label.parentElement && !label.contains(button) && shown(button),
              button: button.tagName === "BUTTON" && button.type === "button" && button.getAttribute("aria-label") === "Tip: " + tips()[key].title,
              closed: button.getAttribute("aria-expanded") === "false"};
            const pop = $(button.getAttribute("aria-controls"));
            button.focus(); button.click();
            result.opened = button.getAttribute("aria-expanded") === "true" && shown(pop) && words(pop.querySelector("b")) === tips()[key].title && words(pop.querySelector("span")) === tips()[key].text;
            result.inView = inView(rectOf(pop), document.documentElement.clientWidth);
            result.said = $("tipAnnounce").textContent === tips()[key].title + ": " + tips()[key].text;
            press("Escape", {}, button);
            result.esc = button.getAttribute("aria-expanded") === "false" && !shown(pop) && document.activeElement === button;
            button.click();
            document.body.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
            result.away = !shown(pop) && button.getAttribute("aria-expanded") === "false";
            button.focus(); button.click();
            $("generateBtn").focus();
            result.tab = !shown(pop) && button.getAttribute("aria-expanded") === "false";
            fieldTips.push(result);
          }
        });
        lc(() => fieldTips.length === 6 && fieldTips.every(tip => tip.beside && tip.button && tip.closed),
          "Field tips: an (i) button beside Product name or model, Describe the item, What's included, Condition, Condition notes and Brand");
        lc(() => fieldTips.length === 6 && fieldTips.every(tip => tip.opened && tip.said), "Field tips: each opens its approved words (aria-expanded, aria-controls) and they are read out");
        lc(() => fieldTips.length === 6 && fieldTips.every(tip => tip.esc), "Field tips: Esc closes the tip and focus goes back to its (i)");
        lc(() => fieldTips.length === 6 && fieldTips.every(tip => tip.away && tip.tab), "Field tips: a click or tap elsewhere, or tabbing away, closes the tip");
        lc(() => fieldTips.length === 6 && fieldTips.every(tip => tip.inView), "Field tips: a tip is never cut off by the window");
        let comma = false;
        await act(async () => {
          newListing();
          const input = $("includedInput");
          const typeComma = () => { const event = new KeyboardEvent("keydown", {key: ",", bubbles: true, cancelable: true}); input.dispatchEvent(event); return event.defaultPrevented; };
          const typed = value => { input.value = value; input.setSelectionRange(value.length, value.length); };
          input.focus();
          typed("Charger");
          const ends = typeComma() && state.includedItems.join("|") === "Charger" && input.value === "";
          typed("Cable (USB-C");
          const bracket = !typeComma() && state.includedItems.length === 1;
          typed("1");
          const digits = !typeComma() && state.includedItems.length === 1;
          typed("");
          comma = ends && bracket && digits;
          $("notes").focus();
        });
        lc(() => comma, "What's included: a typed comma ends an item, as its tip says (but not inside brackets or in 1,000)");

        /* -- Button tips: on hover after about 0.4 s and on keyboard focus, also when disabled -- */
        const BUTTONS = [["lookupBtn", "lookup"], ["mineBtn", "keywords"], ["modeBundle", "bundle"], ["formNewListingBtn", "newListing"], ["generateBtn", "generate"],
          ["copyHtmlBtn", "copyHtml"], ["regenBtn", "regenerate"], ["editContentBtn", "editContent"], ["shuffleStyleBtn", "shuffle"], ["draftsBtn", "drafts"], ["aiStatus", "aiStatus"]];
        let delay = null;
        const buttonTips = [];
        await act(async () => {
          newListing();
          const tip = $("btnTip"), started = performance.now();
          hover($("generateBtn"));
          await wait(200);
          delay = {early: tip.hidden};
          await until(() => !tip.hidden, 2000);
          delay.late = !tip.hidden && words(tip.querySelector("b")) === "Generate listing" && performance.now() - started >= 380;
          leave($("generateBtn"));
          delay.gone = tip.hidden;
          GUIDE_TIMES.tip = 20;
          for (const [id, key] of BUTTONS) {
            const el = $(id);
            hover(el);
            await until(() => !tip.hidden, 1000);
            const describedBy = (el.getAttribute("aria-describedby") || "").split(/\s+/).map(ref => document.getElementById(ref)).filter(Boolean).map(words);
            buttonTips.push({id, shown: !tip.hidden && words(tip.querySelector("b")) === tips()[key].title && words(tip.querySelector(".tip-text")) === tips()[key].text,
              inView: inView(rectOf(tip)), described: describedBy.includes(tips()[key].text), disabled: el.disabled});
            leave(el);
          }
        });
        lc(() => delay.early && delay.late && delay.gone, "Button tips: hovering shows the tip after about 0.4 s, and leaving hides it");
        lc(() => buttonTips.length === BUTTONS.length && buttonTips.every(tip => tip.shown && tip.inView),
          "Button tips: Look up, Find keywords, Bundle / lot, New listing, Generate listing, Copy HTML, Regenerate…, Edit content, Shuffle look, Drafts and AI status show their approved words");
        lc(() => buttonTips.length === BUTTONS.length && buttonTips.every(tip => tip.described), "Button tips: screen readers hear the same words with each button");
        lc(() => buttonTips.some(tip => tip.id === "regenBtn" && tip.disabled && tip.shown) && buttonTips.some(tip => tip.id === "copyHtmlBtn" && tip.disabled && tip.shown),
          "Button tips: a disabled button (Regenerate… or Copy HTML before the first listing) still shows its tip");
        let focusTip = null;
        await act(async () => {
          const tip = $("btnTip");
          press("Tab", {}, document.body);
          $("lookupBtn").focus();
          focusTip = {keyboard: !tip.hidden && words(tip.querySelector("b")) === "Look up"};
          press("Escape", {}, $("lookupBtn"));
          focusTip.esc = tip.hidden;
          $("mineBtn").focus();
          focusTip.next = !tip.hidden && words(tip.querySelector("b")) === "Find keywords";
          $("notes").focus();
          focusTip.blur = tip.hidden;
          $("lookupBtn").dispatchEvent(new PointerEvent("pointerdown", {bubbles: true, pointerType: "mouse"}));
          $("lookupBtn").focus();
          focusTip.click = tip.hidden;
          $("notes").focus();
        });
        lc(() => focusTip.keyboard && focusTip.esc && focusTip.next && focusTip.blur && focusTip.click,
          "Button tips: keyboard focus shows the tip at once, Esc or moving on hides it, and a click doesn't show it");
        let nativeTitle = null;
        await act(async () => {
          const button = $("formNewListingBtn"), tip = $("btnTip");
          hover(button);
          await until(() => !tip.hidden, 1000);
          nativeTitle = {during: !button.hasAttribute("title") && !tip.hidden && /Shortcut: (Alt|Option)\+N/.test(words(tip.querySelector(".tip-extra")))};
          leave(button);
          nativeTitle.after = /\((Alt|Option)\+N\)/.test(button.title);
        });
        lc(() => nativeTitle.during && nativeTitle.after, "Button tips: no second browser tooltip while a tip shows (New listing's tip names Alt+N); the button's own title comes back after");

        /* -- Start here: a marker on the product name until the seller types -- */
        let startHere = null;
        await act(async () => {
          setRecord({}); newListing(); clearToasts();
          await settleUi();
          const marker = $("startHere");
          startHere = {shown: shown(marker) && words(marker) === "Start here" && marker.closest(".field-head") === document.querySelector('label[for="productSearch"]').parentElement &&
              ($("productSearch").getAttribute("aria-describedby") || "").split(/\s+/).includes("tipText-startHere"),
            pulse: getComputedStyle(marker, "::after").animationName === "start-pulse",
            still: [...document.querySelector("style").sheet.cssRules].some(rule => rule instanceof CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(rule.conditionText) &&
              [...rule.cssRules].some(inner => /\.start-here::after/.test(inner.selectorText || "") && inner.style.animationName === "none"))};
          hover(marker);
          await until(() => !$("btnTip").hidden, 1000);
          startHere.tip = !$("btnTip").hidden && words($("btnTip").querySelector(".tip-text")) === tips().startHere.text;
          leave(marker);
          // Even while it is back for a moment (an earlier Generate with nothing to go on), typing ends it.
          GUIDE_TIMES.flash = 60000;
          generate();
          typeInto($("productSearch"), "Canon AE-1");
          startHere.typed = !shown(marker) && record().startHereDismissed === true;
          typeInto($("productSearch"), "");
          newListing();
          startHere.forGood = !shown(marker);
          GUIDE_TIMES.flash = 250;
          generate();
          await settleUi();
          startHere.flash = liveOf("note").map(textOf).includes("Start by describing the item.") && shown(marker) && marker.classList.contains("is-flash");
          await until(() => !shown(marker), 2000);
          startHere.flashGone = !shown(marker);
          GUIDE_TIMES.flash = 60000;
          generate();
          const back = shown(marker);
          newListing();
          startHere.endsWithDraft = back && !shown(marker);
        });
        lc(() => startHere.shown && startHere.pulse && startHere.still, "Start here: a pill on Product name or model on a first run; it pulses gently, and stays still under reduced motion");
        lc(() => startHere.tip, "Start here: hovering it shows what it means");
        lc(() => startHere.typed && startHere.forGood, "Start here: typing a product name removes it for good");
        lc(() => startHere.flash && startHere.flashGone && startHere.endsWithDraft,
          "Start here: the Start by describing the item. Notice brings it back for a moment (a new listing ends that moment)");

        /* -- The AI button, Help, Optional -- */
        let pill = null;
        await act(async () => {
          setRecord({welcome: "done", tour: "done", checklist: "hidden", startHereDismissed: true});
          setStatus(noneSetUp);
          pill = {setup: $("statusText").textContent === "Set up AI" && $("aiStatus").classList.contains("is-setup") && getComputedStyle($("aiStatus")).borderTopStyle === "dashed" &&
            $("statusDot").classList.contains("setup")};
          $("aiStatus").click();
          await settleUi();
          pill.setupOpens = $("settingsOverlay").classList.contains("open") && settingsTab === "ai" && document.activeElement === keyPaste.input;
          closeSettings();
          setStatus(geminiReady);
          pill.ready = $("statusText").textContent === "AI ready" && $("statusDot").classList.contains("on") && !$("aiStatus").classList.contains("is-setup");
          $("aiStatus").click();
          await settleUi();
          pill.readyOpens = $("settingsOverlay").classList.contains("open") && settingsTab === "ai" && !welcomeOpen();
          closeSettings();
          setStatus(resting);
          pill.busy = $("statusText").textContent === "AI busy · 40 s" && $("statusDot").classList.contains("busy");
          setStatus(geminiReady);
        });
        lc(() => pill.setup && pill.setupOpens, "The AI button: Set up AI (dashed, orange) starts the AI setup");
        lc(() => pill.ready && pill.readyOpens && pill.busy, "The AI button: AI ready (green dot) or AI busy · 40 s, and a click opens Settings › AI");
        let help = null;
        await act(async () => {
          setRecord({welcome: "done", tour: "done", checklist: "auto", copied: true, startHereDismissed: true});
          const button = $("helpBtn");
          help = {button: button.tagName === "BUTTON" && button.getAttribute("aria-haspopup") === "menu" && button.getAttribute("aria-expanded") === "false" &&
            button.getAttribute("aria-controls") === "helpPanel" && /help/i.test(button.getAttribute("aria-label")) && words(button) === "?" &&
            button.closest(".header-actions") && button.closest(".header-actions").contains($("feedbackLink")) && $("feedbackLink").tagName === "A"};
          button.focus(); button.click();
          const items = () => [...$("helpPanel").querySelectorAll('[role="menuitem"]')].filter(shown);
          help.open = $("helpPanel").getAttribute("role") === "menu" && shown($("helpPanel")) && button.getAttribute("aria-expanded") === "true" && document.activeElement === items()[0];
          help.items = items().map(words).join("|");
          const at = () => items().indexOf(document.activeElement);
          press("ArrowDown"); const down = at() === 1;
          press("End"); const end = at() === items().length - 1;
          press("Home"); const home = at() === 0;
          press("ArrowUp"); const wrap = at() === items().length - 1;
          press("Escape");
          help.keys = down && end && home && wrap && !shown($("helpPanel")) && document.activeElement === button && button.getAttribute("aria-expanded") === "false";
          press("ArrowDown", {}, button);
          const openDown = shown($("helpPanel")) && at() === 0;
          press("Escape");
          press("ArrowUp", {}, button);
          help.arrowOpen = openDown && shown($("helpPanel")) && at() === items().length - 1;
          const links = items().filter(item => item.tagName === "A");
          help.links = links.length === 2 && links[0].href === "https://github.com/browser-b0X/marteloio/blob/main/docs/GUIDE.md" && links[1].href === $("feedbackLink").href &&
            links.every(link => link.target === "_blank" && /\bnoopener\b/.test(link.rel));
          press("Escape");
          $("helpBtn").click(); $("helpSetup").click();
          await settleUi();
          help.setup = welcomeOpen() && !$("welcomeStep0").hidden;
          $("welcomeSkip").click();
          $("helpBtn").click(); $("helpTour").click();
          await settleUi();
          help.tour = tourActive() && $("tourTitle").textContent === "Start here";
          endTour("skipped");
          setRecord({welcome: "done", tour: "done", checklist: "auto", startHereDismissed: true});
          $("helpBtn").click();
          help.notOffered = !shown($("helpGuide"));
          press("Escape");
        });
        lc(() => help.button && help.open, "Help: a ? button next to the GitHub link opens a menu, with focus on its first item");
        lc(() => help.items === "Show the setup again|Take the tour|Show the Get set up guide|User guide↗ (opens in a new tab)|Report a problem↗ (opens in a new tab)" &&
          help.links && help.notOffered, "Help: Show the setup again, Take the tour, Show the Get set up guide (when hidden or done), User guide and Report a problem");
        lc(() => help.keys && help.arrowOpen, "Help: arrow keys, Home and End move through it, and Esc closes it back to its button");
        lc(() => help.setup && help.tour, "Help: Show the setup again opens the welcome; Take the tour starts the tour");
        lc(() => {
          const hint = $("lookupHint"), tag = hint.querySelector(".opt-tag");
          return shown(tag) && words(tag) === "Optional" && words(hint).startsWith("Optional Look up and Find keywords") &&
            tips().lookup.text.startsWith("Optional.") && tips().keywords.text.startsWith("Optional.");
        }, "Look up and Find keywords are marked Optional, and their tips say so");

        /* -- Storage that throws: everything still works for this visit -- */
        let storageThrows = null;
        await act(async () => {
          clearToasts();
          const realGet = Storage.prototype.getItem, realSet = Storage.prototype.setItem;
          const deny = () => { throw new DOMException("Fixture blocked storage", "SecurityError"); };
          Storage.prototype.getItem = deny; Storage.prototype.setItem = deny;
          try {
            loadGuide();
            storageThrows = {fresh: guideInfo().welcome === ""};
            openWelcome();
            $("welcomeSkip").click();
            startTour(); $("tourNext").click(); press("Escape", {}, $("tourCard"));
            hideSetupGuide();
            storageThrows.session = !welcomeOpen() && !tourActive() && guideInfo().welcome === "skipped" && guideInfo().tour === "skipped" && guideInfo().checklist === "hidden";
            storageThrows.quiet = !liveOf("err").length;
          } finally { Storage.prototype.getItem = realGet; Storage.prototype.setItem = realSet; }
        });
        lc(() => storageThrows.fresh && storageThrows.session && storageThrows.quiet,
          "When storage throws, the welcome, the tour and the guide still work for this visit, with no error message");
      } finally {
        if (clipboard) clipboard.writeText = realWrite;
        if (motionDescriptor) Object.defineProperty(motionMedia, "matches", motionDescriptor); else delete motionMedia.matches;
        try { if (savedTimes) Object.assign(GUIDE_TIMES, savedTimes); } catch (_) { /* older code */ }
        try { endTour("skipped"); } catch (_) { /* older code */ }
        try { closeWelcome(""); } catch (_) { /* older code */ }
        try { closeSettings(); } catch (_) { /* older code */ }
        for (const frame of frames.splice(0)) frame.remove();
        still.remove();
        aiStatus = savedStatus; detectReply = savedDetect; settingsReply = savedSettings;
        try { applyAiStatus(savedStatus); } catch (_) { /* older code */ }
        localStorage.setItem(GUIDE_RECORD, JSON.stringify(GUIDE_DONE));
        try { loadGuide(); } catch (_) { /* older code */ }
        for (const [id, value] of Object.entries(savedSeller)) $(id).value = value;
        for (const [key, value] of Object.entries(savedPrefs)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
        try { syncSellerFieldHints(); } catch (_) { /* older code */ }
        $("appTheme").value = savedTheme; $("appTheme").dispatchEvent(new Event("change"));
        pending.splice(0);
        clearToasts();
        newListing();
        try { renderGuide(); } catch (_) { /* older code */ }
        if (soft) {
          const note = document.createElement("p");
          note.id = "wave3-soft-failures";
          note.dataset.count = String(softFailures.length);
          note.textContent = "WAVE 3 SOFT FAILURES (" + softFailures.length + "): " + softFailures.join(" | ");
          panel.append(note);
        }
      }
    }
    /* ---- v0.2.0 QA walkthrough fixes ----
       Runs after the wave 3 checks, or alone with ?qa. With ?soft it records failures instead of
       stopping, so it can be run against the code before these fixes (each check must fail there). */
    async function qaChecks() {
      const soft = new URLSearchParams(location.search).has("soft");
      const softFailures = [];
      const lc = (fn, label) => {
        let ok = false;
        try { ok = Boolean(fn()); } catch (_) { ok = false; }
        if (ok || !soft) check(ok, label); else softFailures.push(label);
      };
      const act = async fn => { try { await fn(); } catch (_) { /* the outcome is checked next */ } };
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async (fn, ms = 2500) => {
        const end = performance.now() + ms;
        for (;;) {
          let ok = false;
          try { ok = Boolean(fn()); } catch (_) { ok = false; }
          if (ok) return true;
          if (performance.now() > end) return false;
          await wait(10);
        }
      };
      const settleUi = async () => { for (let i = 0; i < 8; i++) await tick(); };
      const typeInto = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", {bubbles: true})); };
      const hover = el => el.dispatchEvent(new PointerEvent("pointerover", {bubbles: true, pointerType: "mouse"}));
      const leave = el => el.dispatchEvent(new PointerEvent("pointerout", {bubbles: true, pointerType: "mouse", relatedTarget: document.body}));
      const words = el => (el && el.textContent || "").replace(/\s+/g, " ").trim();
      const live = () => [...document.querySelectorAll("#toastPanel .toast-item:not(.leaving)")];
      const liveOf = kind => live().filter(item => item.querySelector(".toast." + kind));
      const textOf = item => (item && item.querySelector(".toast p") || {}).textContent || "";
      const titleOf = item => (item && item.querySelector(".toast-title > span") || {}).textContent || "";
      const actionOf = item => item && item.querySelector(".toast-action");
      const countOf = item => item && !item.querySelector(".toast-count").hidden ? words(item.querySelector(".toast-count [aria-hidden]")) : "";
      const failWith = (request, status, data) => request.resolve({ok: false, status, json: async () => data});
      const takeRequest = async path => {
        await until(() => pending.some(request => request.path === path));
        const at = pending.findIndex(request => request.path === path);
        return at < 0 ? null : pending.splice(at, 1)[0];
      };
      const clearToasts = () => {
        try { if (busyToast) dismissToast(busyToast); } catch (_) { /* older code */ }
        for (const item of [...document.querySelectorAll("#toastPanel .toast-item")]) {
          try { dismissToast(item); } catch (_) { /* older code */ }
          item.remove();
        }
      };
      const noteOf = id => $(id).hidden ? "" : words($(id).querySelector(".step-note-text"));
      const noteFixOf = id => $(id).querySelector(".step-note-fix").hidden ? "" : words($(id).querySelector(".step-note-fix"));
      const lum = color => {
        const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const contrastOf = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
      const hueOf = color => {
        const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(v => Number(v) / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
        if (!d) return 0;
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return (h * 60 + 360) % 360;
      };
      const hueApart = (a, b) => { const d = Math.abs(hueOf(a) - hueOf(b)); return Math.min(d, 360 - d); };
      // The server's /ai/status for four services, with the given ones changed ({gemini: {configured: true, …}}).
      const provider = (id, label) => ({id, label, configured: false, enabled: true, state: "off", retry_in: 0, model: "", key_hint: "", checked: "",
        ...(id === "freellmapi" ? {base_url: "http://127.0.0.1:31415/v1"} : {})});
      const SERVICES = [["freellmapi", "FreeLLMAPI"], ["gemini", "Google Gemini"], ["groq", "Groq"], ["openrouter", "OpenRouter"]];
      const statusWith = (changes = {}) => {
        const providers = SERVICES.map(([id, label]) => ({...provider(id, label), ...(changes[id] || {})}));
        const ready = providers.some(p => p.state === "ready");
        const waits = providers.filter(p => p.configured && p.enabled && p.retry_in > 0).map(p => p.retry_in);
        return {ready, retry_in: ready || !waits.length ? 0 : Math.min(...waits), providers};
      };
      const noneSetUp = statusWith();
      const twoSetUp = statusWith({freellmapi: {configured: true, state: "ready", key_hint: "9f3c", checked: "ok", model: "auto:fast"},
        gemini: {configured: true, state: "ready", key_hint: "a1B2", checked: "ok", model: "gemini-flash-latest"}});
      const GUIDE_RECORD = "marteloio.guide.v1";
      const setRecord = value => { localStorage.setItem(GUIDE_RECORD, JSON.stringify(value)); try { loadGuide(); renderGuide(); } catch (_) { /* older code */ } };
      const setStatus = status => { aiStatus = status; try { applyAiStatus(status); } catch (_) { /* older code */ } };
      const pasteInto = (input, text) => {
        const win = input.ownerDocument.defaultView, data = new win.DataTransfer();
        data.setData("text/plain", text);
        input.dispatchEvent(new win.ClipboardEvent("paste", {clipboardData: data, bubbles: true, cancelable: true}));
      };
      const savedStatus = aiStatus, savedDetect = detectReply, savedTheme = document.documentElement.dataset.theme;
      const savedSeller = Object.fromEntries(["storeName", "memberYear", "fbPct"].map(id => [id, $(id).value]));
      const savedPrefs = Object.fromEntries(["eb.store", "eb.memberYear", "eb.fbPct"].map(key => [key, localStorage.getItem(key)]));
      let savedGuideTimes = null, savedSettingsTimes = null;
      try { savedGuideTimes = {...GUIDE_TIMES}; } catch (_) { /* older code */ }
      try { savedSettingsTimes = {...SETTINGS_TIMES}; } catch (_) { /* older code */ }
      const clipboard = navigator.clipboard, realWrite = clipboard && clipboard.writeText;
      if (clipboard) clipboard.writeText = async () => {};
      const frames = [];
      const loadApp = async (query, width = 1366, height = 768) => {
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;left:-20000px;top:0;border:0;width:" + width + "px;height:" + height + "px";
        const loaded = new Promise(resolve => { frame.onload = resolve; });
        frame.src = "/?app-only&" + query;
        document.body.append(frame);
        frames.push(frame);
        await loaded;
        const doc = frame.contentDocument;
        const settled = doc.createElement("style");
        settled.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
        doc.head.append(settled);
        await until(() => doc.getElementById("statusText").textContent !== "Checking AI…", 4000);
        await wait(80);
        return {frame, win: frame.contentWindow, doc, $: id => doc.getElementById(id), fixture: frame.contentWindow.__fixture};
      };
      pending.splice(0);
      try {
        await act(() => { closeSettings(); newListing(); });
        clearToasts();

        /* -- 1. Connected means set up, switched on, not turned down and its check not failed -- */
        let failedPaste = null;
        await act(async () => {
          setStatus(noneSetUp); setRecord({});
          openWelcome();
          await settleUi();
          pasteInto(welcomePaste.input, "AIzaSyFixtureOfflineKey0123456789abcd");
          const request = await takeRequest("/settings/ai");
          // Saved, but Google Gemini couldn't be reached, so its check failed.
          const offline = statusWith({gemini: {configured: true, state: "unavailable", retry_in: 30, key_hint: "abcd", checked: "failed"}});
          aiStatus = offline;
          request.resolve(reply({saved: true, provider: "gemini", label: "Google Gemini",
            test: {ok: false, kind: "unavailable", message: "Google Gemini couldn't be reached. Check your internet connection and try again."}, status: offline}));
          await until(() => welcomePaste.result.classList.contains("is-err"));
          failedPaste = {result: words(welcomePaste.result), next: $("welcomeNext").classList.contains("btn-primary"), paste: welcomePaste.button.classList.contains("btn-primary"),
            pill: $("statusText").textContent};
          $("welcomeNext").click();
          await settleUi();
          failedPaste.tick = $("welcomeCourse").children[0].className;
          failedPaste.note = !$("welcomeNoAi").hidden;
          $("welcomeSkip").click();
        });
        lc(() => failedPaste.result === "Google Gemini couldn't be reached. Check your internet connection and try again." && !failedPaste.next && failedPaste.paste &&
          failedPaste.pill === "Set up AI" && failedPaste.tick === "" && failedPaste.note,
          "QA 1: a pasted key that fails its check isn't connected: Continue stays secondary, Connect AI isn't ticked and the AI button says Set up AI");
        let afterRest = null;
        await act(async () => {
          // Its rest is over (ready) but its check failed: not AI ready, and Get set up still asks for a key.
          setStatus(statusWith({gemini: {configured: true, state: "ready", key_hint: "abcd", checked: "failed"}}));
          setRecord({welcome: "skipped"});
          newListing();
          afterRest = {pill: $("statusText").textContent, tick: $("setupSteps").children[0].classList.contains("is-done"), paste: !setupPaste.root.hidden};
          // A key the service turns down isn't saved (saved: false), and the step stays unticked.
          setupPaste.save("AIzaSyFixtureWrongKey0123456789abcdef");
          const request = await takeRequest("/settings/ai");
          const before = statusWith({gemini: {configured: true, state: "ready", key_hint: "abcd", checked: "failed"}});
          request.resolve(reply({saved: false, provider: "gemini", label: "Google Gemini",
            test: {ok: false, kind: "key_rejected", message: "Google Gemini didn't accept this key. Copy the whole key and paste it again."}, status: before}));
          await until(() => setupPaste.result.classList.contains("is-err"));
          afterRest.rejected = words(setupPaste.result) === "Google Gemini didn't accept this key. Copy the whole key and paste it again. Your saved key (\u2026abcd) is still in use." &&
            !$("setupSteps").children[0].classList.contains("is-done") && $("statusText").textContent === "Set up AI";
        });
        lc(() => afterRest.pill === "Set up AI" && !afterRest.tick && afterRest.paste && afterRest.rejected,
          "QA 1: a service whose check failed isn't AI ready after its rest, Get set up keeps asking for a key, and a key turned down (saved: false) changes nothing");

        /* -- 2. Messages for FreeLLMAPI and every service switched off; a step note says what its message said -- */
        const SERVER = {
          freellmapi_not_running: "FreeLLMAPI isn't running on this computer. Start it, then try again.",
          freellmapi_no_services: "FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then try again.",
          all_disabled: "Every AI service is switched off. Turn one on in Settings › AI.",
          provider_busy: "The AI services couldn't be reached. Your draft is safe. Check your internet connection and try again in 30 seconds."};
        const failures = {};
        for (const kind of Object.keys(SERVER)) {
          await act(async () => {
            setStatus(kind === "all_disabled" ? statusWith({gemini: {configured: true, enabled: false, state: "disabled", key_hint: "a1B2", checked: "ok"}}) : twoSetUp);
            setRecord({});
            clearToasts(); newListing(); typeInto($("notes"), "QA fixture " + kind);
            const run = generate(); const request = await takeRequest("/llm/chat/completions");
            failWith(request, 503, {kind, error: SERVER[kind], ...(kind === "provider_busy" ? {retry_after: 30} : {})});
            await run; await settleUi();
            const item = liveOf("err").at(-1);
            failures[kind] = {text: textOf(item), title: titleOf(item), action: words(actionOf(item)), note: noteOf("generateNote"), fix: noteFixOf("generateNote")};
            if (kind === "all_disabled") {
              actionOf(item).click();
              await settleUi();
              failures[kind].opens = $("settingsOverlay").classList.contains("open") && $("settingsTab-ai").getAttribute("aria-selected") === "true" && !welcomeOpen();
              closeSettings();
            }
          });
        }
        lc(() => ["freellmapi_not_running", "freellmapi_no_services", "all_disabled"].every(kind => failures[kind].text === SERVER[kind] &&
            failures[kind].title === "Couldn't write the listing" && failures[kind].note === "Couldn't write the listing. " + SERVER[kind]) &&
          failures.freellmapi_not_running.action === "" && failures.freellmapi_no_services.action === "" &&
          failures.all_disabled.action === "Set up AI" && failures.all_disabled.fix === "Set up AI" && failures.all_disabled.opens,
          "QA 2: FreeLLMAPI not running, FreeLLMAPI without services and every service switched off each say so; Set up AI opens Settings › AI for the switches");
        lc(() => failures.provider_busy.text === SERVER.provider_busy &&
          failures.provider_busy.note === "Couldn't write the listing. The AI services couldn't be reached. Check your internet connection and try again in a moment.",
          "QA 2: a step note says what its message said (couldn't be reached, not busy), without a countdown that goes stale");

        /* -- 3. The FreeLLMAPI card stays until FreeLLMAPI is connected -- */
        let card = null;
        await act(async () => {
          clearToasts(); closeSettings();
          setStatus(noneSetUp); setRecord({});
          detectReply = {found: true, ready: false, base_url: "http://127.0.0.1:31415/v1", reason: "no_upstreams"};
          openWelcome();
          await until(() => !$("welcomeFound").hidden);
          pasteInto(welcomePaste.input, "freellmapi-0a1b2c3d0a1b2c3d");
          const request = await takeRequest("/settings/ai");
          // Saved, but FreeLLMAPI couldn't answer (no AI services in it yet): its check failed.
          const failing = statusWith({freellmapi: {configured: true, state: "unavailable", retry_in: 30, key_hint: "2c3d", checked: "failed"}});
          aiStatus = failing;
          request.resolve(reply({saved: true, provider: "freellmapi", label: "FreeLLMAPI", test: {ok: false, kind: "unavailable",
            message: "FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then choose Test again."}, status: failing}));
          await until(() => welcomePaste.result.classList.contains("is-err"));
          card = {welcome: !$("welcomeFound").hidden};
          $("welcomeSkip").click();
          await openSettings("ai");
          await until(() => !$("aiFound").hidden);
          card.settings = !$("aiFound").hidden;
          setStatus(statusWith({freellmapi: {configured: true, state: "ready", key_hint: "2c3d", checked: "ok"}}));
          card.goneWhenConnected = $("aiFound").hidden;
          closeSettings();
          detectReply = savedDetect;
        });
        lc(() => card.welcome && card.settings && card.goneWhenConnected,
          "QA 3: when a FreeLLMAPI key doesn't work, the FreeLLMAPI is running card stays in the welcome and Settings until FreeLLMAPI is connected");

        /* -- 4. Two messages at once: screen readers hear both, in order, each once -- */
        let heard = [];
        await act(async () => {
          setStatus(twoSetUp);
          setRecord({welcome: "done", tour: "done", generated: true, tourNotice: true, startHereDismissed: true});
          clearToasts(); newListing(); typeInto($("notes"), "QA fixture first copy");
          const run = generate(); complete(await takeRequest("/llm/chat/completions"), listing("QA first copy title")); await run;
          // Earlier messages have all been read out.
          await until(() => typeof sayQueue === "undefined" || (!sayQueue.length && !sayTimer), 8000);
          const watch = new MutationObserver(() => {
            for (const id of ["toastAnnounce", "toastAlert"]) {
              const text = words($(id));
              if (text && heard[heard.length - 1] !== text) heard.push(text);
            }
          });
          for (const id of ["toastAnnounce", "toastAlert"]) watch.observe($(id), {childList: true, subtree: true, characterData: true});
          $("copyHtmlBtn").click();
          const gap = Number(TOAST_TIMES.sayGap) || 0;
          await until(() => heard.length >= 2, gap * 2 + 1500);
          await wait(gap + 100);
          watch.disconnect();
        });
        lc(() => heard.length === 2 && heard[0] === "Notice: " + ListingCore.GUIDE_TIPS.copyHtml.text &&
          heard[1] === "Done: You're set up. Find the tour and this guide again under Help (?).",
          "QA 4: the first Copy HTML gives two messages at once, and screen readers hear both, in order, each once");

        /* -- 5. The same step failing again: one message, ×2, the new words -- */
        let repeated = null;
        await act(async () => {
          setStatus(twoSetUp);
          clearToasts(); newListing(); typeInto($("notes"), "QA fixture repeated failure");
          const unreachable = n => ({kind: "provider_busy", retry_after: n,
            error: "The AI services couldn't be reached. Your draft is safe. Check your internet connection and try again in " + n + " seconds."});
          let run = generate(); failWith(await takeRequest("/llm/chat/completions"), 503, unreachable(30)); await run;
          run = generate(); failWith(await takeRequest("/llm/chat/completions"), 503, unreachable(27)); await run;
          const items = liveOf("err");
          repeated = {count: items.length, text: textOf(items[0]), times: countOf(items[0])};
        });
        lc(() => repeated.count === 1 && repeated.times === "×2" && repeated.text.endsWith("try again in 27 seconds."),
          "QA 5: the same step failing the same way again shows one message, ×2, with the new words (…27 seconds)");

        /* -- 7. Plain words: the service's name, plain words per service, AI busy only for a rate limit -- */
        let written = "";
        await act(async () => {
          clearToasts(); newListing(); typeInto($("notes"), "QA fixture written with");
          const run = generate(); const request = await takeRequest("/llm/chat/completions");
          request.resolve(reply({model: "freellmapi/auto:fast", provider: "freellmapi", choices: [{message: {content: JSON.stringify(listing("QA written title"))}}]}));
          await run;
          written = words($("modelMeta"));
        });
        lc(() => /^Written with FreeLLMAPI in \d+(\.\d)? s\. Check every fact before you paste it into eBay\.$/.test(written),
          "QA 7: a new listing says which service wrote it by name (Written with FreeLLMAPI), never its model");
        let tipWords = "";
        await act(() => {
          setStatus(statusWith({freellmapi: {configured: true, state: "ready", key_hint: "9f3c", checked: "ok", model: "auto:fast"},
            gemini: {configured: true, state: "rate_limited", retry_in: 40, key_hint: "a1B2", checked: "ok", model: "gemini-flash-latest"},
            groq: {model: "openai/gpt-oss-120b"}, openrouter: {configured: true, enabled: false, state: "disabled", key_hint: "WXYZ", model: "openrouter/free"}}));
          const el = $("aiStatus");
          tipWords = el.dataset.nativeTitle !== undefined ? el.dataset.nativeTitle : el.title;
        });
        lc(() => tipWords === "FreeLLMAPI: ready\nGoogle Gemini: resting 40 s\nGroq: not set up\nOpenRouter: switched off",
          "QA 7: the AI button's tip lists each service in plain words, without model names");
        const pills = [];
        await act(() => {
          for (const [state, rest] of [["unavailable", 30], ["timeout", 12], ["rate_limited", 30]]) {
            setStatus(statusWith({gemini: {configured: true, state, retry_in: rest, key_hint: "a1B2", checked: "ok"}}));
            pills.push($("statusText").textContent + "|" + $("statusDot").className);
          }
          clearTimeout(healthRetryTimer);
        });
        lc(() => pills.join(",") === "AI offline · 30 s|dot off,AI offline · 12 s|dot off,AI busy · 30 s|dot busy",
          "QA 7: the AI button says AI busy only for a rate limit, and AI offline · 30 s when the services couldn't be reached or took too long");

        /* -- 8. Your shop: Skip this step keeps nothing typed -- */
        let skipped = null;
        await act(async () => {
          setStatus(twoSetUp); setRecord({});
          const before = {store: $("storeName").value, year: $("memberYear").value, saved: localStorage.getItem("eb.store"), savedYear: localStorage.getItem("eb.memberYear")};
          openWelcome(1);
          await settleUi();
          typeInto($("welcomeStoreName"), "QA Skipped Store"); $("welcomeStoreName").dispatchEvent(new Event("change"));
          typeInto($("welcomeMemberYear"), "1990"); $("welcomeMemberYear").dispatchEvent(new Event("change"));
          $("welcomeShopSkip").click();
          await settleUi();
          skipped = {tour: !$("welcomeStep2").hidden, kept: $("storeName").value === before.store && $("memberYear").value === before.year &&
            localStorage.getItem("eb.store") === before.saved && localStorage.getItem("eb.memberYear") === before.savedYear, label: words($("welcomeShopSkip"))};
          $("welcomeTourLater").click();
        });
        lc(() => skipped.tour && skipped.kept && skipped.label === "Skip this step",
          "QA 8: Skip this step keeps nothing typed in Your shop (a wrong year isn't saved)");

        /* -- 9. A Notice doesn't look like a Problem, in either theme -- */
        const colours = {};
        await act(async () => {
          for (const theme of ["light", "dark"]) {
            $("appTheme").value = theme; $("appTheme").dispatchEvent(new Event("change"));
            clearToasts();
            const note = toast("note", "QA fixture notice colour."), problem = toast("err", "QA fixture problem colour.");
            const icon = item => getComputedStyle(item.querySelector(".toast-icon"));
            colours[theme] = {note: icon(note).backgroundColor, glyph: icon(note).color, problem: icon(problem).backgroundColor};
          }
          clearToasts();
          $("appTheme").value = savedTheme; $("appTheme").dispatchEvent(new Event("change"));
        });
        lc(() => ["light", "dark"].every(theme => hueApart(colours[theme].note, colours[theme].problem) >= 60 && contrastOf(colours[theme].glyph, colours[theme].note) >= 4.5),
          "QA 9: a Notice has its own calm colour, clearly apart from a Problem's, with AA contrast, in light and dark");

        /* -- 10. Remove: one wording, and its line goes when the button goes back -- */
        let removal = null;
        await act(async () => {
          setStatus(twoSetUp);
          try { SETTINGS_TIMES.removeConfirm = 150; } catch (_) { /* older code */ }
          await openSettings("ai");
          setAiRowOpen(aiRowOf("gemini"), true);
          const button = aiRowOf("gemini").querySelector(".ai-remove"), line = aiRowOf("gemini").querySelector(".key-result");
          const waiting = pending.filter(request => request.path === "/settings/ai").length;
          button.click(); await settleUi();
          removal = {button: words(button), line: line.hidden ? "" : words(line), quiet: pending.filter(request => request.path === "/settings/ai").length === waiting};
          await until(() => words(button) === "Remove" && line.hidden, 1500);
          removal.after = words(button) + "|" + (line.hidden ? "" : words(line));
          closeSettings();
        });
        lc(() => removal.button === "Remove now" && removal.line === "Choose Remove now to delete the Google Gemini key from this computer." && removal.quiet &&
          removal.after === "Remove|", "QA 10: Remove asks once more in the same words on the button and its line (Remove now), and the line goes when the button goes back");

        /* -- 11. Phone line, Start here tip, saved-key box, Settings tab bar -- */
        let phoneLine = null;
        await act(async () => {
          const app = await loadApp("ai=none", 390, 844);
          const input = app.$("welcomePasteMount").querySelector("input");
          pasteInto(input, "freellmapi-0a1b2c3d0a1b2c3d");
          await until(() => app.fixture.pending.some(request => request.path === "/settings/ai"));
          const request = app.fixture.pending.splice(app.fixture.pending.findIndex(item => item.path === "/settings/ai"), 1)[0];
          const connected = statusWith({freellmapi: {configured: true, state: "ready", key_hint: "2c3d", checked: "ok"}});
          app.fixture.setStatus(connected);
          request.resolve(app.fixture.reply({saved: true, provider: "freellmapi", label: "FreeLLMAPI", test: {ok: true, ms: 100, model: "auto:fast"}, status: connected}));
          await until(() => app.$("welcomePasteMount").querySelector(".key-result.is-ok"));
          const line = app.$("welcomePasteMount").querySelector(".key-result"), detail = line.querySelector(".detail");
          const walker = app.doc.createTreeWalker(line, NodeFilter.SHOW_TEXT), text = walker.nextNode(), range = app.doc.createRange();
          range.selectNodeContents(text);
          const textLines = [...range.getClientRects()], last = textLines[textLines.length - 1], first = detail.getClientRects()[0];
          phoneLine = {words: words(line), flows: first.top >= last.top - 1 && line.scrollWidth <= line.clientWidth};
        });
        lc(() => phoneLine.words === "FreeLLMAPI is connected · it answered in 0.1 seconds" && phoneLine.flows,
          "QA 11: on a phone the connected line reads as one sentence; it never splits into two columns");
        let startTip = "";
        await act(async () => {
          setRecord({welcome: "done", tour: "done", generated: true, copied: true, tourNotice: true});
          newListing();
          try { GUIDE_TIMES.tip = 0; } catch (_) { /* older code */ }
          hover($("startHere"));
          await until(() => !$("btnTip").hidden, 1500);
          startTip = words($("btnTip"));
          leave($("startHere"));
        });
        lc(() => (startTip.match(/Start here/g) || []).length === 1 && startTip.includes("type what you're selling"),
          "QA 11: the Start here tooltip says Start here once");
        let holder = null, bar = null;
        await act(async () => {
          setStatus(twoSetUp);
          await openSettings("ai");
          setAiRowOpen(aiRowOf("freellmapi"), true);
          const box = aiRowOf("freellmapi").querySelector(".ai-key"), style = getComputedStyle(box), ctx = document.createElement("canvas").getContext("2d");
          ctx.font = style.fontStyle + " " + style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
          holder = {text: box.placeholder, fits: ctx.measureText(box.placeholder).width <= box.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)};
          closeSettings();
        });
        await act(async () => {
          // A fresh copy of the app at 1366×768 (nothing else on top of it), Settings › AI with every line
          // open so the pane is long, scrolled until a chip is just under the tab bar.
          const app = await loadApp("theme=light&guide=" + encodeURIComponent(JSON.stringify({welcome: "done", tour: "done", copied: true, tourNotice: true})));
          app.fixture.setStatus(twoSetUp);
          app.win.applyAiStatus(twoSetUp);
          await app.win.openSettings("ai");
          const tabs = app.$("settingsTabs"), body = app.$("settingsBody"), before = tabs.getBoundingClientRect().height;
          for (const id of ["freellmapi", "gemini"]) app.win.setAiRowOpen(app.win.aiRowOf(id), true);
          app.win.setAiRowOpen(app.doc.querySelector("#aiRows .ai-group"), true);
          for (const id of ["groq", "openrouter"]) app.win.setAiRowOpen(app.win.aiRowOf(id), true);
          await wait(30);
          const chip = app.win.aiRowOf("freellmapi").querySelector(".ai-chip");
          for (let top = 0; top < body.scrollHeight && chip.getBoundingClientRect().bottom - tabs.getBoundingClientRect().bottom > 3; top++) body.scrollTop = top;
          const line = tabs.getBoundingClientRect(), r = chip.getBoundingClientRect(), hit = app.doc.elementFromPoint((r.left + r.right) / 2, line.bottom - 3);
          bar = {kept: Math.abs(line.height - before) < 0.5 && tabs.scrollHeight <= tabs.clientHeight + 1, over: Boolean(hit) && tabs.contains(hit),
            joined: Math.abs(body.getBoundingClientRect().top - line.bottom) < 0.5, scrolled: body.scrollTop > 0};
        });
        lc(() => holder.text === "Saved (…9f3c)" && holder.fits, "QA 11: a saved key's box says Saved (…9f3c), short enough to fit FreeLLMAPI's narrow box");
        lc(() => bar.kept && bar.over && bar.joined && bar.scrolled,
          "QA 11: Settings › AI scrolled: the tab bar keeps its full height and nothing from the list shows over it");

        /* -- QA re-test 1. A service that is busy accepted the key: calm words, not a problem -- */
        const BUSY = "FreeLLMAPI accepted the key but is busy right now. Marteloio will try it again in 20 seconds.";
        let busyKey = null;
        await act(async () => {
          closeSettings(); clearToasts();
          setStatus(noneSetUp); setRecord({});
          openWelcome();
          await settleUi();
          pasteInto(welcomePaste.input, "freellmapi-0a1b2c3d0a1b2c3d");
          const request = await takeRequest("/settings/ai");
          // The key is saved and connected (its check is "ok"); the service is resting for 20 s.
          const busy = statusWith({freellmapi: {configured: true, state: "rate_limited", retry_in: 20, key_hint: "2c3d", checked: "ok"}});
          aiStatus = busy;
          request.resolve(reply({saved: true, provider: "freellmapi", label: "FreeLLMAPI", test: {ok: false, kind: "rate_limited", message: BUSY}, status: busy}));
          await until(() => !welcomePaste.result.classList.contains("is-busy") && !welcomePaste.result.hidden);
          const line = welcomePaste.result, style = getComputedStyle(line);
          busyKey = {calm: line.classList.contains("is-note") && !line.classList.contains("is-err") && contrastOf(style.color, style.backgroundColor) >= 4.5,
            text: words(line), next: $("welcomeNext").classList.contains("btn-primary"), pill: $("statusText").textContent};
          $("welcomeNext").click();
          await settleUi();
          busyKey.tick = $("welcomeCourse").children[0].className;
          $("welcomeSkip").click();
          // Test again in Settings › AI says it the same calm way.
          await openSettings("ai");
          setAiRowOpen(aiRowOf("freellmapi"), true);
          aiRowOf("freellmapi").querySelector(".ai-test").click();
          (await takeRequest("/ai/test")).resolve(reply({ok: false, kind: "rate_limited", message: BUSY}));
          const row = aiRowOf("freellmapi").querySelector(".key-result");
          await until(() => !row.classList.contains("is-busy"));
          busyKey.row = row.classList.contains("is-note") && !row.classList.contains("is-err") && words(row) === BUSY;
          closeSettings();
        });
        lc(() => busyKey.calm && busyKey.text === BUSY && busyKey.next && busyKey.tick === "is-done" && busyKey.pill === "AI busy · 20 s" && busyKey.row,
          "QA re-test 1: a key whose service is busy is a working key: calm words (not a red problem), Connect AI ticked, AI busy · 20 s");

        /* -- QA re-test 2. After a listing or a section, written or failed, the AI button is checked again at once -- */
        let refreshed = null;
        await act(async () => {
          setStatus(twoSetUp); setRecord({welcome: "done", tour: "done", generated: true, copied: true, tourNotice: true, startHereDismissed: true});
          clearToasts(); newListing(); typeInto($("notes"), "QA re-test status refresh");
          let run = generate(), request = await takeRequest("/llm/chat/completions");
          // While it was writing, the services stopped answering.
          aiStatus = statusWith({freellmapi: {configured: true, state: "unavailable", retry_in: 25, key_hint: "9f3c", checked: "ok"},
            gemini: {configured: true, state: "rate_limited", retry_in: 40, key_hint: "a1B2", checked: "ok"}});
          failWith(request, 503, {kind: "provider_busy", retry_after: 25,
            error: "The AI services couldn't be reached. Your draft is safe. Check your internet connection and try again in 25 seconds."});
          await run;
          await until(() => $("statusText").textContent !== "AI ready", 1500);
          refreshed = {failed: $("statusText").textContent};
          aiStatus = twoSetUp;
          run = generate(); complete(await takeRequest("/llm/chat/completions"), listing("QA re-test refreshed title")); await run;
          await until(() => $("statusText").textContent === "AI ready", 1500);
          refreshed.written = $("statusText").textContent;
          aiStatus = statusWith({freellmapi: {configured: true, state: "rate_limited", retry_in: 30, key_hint: "9f3c", checked: "ok"},
            gemini: {configured: true, state: "rate_limited", retry_in: 45, key_hint: "a1B2", checked: "ok"}});
          run = regenerateSection("title");
          failWith(await takeRequest("/llm/chat/completions"), 429, {kind: "provider_busy", retry_after: 30,
            error: "The AI services are busy right now. Your draft is safe. Try again in 30 seconds."});
          await run;
          await until(() => $("statusText").textContent !== "AI ready", 1500);
          refreshed.section = $("statusText").textContent;
          clearTimeout(healthRetryTimer);
          setStatus(twoSetUp);
        });
        lc(() => refreshed.failed === "AI offline · 25 s" && refreshed.written === "AI ready" && refreshed.section === "AI busy · 30 s",
          "QA re-test 2: after a listing or a section, written or failed, the AI button shows the services' state at once (not AI ready for half a minute)");

        /* -- QA re-test 3. A key turned down while another is saved: the saved one is still in use -- */
        const REJECTED = "Google Gemini didn't accept this key. Copy the whole key and paste it again.";
        let kept = null;
        await act(async () => {
          const before = statusWith({gemini: {configured: true, state: "ready", key_hint: "a1B2", checked: "ok"}});
          setStatus(before); setRecord({welcome: "done", tour: "done", copied: true, tourNotice: true});
          await openSettings("ai");
          keyPaste.save("AIzaSyFixtureWrongKey0123456789abcdef");
          (await takeRequest("/settings/ai")).resolve(reply({saved: false, provider: "gemini", label: "Google Gemini",
            test: {ok: false, kind: "key_rejected", message: REJECTED}, status: before}));
          await until(() => keyPaste.result.classList.contains("is-err"));
          kept = {paste: words(keyPaste.result)};
          // Nothing saved before for Groq: no such sentence.
          keyPaste.save("gsk_fixtureWrongGroqKey0123");
          (await takeRequest("/settings/ai")).resolve(reply({saved: false, provider: "groq", label: "Groq",
            test: {ok: false, kind: "key_rejected", message: "Groq didn't accept this key. Copy the whole key and paste it again."}, status: before}));
          await until(() => words(keyPaste.result).startsWith("Groq"));
          kept.none = words(keyPaste.result);
          // The service's own line says it too.
          setAiRowOpen(aiRowOf("gemini"), true);
          aiRowOf("gemini").querySelector(".ai-key").value = "AIzaSyFixtureWrongKey0123456789abcdef";
          aiRowOf("gemini").querySelector(".ai-save").click();
          (await takeRequest("/settings/ai")).resolve(reply({saved: false, provider: "gemini", label: "Google Gemini",
            test: {ok: false, kind: "key_rejected", message: REJECTED}, status: before}));
          const row = aiRowOf("gemini").querySelector(".key-result");
          await until(() => row.classList.contains("is-err"));
          kept.row = words(row);
          closeSettings();
        });
        lc(() => kept.paste === REJECTED + " Your saved key (\u2026a1B2) is still in use." && kept.none === "Groq didn't accept this key. Copy the whole key and paste it again." &&
          kept.row === REJECTED + " Your saved key (\u2026a1B2) is still in use.",
          "QA re-test 3: a key turned down while another is saved says Your saved key (…a1B2) is still in use.");
      } finally {
        if (clipboard) clipboard.writeText = realWrite;
        try { if (savedGuideTimes) Object.assign(GUIDE_TIMES, savedGuideTimes); } catch (_) { /* older code */ }
        try { if (savedSettingsTimes) Object.assign(SETTINGS_TIMES, savedSettingsTimes); } catch (_) { /* older code */ }
        try { closeWelcome(""); } catch (_) { /* older code */ }
        try { endTour("skipped"); } catch (_) { /* older code */ }
        try { closeSettings(); } catch (_) { /* older code */ }
        for (const frame of frames.splice(0)) frame.remove();
        aiStatus = savedStatus; detectReply = savedDetect;
        try { applyAiStatus(savedStatus); } catch (_) { /* older code */ }
        localStorage.setItem(GUIDE_RECORD, JSON.stringify(GUIDE_DONE));
        try { loadGuide(); } catch (_) { /* older code */ }
        for (const [id, value] of Object.entries(savedSeller)) $(id).value = value;
        for (const [key, value] of Object.entries(savedPrefs)) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
        try { syncSellerFieldHints(); } catch (_) { /* older code */ }
        $("appTheme").value = savedTheme; $("appTheme").dispatchEvent(new Event("change"));
        pending.splice(0);
        clearToasts();
        newListing();
        try { renderGuide(); } catch (_) { /* older code */ }
        if (soft) {
          const note = document.createElement("p");
          note.id = "qa-soft-failures";
          note.dataset.count = String(softFailures.length);
          note.textContent = "QA SOFT FAILURES (" + softFailures.length + "): " + softFailures.join(" | ");
          panel.append(note);
        }
      }
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
      if (new URLSearchParams(location.search).has("wave2")) {
        await wave2Checks();
        title.textContent = passed + " wave 2 checks passed";
        panel.dataset.result = "pass";
        return;
      }
      if (new URLSearchParams(location.search).has("wave3")) {
        await wave3Checks();
        title.textContent = passed + " wave 3 checks passed";
        panel.dataset.result = "pass";
        return;
      }
      if (new URLSearchParams(location.search).has("qa")) {
        await qaChecks();
        title.textContent = passed + " QA fix checks passed";
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
        failure.resolve({ok: false, status, json: async () => ({kind: "provider_busy", error: "The AI services are busy right now. Your draft is safe. Try again in 30 seconds."})});
        await attempt;
        check(state.data.title === "Current listing" && !$("generateBtn").disabled, "Provider " + status + " preserves draft and releases controls");
        const errors = document.querySelectorAll(".toast.err p");
        const message = errors[errors.length - 1].textContent;
        check(message.includes("Try again in 30 seconds") && !/settings|provider|key/i.test(message), "Provider " + status + " shows wait guidance without key checklist");
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
      check(JSON.parse(conditionRequest.opts.body).messages.at(-1).content.includes("Cracked casing; not tested"), "The model receives the condition notes set when Generate was pressed");
      $("condition").value = "FOR_PARTS"; $("condNotes").value = "Edited while waiting";
      complete(conditionRequest, {...listing("Current listing"), condition_rating:"NWT", condition_notes:"Works perfectly", item_specifics:{Condition:"New"}}); await conditionRun;
      check(state.data.condition_rating === "FOR_PARTS" && state.data.condition_notes === "Edited while waiting" && !("Condition" in state.data.item_specifics),
        "Generation applies the form's current condition, changed while the AI was writing, never the AI grade");
      check(state.html.includes("For parts or not working") && state.html.includes("Edited while waiting") && !state.html.includes("Works perfectly") && !state.html.includes("Untested"),
        "Preview shows the seller's latest condition and notes, not the AI's or the earlier ones");
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
        check(miningMessage.includes("just describe the item") && !/keyset|HTTP|retry\b/i.test(miningMessage), "Mining failure offers accurate recovery without guessing credentials: " + failure.status);
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
      renderKeyStatus({provider_storage:'windows_encrypted'});
      check($("settingsKeysNote").textContent === "Keys are saved on this computer, encrypted for your Windows account, and never shown again.",
        "Settings say saved keys are encrypted for this Windows account and never shown again");
      renderKeyStatus({provider_storage:'plaintext'});
      check($("settingsKeysNote").textContent.includes(".env file in the Marteloio folder") && !$("settingsKeysNote").textContent.includes("encrypted"),
        "Settings truthfully describe plaintext storage fallback");
      renderKeyStatus({ebay:{storage:'plaintext'}});
      check($("settingsKeysNote").textContent.includes(".env file"), "eBay Settings do not claim encryption on plaintext systems");
      // A service's own key box (formerly the Groq key field): saved and tested, and a late answer keeps newer typing.
      const groqKeyBox = $("aiKey-groq");
      groqKeyBox.value = 'gsk_fixtureTypedKey0001';
      const rowSave = saveAiRow('groq'); const rowRequest = await nextRequest();
      const rowBody = JSON.parse(rowRequest.opts.body);
      check(rowRequest.path === '/settings/ai' && rowBody.provider === 'groq' && rowBody.key === 'gsk_fixtureTypedKey0001' && aiRowOf('groq').querySelector('.ai-save').disabled,
        "Save and test sends that service's own key and is busy until it answers");
      groqKeyBox.value = 'gsk_newerUnsavedFixture';
      rowRequest.resolve(reply({saved:true, provider:'groq', label:'Groq', test:{ok:true, ms:640, model:'fixture'}, status:aiStatus})); await rowSave;
      check(groqKeyBox.value === 'gsk_newerUnsavedFixture' && !aiRowOf('groq').querySelector('.ai-save').disabled, "A late settings save cannot clear newer typed keys");
      check(!/restart/i.test($("settingsOverlay").textContent), "Settings no longer mention restarting a router");
      showSettingsTab('ebay');
      $("ebayClientSecret").value = 'fixture-visible-secret';
      const eye = document.querySelector('.key-eye[data-for="ebayClientSecret"]'); eye.click();
      check($("ebayClientSecret").type === 'text' && eye.getAttribute('aria-pressed') === 'true', "Key visibility control explicitly reveals the typed value");
      closeSettings();
      check(!groqKeyBox.value && !keyPaste.input.value && !$("ebayClientSecret").value && $("ebayClientSecret").type === 'password' && eye.getAttribute('aria-pressed') === 'false',
        "Closing Settings clears transient secrets and restores masking");
      await openSettings();
      check($("ebayClientSecret").type === 'password' && !$("ebayClientSecret").value && !groqKeyBox.value, "Reopening Settings cannot retain a revealed key field");
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
      closeSettings(); holdSettings = true;
      const earlierOpen = openSettings(); const earlierRead = await nextRequest();
      closeSettings(); await openSettings();
      earlierRead.resolve(reply({ebay:{client_id:{set:true,masked:'STALE-FIXTURE'}}})); await earlierOpen;
      check(!$("ebayClientIdCurrent").textContent.includes('STALE-FIXTURE'), "Late status from a closed Settings session cannot overwrite current status");
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
      disconnectedRequest.resolve(reply({error:"Connect your eBay account in Settings \u203a eBay to fill in your seller numbers.", kind:"ebay_not_connected", fallback:true}));
      await disconnectedStats;
      check($("fbScore").value === '25' && $("fbPct").value === '100' && !$("fetchStatsBtn").disabled &&
        $("ebayStatus").classList.contains("is-err") && $("ebayStatus").textContent.includes('Connect your eBay account'),
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
      check((await invalidSession).message.includes("Marteloio isn't responding") && !appToken, "Malformed session tokens are rejected before use");
      await ensureToken();

      applyDraft({version:1,inputs:{notes:'Backup fixture notes',titleIn:'Backup title'}, mode:'single',
                  html:'<p>Original saved HTML</p>',data:listing('Backup title'),includedItems:[],bundleItems:[]});
      keyPaste.input.value = 'never-export-this-fixture-key'; $("aiKey-gemini").value = 'never-export-this-fixture-key';
      const backupText = draftBackupText();
      check(JSON.parse(backupText).format === 'marteloio-draft' && !backupText.includes('never-export-this-fixture-key'), "Draft backups contain the listing and exclude account key fields");
      keyPaste.input.value = ''; $("aiKey-gemini").value = '';
      $("notes").value = 'Current work before importing';
      const imported = await importDraftFile(new File([backupText], 'fixture-draft.json', {type:'application/json'}));
      check(imported && $("notes").value === 'Backup fixture notes' && state.data.title === 'Backup title' && !state.edited && state.html !== '<p>Original saved HTML</p>' &&
        state.html.includes('Backup title') && !$("editBadge").classList.contains("visible"), "Draft restore recovers editable content and builds its HTML from it, not in Manually edited mode");
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
      check(!busyToast && lastToast('err').includes('The AI took too long to answer') && !$("generateBtn").disabled,
        "A deadline while the generation body is read reports a timeout instead of a stuck busy toast");
      const slowMineBody = mineKeywords("Timeout body fixture"); const slowMineRequest = await nextRequest();
      slowMineRequest.resolve(hangingBody(slowMineRequest)); await tick(); await tick();
      inflight.mine.timedOut = true; inflight.mine.abort(); await slowMineBody;
      check(lastToast('err').includes('eBay took too long to answer') && !$("mineBtn").disabled,
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
        // v0.2.0 wave 3: the pill is a button that says Set up AI, or AI busy with the time.
        [{ready:false, retry_in:12, providers:[{id:'groq', label:'Groq', configured:true, state:'rate_limited', retry_in:12, model:'fixture-model'}]}, 'AI busy · 12 s'],
        [{ready:false, retry_in:0, providers:[{id:'groq', label:'Groq', configured:false, state:'off', retry_in:0, model:''}]}, 'Set up AI'],
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
      check(courseRequest.path === "/llm/chat/completions" && $("generateBtn").disabled && busyToast && !busyToast.isConnected && steps() === "done,now,,",
        "Ctrl+Enter in the form generates: the button is busy at once, a Working message only if it takes a while");
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
      $("aiKey-groq").value = "never-in-template-fixture"; $("ebayClientSecret").value = "never-in-template-secret";
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
      $("aiKey-groq").value = ""; $("ebayClientSecret").value = "";
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
      // A clean slate: a repeated message would count up on the old toast instead of adding one.
      document.querySelectorAll('.toast-item').forEach(item => { item.dataset.seen = '1'; dismissToast(item); });
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
            state.data.title === "Canon AE-1 Program 35mm SLR Film Camera Body" && $("condition").value === "FOR_PARTS" && state.data.condition_rating === "FOR_PARTS" &&
            $("productBarcode").value === "" && $("productSearch").value === "Canon AE-1" && $("templateSuggest").hidden && !$("templateNotice").hidden,
            "Using the suggestion starts from the template with zero AI requests, keeping the condition the seller chose");
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
            const message = lastToast("err"), title = [...document.querySelectorAll(".toast.err .toast-title")].at(-1)?.textContent || "";
            check(JSON.stringify(state.data) === before && state.html === htmlBefore && title.startsWith("Couldn't regenerate the " + section) &&
              message === "The AI's new " + section + " couldn't be used. Choose Regenerate to try again. Your listing was not changed." &&
              !ListingCore.hasJargon(message) && !$("regenBtn").disabled && $("regenNotice").hidden,
              "An invalid " + section + " reply is rejected in plain words (" + reason + ")");
          }
          for (const [status, data] of [[429, {error: "Three AI requests are already running in this app. Wait for a current lookup or generation to finish, then retry. Your draft is safe.", kind: "local_busy"}],
            [429, {error: "The AI services are busy right now. Your draft is safe. Try again in 30 seconds.", kind: "provider_busy", retry_after: 30}]]) {
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
          // (v0.2.0 wave 3: its tooltip's words are a second description.)
          check($("regenBtn").disabled && !$("regenHint").hidden && $("regenHint").textContent.includes("hand-edited") &&
            $("regenBtn").getAttribute("aria-describedby").split(/\s+/)[0] === "regenHint", "Regenerate is disabled with a reason while the HTML is hand-edited");
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
          check(undoToast?.querySelector("p").textContent === "Started a new listing. The previous one is in Drafts \u203a Recent drafts." &&
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
          $("templateSuggestUse").click(); // The seller's own fields stay, so no confirm question is asked.
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
          lc(() => !$("descItemsRow").hidden && $("descToItems").checked && $("descToItems").labels[0].textContent === "Make a bundle item from each line or bullet of the description",
            "Bundle mode offers to make a bundle item from each line or bullet of the description, ticked by default");
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
          await act(() => typeInto($("notes"), "Pikmin 4\nSplatoon 3"));
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
          await act(() => { $("modeBundle").click(); typeInto($("notes"), "Nintendo Switch console\nNintendo Switch Pro Controller\nMario Kart 8"); });
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
          await act(() => typeInto($("notes"), "Nintendo Switch console\nNintendo Switch Pro Controller\nMario Kart 8\nSony DualSense"));
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

      /* ---- v0.2.0 bug fixes (the owner's plan numbers) ---- */
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
        const choose = (el, value) => { el.value = value; el.dispatchEvent(new Event("change", {bubbles: true})); };
        const settle = () => new Promise(resolve => setTimeout(resolve, 480));
        const frames = async n => { for (let i = 0; i < n; i++) await new Promise(resolve => requestAnimationFrame(resolve)); };
        const cards = () => [...document.querySelectorAll("#bundleCards .bundle-card")];
        const cardNames = () => cards().map(card => card.querySelector(".bi-name").value).join("|");
        const liveToasts = kind => [...document.querySelectorAll("#toastPanel .toast-item:not(.leaving) .toast." + kind)];
        const toastWith = (kind, text) => liveToasts(kind).find(card => card.querySelector("p").textContent === text);
        const actionToast = (kind, label) => liveToasts(kind).find(card => card.querySelector(".toast-action")?.textContent === label);
        const generateWith = async data => { const run = generate(); complete(await nextRequest(), data); await run; };
        const clipboard = navigator.clipboard, realWrite = clipboard && clipboard.writeText;
        const copies = [];
        if (clipboard) clipboard.writeText = async text => { copies.push(text); };
        let confirms = 0;
        const fixtureConfirm = window.confirm;
        window.confirm = () => { confirms++; return true; };
        const savedSeller = Object.fromEntries(["memberYear", "fbPct", "logoUrl"].map(id => [id, $(id).value]));
        pending.splice(0);
        try {
          // #2 Bundle items keep their own card's condition and brand after cards are added or deleted.
          setupBundle(["Camera body", "Battery grip", "Charger"]);
          $("notes").value = "Bundle id fixture";
          await act(() => { setBundleConditions(["USED", "NEW", "FOR_PARTS"]); ["Canon", "Meike", ""].forEach((brand, i) => typeInto(cards()[i].querySelector(".bi-brand"), brand)); });
          await act(() => generateWith({...listing("Bundle id fixture"), bundle_items: [{name: "Canon body", description: "Body."},
            {name: "BG-5D grip", description: "Grip."}, {name: "OEM charger", description: "Charger."}]}));
          const itemConditions = () => state.data.bundle_items.map(b => b.condition).join();
          const itemBrands = () => state.data.bundle_items.map(b => b.brand).join();
          lc(() => itemConditions() === "Used,New,For parts or not working" && itemBrands() === "Canon,Meike,", "Bundle fixture: each generated item has its card's condition and brand");
          await act(() => { $("addBundleItemBtn").click(); typeInto(cards().at(-1).querySelector(".bi-name"), "Neck strap"); });
          lc(() => itemConditions() === "Used,New,For parts or not working" && itemBrands() === "Canon,Meike,", "#2 Adding an item card after generating keeps every item's brand and condition");
          await act(() => { typeInto($("condNotes"), "Light wear overall"); choose($("condition"), "USED"); });
          lc(() => itemConditions() === "Used,New,For parts or not working" && state.html.includes("For parts or not working"),
            "#2 Changing Condition or Condition notes after adding a card keeps each item's own condition, even For parts");
          await act(() => cards()[0].querySelector(".remove-card").click());
          await act(() => typeInto($("condNotes"), "Light wear, checked"));
          lc(() => itemConditions() === "Used,New,For parts or not working" && itemBrands() === "Canon,Meike,",
            "#2 Deleting a card keeps the other items' conditions and brands, and its own item keeps what it had");
          await act(() => choose(cards().find(card => card.querySelector(".bi-name").value === "Charger").querySelector("select"), "USED"));
          lc(() => itemConditions() === "Used,New,Used", "#2 A card's new condition reaches only its own item");

          // #3 Generate again keeps an edited listing in Recent drafts, with Undo and no confirm dialog.
          newListing(); typeInto($("notes"), "Edits fixture camera");
          await act(() => generateWith(listing("Edits fixture first title")));
          await act(() => typeInto($("titleIn"), "Seller's own title"));
          confirms = 0;
          await act(() => generateWith(listing("Edits fixture second title")));
          const savedNotice = () => toastWith("ok", "Saved your edited version in Recent drafts.");
          lc(() => confirms === 0 && loadHistory().find(entry => entry.draft.inputs?.titleIn === "Seller's own title")?.draft.data?.title === "Edits fixture first title" &&
            state.data.title === "Edits fixture second title" && savedNotice()?.querySelector(".toast-action")?.textContent === "Undo",
            "#3 Generate again saves an edited title to Recent drafts and says so with Undo, without a confirm dialog");
          await act(() => savedNotice().querySelector(".toast-action").click());
          lc(() => $("titleIn").value === "Seller's own title" && state.data.title === "Edits fixture first title" && confirms === 0 &&
            loadHistory().some(entry => entry.draft.data?.title === "Edits fixture second title"), "#3 Undo brings the edited version back and keeps the new one in Recent drafts");
          await act(() => { $("editDescription").value = "Seller-written description"; $("editDescription").dispatchEvent(new Event("input", {bubbles: true})); $("applyContentBtn").click(); });
          confirms = 0;
          await act(() => generateWith(listing("Edits fixture third title")));
          lc(() => confirms === 0 && state.data.title === "Edits fixture third title" &&
            loadHistory().some(entry => entry.draft.data?.description_paragraphs?.[0] === "Seller-written description"), "#3 Generate again saves applied content edits to Recent drafts");
          await act(() => typeInto($("htmlOut"), "<p>Hand-written fixture HTML</p>"));
          confirms = 0;
          await act(() => generateWith(listing("Edits fixture fourth title")));
          lc(() => confirms === 0 && !state.edited && state.data.title === "Edits fixture fourth title" &&
            loadHistory().some(entry => entry.draft.html === "<p>Hand-written fixture HTML</p>" && entry.draft.edited), "#3 Generate again saves hand-edited HTML to Recent drafts, with no confirm dialog");
          // A clean slate, so a repeated Undo message would be a new toast rather than counting up an old one.
          document.querySelectorAll(".toast-item").forEach(item => { item.dataset.seen = "1"; dismissToast(item); });
          await act(() => generateWith(listing("Edits fixture fifth title")));
          lc(() => state.data.title === "Edits fixture fifth title" && !document.querySelector(".toast-item:not([data-seen]) .toast.ok .toast-action"),
            "#3 A listing without edits is replaced without an extra Recent drafts copy");

          // #29 Recent drafts hold each listing once.
          newListing(); typeInto($("notes"), "Dedupe fixture item");
          await act(() => generateWith(listing("Dedupe fixture title")));
          newListing();
          lc(() => loadHistory().filter(entry => entry.draft.inputs?.notes === "Dedupe fixture item").length === 1,
            "#29 Generate then New listing leaves one Recent drafts entry for the listing, not two");
          typeInto($("notes"), "Duplicate fixture item"); duplicateDraft(); newListing();
          lc(() => loadHistory().filter(entry => entry.draft.inputs?.notes === "Duplicate fixture item").length === 2, "#29 Duplicate still keeps its own copy beside the draft");
          typeInto($("notes"), "Version one");
          await act(() => generateWith(listing("Version fixture")));
          typeInto($("notes"), "Version two");
          await act(() => restoreHistoryDraft(loadHistory().find(entry => entry.draft.inputs?.notes === "Version one").draft));
          newListing();
          lc(() => ["Version one", "Version two"].every(notes => loadHistory().some(entry => entry.draft.inputs?.notes === notes)),
            "#29 Restoring an older version of the current draft keeps the newer version in Recent drafts too");

          // #5 Condition notes applied in Edit content are copied to the form.
          newListing(); typeInto($("notes"), "Condition notes fixture"); choose($("condition"), "USED"); typeInto($("condNotes"), "Light wear");
          await act(() => generateWith(listing("Condition notes fixture")));
          await act(() => { $("editConditionNotes").value = "Small dent on the lid"; $("editConditionNotes").dispatchEvent(new Event("input", {bubbles: true})); $("applyContentBtn").click(); });
          lc(() => $("condNotes").value === "Small dent on the lid" && state.data.condition_notes === "Small dent on the lid", "#5 Applied condition notes are copied to the form's Condition notes");
          await act(() => choose($("condition"), "FOR_PARTS"));
          lc(() => state.data.condition_rating === "FOR_PARTS" && state.data.condition_notes === "Small dent on the lid" && state.html.includes("Small dent on the lid"),
            "#5 Changing Condition afterwards keeps the applied condition notes");

          // #6 A suggested template keeps the seller's own notes and condition.
          localStorage.removeItem(TEMPLATES_KEY); renderTemplates();
          newListing(); typeInto($("productSearch"), "Canon AE-1"); typeInto($("notes"), "Canon AE-1 body. Dent on the prism housing, light meter dead."); choose($("condition"), "FOR_PARTS");
          await act(() => generateWith({...listing("Canon AE-1 35mm SLR Film Camera Body"), description_paragraphs: ["Canon AE-1 body with a dent on the prism housing."]}));
          await act(() => saveTemplate("AE-1 with dent"));
          newListing(); typeInto($("productSearch"), "Canon AE-1"); typeInto($("notes"), "Canon AE-1 body, excellent, meter works, no dents.");
          choose($("condition"), "EUC"); typeInto($("condNotes"), "Light wear on the top plate");
          await settle();
          confirms = 0;
          await act(() => $("templateSuggestUse").click());
          lc(() => state.template?.name === "AE-1 with dent" && state.data?.title === "Canon AE-1 35mm SLR Film Camera Body" && confirms === 0 &&
            $("notes").value === "Canon AE-1 body, excellent, meter works, no dents." && $("condition").value === "EUC" && $("condNotes").value === "Light wear on the top plate" &&
            state.data.condition_rating === "EUC" && state.data.condition_notes === "Light wear on the top plate" && state.html.includes("Light wear on the top plate"),
            "#6 Using a suggested template keeps the seller's own notes and condition, with no confirm dialog");
          lc(() => !/Condition is never saved/.test($("draftsPanel").textContent) && /description is/.test($("templateList").nextElementSibling.textContent),
            "#6 The Templates hint says the description is kept, so the old item's flaws need checking");
          localStorage.removeItem(TEMPLATES_KEY); renderTemplates();

          // #7 A restored backup file is not forced into Manually edited mode.
          newListing(); typeInto($("notes"), "Backup mode fixture");
          await act(() => generateWith(listing("Backup mode fixture title")));
          const plainFile = draftBackupText();
          await act(() => typeInto($("htmlOut"), "<p>Hand-made backup HTML</p>"));
          const handFile = draftBackupText();
          newListing();
          await act(() => importDraftFile(new File([plainFile], "plain.json")));
          lc(() => !state.edited && !$("editBadge").classList.contains("visible") && state.html.includes("Backup mode fixture title"),
            "#7 Restoring a backup file of an unedited listing does not switch to Manually edited");
          await act(() => typeInto($("titleIn"), "Backup mode retitled"));
          lc(() => state.html.includes("Backup mode retitled"), "#7 After restoring a backup file, a title change reaches Copy HTML");
          newListing();
          await act(() => importDraftFile(new File([handFile], "hand.json")));
          lc(() => state.edited && state.html === "<p>Hand-made backup HTML</p>" && actionToast("note", "Rebuild from content"),
            "#7 A backup with hand-edited HTML keeps it and offers Rebuild from content");
          await act(() => actionToast("note", "Rebuild from content").querySelector(".toast-action").click());
          lc(() => !state.edited && state.html.includes("Backup mode fixture title") && !$("editBadge").classList.contains("visible"), "#7 Rebuild from content builds the HTML from the listing again");

          // #8 A draft whose HTML was cleared never shows or copies another listing's HTML.
          newListing(); typeInto($("notes"), "Cleared HTML fixture A");
          await act(() => generateWith(listing("Cleared fixture listing A")));
          await act(() => typeInto($("htmlOut"), ""));
          const clearedDraft = JSON.parse(JSON.stringify(snapshotDraft()));
          newListing(); typeInto($("notes"), "Cleared HTML fixture B");
          await act(() => generateWith(listing("Cleared fixture listing B")));
          await act(() => { applyDraft(clearedDraft); renderDraft(); });
          lc(() => $("htmlOut").value === "" && state.html === "" && $("copyHtmlBtn").disabled && !$("preview").srcdoc.includes("listing B"),
            "#8 Restoring a draft whose HTML was cleared keeps it empty instead of showing another listing's HTML");

          // #13 Web addresses and emails stop Copy HTML and Download until the seller chooses.
          lc(() => ["web addresses", "email", "phone numbers", "social media"].every(words => generationRule(15).includes(words)) &&
            buildSectionSystemPrompt("description").includes(generationRule(15)),
            "#13 The AI instructions forbid web addresses, emails, phone numbers and social media handles, for full and section requests");
          newListing(); typeInto($("notes"), "Contact fixture");
          await act(() => generateWith({...listing("Contact fixture title"), description_paragraphs: ["Great camera.", "Visit www.example.com for more photos."],
            buyer_notes: ["Email me@example.com with questions."]}));
          copies.length = 0;
          await act(async () => { $("copyHtmlBtn").click(); await tick(); await tick(); });
          lc(() => !copies.length && !state.copied && actionToast("err", "Copy anyway")?.querySelector("p").textContent ===
            "This listing contains a web address or email (www.example.com). eBay doesn't allow contact details in listings. Remove it with Edit content, then copy.",
            "#13 Copy HTML names the web address it found and copies nothing");
          await act(async () => { actionToast("err", "Copy anyway").querySelector(".toast-action").click(); await tick(); await tick(); });
          lc(() => copies.length === 1 && copies[0] === state.html && state.copied, "#13 Copy anyway copies the listing");
          {
            const downloads = [], realDownload = window.downloadText;
            window.downloadText = (text, type, name) => downloads.push(name);
            try {
              await act(() => $("downloadBtn").click());
              lc(() => !downloads.length && actionToast("err", "Download anyway"), "#13 Download HTML stops at the web address too");
              await act(() => actionToast("err", "Download anyway").querySelector(".toast-action").click());
              lc(() => downloads.join() === "ebay-listing.html", "#13 Download anyway downloads the listing");
            } finally { window.downloadText = realDownload; }
          }
          newListing(); typeInto($("notes"), "Clean contact fixture");
          await act(() => generateWith(listing("Clean contact fixture title")));
          await act(() => { $("logoUrl").value = "https://i.ebayimg.com/images/g/fixture/s-l500.png"; renderPreview(); });
          copies.length = 0;
          await act(async () => { $("copyHtmlBtn").click(); await tick(); await tick(); });
          lc(() => state.html.includes("https://i.ebayimg.com/images/g/fixture/s-l500.png") && copies.length === 1,
            "#13 The seller's logo address and the Marteloio signature never stop Copy HTML");

          // #23 What's included: typed text is never lost, and each item becomes its own chip.
          newListing(); typeInto($("notes"), "Included fixture camera");
          await act(() => { $("includedInput").value = "Charger, lens cap"; $("includedInput").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true})); });
          lc(() => state.includedItems.join("|") === "Charger|lens cap" && $("includedInput").value === "", "#23 Enter adds one chip for each comma-separated item");
          $("includedInput").value = "Strap; manual";
          let includedPrompt = "";
          await act(async () => {
            const run = generate(); const request = await nextRequest();
            includedPrompt = JSON.parse(request.opts.body).messages.at(-1).content;
            complete(request, listing("Included fixture")); await run;
          });
          lc(() => includedPrompt.includes("WHAT'S INCLUDED (list exactly these items in included_items): Charger, lens cap, Strap, manual") &&
            state.includedItems.join("|") === "Charger|lens cap|Strap|manual" && $("includedInput").value === "", "#23 Generate adds what was typed without Enter, as separate items");
          await act(() => { $("includedInput").focus(); $("includedInput").value = "Battery"; $("notes").focus(); saveDraft(); flushDraft(); });
          lc(() => state.includedItems.at(-1) === "Battery" && $("includedInput").value === "" && JSON.parse(localStorage.getItem(DRAFT_KEY)).includedItems.includes("Battery"),
            "#23 Leaving the field adds what was typed, and it is autosaved");

          // #24 Bundle auto-fill: one card per line or bullet; deleted cards stay deleted; old drafts gain no duplicates.
          newListing();
          await act(() => { $("modeBundle").click(); if (!$("descToItems").checked) $("descToItems").click(); });
          await act(() => typeInto($("notes"), "Lot of 5 Hot Wheels cars, 1990s, some paint chips. Pickup or ship."));
          await settle();
          lc(() => $("descToItems").checked && !cards().length, "#24 Auto-fill stays on, and a one-line description with commas and sentences makes no item cards");
          await act(() => typeInto($("notes"), "Hot Wheels lot:\n- Red Corvette\n- Blue Mustang\n- Green Beetle"));
          await settle();
          lc(() => cardNames() === "Red Corvette|Blue Mustang|Green Beetle", "#24 Each bullet makes one card");
          await act(() => cards()[1].querySelector(".remove-card").click());
          await act(() => typeInto($("notes"), $("notes").value + "\nShipped boxed."));
          await settle();
          lc(() => cardNames() === "Red Corvette|Green Beetle" && $("descItemsCount").textContent === "2 items found",
            "#24 A card the seller deleted does not come back on the next keystroke, and is not counted");
          await act(() => { saveDraft(); flushDraft(); applyDraft(JSON.parse(localStorage.getItem(DRAFT_KEY))); renderDraft(); });
          await act(() => typeInto($("notes"), $("notes").value + " Smoke-free home."));
          await settle();
          lc(() => cardNames() === "Red Corvette|Green Beetle", "#24 The deleted card is remembered with the draft");
          await act(() => {
            applyDraft({version: 1, mode: "bundle", inputs: {notes: "Mario Kart 8 Deluxe and a Pro Controller, both work"},
              bundleItems: [{name: "Mario Kart 8 Deluxe", condition: "EUC", notes: ""}, {name: "Nintendo Switch Pro Controller", condition: "GUC", notes: ""}]});
            renderDraft();
          });
          await act(() => typeInto($("notes"), $("notes").value + "."));
          await settle();
          lc(() => cardNames() === "Mario Kart 8 Deluxe|Nintendo Switch Pro Controller", "#24 Typing in a bundle draft saved before auto-fill adds no duplicate cards");

          // #25 Conditions vary updates the listing straight away.
          setupBundle(["Lens", "Cap"]); $("notes").value = "Varies fixture";
          await act(() => generateWith({...listing("Varies fixture"), bundle_items: [{name: "Lens"}, {name: "Cap"}]}));
          await act(() => $("condVaries").click());
          lc(() => state.condVaries && state.html.includes("Conditions vary across the items in this listing.") && $("htmlOut").value === state.html,
            "#25 Ticking Conditions vary updates the preview and Copy HTML");
          await act(() => $("condVaries").click());
          lc(() => !state.condVaries && !state.html.includes("Conditions vary across"), "#25 Unticking it removes the line again");

          // #26 A focused field is never hidden under the Generate bar, on a desktop or a phone.
          newListing();
          await frames(2);
          {
            const bar = document.querySelector(".gen-bar"), field = $("brand");
            window.scrollBy(0, field.getBoundingClientRect().bottom - innerHeight + 2);
            const covered = field.getBoundingClientRect().bottom > bar.getBoundingClientRect().top;
            field.focus();
            const r = field.getBoundingClientRect();
            lc(() => covered && r.bottom <= bar.getBoundingClientRect().top && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === field,
              "#26 Focusing a field under the Generate bar scrolls it above the bar");
          }
          let phoneFocusClear = false;
          await act(async () => {
            const phone = document.createElement("iframe");
            phone.style.cssText = "width:390px;height:700px;border:0;display:block";
            const loaded = new Promise(resolve => phone.onload = resolve);
            phone.srcdoc = '<!doctype html><html data-theme="light"><head><style>' + document.querySelector("style").textContent + '</style></head><body><main>' +
              $("inputCard").outerHTML + $("outputCard").outerHTML + '</main></body></html>';
            panel.append(phone); await loaded;
            try {
              const doc = phone.contentDocument, win = phone.contentWindow, bar = doc.querySelector(".gen-bar"), field = doc.getElementById("brand");
              doc.querySelectorAll(".card").forEach(card => card.style.animation = "none");
              win.scrollBy(0, field.getBoundingClientRect().bottom - win.innerHeight + 2);
              const covered = field.getBoundingClientRect().bottom > bar.getBoundingClientRect().top;
              field.focus();
              phoneFocusClear = covered && field.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top;
            } finally { phone.remove(); }
          });
          lc(() => phoneFocusClear, "#26 At 390px a focused field is scrolled above the fixed Generate bar");

          // #27 Seller header wording.
          const thisYear = new Date().getFullYear();
          newListing(); typeInto($("notes"), "Header fixture");
          await act(() => generateWith(listing("Header fixture title")));
          await act(() => { typeInto($("memberYear"), String(thisYear)); typeInto($("fbPct"), "99.6%"); renderPreview(); });
          lc(() => state.html.includes("Member since " + thisYear + "<") && state.html.includes("99.6% positive") && !state.html.includes("%%") && !/Member for 0/.test(state.html),
            "#27 The current year reads Member since, and a typed % is not doubled");
          await act(() => { typeInto($("memberYear"), String(thisYear - 1)); renderPreview(); });
          lc(() => state.html.includes("Member for 1 year<"), "#27 One year reads Member for 1 year");
          await act(() => { typeInto($("memberYear"), "15"); typeInto($("fbPct"), "150"); renderPreview(); });
          lc(() => !/Member (for|since)/.test(state.html) && !state.html.includes("150% positive") &&
            !$("memberYearError").hidden && $("memberYear").getAttribute("aria-invalid") === "true" && $("memberYear").getAttribute("aria-describedby") === "memberYearError" &&
            !$("fbPctError").hidden && $("fbPct").getAttribute("aria-invalid") === "true", "#27 A year like 15 or a percentage over 100 is left out, and the field says why");
          await act(() => { typeInto($("memberYear"), "2014"); typeInto($("fbPct"), "99.8"); renderPreview(); });
          lc(() => $("memberYearError").hidden && !$("memberYear").hasAttribute("aria-invalid") && $("fbPctError").hidden && !$("fbPct").hasAttribute("aria-invalid") &&
            state.html.includes("Member for " + (thisYear - 2014) + " years"), "#27 A valid value clears the field hint and shows in the listing");

          // #28 On a phone a new listing scrolls its title into view.
          {
            const motionDescriptor = Object.getOwnPropertyDescriptor(motionMedia, "matches");
            const scrolls = [], realScrollIntoView = Element.prototype.scrollIntoView;
            let phoneDescriptor, reached = 0;
            try {
              Element.prototype.scrollIntoView = function(options) { scrolls.push({el: this, options}); };
              phoneDescriptor = Object.getOwnPropertyDescriptor(phoneMedia, "matches");
              Object.defineProperty(phoneMedia, "matches", {configurable: true, value: true});
              for (const reduced of [false, true]) {
                Object.defineProperty(motionMedia, "matches", {configurable: true, value: reduced});
                newListing(); typeInto($("notes"), "Phone fixture");
                scrolls.length = 0;
                await act(() => generateWith(listing("Phone fixture title")));
                if (scrolls.some(({el, options}) => el.contains($("titleIn")) && options?.block === "start" && options.behavior === (reduced ? "auto" : "smooth"))) reached++;
              }
            } catch (_) { /* older code has no phone layout check */ }
            finally {
              Element.prototype.scrollIntoView = realScrollIntoView;
              if (motionDescriptor) Object.defineProperty(motionMedia, "matches", motionDescriptor); else delete motionMedia.matches;
              if (typeof phoneMedia !== "undefined") { if (phoneDescriptor) Object.defineProperty(phoneMedia, "matches", phoneDescriptor); else delete phoneMedia.matches; }
            }
            lc(() => reached === 2, "#28 On a phone a new listing scrolls its title into view, smoothly unless reduced motion is on");
          }

          // #30 Barcode problems are shown, not hidden under the folded More options.
          // Requests older code sends are answered after each check, so nothing waits forever.
          const answerLeftovers = async (run, before) => { while (pending.length > before) pending.pop().resolve(reply({items: []})); await run; };
          newListing(); typeInto($("productSearch"), "Canon AE-1"); $("productBarcode").value = "012345678905"; $("moreOptions").open = false;
          let pendingBefore = pending.length;
          let lookupRun = lookupProduct(); await tick(); await tick();
          lc(() => pending.length === pendingBefore && $("moreOptions").open && document.activeElement === $("productBarcode") &&
            $("productBarcode").getAttribute("aria-invalid") === "true" && !$("barcodeError").hidden && /searches by this barcode/.test($("barcodeError").textContent),
            "#30 Look up with a barcode hidden in More options shows and marks the barcode instead of searching it");
          await answerLeftovers(lookupRun, pendingBefore);
          let lookupByBarcode = false;
          await act(async () => {
            const run = lookupProduct(); const requests = [await nextRequest(), await nextRequest()];
            lookupByBarcode = requests.every(request => request.path.includes("gtin=012345678905"));
            requests.forEach(request => request.resolve(reply({items: []}))); await run;
          });
          lc(() => lookupByBarcode && $("barcodeError").hidden && !$("productBarcode").hasAttribute("aria-invalid"), "#30 Choosing Look up again searches the barcode now in view");
          pending.splice(0);
          newListing(); typeInto($("productSearch"), "Canon AE-1"); $("productBarcode").value = "123"; $("moreOptions").open = false;
          pendingBefore = pending.length;
          lookupRun = lookupProduct(); await tick(); await tick();
          lc(() => pending.length === pendingBefore && $("moreOptions").open && document.activeElement === $("productBarcode") &&
            $("productBarcode").getAttribute("aria-invalid") === "true" && /8, 12, 13 or 14/.test($("barcodeError").textContent),
            "#30 A barcode that stops Look up is shown, focused and marked");
          await answerLeftovers(lookupRun, pendingBefore);

          // #32 Focus after Restore and after deleting a template.
          newListing(); typeInto($("notes"), "Focus restore fixture");
          await act(() => generateWith(listing("Focus restore fixture title")));
          newListing();
          await act(() => {
            setDraftsMenu(true, false);
            const restore = [...$("historyList").querySelectorAll(".history-row")].find(row => row.textContent.includes("Focus restore fixture title")).querySelector("button");
            restore.focus(); restore.click();
          });
          lc(() => $("draftsPanel").hidden && document.activeElement === $("titleIn") && state.data?.title === "Focus restore fixture title",
            "#32 Restore closes the Drafts panel and puts focus on the restored listing's title");
          await act(() => {
            localStorage.setItem(TEMPLATES_KEY, JSON.stringify([{...buildTemplate("First focus template"), id: "focus-1"}, {...buildTemplate("Second focus template"), id: "focus-2"}]));
            renderTemplates(); setDraftsMenu(true, false);
            const del = $("templateList").querySelector(".template-delete"); del.focus(); del.click();
          });
          lc(() => loadTemplates().map(entry => entry.id).join() === "focus-2" && document.activeElement === $("templateList").querySelector(".template-use"),
            "#32 Deleting a template moves focus to the next template");
          await act(() => { const del = $("templateList").querySelector(".template-delete"); del.focus(); del.click(); });
          lc(() => !loadTemplates().length && document.activeElement === $("draftsBtn"), "#32 Deleting the last template moves focus to the Drafts button");
          setDraftsMenu(false, false); localStorage.removeItem(TEMPLATES_KEY); renderTemplates();

          // #33 A double-click on Copy HTML leaves the label as it was.
          newListing(); typeInto($("notes"), "Double copy fixture");
          await act(() => generateWith(listing("Double copy fixture title")));
          await act(async () => { $("copyHtmlBtn").click(); $("copyHtmlBtn").click(); await tick(); await tick(); });
          await new Promise(resolve => setTimeout(resolve, 1700));
          lc(() => $("copyHtmlBtn").querySelector(".launch-label").textContent === "Copy HTML" && !$("copyHtmlBtn").classList.contains("launched"),
            "#33 After a double-click, Copy HTML returns to its label");

          // #34 Restart advice works on every system.
          lc(() => ![...document.scripts].some(script => /\.bat\b/i.test(script.textContent)) &&
            [...document.scripts].some(script => script.textContent.includes("Restart Marteloio (close it and open it again)")),
            "#34 Restart advice says to close and open Marteloio again, with no .bat file");

          // The browser waits up to 180 s for the AI and refuses notes over 40,000 characters.
          newListing(); typeInto($("notes"), "x".repeat(40001));
          pendingBefore = pending.length;
          const longNotesRun = generate(); await tick(); await tick();
          lc(() => pending.length === pendingBefore && !inflight.generate && document.activeElement === $("notes") &&
            liveToasts("err").at(-1)?.querySelector("p").textContent === "These notes are too long for one listing (over 40,000 characters). Shorten them and try again.",
            "Notes over 40,000 characters are refused before sending, with the notes field focused");
          while (pending.length > pendingBefore) complete(pending.pop(), listing("Overlong notes fixture"));
          await longNotesRun;
          {
            const deadlines = [], realSetTimeout = window.setTimeout;
            window.setTimeout = (fn, ms, ...rest) => { deadlines.push(ms); return realSetTimeout(fn, ms, ...rest); };
            let generateWait = false;
            try {
              newListing(); typeInto($("notes"), "Deadline fixture");
              await act(() => generateWith(listing("Deadline fixture title")));
              generateWait = deadlines.includes(180000);
              deadlines.length = 0;
              await act(async () => { const run = regenerateSection("title"); complete(await nextRequest(), {title: "Deadline fixture new title"}); await run; });
            } finally { window.setTimeout = realSetTimeout; }
            lc(() => generateWait && deadlines.includes(180000) && !deadlines.includes(120000), "Generate and section regenerate wait up to 180 seconds for the AI");
          }

          // New listing cancels a waypoint landing that Generate scheduled but had not started (the flaky check's race).
          {
            const realLanding = window.courseLanding;
            let landings = 0;
            window.courseLanding = () => { landings++; return false; };
            try {
              newListing(); typeInto($("notes"), "Landing fixture");
              await act(() => generateWith(listing("Landing fixture title")));
              newListing();
              await frames(3);
              lc(() => landings === 0 && !document.querySelector(".course-flight") && $("rulerWaypoint").style.opacity === "",
                "New listing cancels a waypoint landing Generate had scheduled, so none starts on the new listing");
              typeInto($("notes"), "Landing fixture two");
              await act(() => generateWith(listing("Landing fixture two")));
              await frames(3);
              lc(() => landings === 1, "Without New listing the scheduled landing still runs, once");
            } finally { window.courseLanding = realLanding; }
          }
        } finally {
          window.confirm = fixtureConfirm;
          if (clipboard) clipboard.writeText = realWrite;
          for (const [id, value] of Object.entries(savedSeller)) { $(id).value = value; $(id).dispatchEvent(new Event("input", {bubbles: true})); }
          localStorage.removeItem(TEMPLATES_KEY); renderTemplates();
          setDraftsMenu(false, false);
          pending.splice(0);
          newListing();
          if (soft) {
            const note = document.createElement("p");
            note.id = "v020-soft-failures";
            note.dataset.count = String(softFailures.length);
            note.textContent = "V0.2.0 SOFT FAILURES (" + softFailures.length + "): " + softFailures.join(" | ");
            panel.append(note);
          }
        }
      }

      await wave2Checks();
      await wave3Checks();
      await qaChecks();

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
