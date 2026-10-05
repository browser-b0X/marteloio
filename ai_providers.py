"""Built-in AI provider fallback for Marteloio: Gemini -> Groq -> OpenRouter.

Every provider is called through its OpenAI-compatible chat endpoint with plain
urllib, so there is no router process to install, start or restart. A provider
is used only when its key is present in the ``keys`` mapping the relay passes
in (the effective environment: os.environ and .env overlaid by the encrypted
store). Rate limits and outages bench a provider for a while and the next one
answers. A rejected key stays benched until that provider's key changes.

Keys are never returned, logged or included in error details. Only a one-way
fingerprint of each key is kept in memory, to notice when a key changes.
"""
from __future__ import annotations

import email.utils
import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Optional

PROVIDERS: dict = {
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
    },
}
ORDER = ("gemini", "groq", "openrouter")

# Bench lengths after a failure, in seconds. A rejected key is benched until
# that provider's key changes (see _sync_keys / reset).
_COOLDOWN = {"rate_limited": 60, "unavailable": 30, "timeout": 30, "bad_response": 15,
             "request_rejected": 15, "key_rejected": 10**9}
_FOREVER = 10**8
_MAX_MODEL_TRIES = 8  # the configured model, the fallbacks, then a few listed ones
_MAX_RESPONSE = 2_000_000
_TIMEOUT = 45  # one HTTP call; the whole chat() call is bounded by `deadline`
_USER_AGENT = "Marteloio"

_LOCK = threading.RLock()
_state: dict = {name: {} for name in ORDER}     # {"until": epoch seconds, "reason": str}
_resolved: dict = {}                             # replacement for a retired configured model
_details: dict = {}                              # redacted provider error text (diagnostics)
_fingerprints: dict = {}                         # provider -> sha256 of its current key


class NoProvider(RuntimeError):
    """No configured provider could answer.

    ``code`` is one of: no_provider, key_rejected, rate_limited, unavailable,
    timeout, request. ``retry_after`` is set for rate_limited/unavailable.
    """

    def __init__(self, code: str = "no_provider", retry_after: int = 0):
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the Authorization header to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _urlopen(request, timeout):
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)


# -- keys ----------------------------------------------------------------------

def _key(keys, name: str) -> str:
    value = keys.get(PROVIDERS[name]["env"], "") if keys else ""
    return value.strip() if isinstance(value, str) else ""


def _valid_key(value: str) -> bool:
    # Printable ASCII without spaces: anything else cannot be a bearer token and
    # could not be sent in an HTTP header anyway.
    return 1 <= len(value) <= 1024 and re.fullmatch(r"[\x21-\x7e]+", value) is not None


def _fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest() if value else ""


def _clear(name: str) -> None:
    _state[name] = {}
    _resolved.pop(name, None)
    _details.pop(name, None)


def _sync_keys(keys) -> None:
    """Clear a provider's bench when its key changed since we last saw it."""
    with _LOCK:
        for name in ORDER:
            fp = _fingerprint(_key(keys, name))
            if _fingerprints.get(name) != fp:
                _fingerprints[name] = fp
                _clear(name)


def reset(names=None) -> None:
    """Forget benches (all, or the given provider ids / key env names)."""
    with _LOCK:
        for name in ORDER:
            if names is None or name in names or PROVIDERS[name]["env"] in names:
                _clear(name)


# -- status --------------------------------------------------------------------

def _bench_wait(name: str, now: float) -> Optional[int]:
    """Seconds until `name` is usable: 0 = now, None = never by waiting."""
    until = _state[name].get("until", 0)
    if until <= now:
        return 0
    if until - now >= _FOREVER:
        return None
    return int(until - now) + 1


def retry_in(keys) -> int:
    """Seconds until a configured provider is off the bench (0 if one is ready)."""
    now = time.time()
    waits = []
    with _LOCK:
        for name in ORDER:
            if not _key(keys, name):
                continue
            wait = _bench_wait(name, now)
            if wait == 0:
                return 0
            if wait is not None:
                waits.append(wait)
    return min(waits) if waits else 0


def status(keys) -> dict:
    _sync_keys(keys)
    now = time.time()
    providers = []
    with _LOCK:
        for name in ORDER:
            spec = PROVIDERS[name]
            configured = bool(_key(keys, name))
            wait = _bench_wait(name, now)
            if not configured:
                state = "off"
            elif wait == 0:
                state = "ready"
            else:
                state = _state[name].get("reason", "unavailable")
            providers.append({
                "id": name, "label": spec["label"], "configured": configured, "state": state,
                "retry_in": wait if configured and wait else 0,
                "model": _resolved.get(name) or spec["model"],
            })
    ready = any(p["state"] == "ready" for p in providers)
    return {"ready": ready, "retry_in": 0 if ready else retry_in(keys), "providers": providers}


# -- calling -------------------------------------------------------------------

def _post(url: str, key: str, payload: dict, timeout: float) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": _USER_AGENT,
               "Authorization": "Bearer " + key}
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


def _bench(name: str, reason: str, retry_after=None) -> None:
    seconds = _COOLDOWN[reason]
    if reason == "rate_limited":
        seconds = _retry_seconds(retry_after, seconds)
    with _LOCK:
        _state[name] = {"until": time.time() + seconds, "reason": reason}


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
    message = re.sub(r"\b(sk|gsk|AIza|nvapi)[-_A-Za-z0-9]{8,}", "…", message)
    # Any other long opaque token.
    return re.sub(r"[A-Za-z0-9_\-]{24,}", "…", message)


def _http_detail(exc: urllib.error.HTTPError, key: str) -> str:
    """The provider's own error message, minus anything that could echo the key.

    The body can be read only once, so the result is kept on the exception."""
    cached = getattr(exc, "marteloio_detail", None)
    if cached:
        return cached
    try:
        body = json.loads(exc.read(20000).decode("utf-8", "replace"))
        if isinstance(body, list) and body and isinstance(body[0], dict):
            body = body[0]
        error = body.get("error") if isinstance(body, dict) else None
        message = error.get("message") if isinstance(error, dict) else error if isinstance(error, str) else ""
        if not message and isinstance(body, dict) and isinstance(body.get("message"), str):
            message = body["message"]
        if not message and isinstance(body, dict) and isinstance(body.get("detail"), str):
            message = body["detail"]
    except (ValueError, OSError, AttributeError, TypeError):
        message = ""
    message = _redact(str(message or "HTTP %d" % exc.code), key)[:300]
    exc.marteloio_detail = message
    return message


def _retired(code: int, detail: str) -> bool:
    """The provider says this model is gone or unknown (not a key or quota problem)."""
    if code in (404, 410):
        return True
    return code in (400, 422) and re.search(
        r"model.{0,60}(not (found|exist|available|supported)|deprecat|retired|end of life|no longer)"
        r"|(unknown|invalid|unsupported) model", detail, re.I) is not None


_SKIP = re.compile(r"embed|vision|-vl\b|guard|reward|retriev|rerank|safety|parse|ocr|clip|whisper|tts|asr|"
                   r"pii|detect|translat|coder|math|audio|image|video|nemoguard|content", re.I)
_PREFER = ("llama-4", "mistral-medium", "mistral-large", "qwen3", "gpt-oss", "llama-3.3", "gemma-3", "llama-3.1-70b")


def _valid_model(value) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 200 and re.fullmatch(r"[A-Za-z0-9._:/@+-]+", value) is not None


def list_models(name: str, key: str, timeout: float = 10) -> list:
    request = urllib.request.Request(PROVIDERS[name]["base"] + "/models",
                                     headers={"User-Agent": _USER_AGENT, "Authorization": "Bearer " + key})
    try:
        with _urlopen(request, timeout) as response:
            data = json.loads(response.read(_MAX_RESPONSE).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        exc.close()
        return []
    except (urllib.error.URLError, OSError, ValueError):
        return []
    items = data.get("data") if isinstance(data, dict) else None
    names = []
    for item in items if isinstance(items, list) else []:
        ident = item.get("id") if isinstance(item, dict) else None
        if _valid_model(ident):
            names.append(ident[len("models/"):] if ident.startswith("models/") else ident)
    return sorted(set(names))


def _discovered(name: str, key: str, timeout: float) -> list:
    """Chat models the account lists, best guesses first (used only after retirements)."""
    chat_models = [m for m in list_models(name, key, timeout)
                   if re.search(r"instruct|chat|gpt-oss", m, re.I) and not _SKIP.search(m)]
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


def _complete(name: str, key: str, model: str, messages: list, max_tokens: int,
              temperature: float, json_mode: bool, timeout: float) -> dict:
    payload = {"model": model, "messages": messages, "temperature": temperature,
               "max_tokens": max(max_tokens, PROVIDERS[name].get("min_tokens", 0)), **_extra(name, model)}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    url = PROVIDERS[name]["base"] + "/chat/completions"
    try:
        return _post(url, key, payload, timeout)
    except urllib.error.HTTPError as exc:
        # Some models reject response_format: retry once without it.
        if exc.code == 400 and json_mode and not _retired(400, _http_detail(exc, key)):
            exc.close()
            payload.pop("response_format", None)
            return _post(url, key, payload, timeout)
        raise


def _remaining(deadline: Optional[float]) -> float:
    return _TIMEOUT if deadline is None else min(_TIMEOUT, deadline - time.monotonic())


def _complete_any(name: str, key: str, model: str, messages: list, max_tokens: int,
                  temperature: float, json_mode: bool, deadline: Optional[float]):
    """Ask `model`; if the provider has retired it, walk to a model that still answers."""
    candidates = [model] + [m for m in PROVIDERS[name].get("fallbacks", []) if m != model]
    seen = set()
    retired = []
    discovered = False
    while candidates and len(seen) < _MAX_MODEL_TRIES:
        current = candidates.pop(0)
        if current in seen:
            continue
        seen.add(current)
        wait = _remaining(deadline)
        if wait < 3:
            raise TimeoutError("timed out: out of time for this request")
        try:
            body = _complete(name, key, current, messages, max_tokens, temperature, json_mode, wait)
        except urllib.error.HTTPError as exc:
            if not _retired(exc.code, _http_detail(exc, key)):
                raise
            exc.close()
            retired.append(current)
            if not candidates and not discovered:
                discovered = True
                candidates = [m for m in _discovered(name, key, max(1, min(10, _remaining(deadline))))
                              if m not in seen]
            if not candidates or len(seen) >= _MAX_MODEL_TRIES:
                _note(name, "No offered model answered; tried %s." % ", ".join(retired))
                raise NoProvider("unavailable")
            continue
        if retired:
            _note(name, "%s is no longer offered; using %s instead." % (retired[0], current))
        return body, current
    raise NoProvider("unavailable")


def _outcome(reasons: dict, keys) -> NoProvider:
    """One failure for the whole call, from each configured provider's reason."""
    if not reasons:
        return NoProvider("no_provider")
    values = set(reasons.values())
    if values == {"key_rejected"}:
        return NoProvider("key_rejected")
    values.discard("key_rejected")
    if values == {"rate_limited"}:
        return NoProvider("rate_limited", max(1, retry_in(keys)))
    if values <= {"rate_limited", "unavailable"}:
        return NoProvider("unavailable", max(1, retry_in(keys)))
    if "timeout" in values:
        return NoProvider("timeout")
    return NoProvider("request")


def chat(messages: list, *, keys, max_tokens: int = 3000, temperature: float = 0.2,
         json_mode: bool = True, deadline: Optional[float] = None):
    """Return (text, provider id, model) from the first provider that answers.

    ``keys`` maps key env names (GROQ_API_KEY, ...) to values. ``deadline``
    (a time.monotonic() value) bounds the whole call across providers and model
    retries, so a request never outlasts the browser waiting for it.
    Raises NoProvider when no configured provider answers."""
    _sync_keys(keys)
    reasons = {}
    for name in ORDER:
        key = _key(keys, name)
        if not key:
            continue
        with _LOCK:
            bench = dict(_state[name])
            model = _resolved.get(name) or PROVIDERS[name]["model"]
        if bench.get("until", 0) > time.time():
            reasons[name] = bench.get("reason", "unavailable")
            continue
        if not _valid_key(key):
            _note(name, "The saved key contains characters an API key cannot have.")
            _bench(name, "key_rejected")
            reasons[name] = "key_rejected"
            continue
        if deadline is not None and deadline - time.monotonic() < 4:
            reasons[name] = "timeout"
            continue
        try:
            body, used = _complete_any(name, key, model, messages, max_tokens, temperature, json_mode, deadline)
            message = body["choices"][0]["message"]
            text = message.get("content")
            if not isinstance(text, str) or not text.strip():
                # A reasoning model that spent the whole budget thinking answers with nothing.
                _note(name, "The model used its whole answer budget on reasoning and returned no text."
                      if message.get("reasoning") or message.get("reasoning_content") else "The model returned an empty answer.")
                raise ValueError("empty")
            with _LOCK:
                _state[name] = {}
                if used != PROVIDERS[name]["model"]:
                    _resolved[name] = used
            return text, name, used
        except NoProvider as exc:
            _bench(name, "unavailable")
            reasons[name] = "unavailable" if exc.code != "timeout" else "timeout"
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                reason = "rate_limited"
            elif exc.code in (401, 403):
                reason = "key_rejected"
            elif exc.code in (408, 504):
                reason = "timeout"
            elif exc.code >= 500:
                reason = "unavailable"
            else:
                reason = "request_rejected"
            _note(name, _http_detail(exc, key))
            _bench(name, reason, exc.headers.get("Retry-After") if exc.headers else None)
            exc.close()
            reasons[name] = reason
        except (TimeoutError, urllib.error.URLError, OSError) as exc:
            reason = "timeout" if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower() else "unavailable"
            _note(name, "The provider took too long to answer." if reason == "timeout" else "Could not reach the provider.")
            _bench(name, reason)
            reasons[name] = reason
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            if str(exc) != "empty":
                _note(name, "The reply wasn't in the expected chat format.")
            _bench(name, "bad_response")
            reasons[name] = "bad_response"
    raise _outcome(reasons, keys)
