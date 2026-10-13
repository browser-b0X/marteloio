"""Built-in AI provider fallback for Marteloio: FreeLLMAPI -> Gemini -> Groq -> OpenRouter.

Every provider is called through its OpenAI-compatible chat endpoint with plain
urllib, so there is no router process to install, start or restart. A provider
is used when it is configured in the ``keys`` mapping the relay passes in (the
effective environment: os.environ and .env overlaid by the encrypted store) and
the seller has not switched it off. Rate limits and outages bench a provider for
a while and the next one answers. A rejected key stays benched until that
provider's key changes.

FreeLLMAPI (github.com/tashfeenahmed/freellmapi, MIT) is a router the seller runs
on this computer or the home network. It spreads requests over many free tiers,
so it goes first once it is set up. Its address must be local and is never
reached through a proxy.

Keys are never returned, logged or included in error details. Only a one-way
fingerprint of each key is kept in memory, to notice when a key changes; the
status shows a key's last four characters so the seller can tell keys apart.
"""
from __future__ import annotations

import email.utils
import hashlib
import http.client
import ipaddress
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

PROVIDERS: dict = {
    "freellmapi": {
        "label": "FreeLLMAPI", "base": "http://127.0.0.1:31415/v1",
        "env": "FREELLMAPI_KEY", "url_env": "FREELLMAPI_URL",
        # auto:fast picks its fastest model. Versions before 0.4 answer
        # "Profile 'fast' not found", so plain auto is the fallback.
        "model": "auto:fast", "fallbacks": ["auto"],
        "extra": {"reasoning_effort": "low"},
        # It fails over between its own providers before answering: wait longer,
        # bench it only briefly, and never pin one of the models it lists.
        "patience": 110, "self_routing": True, "test_limit": 60,
        # It passes on only standard fields, so leave a thinking model room and end
        # the prompt with the marker some chat templates use for short thinking.
        "thinking_room": 4000, "prompt_suffix": "\n\n{reasoning effort: low}",
    },
    "gemini": {
        "label": "Google Gemini", "base": "https://generativelanguage.googleapis.com/v1beta/openai",
        "env": "GEMINI_API_KEY", "model": "gemini-flash-latest", "fallbacks": ["gemini-3.6-flash"],
        # Thinking can't be switched off on Gemini 3; keep it short so the answer fits.
        "extra": {"reasoning_effort": "low"},
    },
    "groq": {
        "label": "Groq", "base": "https://api.groq.com/openai/v1", "env": "GROQ_API_KEY",
        "model": "openai/gpt-oss-120b",
        "fallbacks": ["openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
        # gpt-oss spends its token budget on hidden reasoning unless told otherwise.
        "extra_for": {"openai/gpt-oss": {"reasoning_effort": "low", "include_reasoning": False}},
    },
    "openrouter": {
        "label": "OpenRouter", "base": "https://openrouter.ai/api/v1", "env": "OPENROUTER_API_KEY",
        # The free router picks one of the currently free models.
        "model": "openrouter/free",
        "extra": {"reasoning": {"effort": "low", "exclude": True}},
        # Measured 2026-10-04: with max_tokens 800 the free router can pick a
        # reasoning model that spends the whole budget thinking and answers with
        # nothing; 3000 answered. Short section requests get this floor here.
        "min_tokens": 2000,
        # Never move to a paid model: a replacement must be a free one.
        "free_only": True,
    },
}
ORDER = ("freellmapi", "gemini", "groq", "openrouter")

# Bench lengths after a failure, in seconds. A rejected key is benched until
# that provider's key changes (see _sync_keys / reset).
_COOLDOWN = {"rate_limited": 60, "unavailable": 30, "timeout": 30, "bad_response": 15,
             "request_rejected": 15, "key_rejected": 10**9}
_SELF_ROUTING_BENCH = 5  # a router picks another model next time (slow or cut-off answers only)
_INSTANT_BENCH = 3       # a local router that refused or has no services answered at once
_CUT_OFF_RETRY = 15      # the least time worth a router's second try after a cut-off answer...
_CLOUD_RESERVE = 45      # ...which still leaves this much of the deadline for the services after it
_FOREVER = 10**8
_MAX_MODEL_TRIES = 8  # the configured model, the fallbacks, then a few listed ones
_MAX_RESPONSE = 2_000_000
_TIMEOUT = 45  # one HTTP call; the whole chat() call is bounded by `deadline`
_TEST_LIMIT = 30
_USER_AGENT = "Marteloio"
_HOME_NETWORKS = tuple(ipaddress.ip_network(net) for net in
                       ("127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))

_LOCK = threading.RLock()
_state: dict = {name: {} for name in ORDER}     # {"until": epoch seconds, "reason": str}
_resolved: dict = {}                             # replacement for a retired configured model
_details: dict = {}                              # redacted provider error text (diagnostics)
_fingerprints: dict = {}                         # provider -> sha256 of its current key and address
_checked: dict = {}                              # provider -> "ok" / "failed" for its current key (status)


class NoProvider(RuntimeError):
    """No configured provider could answer.

    ``code`` is one of: no_provider, key_rejected, rate_limited, unavailable,
    timeout, request, freellmapi_not_running, freellmapi_no_services (FreeLLMAPI
    was the only service tried). ``retry_after`` is set for rate_limited/unavailable.
    """

    def __init__(self, code: str = "no_provider", retry_after: int = 0):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


class _Failed(Exception):
    """One provider's failed attempt: its bench reason and what to tell the seller."""

    def __init__(self, reason: str, retry_after=None, why: str = "", bench: bool = True):
        super().__init__(reason)
        self.reason, self.retry_after, self.why, self.bench = reason, retry_after, why, bench


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the Authorization header to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _urlopen(request, timeout):
    handlers = [_NoRedirect()]
    if _local_host(urlsplit(request.full_url).hostname):
        # A key for a local address never travels through a proxy.
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers).open(request, timeout=timeout)


# -- addresses -----------------------------------------------------------------

def _local_host(host) -> bool:
    """This computer or the home network: localhost, *.local, 127/8, 10/8, 172.16/12, 192.168/16, ::1."""
    host = (host or "").lower()
    if host == "localhost" or re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.local", host):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if address.version == 6:
        return address == ipaddress.ip_address("::1")
    return any(address in network for network in _HOME_NETWORKS)


def _loopback(host) -> bool:
    host = (host or "").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def valid_local_url(value) -> bool:
    """An http(s) address on this computer or the home network, without a user or password."""
    if not isinstance(value, str) or not re.fullmatch(r"[\x21-\x7e]{1,2048}", value):
        return False
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 - raises ValueError for a malformed port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or "@" in parts.netloc or parts.query or parts.fragment:
        return False
    return _local_host(parts.hostname)


def normalize_base(url: str) -> str:
    """An API base without a trailing slash; a bare address gets FreeLLMAPI's /v1."""
    url = url.rstrip("/")
    parts = urlsplit(url)
    if parts.path in ("", "/"):
        url = urlunsplit((parts.scheme, parts.netloc, "/v1", "", ""))
    return url


def _base(name: str, keys) -> str:
    spec = PROVIDERS[name]
    raw = keys.get(spec["url_env"], "") if keys and spec.get("url_env") else ""
    raw = raw.strip() if isinstance(raw, str) else ""
    # An address that is not local is ignored: the key must not leave the home network.
    return normalize_base(raw) if raw and valid_local_url(raw) else spec["base"]


def _tokenised(base: str) -> bool:
    """FreeLLMAPI addresses can carry their own revocable access token: .../v1/t/<token>."""
    return re.search(r"/t/[^/]+", urlsplit(base).path) is not None


def _masked(base: str) -> str:
    return re.sub(r"(/t/)([^/]+)", lambda m: m.group(1) + "\u2026" + m.group(2)[-4:], base)


# -- keys ----------------------------------------------------------------------

def _key(keys, name: str) -> str:
    value = keys.get(PROVIDERS[name]["env"], "") if keys else ""
    return value.strip() if isinstance(value, str) else ""


def _valid_key(value: str) -> bool:
    # Printable ASCII without spaces: anything else cannot be a bearer token and
    # could not be sent in an HTTP header anyway.
    return 1 <= len(value) <= 1024 and re.fullmatch(r"[\x21-\x7e]+", value) is not None


def configured(name: str, keys) -> bool:
    """A key, or (FreeLLMAPI) an address with its own access token."""
    if _key(keys, name):
        return True
    return bool(PROVIDERS[name].get("url_env")) and _tokenised(_base(name, keys))


def usable(keys, disabled=()) -> list:
    """Configured providers the seller has not switched off, in try order."""
    return [name for name in ORDER if name not in disabled and configured(name, keys)]


def _fingerprint(name: str, keys) -> str:
    key = _key(keys, name)
    if PROVIDERS[name].get("url_env"):
        key += "\n" + _base(name, keys)
    return hashlib.sha256(key.encode("utf-8")).hexdigest() if key.strip() else ""


def _clear(name: str) -> None:
    _state[name] = {}
    _resolved.pop(name, None)
    _details.pop(name, None)


def _sync_keys(keys) -> None:
    """Clear a provider's bench when its key or address changed since we last saw it."""
    with _LOCK:
        for name in ORDER:
            fp = _fingerprint(name, keys)
            if _fingerprints.get(name) != fp:
                _fingerprints[name] = fp
                _clear(name)
                _checked.pop(name, None)


def reset(names=None) -> None:
    """Forget benches (all, or the given provider ids / key or address env names)."""
    with _LOCK:
        for name in ORDER:
            spec = PROVIDERS[name]
            if names is None or name in names or spec["env"] in names or spec.get("url_env") in names:
                _clear(name)


_PASTED = (("gemini", ("AIza",)), ("groq", ("gsk_",)), ("openrouter", ("sk-or-",)),
           ("freellmapi", ("freellmapi-", "sk-cp-")))


def clean_pasted(text: str) -> str:
    """A pasted key without surrounding spaces or quotes and without a leading 'Bearer '."""
    for _ in range(2):
        text = text.strip().strip("\"'`\u201c\u201d\u2018\u2019").strip()
        if text[:7].lower() == "bearer ":
            text = text[7:]
    return text.strip()


def recognise(text: str):
    """(provider id, "key" or "url") for pasted text, or (None, None)."""
    if re.match(r"https?://", text, re.I) and "/v1/t/flmurl_" in text:
        return "freellmapi", "url"
    for name, prefixes in _PASTED:
        if text.startswith(prefixes):
            return name, "key"
    return None, None


def valid_key_text(text: str) -> bool:
    return re.fullmatch(r"[\x21-\x7e]{8,1024}", text) is not None


# -- status --------------------------------------------------------------------

def _bench_wait(name: str, now: float) -> Optional[int]:
    """Seconds until `name` is usable: 0 = now, None = never by waiting."""
    until = _state[name].get("until", 0)
    if until <= now:
        return 0
    if until - now >= _FOREVER:
        return None
    return int(until - now) + 1


def retry_in(keys, disabled=()) -> int:
    """Seconds until a usable provider is off the bench (0 if one is ready)."""
    now = time.time()
    waits = []
    with _LOCK:
        for name in usable(keys, disabled):
            wait = _bench_wait(name, now)
            if wait == 0:
                return 0
            if wait is not None:
                waits.append(wait)
    return min(waits) if waits else 0


def check_hint(name: str, keys) -> str:
    """The public hint that tells this key (or FreeLLMAPI address token) apart: its last four characters."""
    key = _key(keys, name)
    if key:
        return key[-4:] if len(key) >= 8 else ""
    token = re.search(r"/t/([^/]+)", urlsplit(_base(name, keys)).path) if PROVIDERS[name].get("url_env") else None
    return token.group(1)[-4:] if token else ""


def checked(name: str, keys) -> str:
    """"ok", "failed" or "" for the current key, from this run only."""
    _sync_keys(keys)
    with _LOCK:
        return _checked.get(name, "")


def status(keys, disabled=(), failed=None) -> dict:
    """{"ready", "retry_in", "providers": [...]} in try order. Each provider entry has
    id, label, configured, enabled, state (off | disabled | ready | a bench reason),
    retry_in, model, key_hint (last four characters, "" without a key), base_url
    (FreeLLMAPI only, its access token shortened) and "checked": "ok" after a
    successful test or listing with the current key, "failed" after a failed test or
    a rejected key, "" when unchecked. "ok" is kept in memory only; `failed` maps
    provider ids to the check hint of a failure saved before a restart, which counts
    while that hint still matches the current key. A new key starts unchecked."""
    _sync_keys(keys)
    failed = failed or {}
    now = time.time()
    providers = []
    with _LOCK:
        for name in ORDER:
            spec = PROVIDERS[name]
            is_configured, enabled = configured(name, keys), name not in disabled
            wait = _bench_wait(name, now)
            if not is_configured:
                state = "off"
            elif not enabled:
                state = "disabled"
            elif wait == 0:
                state = "ready"
            else:
                state = _state[name].get("reason", "unavailable")
            key = _key(keys, name)
            entry = {
                "id": name, "label": spec["label"], "configured": is_configured, "enabled": enabled,
                "state": state, "retry_in": wait if is_configured and enabled and wait else 0,
                "model": _resolved.get(name) or spec["model"],
                "key_hint": key[-4:] if len(key) >= 8 else "",
                "checked": (_checked.get(name) or ("failed" if failed.get(name) and failed[name] == check_hint(name, keys)
                                                    else "")) if is_configured else "",
            }
            if spec.get("url_env"):
                entry["base_url"] = _masked(_base(name, keys))
            providers.append(entry)
    ready = any(p["state"] == "ready" for p in providers)
    return {"ready": ready, "retry_in": 0 if ready else retry_in(keys, disabled), "providers": providers}


# -- calling -------------------------------------------------------------------

def _post(url: str, key: str, payload: dict, timeout: float) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": _USER_AGENT}
    if key:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                     headers=headers, method="POST")
    with _urlopen(request, timeout) as response:
        raw = response.read(_MAX_RESPONSE + 1)
    if len(raw) > _MAX_RESPONSE:
        raise ValueError("response too large")
    return json.loads(raw.decode("utf-8"))


def _retry_seconds(value, default: int) -> int:
    seconds = None
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if re.fullmatch(r"[0-9]{1,9}(\.[0-9]+)?", text):
            seconds = float(text)
        else:
            try:
                when = email.utils.parsedate_to_datetime(text)
                seconds = when.timestamp() - time.time()
            except (TypeError, ValueError, IndexError, OverflowError):
                seconds = None
    if seconds is None:
        return default
    return int(min(max(seconds, 5), 3600))


def _bench(name: str, reason: str, retry_after=None, why: str = "") -> None:
    seconds = _COOLDOWN[reason]
    if reason == "rate_limited":
        seconds = _retry_seconds(retry_after, seconds)
    elif _instant(name, why):
        seconds = _INSTANT_BENCH
    elif PROVIDERS[name].get("self_routing") and reason in ("timeout", "bad_response"):
        seconds = _SELF_ROUTING_BENCH
    with _LOCK:
        _state[name] = {"until": time.time() + seconds, "reason": reason, "why": why}


def _instant(name: str, why: str) -> bool:
    """A local router that refused or has no services answers at once: asking again costs nothing."""
    return bool(PROVIDERS[name].get("self_routing")) and why in ("refused", "no_upstreams")


def _note(name: str, detail: str) -> None:
    with _LOCK:
        _details[name] = detail[:300]


def details() -> dict:
    """Redacted provider error details (diagnostics only; never contains keys)."""
    with _LOCK:
        return dict(_details)


def _redact(message: str, key: str) -> str:
    message = re.sub(r"\s+", " ", message).strip()
    if key and key in message:
        message = message.replace(key, "…")
    message = re.sub(r"\b(sk|gsk|AIza|nvapi|flmurl|freellmapi)[-_A-Za-z0-9]{8,}", "…", message)
    # Any other long opaque token.
    return re.sub(r"[A-Za-z0-9_\-]{24,}", "…", message)


_KEY_INVALID = re.compile(r"api[ _]key[ _](?:not[ _]valid|invalid|expired)|pass a valid api key", re.I)


def _http_info(exc: urllib.error.HTTPError, key: str) -> dict:
    """The provider's error message (redacted), its error code and whether it names a bad key.

    The body can be read only once, so the result is kept on the exception."""
    cached = getattr(exc, "marteloio_info", None)
    if cached:
        return cached
    try:
        raw = exc.read(20000).decode("utf-8", "replace")
    except (OSError, AttributeError, ValueError, http.client.HTTPException):
        raw = ""
    message, code = "", ""
    try:
        body = json.loads(raw)
        if isinstance(body, list) and body and isinstance(body[0], dict):
            body = body[0]
        error = body.get("error") if isinstance(body, dict) else None
        message = error.get("message") if isinstance(error, dict) else error if isinstance(error, str) else ""
        if isinstance(error, dict) and isinstance(error.get("code"), str):
            code = error["code"][:60]
        for field in ("message", "detail"):
            if not message and isinstance(body, dict) and isinstance(body.get(field), str):
                message = body[field]
    except (ValueError, AttributeError, TypeError, RecursionError):
        message = ""
    info = {"detail": _redact(str(message or "HTTP %d" % exc.code), key)[:300], "code": code,
            "key_invalid": _KEY_INVALID.search(raw) is not None}
    exc.marteloio_info = info
    return info


def _http_detail(exc: urllib.error.HTTPError, key: str) -> str:
    return _http_info(exc, key)["detail"]


_PRIVACY = re.compile(r"data policy|privacy", re.I)


def _retired(code: int, detail: str, error_code: str = "") -> bool:
    """The provider says this model is gone or unknown (not a key, quota or account setting)."""
    if code == 404 and _PRIVACY.search(detail):
        return False  # OpenRouter: the account's privacy settings rule out every free endpoint
    if code in (404, 410) or (code in (400, 422) and error_code == "model_not_found"):
        return True
    return code in (400, 422) and re.search(
        r"model.{0,60}(not (found|exist|available|supported)|deprecat|retired|end of life|no longer)"
        r"|(unknown|invalid|unsupported) model"
        # FreeLLMAPI versions without the auto:* profiles read auto:fast as a profile name.
        r"|profile '[^']{1,40}' not found", detail, re.I) is not None


# FreeLLMAPI's names for an answer cut off at the length limit or that wasn't JSON.
_CUT_OFF_CLASSES = {"format_ignored", "empty_completion"}


def _cut_off(detail: str) -> bool:
    """FreeLLMAPI says every model it tried cut its answer off: "(format_ignored ×2)" in its tally."""
    tally = re.search(r"failed with upstream provider errors \(([^)]{1,300})\)", detail)
    if not tally:
        return False
    classes = {part.strip().split(" ")[0] for part in tally.group(1).split(",")}
    return classes <= _CUT_OFF_CLASSES


_SKIP = re.compile(r"embed|vision|-vl\b|guard|reward|retriev|rerank|safety|parse|ocr|clip|whisper|tts|asr|"
                   r"pii|detect|translat|coder|math|audio|image|video|nemoguard|content", re.I)
_PREFER = ("llama-4", "mistral-medium", "mistral-large", "qwen3", "gpt-oss", "llama-3.3", "gemma-3", "llama-3.1-70b")


def _valid_model(value) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 200 and re.fullmatch(r"[A-Za-z0-9._:/@+-]+", value) is not None


def list_models(name: str, key: str, timeout: float = 10, base: Optional[str] = None) -> list:
    headers = {"User-Agent": _USER_AGENT}
    if key:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request((base or PROVIDERS[name]["base"]) + "/models", headers=headers)
    try:
        with _urlopen(request, timeout) as response:
            data = json.loads(response.read(_MAX_RESPONSE).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        exc.close()
        return []
    except (urllib.error.URLError, OSError, ValueError, RecursionError, http.client.HTTPException):
        return []
    items = data.get("data") if isinstance(data, dict) else None
    names = []
    for item in items if isinstance(items, list) else []:
        ident = item.get("id") if isinstance(item, dict) else None
        if _valid_model(ident):
            names.append(ident[len("models/"):] if ident.startswith("models/") else ident)
    return sorted(set(names))


def _discovered(name: str, key: str, timeout: float, base: Optional[str] = None) -> list:
    """Chat models the account lists, best guesses first (used only after retirements)."""
    chat_models = [m for m in list_models(name, key, timeout, base)
                   if re.search(r"instruct|chat|gpt-oss", m, re.I) and not _SKIP.search(m)]
    if PROVIDERS[name].get("free_only"):
        chat_models = [m for m in chat_models if m.endswith(":free") or m == "openrouter/free"]
    rank = lambda m: next((i for i, p in enumerate(_PREFER) if p in m.lower()), len(_PREFER))
    return sorted(chat_models, key=rank)


def _extra(name: str, model: str) -> dict:
    """Provider-specific request fields (reasoning limits for thinking models)."""
    spec = PROVIDERS[name]
    extra = dict(spec.get("extra", {}))
    for prefix, fields in spec.get("extra_for", {}).items():
        if model.startswith(prefix):
            extra.update(fields)
    return extra


def _shaped(name: str, messages: list) -> list:
    """The messages as this provider gets them: a copy whose last user message ends with
    the provider's prompt suffix (the next provider gets the caller's messages unchanged)."""
    suffix = PROVIDERS[name].get("prompt_suffix", "")
    last = messages[-1] if messages else None
    if not suffix or not isinstance(last, dict) or last.get("role") != "user" or not isinstance(last.get("content"), str):
        return messages
    return [*messages[:-1], dict(last, content=last["content"] + suffix)]


def _remaining(name: str, deadline: Optional[float]) -> float:
    limit = PROVIDERS[name].get("patience", _TIMEOUT)
    return limit if deadline is None else min(limit, deadline - time.monotonic())


def _time_left(deadline: Optional[float]) -> float:
    return float("inf") if deadline is None else deadline - time.monotonic()


def _complete(name: str, key: str, base: str, model: str, messages: list, max_tokens: int,
              temperature: float, json_mode: bool, timeout: float, deadline: Optional[float]) -> dict:
    spec = PROVIDERS[name]
    payload = {"model": model, "messages": _shaped(name, messages), "temperature": temperature,
               "max_tokens": max(max_tokens, spec.get("min_tokens", 0)) + spec.get("thinking_room", 0),
               **_extra(name, model)}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    url = base + "/chat/completions"
    try:
        return _post(url, key, payload, timeout)
    except urllib.error.HTTPError as exc:
        info = _http_info(exc, key)
        # Some models reject response_format: retry once without it, in the time that is left.
        if exc.code == 400 and json_mode and not info["key_invalid"] and not _retired(400, info["detail"], info["code"]):
            exc.close()
            payload.pop("response_format", None)
            wait = _remaining(name, deadline)
            if wait < 3:
                raise TimeoutError("timed out: no time left to retry without JSON mode") from None
            return _post(url, key, payload, wait)
        raise


def _complete_any(name: str, key: str, base: str, model: str, messages: list, max_tokens: int,
                  temperature: float, json_mode: bool, deadline: Optional[float]):
    """Ask `model`; if the provider has retired it, walk to a model that still answers."""
    spec = PROVIDERS[name]
    candidates = [model] + [m for m in spec.get("fallbacks", []) if m != model]
    seen = set()
    retired = []
    # A router picks its own models: never pin one it lists.
    discovered = bool(spec.get("self_routing"))
    while candidates and len(seen) < _MAX_MODEL_TRIES:
        current = candidates.pop(0)
        if current in seen:
            continue
        seen.add(current)
        wait = _remaining(name, deadline)
        if wait < 3:
            raise TimeoutError("timed out: out of time for this request")
        try:
            body = _complete(name, key, base, current, messages, max_tokens, temperature, json_mode, wait, deadline)
        except urllib.error.HTTPError as exc:
            info = _http_info(exc, key)
            if not _retired(exc.code, info["detail"], info["code"]):
                raise
            exc.close()
            retired.append(current)
            if not candidates and not discovered:
                discovered = True
                candidates = [m for m in _discovered(name, key, max(1, min(10, _remaining(name, deadline))), base)
                              if m not in seen]
            if not candidates or len(seen) >= _MAX_MODEL_TRIES:
                _note(name, "No offered model answered; tried %s." % ", ".join(retired))
                raise NoProvider("unavailable")
            continue
        if retired:
            _note(name, "%s is no longer offered; using %s instead." % (retired[0], current))
        return body, current
    raise NoProvider("unavailable")


def _parses(text: str) -> bool:
    """JSON the browser can read: as sent, without a code fence, or its outermost {...}."""
    text = re.sub(r"```\s*$", "", re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.I))
    start, end = text.find("{"), text.rfind("}")
    for candidate in (text, text[start:end + 1] if 0 <= start < end else ""):
        try:
            json.loads(candidate)
            return True
        except (ValueError, RecursionError):
            continue
    return False


def _answer(name: str, body: dict, json_mode: bool) -> str:
    choice = body["choices"][0]
    message = choice["message"]
    text = message.get("content")
    if not isinstance(text, str) or not text.strip():
        # A reasoning model that spent the whole budget thinking answers with nothing.
        _note(name, "The model used its whole answer budget on reasoning and returned no text."
              if message.get("reasoning") or message.get("reasoning_content") else "The model returned an empty answer.")
        raise _Failed("bad_response", why="cut_off")
    if choice.get("finish_reason") == "length" or (json_mode and not _parses(text)):
        _note(name, "The answer was cut off, or was not the JSON that was asked for.")
        raise _Failed("bad_response", why="cut_off")
    return text


def _http_failure(name: str, exc: urllib.error.HTTPError, key: str) -> _Failed:
    info = _http_info(exc, key)
    _note(name, info["detail"])
    code = exc.code
    if PROVIDERS[name].get("self_routing"):
        if code == 502 and _cut_off(info["detail"]):
            # Every model it tried cut its answer off; the router itself is fine.
            return _Failed("bad_response", why="cut_off", bench=False)
        if code == 503 and info["code"] in ("no_upstreams_configured", "no_providers_configured"):
            return _Failed("unavailable", why="no_upstreams")
    if code == 429:
        return _Failed("rate_limited", exc.headers.get("Retry-After") if exc.headers else None)
    if code in (401, 403) or (code == 400 and info["key_invalid"]):
        return _Failed("key_rejected")
    if code in (408, 504):
        return _Failed("timeout")
    if code >= 500:
        return _Failed("unavailable")
    if code == 404 and _PRIVACY.search(info["detail"]):
        _note(name, "OpenRouter's privacy settings block its free models. Allow them at "
                    "openrouter.ai/settings/privacy, then try again.")
        return _Failed("request_rejected", why="privacy")
    return _Failed("request_rejected")


def _transport_failure(name: str, exc: BaseException) -> _Failed:
    # urllib wraps a failure to connect in URLError (a connect timeout too): that is an
    # outage. A bare timeout came while waiting for the answer: the service was slow.
    cause = getattr(exc, "reason", exc)
    if not isinstance(exc, urllib.error.URLError) and (isinstance(exc, TimeoutError) or "timed out" in str(exc).lower()):
        _note(name, "The provider took too long to answer.")
        return _Failed("timeout")
    refused = isinstance(cause, ConnectionRefusedError)
    _note(name, "Nothing answered at this address." if refused else "Could not reach the provider.")
    return _Failed("unavailable", why="refused" if refused else "")


def _attempt(name: str, keys, messages: list, max_tokens: int, temperature: float,
             json_mode: bool, deadline: Optional[float], reserve: float = _CLOUD_RESERVE):
    """Ask one provider: (text, model), or raise _Failed. Benching is up to the caller.

    A router's second try after a cut-off answer leaves `reserve` seconds of the deadline."""
    spec = PROVIDERS[name]
    key, base = _key(keys, name), _base(name, keys)
    with _LOCK:
        model = _resolved.get(name) or spec["model"]
    retries = 1 if spec.get("self_routing") else 0
    while True:
        try:
            try:
                body, used = _complete_any(name, key, base, model, messages, max_tokens, temperature,
                                           json_mode, deadline)
                return _answer(name, body, json_mode), used
            except urllib.error.HTTPError as exc:
                failure = _http_failure(name, exc, key)
                exc.close()
                raise failure from None
        except _Failed as failure:
            # A router picks another model next time: one more try if time allows.
            if failure.why == "cut_off" and retries and _time_left(deadline) - reserve >= _CUT_OFF_RETRY:
                retries -= 1
                deadline = None if deadline is None else deadline - reserve
                continue
            raise
        except NoProvider as exc:
            raise _Failed("timeout" if exc.code == "timeout" else "unavailable") from None
        except (TimeoutError, urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise _transport_failure(name, exc) from None
        except (ValueError, KeyError, IndexError, TypeError, AttributeError, RecursionError):
            _note(name, "The reply wasn't in the expected chat format.")
            raise _Failed("bad_response") from None


def _succeeded(name: str, used: str) -> None:
    with _LOCK:
        _state[name] = {}
        _checked[name] = "ok"
        if used != PROVIDERS[name]["model"]:
            _resolved[name] = used


def _outcome(reasons: dict, keys, disabled=(), whys=None) -> NoProvider:
    """One failure for the whole call, from each configured provider's reason."""
    if not reasons:
        return NoProvider("no_provider")
    why = (whys or {}).get("freellmapi")
    if set(reasons) == {"freellmapi"} and why in ("refused", "no_upstreams"):
        # Nothing else was tried: say what is wrong with FreeLLMAPI, not with the internet.
        return NoProvider("freellmapi_not_running" if why == "refused" else "freellmapi_no_services")
    values = set(reasons.values())
    if values == {"key_rejected"}:
        return NoProvider("key_rejected")
    values.discard("key_rejected")
    if values == {"rate_limited"}:
        return NoProvider("rate_limited", max(1, retry_in(keys, disabled)))
    if values <= {"rate_limited", "unavailable"}:
        return NoProvider("unavailable", max(1, retry_in(keys, disabled)))
    if "timeout" in values:
        return NoProvider("timeout")
    return NoProvider("request")


def chat(messages: list, *, keys, max_tokens: int = 3000, temperature: float = 0.2,
         json_mode: bool = True, deadline: Optional[float] = None, disabled=()):
    """Return (text, provider id, model) from the first provider that answers.

    ``keys`` maps key env names (GROQ_API_KEY, ...) to values; ``disabled`` holds
    provider ids the seller switched off. ``deadline`` (a time.monotonic() value)
    bounds the whole call across providers and model retries, so a request never
    outlasts the browser waiting for it. Raises NoProvider when no provider answers."""
    _sync_keys(keys)
    reasons, whys = {}, {}
    for name in usable(keys, disabled):
        with _LOCK:
            bench = dict(_state[name])
        # A router that failed at once is asked again: it may have been started meanwhile.
        if bench.get("until", 0) > time.time() and not _instant(name, bench.get("why", "")):
            reasons[name], whys[name] = bench.get("reason", "unavailable"), bench.get("why", "")
            continue
        key = _key(keys, name)
        if key and not _valid_key(key):
            _note(name, "The saved key contains characters an API key cannot have.")
            _bench(name, "key_rejected")
            _checked[name] = "failed"
            reasons[name] = "key_rejected"
            continue
        if deadline is not None and deadline - time.monotonic() < 4:
            reasons[name] = "timeout"
            continue
        try:
            text, used = _attempt(name, keys, messages, max_tokens, temperature, json_mode, deadline)
        except _Failed as failure:
            if failure.bench:
                _bench(name, failure.reason, failure.retry_after, failure.why)
            if failure.reason == "key_rejected":
                _checked[name] = "failed"
            reasons[name], whys[name] = failure.reason, failure.why
            continue
        _succeeded(name, used)
        return text, name, used
    raise _outcome(reasons, keys, disabled, whys)


# -- test (Settings > AI) ------------------------------------------------------

_TEST_PROMPT = [{"role": "user", "content": 'Reply with this JSON and nothing else: {"ok": true}'}]
_TEST_TEXT = {
    "key_rejected": "{label} didn't accept this key. Copy the whole key and paste it again.",
    "rate_limited": "{label} accepted the key but is busy right now. Marteloio will try it again in {n} seconds.",
    "not_running": "FreeLLMAPI isn't running on this computer. Start it, then choose Test again.",
    "no_upstreams": "FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, "
                    "then choose Test again.",
    "timeout": "{label} didn't answer in time. Try again in a minute.",
    "unavailable": "{label} couldn't be reached. Check your internet connection and try again.",
    "bad_response": "{label} answered, but not in a way Marteloio can use. Try again later.",
    "request_rejected": "{label} answered, but not in a way Marteloio can use. Try again later.",
    "privacy": "OpenRouter answered, but its privacy settings block the free models. On openrouter.ai, "
               "open Settings \u203a Privacy, allow free models, then choose Test again.",
    "not_configured": "Add a key for {label} first.",
}


def _test_failure(name: str, kind: str, text_key: str = "") -> dict:
    wait = _bench_wait(name, time.time()) or _COOLDOWN["rate_limited"]
    message = _TEST_TEXT[text_key or kind].format(label=PROVIDERS[name]["label"], n=wait)
    return {"ok": False, "kind": kind, "message": message}


def test(name: str, keys) -> dict:
    """One tiny request to one provider, ignoring its bench and the order.

    {"ok": true, "ms": .., "model": ..} or {"ok": false, "kind": .., "message": ..}."""
    if name not in PROVIDERS:
        raise ValueError("Unknown provider")
    _sync_keys(keys)
    if not configured(name, keys):
        return _test_failure(name, "not_configured")
    key = _key(keys, name)
    if key and not _valid_key(key):
        _bench(name, "key_rejected")
        _checked[name] = "failed"
        return _test_failure(name, "key_rejected")
    started = time.monotonic()
    deadline = started + PROVIDERS[name].get("test_limit", _TEST_LIMIT)
    try:
        _, used = _attempt(name, keys, _TEST_PROMPT, 600, 0.0, True, deadline, reserve=0)
    except _Failed as failure:
        if failure.bench:
            _bench(name, failure.reason, failure.retry_after, failure.why)
        # A busy answer (429) arrives only after the service accepted the key.
        _checked[name] = "ok" if failure.reason == "rate_limited" else "failed"
        if PROVIDERS[name].get("self_routing") and failure.why in ("refused", "no_upstreams"):
            return _test_failure(name, "not_running" if failure.why == "refused" else "no_upstreams")
        return _test_failure(name, failure.reason, "privacy" if failure.why == "privacy" else "")
    _succeeded(name, used)
    return {"ok": True, "ms": int((time.monotonic() - started) * 1000), "model": used}


# -- FreeLLMAPI detection --------------------------------------------------------

_READY_REASONS = {"no_upstreams_configured": "no_upstreams", "all_upstreams_rate_limited": "busy",
                  "all_upstreams_unhealthy": "unhealthy", "db_unreachable": "unhealthy"}


def _desktop_port(environ) -> Optional[int]:
    """The port FreeLLMAPI's Windows app settled on, from %APPDATA%\\FreeLLMAPI\\config.json."""
    if os.name != "nt" or not environ.get("APPDATA"):
        return None
    try:
        with open(os.path.join(environ["APPDATA"], "FreeLLMAPI", "config.json"), encoding="utf-8-sig") as handle:
            data = json.loads(handle.read(65536))
    except (OSError, ValueError, RecursionError):
        return None
    port = data.get("port") if isinstance(data, dict) else None
    return port if isinstance(port, int) and not isinstance(port, bool) and 1024 <= port <= 65535 else None


def _readyz(origin: str, timeout: float) -> Optional[dict]:
    """FreeLLMAPI's readiness answer at `origin` (no key, no redirects, no proxy), or None.

    Only its own shapes count: 200 {"status": "ok", "ready_upstreams": <int>} or
    503 {"status": "unavailable", "reason": <one of its reasons>}."""
    opener = urllib.request.build_opener(_NoRedirect(), urllib.request.ProxyHandler({}))
    request = urllib.request.Request(origin + "/readyz", headers={"User-Agent": _USER_AGENT})
    try:
        with opener.open(request, timeout=timeout) as response:
            status, raw = response.status, response.read(4096)
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            raw = exc.read(4096)
        except (OSError, AttributeError, http.client.HTTPException):
            raw = b""
        finally:
            exc.close()
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, RecursionError):
        return None
    if not isinstance(data, dict):
        return None
    upstreams = data.get("ready_upstreams")
    if status == 200 and data.get("status") == "ok" and isinstance(upstreams, int) and not isinstance(upstreams, bool):
        return data
    if status == 503 and data.get("status") == "unavailable" and data.get("reason") in _READY_REASONS:
        return data
    return None


def detect_freellmapi(saved_base: str = "", environ=None) -> dict:
    """Look for FreeLLMAPI on this computer: the saved address, its desktop app's port
    (31415, or the one it chose), then Docker/Node's 3001. Loopback addresses only."""
    environ = os.environ if environ is None else environ
    origins = []
    if saved_base and valid_local_url(saved_base) and _loopback(urlsplit(saved_base).hostname):
        parts = urlsplit(saved_base)
        origins.append("%s://%s" % (parts.scheme, parts.netloc))
    port = _desktop_port(environ)
    for origin in ("http://127.0.0.1:31415", "http://127.0.0.1:%d" % port if port else "", "http://127.0.0.1:3001"):
        if origin and origin not in origins:
            origins.append(origin)
    deadline = time.monotonic() + 5
    for origin in origins:
        left = deadline - time.monotonic()
        if left < 0.05:
            break
        answer = _readyz(origin, min(1.5, left))
        if answer is not None:
            ready = answer.get("status") == "ok"
            return {"found": True, "ready": ready, "base_url": origin + "/v1",
                    "reason": "" if ready else _READY_REASONS.get(answer.get("reason"), "unhealthy")}
    return {"found": False, "ready": False, "base_url": "", "reason": "not_running"}
