#!/usr/bin/env python3
"""Local relay + static server for Marteloio (eBay listing builder).

Serves index.html on :8080 and proxies eBay API calls, because eBay
endpoints send no CORS headers and the browser cannot call them directly.
Stdlib only - runs under the uv-managed CPython, no pip installs.
"""
import json
import math
import unicodedata
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
import hashlib
import http.client
import os
import secrets
import socket
import sys
import tempfile
import socketserver
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from base64 import b64decode, b64encode
from http.server import BaseHTTPRequestHandler, HTTPServer

import ai_providers
import app_paths

BASE_DIR = app_paths.APP_DIR    # the code
DATA_DIR = app_paths.DATA_DIR   # keys, settings and logs (the same folder for a ZIP copy)
VERSION = app_paths.VERSION
BUILD = app_paths.build_id(BASE_DIR)
INSTALLED = app_paths.INSTALLED
ENV_PATH = os.path.join(DATA_DIR, ".env")
TOKEN_PATH = os.path.join(DATA_DIR, ".ebay_token.json")
SECRETS_PATH = os.path.join(DATA_DIR, ".marteloio-secrets.enc")
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")
# Pre-rename store: read while the new file does not exist, removed after the
# first verified write of the new file.
LEGACY_SECRETS_PATH = os.path.join(BASE_DIR, ".lanzalister-secrets.enc")
PORT = 8080
SESSION_TOKEN = secrets.token_urlsafe(32)
MAX_BODY = 128 * 1024
MAX_UPSTREAM_BODY = 4 * 1024 * 1024
REJECT_DRAIN_TIMEOUT = 0.25
APP_ID = hashlib.sha256(os.path.normcase(BASE_DIR).encode()).hexdigest()[:16]
_OAUTH_STATES = {}
_OAUTH_LOCK = threading.Lock()
_USER_TOKEN_LOCK = threading.RLock()
_ENV_LOCK = threading.RLock()
_COMPLETION_SLOTS = threading.BoundedSemaphore(3)
_SETTINGS_LOCK = threading.Lock()
# The whole provider fallback must finish before the browser stops waiting (180 s).
COMPLETION_DEADLINE = 160
# Answer budget for a full listing; a request may ask for less (64 or more).
COMPLETION_MAX_TOKENS = 3000
MAX_NOTES = 40000


def atomic_write(path, text):
    fd, tmp = tempfile.mkstemp(prefix=".marteloio-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        for attempt in range(3):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if os.name != "nt" or attempt == 2:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def safe_value(value):
    if not isinstance(value, str) or len(value) > 8192:
        raise ValueError("Expected a text value of at most 8192 characters")
    # Cc covers C0, DEL and C1 (including U+0085 NEL); Zl/Zp are U+2028/U+2029.
    # Any of these could start a new line in .env or in a header.
    if any(unicodedata.category(c) in ("Cc", "Zl", "Zp") for c in value):
        raise ValueError("Control characters and line separators are not allowed")
    return value.strip()


class UpstreamError(ValueError):
    """An upstream service answered with something unreadable (HTTP 502, fixed text)."""


class RequestError(ValueError):
    """A request the app can't serve, with a plain message and a kind for the UI."""

    def __init__(self, message, kind="invalid_request", status=400):
        super().__init__(message)
        self.kind = kind
        self.status = status


class EbayAuthError(RuntimeError):
    """eBay's token service turned down the request (HTTP 400/401): usually the keys."""

    def __init__(self, code):
        super().__init__("eBay rejected the request: HTTP %d" % code)
        self.code = code


UPSTREAM_ERROR_MESSAGE = "eBay sent an answer Marteloio couldn't read. Try again in a minute, or just describe the item."
SERVER_ERROR_MESSAGE = "Marteloio couldn't finish this. Try again in a minute."
# Menu paths use the single right-pointing angle quote (U+203A).
EBAY_MESSAGES = {
    "ebay_not_configured": "Look up needs an eBay key (optional). Add one in Settings \u203a eBay, or just describe the item.",
    "ebay_auth": "eBay didn't accept your eBay keys. Check the Client ID and Client Secret in Settings \u203a eBay.",
    "ebay_unavailable": "eBay couldn't be reached. Try again in a minute, or just describe the item.",
    "ebay_listing_gone": "This listing is no longer on eBay. Pick another one.",
    "ebay_busy": "Marteloio is already looking up several items. Wait a moment, then try again.",
    "ebay_storage": "Marteloio couldn't read your saved eBay keys. This happens after moving to another PC "
                    "or Windows account. Enter them again in Settings \u203a eBay.",
}
EBAY_STATUS = {"ebay_auth": 502, "ebay_unavailable": 502, "ebay_storage": 503}
INVALID_BARCODE_MESSAGE = "Check the barcode: it should have 8, 12, 13 or 14 digits."
NOTES_TOO_LONG_MESSAGE = ("These notes are too long for one listing (over 40,000 characters). "
                          "Shorten them and try again.")


def ebay_error(kind):
    return {"error": EBAY_MESSAGES[kind], "kind": kind, "fallback": True}


def env_lines(text):
    """Split .env text on newlines only; str.splitlines() also splits on U+2028 etc."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return [line[:-1] if line.endswith("\r") else line for line in lines]


NO_PROVIDER_MESSAGE = "Connect an AI service first. It takes about 2 minutes with a free Google key."
# Generation errors that need a plain sentence of their own (all 503).
SERVICE_MESSAGES = {
    "all_disabled": "Every AI service is switched off. Turn one on in Settings \u203a AI.",
    "freellmapi_not_running": "FreeLLMAPI isn't running on this computer. Start it, then try again.",
    "freellmapi_no_services": "FreeLLMAPI is running but has no AI services yet. Add a key on its Keys page, then try again.",
}


def provider_failure(reason, retry_after=None):
    """Safe, actionable errors for an ai_providers.NoProvider code.

    Never echo upstream bodies or credentials."""
    if reason == "no_provider":
        return 503, {"error": NO_PROVIDER_MESSAGE, "kind": "no_provider"}
    if reason in SERVICE_MESSAGES:
        return 503, {"error": SERVICE_MESSAGES[reason], "kind": reason}
    if reason in ("rate_limited", "unavailable"):
        seconds = 30 if reason == "rate_limited" else 15
        try:
            seconds = max(1, min(int(retry_after), 3600))
        except (TypeError, ValueError, OverflowError):
            pass
        wait = "%d second%s" % (seconds, "" if seconds == 1 else "s")
        message = ("The AI services are busy right now. Your draft is safe. Try again in %s." % wait
                   if reason == "rate_limited" else
                   "The AI services couldn't be reached. Your draft is safe. "
                   "Check your internet connection and try again in %s." % wait)
        return (429 if reason == "rate_limited" else 503), {
            "error": message, "kind": "provider_busy", "retry_after": seconds}
    if reason == "key_rejected":
        return 502, {"error": "Your AI key was turned down. Open Settings \u203a AI and paste a new key.",
                     "kind": "provider_auth"}
    if reason == "timeout":
        return 504, {"error": "The AI took too long to answer. Your draft is safe. Try again in a moment.",
                     "kind": "provider_timeout"}
    return 502, {"error": "The AI couldn't write this listing. Your draft is safe. Try again; "
                          "if it keeps happening, shorten your notes.", "kind": "provider_request"}

OAUTH_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
TRADING_URL = "https://api.ebay.com/ws/api.dll"
BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search"


def load_env():
    for key, value in app_paths.read_env_file(ENV_PATH).items():
        os.environ.setdefault(key, value)


# ---------------- DPAPI at-rest encryption (Windows only) ----------------
# User-scope DPAPI stops other local accounts, offline/copy-off-machine theft
# and casual plaintext reads. It does NOT stop another process running as this
# same Windows user (such a process can call CryptUnprotectData itself).

_DPAPI = False
crypt32 = None
kernel32 = None
if os.name == "nt":
    try:
        import ctypes
        from ctypes import wintypes

        class _DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD),
                        ("pbData", ctypes.POINTER(ctypes.c_char))]

        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        crypt32.CryptProtectData.restype = wintypes.BOOL
        crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(_DATA_BLOB), ctypes.c_wchar_p, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(_DATA_BLOB)]
        crypt32.CryptUnprotectData.restype = wintypes.BOOL
        crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DATA_BLOB), ctypes.POINTER(ctypes.c_wchar_p),
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(_DATA_BLOB)]
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        _DPAPI = True
    except Exception:
        _DPAPI = False
        crypt32 = None
        kernel32 = None

CRYPTPROTECT_UI_FORBIDDEN = 0x1


def dpapi_available():
    return _DPAPI


def _make_blob(data):
    buf = ctypes.create_string_buffer(data, len(data))
    blob = _DATA_BLOB()
    blob.cbData = len(data)
    blob.pbData = ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))
    return blob, buf  # caller must keep buf alive across the DPAPI call


def dpapi_encrypt(plain):
    if not _DPAPI:
        raise OSError("DPAPI unavailable")
    inp, _keep = _make_blob(plain)
    out = _DATA_BLOB()
    if not crypt32.CryptProtectData(ctypes.byref(inp), None, None, None, None,
                                    CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def dpapi_decrypt(blob_bytes):
    if not _DPAPI:
        raise OSError("DPAPI unavailable")
    inp, _keep = _make_blob(blob_bytes)
    out = _DATA_BLOB()
    if not crypt32.CryptUnprotectData(ctypes.byref(inp), None, None, None, None,
                                      CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


# ---------------- encrypted secret store ----------------
# One DPAPI blob (base64 text) wrapping JSON:
#   {"v":1, "ebay_client_id":..., "ebay_client_secret":..., "token":{...}}

_STORE_LOCK = threading.Lock()


def secrets_read_path():
    """The store to read: the Marteloio file, else the pre-rename LanzaLister file."""
    if not os.path.exists(SECRETS_PATH) and os.path.exists(LEGACY_SECRETS_PATH):
        return LEGACY_SECRETS_PATH
    return SECRETS_PATH


class StoreUnreadable(ValueError):
    """The store was read but can't be used: decryption, base64, JSON or its structure failed."""


def _store_read_raw(path=None):
    path = path or secrets_read_path()
    if not os.path.exists(path):
        return {}
    # A failure to open or read (file in use, OneDrive file not downloaded) is an OSError
    # and leaves the store alone; only a store that was read but is unusable is replaced.
    with open(path, "rb") as f:
        raw = f.read()
    try:
        data = json.loads(dpapi_decrypt(b64decode(raw.strip())).decode("utf-8"))
        _check_store(data)
    except Exception as error:
        raise StoreUnreadable(type(error).__name__) from error
    return data


def _check_store(data):
    if not isinstance(data, dict):
        raise ValueError("Invalid credential store structure")
    for name in ("ebay_client_id", "ebay_client_secret"):
        if name in data and not isinstance(data[name], str):
            raise ValueError("Invalid stored eBay credential")
    if data.get("token") is not None and not isinstance(data["token"], dict):
        raise ValueError("Invalid stored token structure")
    try:
        provider_environment({}, data)
    except OSError:
        raise ValueError("Invalid stored provider keys") from None


def _store_write(data, unreadable=None):
    """Encrypt, verify and replace the store. `unreadable` = (path, error) of a store
    that could not be read: it is kept under a new name once the new one is ready."""
    blob = dpapi_encrypt(json.dumps(data).encode("utf-8"))
    if json.loads(dpapi_decrypt(blob).decode("utf-8")) != data:
        return False
    if unreadable:
        _set_aside(*unreadable)
    atomic_write(SECRETS_PATH, b64encode(blob).decode("ascii"))
    _retire_legacy_store(data)
    return True


def _set_aside(path, error):
    """Rename an unreadable store to <name>.unreadable-<YYYYmmdd-HHMMSS>.enc; never delete it."""
    if not os.path.exists(path):
        return
    folder, stem = os.path.split(path)
    stem = stem[:-4] if stem.endswith(".enc") else stem
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target, n = os.path.join(folder, "%s.unreadable-%s.enc" % (stem, stamp)), 1
    while os.path.exists(target):
        n += 1
        target = os.path.join(folder, "%s.unreadable-%s-%d.enc" % (stem, stamp, n))
    os.rename(path, target)
    print("[secrets] The saved keys could not be read: %s. Kept it as %s and started a new store."
          % (_store_problem(error), os.path.basename(target)), file=sys.stderr, flush=True)


def _store_problem(error):
    """Why a store that was read can't be used, for relay.log (never key values)."""
    if isinstance(error.__cause__, OSError):
        return "Windows could not decrypt it; it was probably saved on another PC or Windows account"
    return "it is damaged (%s)" % error


def _store_update(change):
    """Read, change and save the store for a seller's own save (hold _STORE_LOCK).

    An unreadable store does not block the save: it is kept under a new name and a
    new store is started, because nothing in it can be used any more."""
    path = secrets_read_path()
    try:
        data, unreadable = _store_read_raw(path), None
    except StoreUnreadable as error:
        data, unreadable = {}, (path, error)
    change(data)
    if not _store_write(data, unreadable):
        raise OSError("Could not verify the encrypted store")


def _retire_legacy_store(data):
    """Remove the pre-rename store only once the new file reads back identical."""
    if not os.path.exists(LEGACY_SECRETS_PATH):
        return
    try:
        if _store_read_raw(SECRETS_PATH) == data:
            os.remove(LEGACY_SECRETS_PATH)
    except Exception:
        pass  # A leftover copy is harmless: the new file always wins on read.


def load_secrets(path=None):
    if not dpapi_available():
        return {}
    with _STORE_LOCK:
        try:
            return _store_read_raw(path) if path is not None else _store_read_raw()
        except Exception as e:
            raise OSError("Cannot read encrypted credentials; restore the store or use its original Windows account") from e


def save_secrets(data):
    if not dpapi_available():
        return False
    with _STORE_LOCK:
        try:
            return _store_write(data)
        except Exception:
            return False


_ENV_FOR_CRED = {"ebay_client_id": "EBAY_CLIENT_ID",
                 "ebay_client_secret": "EBAY_CLIENT_SECRET"}


def get_ebay_cred(name):
    val = (load_secrets().get(name) or "").strip()
    if val:
        return val
    return os.environ.get(_ENV_FOR_CRED[name], "").strip()


def set_ebay_creds(cid=None, csec=None):
    if not dpapi_available():
        return False

    def change(data):
        if cid:
            data["ebay_client_id"] = cid
        if csec:
            data["ebay_client_secret"] = csec
    with _STORE_LOCK:
        try:
            _store_update(change)
        except Exception:
            return False
    return True


def read_token():
    if dpapi_available():
        tok = load_secrets().get("token")
        return tok if isinstance(tok, dict) and tok else None
    if not os.path.exists(TOKEN_PATH):
        return None
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as f:
            tok = json.load(f)
            return tok if isinstance(tok, dict) and tok else None
    except (ValueError, OSError):
        return None


def write_token(tok):
    if dpapi_available():
        with _STORE_LOCK:
            try:
                data = _store_read_raw()
            except Exception as e:
                raise OSError("Cannot read existing credential store") from e
            data["token"] = tok
            if not _store_write(data):
                raise OSError("Could not persist encrypted token")
        return
    atomic_write(TOKEN_PATH, json.dumps(tok, indent=2))


def update_token(patch):
    if dpapi_available():
        with _STORE_LOCK:
            try:
                data = _store_read_raw()
            except Exception as e:
                raise OSError("Cannot read existing credential store") from e
            merged = dict(data.get("token") or {})
            merged.update(patch)
            data["token"] = merged
            if not _store_write(data):
                raise OSError("Could not persist encrypted token")
            return merged
    tok = read_token() or {}
    tok.update(patch)
    write_token(tok)
    return tok


def client_id():
    return get_ebay_cred("ebay_client_id")


def client_secret():
    return get_ebay_cred("ebay_client_secret")


class NoCredentialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def outbound_request(req, timeout):
    handlers = [NoCredentialRedirect()]
    if urllib.parse.urlsplit(req.full_url).hostname in ('127.0.0.1', 'localhost', '::1'):
        # Local credentials must not be sent through an inherited HTTP proxy.
        # External eBay requests still respect normal proxy settings.
        handlers.append(urllib.request.ProxyHandler({}))
    opener = urllib.request.build_opener(*handlers)
    with opener.open(req, timeout=timeout) as response:
        body = response.read(MAX_UPSTREAM_BODY + 1)
        if len(body) > MAX_UPSTREAM_BODY:
            raise ValueError("Upstream response exceeded the size limit")
        return response.status, body.decode('utf-8')


def http_post(url, data, headers, timeout=15):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return outbound_request(req, timeout)


def http_get(url, timeout=15, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    return outbound_request(req, timeout)


def strip_ns(tag):
    return tag.split("}")[-1]


def iter_named(root, name):
    return [el for el in root.iter() if strip_ns(el.tag) == name]


def find_text(root, name):
    els = iter_named(root, name)
    return els[0].text.strip() if els and els[0].text else ""


# ---------------- OAuth token exchange ----------------

def exchange_grant(body):
    cid, csec = client_id(), client_secret()
    if not cid or not csec:
        return 400, {"error": "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set - save them in Settings"}
    basic = b64encode(("%s:%s" % (cid, csec)).encode()).decode()
    try:
        status, text = http_post(OAUTH_TOKEN_URL, urllib.parse.urlencode(body).encode(), {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + basic,
        })
    except urllib.error.HTTPError as e:
        code = e.code
        e.close()
        if code in (400, 401):
            raise EbayAuthError(code) from None
        raise RuntimeError("eBay rejected the request: HTTP %d" % code) from None
    try:
        data = json.loads(text)
    except ValueError:
        raise UpstreamError("Invalid eBay token response") from None
    if not isinstance(data, dict):
        raise UpstreamError("Invalid eBay token response")
    if "access_token" in data:
        if not isinstance(data['access_token'], str) or not data['access_token'].strip():
            raise UpstreamError("Invalid eBay access token")
        if 'refresh_token' in data and (not isinstance(data['refresh_token'], str) or not data['refresh_token'].strip()):
            raise UpstreamError("Invalid eBay refresh token")
        expires = data.get('expires_in')
        if isinstance(expires, bool) or not isinstance(expires, (int, str)):
            raise UpstreamError("Invalid eBay token lifetime")
        try:
            expires = int(expires)
        except ValueError:
            raise UpstreamError("Invalid eBay token lifetime") from None
        if not 0 < expires <= 2147483647:
            raise UpstreamError("Invalid eBay token lifetime")
        data["expires_at"] = time.time() + expires
    return status, data


def user_token_fresh():
    # Serialize refreshes with new authorizations so a late refresh cannot
    # overwrite a newly connected account. Re-read after acquiring the lock.
    with _USER_TOKEN_LOCK:
        return _user_token_fresh_locked()


def _user_token_fresh_locked():
    tok = read_token()
    if not tok or not isinstance(tok.get('access_token'), str) or not tok['access_token'].strip():
        return None
    expires = tok.get('expires_at', 0)
    if isinstance(expires, bool) or not isinstance(expires, (int, float)):
        return None
    try:
        if not math.isfinite(expires):
            return None
    except OverflowError:
        return None
    if expires - 60 > time.time():
        return tok
    if isinstance(tok.get("refresh_token"), str) and tok['refresh_token'].strip():
        try:
            _, data = exchange_grant({
                "grant_type": "refresh_token",
                "refresh_token": tok["refresh_token"],
            })
            if "access_token" in data:
                return update_token(data)
        except Exception:
            pass
    return tok if expires > time.time() else None


# ---------------- eBay API calls ----------------

def trading_get_user(token):
    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
        "<IncludeFeedbackScore>true</IncludeFeedbackScore>"
        "</GetUserRequest>"
    )
    _, text = http_post(TRADING_URL, body.encode("utf-8"), {
        "Content-Type": "text/xml",
        "X-EBAY-API-CALL-NAME": "GetUser",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-IAF-TOKEN": token,
        "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
    }, timeout=20)
    root = ET.fromstring(text)
    if find_text(root, "Ack") == "Failure":
        msg = find_text(root, "ShortMessage") or find_text(root, "ErrorMessage") or "GetUser failed"
        return {"error": msg}
    reg = find_text(root, "RegistrationDate")
    years = ""
    if reg[:4].isdigit():
        years = str(max(0, time.gmtime().tm_year - int(reg[:4])))
    return {
        "username": find_text(root, "UserID"),
        "feedback_score": find_text(root, "FeedbackScore"),
        "feedback_star": find_text(root, "FeedbackRatingStar"),
        "positive_pct": find_text(root, "PositiveFeedbackPercent"),
        "registration_date": reg,
        "years_member": years,
    }


APP_TOKEN = {"value": None, "expires_at": 0}
_TOKEN_LOCK = threading.Lock()
_SEARCH_LOCK = threading.Lock()
_SEARCH_CACHE = {}
_SEARCH_PENDING = {}
_SEARCH_SLOTS = threading.BoundedSemaphore(3)
_SEARCH_GENERATION = 0


def invalidate_search_cache():
    global _SEARCH_GENERATION
    with _SEARCH_LOCK:
        _SEARCH_GENERATION += 1
        _SEARCH_CACHE.clear()


def invalidate_ebay_cache():
    with _TOKEN_LOCK:
        APP_TOKEN.update(value=None, expires_at=0)
    invalidate_search_cache()


def app_token_fresh():
    global APP_TOKEN
    with _TOKEN_LOCK:
        if APP_TOKEN["value"] and APP_TOKEN["expires_at"] - 60 > time.time():
            return APP_TOKEN["value"]
        _, data = exchange_grant({
            "grant_type": "client_credentials",
            "scope": "https://api.ebay.com/oauth/api_scope",
        })
        if "access_token" not in data:
            return None
        APP_TOKEN = {"value": data["access_token"], "expires_at": data.get("expires_at", 0)}
        return APP_TOKEN["value"]


def normalize_gtin(value):
    if not isinstance(value, str) or len(value) > 32:
        raise ValueError("Invalid barcode")
    code = value.strip().replace(' ', '').replace('-', '')
    if value.strip() and (len(code) not in (8, 12, 13, 14) or not code.isascii() or not code.isdigit()):
        raise ValueError("Barcode must contain 8, 12, 13 or 14 digits")
    return code


def browse_search(keywords, limit, gtin=""):
    token = app_token_fresh()
    if not token:
        return ebay_error("ebay_not_configured")  # the Client Secret is missing
    # Default Browse results already contain titles. Aggregate aspect refinements
    # are not seller-item facts and are unused by the listing builder.
    params = {"limit": str(limit)}
    params.update({'gtin': gtin} if gtin else {'q': keywords})
    query = urllib.parse.urlencode(params)
    _, text = http_get(BROWSE_URL + "?" + query, timeout=15,
                       headers={"Authorization": "Bearer " + token,
                                "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"})
    data = json.loads(text)
    if not isinstance(data, dict) or data.get('errors'):
        raise ValueError("Invalid eBay search response")
    raw_items = data.get('itemSummaries', [])
    if not isinstance(raw_items, list):
        raise ValueError("Invalid eBay search items")
    items = []
    for it in raw_items[:50]:
        if not isinstance(it, dict) or not isinstance(it.get('title'), str) or not it['title'].strip():
            continue
        seller = it.get('seller') if isinstance(it.get('seller'), dict) else {}
        items.append({'title': it['title'].strip()[:300],
                      'url': it.get('itemWebUrl') if isinstance(it.get('itemWebUrl'), str) else '',
                      'seller_feedback': str(seller.get('feedbackScore', ''))[:30],
                      'seller_pct': str(seller.get('feedbackPercentage', ''))[:30]})
        if isinstance(it.get('itemId'), str):
            items[-1]['item_id'] = it['itemId'][:120]
        if len(items) >= limit:
            break
    if raw_items and not items:
        raise ValueError("No valid eBay search items in response")
    return {"items": items, "aspects": {}, "total": len(items),
            "source": "eBay listing titles", "cached": False}


# Only product identifiers and technical attributes, never arbitrary listing text.
REFERENCE_ASPECTS = {'brand', 'model', 'mpn', 'gtin', 'upc', 'ean', 'isbn',
    'color', 'colour', 'material', 'type', 'connectivity', 'storage capacity',
    'screen size', 'processor', 'ram size', 'maximum resolution', 'mount',
    'focal length', 'maximum aperture', 'compatible brand', 'compatible model'}


EBAY_NO_DETAILS_MESSAGE = "This listing has no product details Marteloio can use. Pick another one, or just describe the item."


def browse_reference(item_id):
    import re
    if not isinstance(item_id, str) or not re.fullmatch(r'v1\|[0-9]{1,20}\|[0-9]{1,20}', item_id):
        raise RequestError("That eBay listing number isn't valid. Pick a listing from the search results.")
    token = app_token_fresh()
    if not token:
        raise UpstreamError('Could not obtain an eBay application token')
    status, text = http_get('https://api.ebay.com/buy/browse/v1/item/' + urllib.parse.quote(item_id, safe=''),
        timeout=15, headers={'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'})
    try:
        data = json.loads(text)
    except ValueError:
        raise UpstreamError('Invalid eBay listing response') from None
    if status != 200 or not isinstance(data, dict) or data.get('errors') or data.get('itemId') != item_id:
        raise UpstreamError('Could not retrieve the selected eBay listing')
    title, url = data.get('title'), data.get('itemWebUrl')
    no_details = RequestError(EBAY_NO_DETAILS_MESSAGE, "ebay_no_details", 422)
    if not isinstance(title, str) or not title.strip() or not isinstance(url, str):
        raise no_details
    link = urllib.parse.urlsplit(url)
    if link.scheme != 'https' or link.netloc not in ('www.ebay.com', 'ebay.com') or not link.path.startswith('/itm/') or link.path.rstrip('/').split('/')[-1] != item_id.split('|')[1]:
        raise no_details
    specs = {}
    for key in ('brand', 'mpn', 'gtin'):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            specs[key.upper() if key != 'brand' else 'Brand'] = value.strip()[:1000]
    aspects = data.get('localizedAspects', [])
    if not isinstance(aspects, list):
        raise UpstreamError('Invalid listing specifications')
    for aspect in aspects[:100]:
        if not isinstance(aspect, dict):
            continue
        name, value = aspect.get('name'), aspect.get('value')
        if isinstance(name, str) and name.strip().lower() in REFERENCE_ASPECTS and isinstance(value, str) and value.strip():
            # Prefer explicit identifier fields when an aspect repeats them.
            if name.strip().lower() not in {k.lower() for k in specs}:
                specs[name.strip()] = value.strip()[:1000]
    if not specs:
        raise no_details
    return {'kind': 'ebay-listing', 'source': {'item_id': item_id,
        'title': title.strip()[:300], 'url': urllib.parse.urlunsplit((link.scheme, link.netloc, link.path, '', ''))},
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'data': {'product_name': '', 'key_specs': specs}}


def try_search(keywords, limit, gtin=""):
    # Share identical work, but do not hold a global lock across network I/O.
    busy = ebay_error("ebay_busy")
    with _SEARCH_LOCK:
        generation = _SEARCH_GENERATION
        key = (generation, ('gtin', gtin) if gtin else ('q', " ".join(keywords.casefold().split())), limit)
        cached = _SEARCH_CACHE.get(key)
        if cached and cached[0] > time.monotonic():
            return dict(cached[1], cached=True)
        pending = _SEARCH_PENDING.get(key)
        owner = pending is None
        if owner:
            if len(_SEARCH_PENDING) >= 8:
                return busy
            pending = Future()
            _SEARCH_PENDING[key] = pending
    if not owner:
        try:
            return pending.result(timeout=40)
        except FutureTimeoutError:
            return busy
    result = busy
    acquired = False
    try:
        acquired = _SEARCH_SLOTS.acquire(timeout=1)
        if not acquired:
            return result
        try:
            result = browse_search('', limit, gtin=gtin) if gtin else browse_search(keywords, limit)
        except EbayAuthError:
            result = ebay_error("ebay_auth")
        except urllib.error.HTTPError as e:
            # The search itself refused the keyset (no Browse access) or eBay is down.
            result = ebay_error("ebay_auth" if e.code in (401, 403) else "ebay_unavailable")
            e.close()
        except Exception:
            result = ebay_error("ebay_unavailable")
        with _SEARCH_LOCK:
            if result and "error" not in result and generation == _SEARCH_GENERATION:
                if len(_SEARCH_CACHE) >= 128:
                    _SEARCH_CACHE.pop(next(iter(_SEARCH_CACHE)))
                _SEARCH_CACHE[key] = (time.monotonic() + 300, result)
        return result
    finally:
        if acquired:
            _SEARCH_SLOTS.release()
        with _SEARCH_LOCK:
            _SEARCH_PENDING.pop(key, None)
        pending.set_result(result)


# ---------------- LLM key settings ----------------

SETTING_KEYS = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY",
                # FreeLLMAPI's address is stored like a key: it can carry an access token.
                "FREELLMAPI_KEY", "FREELLMAPI_URL")


def provider_environment(env, stored=None):
    """Overlay saved encrypted keys, including empty removal markers."""
    result = dict(env)
    store = load_secrets() if stored is None else stored
    if not isinstance(store, dict) or not isinstance(store.get("provider_keys", {}), dict):
        raise OSError("Encrypted provider settings have an invalid format.")
    saved = store.get("provider_keys", {})
    try:
        for key in SETTING_KEYS:
            if key in saved:
                result[key] = safe_value(saved[key])
    except ValueError as error:
        raise OSError("Encrypted provider settings have an invalid value.") from error
    return result


def effective_provider_environment():
    """The keys generation uses now: inherited env, then .env, then the encrypted store.

    Raises OSError when the encrypted store cannot be read."""
    env = dict(os.environ)
    env.update(read_env())  # Includes explicit empty overrides.
    return provider_environment(env)


PROVIDER_STORE_ERROR = ("Marteloio couldn't read your saved keys. This happens after moving to another PC "
                        "or Windows account. Paste your key again in Settings \u203a AI.")
STORAGE_WRITE_ERROR = "Marteloio couldn't save this. Check that its folder isn't read-only or full, then try again."


def save_provider_settings(updates):
    """Save verified encrypted keys before removing their plaintext copies.

    Existing .env keys are not migrated at startup. Only keys explicitly saved
    through Settings are changed. Empty stored values prevent inherited keys
    from being reactivated after an explicit removal. An unreadable store is
    set aside (see _store_update), so a new key can always be saved.
    """
    if not set(updates) <= set(SETTING_KEYS):
        raise ValueError("Unsupported provider setting")
    updates = {key: safe_value(value) for key, value in updates.items()}
    if not dpapi_available():
        write_env(updates)
        return {"encrypted": False, "cleanup_pending": False}

    def change(store):
        store["provider_keys"] = dict(store.get("provider_keys", {}), **updates)
    with _ENV_LOCK:
        with _STORE_LOCK:
            try:
                _store_update(change)
            except Exception as error:
                raise OSError("Could not save encrypted provider settings. Check the existing store and permissions.") from error
        try:
            rewrite_env_without(set(updates))
        except OSError:
            return {"encrypted": True, "cleanup_pending": True}
    return {"encrypted": True, "cleanup_pending": False}


def read_env():
    return app_paths.read_env_file(ENV_PATH)


def write_env(updates):
    allowed = set(SETTING_KEYS) | {"EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"}
    if not set(updates) <= allowed:
        raise ValueError("Unsupported setting")
    updates = {k: safe_value(v) for k, v in updates.items()}
    with _ENV_LOCK:
        lines = []
        if os.path.exists(ENV_PATH):
            with open(ENV_PATH, encoding="utf-8-sig") as f:
                lines = env_lines(f.read())
        out, seen = [], set()
        for line in lines:
            key = line.partition("=")[0].strip()
            if not line.lstrip().startswith("#") and key in updates:
                if key not in seen:
                    out.append("%s=%s" % (key, updates[key]))
                    seen.add(key)
            else:
                out.append(line)
        out.extend("%s=%s" % (k, v) for k, v in updates.items() if k not in seen)
        atomic_write(ENV_PATH, "\n".join(out) + "\n")


def rewrite_env_without(drop_keys):
    with _ENV_LOCK:
        if not os.path.exists(ENV_PATH):
            return
        with open(ENV_PATH, "r", encoding="utf-8-sig") as f:
            lines = env_lines(f.read())
        out = []
        for line in lines:
            s = line.strip()
            if s and not s.startswith("#") and "=" in s:
                if s.partition("=")[0].strip() in drop_keys:
                    continue
            out.append(line)
        atomic_write(ENV_PATH, "\n".join(out) + "\n")


def _token_like(tok):
    """A JSON object holding an eBay access or refresh token, every token field a string."""
    fields = ("access_token", "refresh_token", "token_type")
    return (isinstance(tok, dict) and any(isinstance(tok.get(k), str) and tok[k].strip() for k in fields[:2])
            and all(isinstance(tok[k], str) for k in fields if k in tok))


def migrate_secrets():
    """Move plaintext eBay creds/token into the DPAPI store (idempotent)."""
    if not dpapi_available():
        print("[secrets] DPAPI unavailable - keeping plaintext .env / .ebay_token.json fallback.")
        return
    env = read_env()
    cid = env.get("EBAY_CLIENT_ID", "").strip()
    csec = env.get("EBAY_CLIENT_SECRET", "").strip()
    plain_token = None
    if os.path.exists(TOKEN_PATH):
        try:
            with open(TOKEN_PATH, "r", encoding="utf-8") as f:
                plain_token = json.load(f)
        except (ValueError, OSError):
            plain_token = None
        if not _token_like(plain_token):
            # Copying anything else in would make the whole store unreadable.
            print("[secrets] .ebay_token.json is not a saved eBay sign-in, so it was left in place.")
            plain_token = None
    if not cid and not csec and plain_token is None:
        return
    try:
        with _STORE_LOCK:
            store = _store_read_raw()
    except Exception:
        print("[secrets] Existing store unreadable; migration stopped without changing credentials.")
        return
    if cid:
        store["ebay_client_id"] = cid
    if csec:
        store["ebay_client_secret"] = csec
    if plain_token is not None:
        store["token"] = plain_token
    if not save_secrets(store):
        print("[secrets] could not encrypt store - leaving plaintext in place, will retry next start.")
        return
    try:
        rewrite_env_without({"EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"})
    except OSError as e:
        print("[secrets] store written but could not strip .env: %s" % e)
    os.environ.pop("EBAY_CLIENT_ID", None)
    os.environ.pop("EBAY_CLIENT_SECRET", None)
    if plain_token is not None:
        try:
            os.remove(TOKEN_PATH)
        except FileNotFoundError:
            pass
        except OSError as e:
            print("[secrets] store written but could not remove .ebay_token.json: %s" % e)
    print("[secrets] migrated eBay credentials/token into the DPAPI-encrypted store.")


def mask_key(value):
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return value[:4] + "\u2026" + value[-4:]


# ---------------- settings.json (non-secret preferences) ----------------
#   {"ai": {"groq": {"enabled": false}},                          - the Use switch in Settings > AI
#    "checked": {"groq": {"key_hint": "WXYZ", "result": "failed"}}} - a failed key check, kept
#   across restarts; key_hint is the key's last four characters, already shown in /ai/status.

def read_settings():
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as handle:
            data = json.loads(handle.read(65536))
    except (OSError, ValueError, RecursionError):
        return {}  # Missing or damaged: every switch is on.
    return data if isinstance(data, dict) else {}


def disabled_providers():
    ai = read_settings().get("ai")
    if not isinstance(ai, dict):
        return frozenset()
    return frozenset(name for name, entry in ai.items()
                     if name in ai_providers.PROVIDERS and isinstance(entry, dict) and entry.get("enabled") is False)


def set_provider_enabled(name, enabled):
    with _SETTINGS_LOCK:
        data = read_settings()
        ai = data["ai"] if isinstance(data.get("ai"), dict) else {}
        entry = ai[name] if isinstance(ai.get(name), dict) else {}
        ai[name] = dict(entry, enabled=bool(enabled))
        data["ai"] = ai
        atomic_write(SETTINGS_PATH, json.dumps(data, indent=2) + "\n")


def failed_checks():
    """{provider: key hint} of failed key checks saved before a restart."""
    checked = read_settings().get("checked")
    if not isinstance(checked, dict):
        return {}
    return {name: entry["key_hint"] for name, entry in checked.items()
            if name in ai_providers.PROVIDERS and isinstance(entry, dict) and entry.get("result") == "failed"
            and isinstance(entry.get("key_hint"), str) and entry["key_hint"]}


def update_checks(changes):
    """Save failed checks ({provider: key hint}) or forget them ({provider: None}); writes only on a change."""
    with _SETTINGS_LOCK:
        data = read_settings()
        before = data["checked"] if isinstance(data.get("checked"), dict) else {}
        checked = dict(before)
        for name, hint in changes.items():
            if hint:
                checked[name] = {"key_hint": hint, "result": "failed"}
            else:
                checked.pop(name, None)
        if checked != before:
            data["checked"] = checked
            atomic_write(SETTINGS_PATH, json.dumps(data, indent=2) + "\n")


def check_results(keys):
    return {name: ai_providers.checked(name, keys) for name in ai_providers.ORDER}


def remember_checks(keys, before):
    """Keep this run's new failed checks across restarts and forget the ones that passed.

    Only results that changed since `before` (from check_results) are written."""
    changes = {}
    for name, result in check_results(keys).items():
        if result and result != before.get(name):
            changes[name] = ai_providers.check_hint(name, keys) if result == "failed" else None
    if changes:
        try:
            update_checks(changes)
        except OSError:
            pass  # remembering a check is a convenience, never a reason to fail the request


def ai_status(keys):
    return ai_providers.status(keys, disabled_providers(), failed_checks())


def platform_name():
    if os.name == "nt":
        return "windows"
    if sys.platform == "darwin":
        return "mac"
    return "linux" if sys.platform.startswith("linux") else "other"


# ---------------- HTTP handler ----------------

# Exact static files only; never a directory or user-supplied path.
STATIC_ASSETS = {
    "/assets/brand/marteloio-light.png": "image/png",
    "/assets/brand/marteloio-dark.png": "image/png",
    "/assets/brand/marteloio-light-64.png": "image/png",
    "/assets/brand/marteloio-dark-64.png": "image/png",
    "/assets/fonts/manrope-latin-wght-normal.woff2": "font/woff2",
    "/assets/fonts/manrope-latin-ext-wght-normal.woff2": "font/woff2",
    "/assets/fonts/space-grotesk-latin-wght-normal.woff2": "font/woff2",
    "/assets/fonts/space-grotesk-latin-ext-wght-normal.woff2": "font/woff2",
}

class Handler(BaseHTTPRequestHandler):
    server_version = "MarteloioRelay/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
        super().end_headers()

    def validate_request(self, protected=False):
        port = self.server.server_address[1]
        hosts = {"localhost:%d" % port, "127.0.0.1:%d" % port}
        if port == 80:
            hosts |= {"localhost", "127.0.0.1"}  # browsers leave out the default port
        host = self.headers.get("Host", "").lower()
        origin = self.headers.get("Origin")
        if host not in hosts or (origin and origin != "http://" + host):
            self.reject_json({"error": "Request origin is not allowed", "kind": "forbidden"}, 403)
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.reject_json({"error": "Cross-site requests are not allowed", "kind": "forbidden"}, 403)
            return False
        app_token = self.headers.get("X-App-Token", "")
        if protected and (not app_token.isascii() or not secrets.compare_digest(app_token, SESSION_TOKEN)):
            self.reject_json({"error": "Session expired. Reload the page and try again.", "kind": "session_expired"}, 403)
            return False
        return True

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def request_body_length(self):
        # Reject ambiguous framing rather than trusting the first header value.
        if self.headers.get_all("Transfer-Encoding"):
            raise ValueError("Transfer-Encoding is not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            raise ValueError("Exactly one Content-Length is required")
        value = lengths[0].strip(" \t")
        if not value or len(value) > len(str(MAX_BODY)) or any(c not in "0123456789" for c in value):
            raise ValueError("Invalid Content-Length")
        n = int(value)
        if n < 1 or n > MAX_BODY:
            raise ValueError("Request body must be between 1 and 131072 bytes")
        return n

    def drain_rejected_body(self):
        # Closing with an unread POST body can reset the connection on Windows,
        # hiding the JSON error from fetch(). Only discard bounded, unambiguous
        # bodies, and use a total deadline so a trickling client cannot extend it.
        if self.command != "POST":
            return
        try:
            remaining = getattr(self, "_body_remaining", None)
            if remaining is None:
                remaining = self.request_body_length()
        except ValueError:
            return
        old_timeout = self.connection.gettimeout()
        deadline = time.monotonic() + REJECT_DRAIN_TIMEOUT
        try:
            while remaining:
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    break
                self.connection.settimeout(timeout)
                chunk = self.rfile.read1(min(remaining, 8192))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            pass
        finally:
            self._body_remaining = remaining
            self.connection.settimeout(old_timeout)

    def reject_json(self, obj, status):
        self.close_connection = True
        self.drain_rejected_body()
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Use application/json")
        n = self.request_body_length()
        self._body_remaining = n
        raw = self.rfile.read(n)
        self._body_remaining -= len(raw)
        if len(raw) != n:
            raise ValueError("Incomplete request body")
        try:
            data = json.loads(raw.decode("utf-8"))
        except UnicodeDecodeError:
            raise ValueError("Request body is not valid UTF-8")
        except (json.JSONDecodeError, ValueError):
            raise ValueError("Malformed JSON")
        if not isinstance(data, dict):
            raise ValueError("Request body must be a JSON object")
        return data

    def fail(self, status, kind, message, **extra):
        self.send_json(dict({"error": message, "kind": kind}, **extra), status)

    def do_GET(self):
        if not self.validate_request():
            return
        try:
            self.route_get()
        except UpstreamError:
            self.fail(502, "ebay_unavailable", UPSTREAM_ERROR_MESSAGE)
        except RequestError as e:
            self.fail(e.status, e.kind, str(e))
        except ValueError as e:
            self.fail(400, "invalid_request", str(e) or "Invalid request parameters")
        except TypeError:
            self.fail(400, "invalid_request", "Invalid request parameters")
        except Exception:
            self.fail(502, "server_error", SERVER_ERROR_MESSAGE)

    def route_get(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            self.serve_index()
        elif path == "/listing-core.js":
            self.serve_index("listing-core.js", "text/javascript; charset=utf-8")
        elif path in STATIC_ASSETS:
            self.serve_index(path[1:], STATIC_ASSETS[path])
        elif path == "/health":
            self.handle_health()
        elif path == "/session":
            self.send_json({"token": SESSION_TOKEN})
        elif not self.validate_request(protected=True):
            return
        elif path == "/app/info":
            self.send_json({"version": VERSION, "build": BUILD, "installed": INSTALLED, "data_dir": DATA_DIR,
                            "os": platform_name(), "port": self.server.server_address[1]})
        elif path == "/ai/status":
            self.handle_ai_status()
        elif path == "/ai/freellmapi/detect":
            self.handle_freellmapi_detect()
        elif path == "/ebay/userstats":
            self.handle_userstats()
        elif path == "/ebay/reference":
            self.handle_reference(urllib.parse.parse_qs(parsed.query).get("item_id", [""])[0])
        elif path == "/ebay/search":
            self.handle_search(urllib.parse.parse_qs(parsed.query))
        elif path == "/ebay/authorize-url":
            self.handle_authorize_url(parsed.query)
        elif path == "/settings":
            self.handle_settings_get()
        else:
            self.fail(404, "not_found", "not found")

    def do_POST(self):
        if not self.validate_request(protected=True):
            return
        try:
            self.route_post()
        except UpstreamError:
            self.fail(502, "ebay_unavailable", UPSTREAM_ERROR_MESSAGE)
        except RequestError as e:
            self.reject_json({"error": str(e), "kind": e.kind}, e.status)
        except ValueError as e:
            self.reject_json({"error": str(e) or "Invalid request. Check field types, size and characters.",
                              "kind": "invalid_request"}, 400)
        except TypeError:
            self.reject_json({"error": "Invalid request. Check field types, size and characters.",
                              "kind": "invalid_request"}, 400)
        except Exception:
            self.fail(502, "server_error", SERVER_ERROR_MESSAGE)

    def route_post(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/shutdown":
            self.read_json()
            self.send_json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        elif path == "/llm/chat/completions":
            self.handle_completion()
        elif path == "/ebay/token-user":
            body = self.read_json()
            code = safe_value(body.get("code", ""))
            if not code:
                self.fail(400, "invalid_request", "Paste the whole web address you land on after approving on eBay.")
                return
            redirect = safe_value(body.get("redirect_uri", "")) \
                or os.environ.get("EBAY_REDIRECT_URI", "").strip()
            if not redirect:
                self.fail(400, "invalid_request", "Enter your RuName in Settings \u203a eBay first.")
                return
            state = safe_value(body.get("state", ""))
            with _OAUTH_LOCK:
                pending = _OAUTH_STATES.pop(state, None)
            if not pending or pending[0] < time.monotonic() or pending[1] != redirect:
                self.fail(400, "invalid_request", "Choose Connect eBay again, then paste the whole web address you land on.")
                return
            self.guard(lambda: exchange_grant({
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect,
            }), merge=False)
        elif path == "/ebay/token-refresh":
            self.read_json()
            with _USER_TOKEN_LOCK:
                tok = read_token()
                if not tok or not isinstance(tok.get("refresh_token"), str) or not tok['refresh_token'].strip():
                    self.fail(400, "ebay_not_connected", "Connect your eBay account in Settings \u203a eBay first.")
                    return
                self.guard(lambda: exchange_grant({
                    "grant_type": "refresh_token",
                    "refresh_token": tok["refresh_token"],
                }))
        elif path == "/settings":
            self.handle_settings_post()
        elif path == "/settings/ebay":
            self.handle_settings_ebay_post()
        elif path == "/settings/ai":
            self.handle_settings_ai()
        elif path == "/ai/test":
            self.handle_ai_test()
        else:
            self.reject_json({"error": "not found", "kind": "not_found"}, 404)

    def guard(self, fn, persist=True, merge=True):
        try:
            with _USER_TOKEN_LOCK:
                status, data = fn()
                if persist and "access_token" in data:
                    if merge:
                        update_token(data)
                    else:
                        write_token(data)
            if "access_token" in data:
                self.send_json({"connected": True})
            elif status == 400 and not (client_id() and client_secret()):
                self.fail(400, "ebay_not_configured", "Add your eBay Client ID and Client Secret in Settings \u203a eBay first.")
            else:
                self.fail(status if status >= 400 else 502, "ebay_connect_failed",
                          "eBay didn't finish connecting your account. Choose Connect eBay and try again.")
        except EbayAuthError as error:
            # 401 is the keyset; 400 is usually an expired or reused sign-in code.
            if error.code == 401:
                self.fail(502, "ebay_auth", EBAY_MESSAGES["ebay_auth"])
            else:
                self.fail(502, "ebay_connect_failed", "eBay didn't finish connecting your account. Choose Connect eBay and try again.")
        except Exception:
            self.fail(502, "ebay_connect_failed", "Marteloio couldn't connect or save your eBay account. Try again in a minute.")

    def handle_health(self):
        storage_error = False
        try:
            ebay_configured = bool(client_id())
        except OSError:
            ebay_configured, storage_error = False, True
        try:
            ai_ready = ai_providers.status(effective_provider_environment(), disabled_providers())["ready"]
        except OSError:
            ai_ready, storage_error = False, True
        except Exception:
            ai_ready = False
        body = {
            "ok": True,
            "app": "Marteloio",
            "instance": APP_ID,
            "version": VERSION,
            "build": BUILD,
            "ebay_configured": ebay_configured,
            "encrypted_storage": dpapi_available(),
            "ai_ready": ai_ready,
            "providers": {name: bool(os.environ.get(spec["env"])) for name, spec in ai_providers.PROVIDERS.items()},
        }
        if storage_error:
            body["storage_error"] = True  # the app still runs; saving a key starts a new store
        self.send_json(body)

    def handle_completion(self):
        body = self.read_json()
        if body.get("model") != "listing-text":
            raise ValueError("Unsupported model")
        messages = body.get("messages")
        if not isinstance(messages, list) or not 1 <= len(messages) <= 4:
            raise ValueError("Invalid messages")
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in ("system", "user"):
                raise ValueError("Invalid message")
            if not isinstance(message.get("content"), str):
                raise ValueError("Invalid message content")
            if len(message["content"]) > MAX_NOTES:
                raise RequestError(NOTES_TOO_LONG_MESSAGE, "notes_too_long")
        raw_temp = body.get("temperature", 0.2)
        if isinstance(raw_temp, bool) or not isinstance(raw_temp, (int, float)):
            raise ValueError("Invalid temperature")
        try:
            temperature = float(raw_temp)
        except OverflowError:
            raise ValueError("Invalid temperature") from None
        if not math.isfinite(temperature):
            raise ValueError("Invalid temperature")
        temperature = max(0.0, min(temperature, 1.0))
        # Optional answer budget: short one-section requests ask for less.
        max_tokens = body.get("max_tokens", COMPLETION_MAX_TOKENS)
        if isinstance(max_tokens, bool) or not isinstance(max_tokens, int) or not 64 <= max_tokens <= COMPLETION_MAX_TOKENS:
            raise ValueError("Invalid max_tokens")
        try:
            keys = effective_provider_environment()
        except OSError:
            self.fail(503, "provider_storage", PROVIDER_STORE_ERROR)
            return
        disabled = disabled_providers()
        if not ai_providers.usable(keys, disabled):
            configured = any(ai_providers.configured(name, keys) for name in ai_providers.ORDER)
            status, error = provider_failure("all_disabled" if configured else "no_provider")
            self.send_json(error, status)
            return
        if not _COMPLETION_SLOTS.acquire(blocking=False):
            self.fail(429, "local_busy", "Marteloio is already writing three things. Wait for one to finish, then try again.")
            return
        try:
            before, failure = check_results(keys), None
            try:
                text, provider, model = ai_providers.chat(
                    messages, keys=keys, max_tokens=max_tokens, temperature=temperature, json_mode=True,
                    deadline=time.monotonic() + COMPLETION_DEADLINE, disabled=disabled)
            except ai_providers.NoProvider as error:
                failure = error
            remember_checks(keys, before)
            if failure:
                status, error = provider_failure(failure.code, failure.retry_after)
                self.send_json(error, status)
                return
            self.send_json({"model": "%s/%s" % (provider, model), "provider": provider,
                            "choices": [{"message": {"role": "assistant", "content": text}}]})
        finally:
            _COMPLETION_SLOTS.release()

    def handle_ai_status(self):
        try:
            keys = effective_provider_environment()
        except OSError:
            self.send_json({"ready": False, "retry_in": 0, "providers": [], "error": PROVIDER_STORE_ERROR,
                            "kind": "provider_storage"}, 503)
            return
        self.send_json(ai_status(keys))

    def handle_ai_test(self):
        body = self.read_json()
        name = body.get("provider")
        if not isinstance(name, str) or name not in ai_providers.PROVIDERS:
            raise RequestError("Choose one of the AI services to test.")
        try:
            keys = effective_provider_environment()
        except OSError:
            self.fail(503, "provider_storage", PROVIDER_STORE_ERROR)
            return
        before = check_results(keys)
        result = ai_providers.test(name, keys)
        remember_checks(keys, before)
        self.send_json(result)

    def handle_freellmapi_detect(self):
        try:
            saved = effective_provider_environment().get("FREELLMAPI_URL", "")
        except OSError:
            saved = ""  # an unreadable store has no usable address
        self.send_json(ai_providers.detect_freellmapi(saved if isinstance(saved, str) else ""))

    def handle_settings_ai(self):
        """One box for every AI service: recognise the pasted key, save it, set the Use switch, test."""
        body = self.read_json()
        provider = body.get("provider")
        if not isinstance(provider, str) or provider not in ("auto",) + ai_providers.ORDER:
            raise RequestError("Choose one of the AI services.")
        text, url = body.get("key", ""), body.get("base_url", "")
        enabled, remove, test = body.get("enabled"), body.get("remove", False), body.get("test", True)
        if not isinstance(text, str) or not isinstance(url, str) or not isinstance(remove, bool) \
                or not isinstance(enabled, (bool, type(None))) or not isinstance(test, (bool, type(None))):
            raise RequestError("Invalid request. Check field types, size and characters.")
        text, url = ai_providers.clean_pasted(text), url.strip()
        looks_like_url = text.lower().startswith(("http://", "https://"))
        if provider == "auto":
            if not text:
                raise RequestError(SETTINGS_AI_MESSAGES["nothing_to_save"], "nothing_to_save")
            provider, pasted = ai_providers.recognise(text)
            if provider is None:
                raise RequestError(SETTINGS_AI_MESSAGES["unknown_key"], "unknown_key")
        else:
            pasted = "url" if provider == "freellmapi" and looks_like_url else "key"
        spec = ai_providers.PROVIDERS[provider]
        if pasted == "url":
            text, url = "", text
        elif looks_like_url:
            raise RequestError(SETTINGS_AI_MESSAGES["invalid_key"], "invalid_key")
        if not spec.get("url_env"):
            url = ""  # only FreeLLMAPI has an address; the one-box UI may send it along anyway
        if text and not ai_providers.valid_key_text(text):
            raise RequestError(SETTINGS_AI_MESSAGES["invalid_key"], "invalid_key")
        if url:
            if not ai_providers.valid_local_url(url):
                raise RequestError(SETTINGS_AI_MESSAGES["invalid_url"], "invalid_url")
            url = ai_providers.normalize_base(url)
        if remove and (text or url):
            raise RequestError("Choose a new key or Remove, not both.")
        updates = {}
        if remove:
            updates.update({env: "" for env in (spec["env"], spec.get("url_env")) if env})
        if text:
            updates[spec["env"]] = text
        if url:
            updates[spec["url_env"]] = url
        if not updates and enabled is None:
            raise RequestError(SETTINGS_AI_MESSAGES["nothing_to_save"], "nothing_to_save")
        current = self.current_keys()
        saved_url = current.get("FREELLMAPI_URL", "")
        if text and spec.get("url_env") and not url and not (isinstance(saved_url, str) and saved_url.strip()):
            # No address yet: use the one FreeLLMAPI answers at when it isn't the default.
            found = ai_providers.detect_freellmapi()
            if found["found"] and found["base_url"] != spec["base"]:
                updates[spec["url_env"]] = found["base_url"]
        if (text or url) and enabled is None:
            enabled = True  # a new key is meant to be used
        result, candidate = None, dict(current, **updates)
        before = check_results(candidate)
        if (text or url) and test is not False:
            # Check the pasted key before it replaces the saved one: a rejected key is not kept.
            result = ai_providers.test(provider, candidate)
            if result.get("kind") == "key_rejected":
                self.send_json({"saved": False, "provider": provider, "label": spec["label"], "test": result,
                                "status": ai_status(current)})
                return
        try:
            if updates:
                save_provider_settings(updates)
            if enabled is not None:
                set_provider_enabled(provider, enabled)
        except OSError:
            self.fail(500, "provider_storage_write", STORAGE_WRITE_ERROR)
            return
        for name, value in updates.items():
            os.environ[name] = value
        if updates:
            ai_providers.reset({provider})
            if result is None:
                self.forget_checks({provider})  # a new key or address has not been checked yet
        try:
            keys = effective_provider_environment()
        except OSError:
            self.fail(503, "provider_storage", PROVIDER_STORE_ERROR)
            return
        if result is not None:
            remember_checks(keys, before)
        self.send_json({"saved": True, "provider": provider, "label": spec["label"], "test": result,
                        "status": ai_status(keys)})

    @staticmethod
    def forget_checks(names):
        try:
            update_checks({name: None for name in names})
        except OSError:
            pass

    @staticmethod
    def current_keys():
        """The keys in use now; a store that can't be read adds none."""
        try:
            return effective_provider_environment()
        except OSError:
            keys = dict(os.environ)
            keys.update(read_env())
            return keys

    def ebay_ready(self):
        """True when eBay keys are saved; otherwise send the matching error."""
        try:
            if client_id():
                return True
            kind = "ebay_not_configured"
        except OSError:
            kind = "ebay_storage"
        self.fail(EBAY_STATUS.get(kind, 200), kind, EBAY_MESSAGES[kind], fallback=True)
        return False

    def handle_reference(self, item_id):
        if not self.ebay_ready():
            return
        try:
            self.send_json(browse_reference(item_id))
        except EbayAuthError:
            self.fail(502, "ebay_auth", EBAY_MESSAGES["ebay_auth"])
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            kind = ("ebay_listing_gone" if code in (404, 410) else
                    "ebay_auth" if code in (401, 403) else "ebay_unavailable")
            self.fail(404 if kind == "ebay_listing_gone" else 502, kind, EBAY_MESSAGES[kind])
        except (urllib.error.URLError, OSError, http.client.HTTPException, RuntimeError):
            self.fail(502, "ebay_unavailable", EBAY_MESSAGES["ebay_unavailable"])

    def handle_userstats(self):
        try:
            tok = user_token_fresh()
        except OSError:
            self.fail(503, "ebay_storage", EBAY_MESSAGES["ebay_storage"])
            return
        if not tok:
            self.fail(200, "ebay_not_connected",
                      "Connect your eBay account in Settings \u203a eBay to fill in your seller numbers.", fallback=True)
            return
        try:
            stats = trading_get_user(tok["access_token"])
        except Exception:
            self.fail(502, "ebay_unavailable", "Marteloio couldn't load your eBay seller statistics. Try again in a minute.")
            return
        if "error" in stats:
            # eBay's own text is not shown: it can name internal details.
            self.fail(502, "ebay_not_connected",
                      "eBay didn't accept the saved connection. Choose Connect eBay in Settings \u203a eBay, then try again.")
            return
        self.send_json(stats)

    def handle_search(self, qs):
        keywords = (qs.get("keywords", [""])[0]).strip()
        raw_limit = qs.get("limit", ["20"])[0] or "20"
        try:
            limit = int(raw_limit)
        except (ValueError, TypeError):
            self.fail(400, "invalid_request", "limit must be a number")
            return
        limit = max(1, min(limit, 50))
        try:
            gtin = normalize_gtin(qs.get("gtin", [""])[0])
        except ValueError:
            raise RequestError(INVALID_BARCODE_MESSAGE, "invalid_barcode") from None
        if len(keywords) > 200:
            raise RequestError("This product name is too long. Shorten it and try again.")
        if not keywords and not gtin:
            self.fail(400, "invalid_request", "Enter a product name or barcode first.")
            return
        if not self.ebay_ready():
            return
        result = try_search('', limit, gtin=gtin) if gtin else try_search(keywords, limit)
        if "error" in result:
            self.send_json(result, EBAY_STATUS.get(result.get("kind"), 200))
        else:
            self.send_json(result)

    def handle_settings_get(self):
        plain = read_env()
        provider_error = ""
        try:
            env = effective_provider_environment()
        except OSError:
            env = {}
            provider_error = PROVIDER_STORE_ERROR
        ebay_error = ""
        try:
            cid = get_ebay_cred("ebay_client_id")
            csec = get_ebay_cred("ebay_client_secret")
        except OSError:
            cid = csec = ""
            ebay_error = EBAY_MESSAGES["ebay_storage"]
        self.send_json({
            "provider_error": provider_error,
            "provider_storage": "windows_encrypted" if dpapi_available() else "plaintext",
            "provider_plaintext_present": any(plain.get(key, "").strip() for key in SETTING_KEYS),
            "groq": {"set": bool(env.get("GROQ_API_KEY")),
                     "masked": mask_key(env.get("GROQ_API_KEY", ""))},
            "gemini": {"set": bool(env.get("GEMINI_API_KEY")),
                       "masked": mask_key(env.get("GEMINI_API_KEY", ""))},
            "openrouter": {"set": bool(env.get("OPENROUTER_API_KEY")),
                           "masked": mask_key(env.get("OPENROUTER_API_KEY", ""))},
            "ebay": {
                "storage": "windows_encrypted" if dpapi_available() else "plaintext",
                "client_id": {"set": bool(cid), "masked": mask_key(cid)},
                "client_secret": {"set": bool(csec), "masked": mask_key(csec)},
                "error": ebay_error,
            },
        })

    def handle_settings_ebay_post(self):
        body = self.read_json()
        cid = safe_value(body.get("client_id", ""))
        csec = safe_value(body.get("client_secret", ""))
        if not cid and not csec:
            self.fail(400, "nothing_to_save", "Enter a Client ID or Client Secret first.")
            return
        if dpapi_available():
            if not set_ebay_creds(cid or None, csec or None):
                self.fail(500, "ebay_storage_write", STORAGE_WRITE_ERROR)
                return
            invalidate_ebay_cache()
            saved = [n for n, v in (("EBAY_CLIENT_ID", cid),
                                    ("EBAY_CLIENT_SECRET", csec)) if v]
            self.send_json({"saved": sorted(saved),
                            "message": "eBay credentials saved to the encrypted local store."})
            return
        updates = {}
        if cid:
            updates["EBAY_CLIENT_ID"] = cid
        if csec:
            updates["EBAY_CLIENT_SECRET"] = csec
        try:
            write_env(updates)
        except OSError:
            self.fail(500, "ebay_storage_write", STORAGE_WRITE_ERROR)
            return
        for k, v in updates.items():
            os.environ[k] = v
        invalidate_ebay_cache()
        self.send_json({"saved": sorted(updates),
                        "message": "eBay credentials saved to .env - DPAPI unavailable, "
                                   "saved in plaintext."})

    def handle_authorize_url(self, query):
        redirect = (urllib.parse.parse_qs(query).get("redirect_uri") or [""])[0].strip() \
            or os.environ.get("EBAY_REDIRECT_URI", "").strip()
        try:
            cid = client_id()
        except OSError:
            self.fail(503, "ebay_storage", EBAY_MESSAGES["ebay_storage"])
            return
        if not cid:
            self.fail(400, "ebay_not_configured", "Add your eBay Client ID in Settings \u203a eBay first.")
            return
        if not redirect:
            self.fail(400, "invalid_request", "Enter your RuName in Settings \u203a eBay first.")
            return
        url = ("https://auth.ebay.com/oauth2/authorize"
               + "?client_id=" + urllib.parse.quote(cid)
               + "&redirect_uri=" + urllib.parse.quote(redirect)
               + "&response_type=code"
               + "&scope=" + urllib.parse.quote("https://api.ebay.com/oauth/api_scope"))
        state = secrets.token_urlsafe(32)
        with _OAUTH_LOCK:
            for old, pending in list(_OAUTH_STATES.items()):
                if pending[0] < time.monotonic():
                    del _OAUTH_STATES[old]
            if len(_OAUTH_STATES) >= 16:
                _OAUTH_STATES.pop(next(iter(_OAUTH_STATES)))
            _OAUTH_STATES[state] = (time.monotonic() + 600, redirect)
        url += "&state=" + urllib.parse.quote(state)
        self.send_json({"url": url, "state": state})

    def handle_settings_post(self):
        body = self.read_json()
        updates = {}
        remove = body.get("remove_keys", [])
        allowed = {"groq_api_key", "gemini_api_key", "openrouter_api_key"}
        if not isinstance(remove, list) or len(remove) > 3 or any(not isinstance(field, str) or field not in allowed for field in remove):
            raise ValueError("Invalid key removal selection")
        for field, envname in (("groq_api_key", "GROQ_API_KEY"),
                               ("gemini_api_key", "GEMINI_API_KEY"),
                               ("openrouter_api_key", "OPENROUTER_API_KEY")):
            value = safe_value(body.get(field, ""))
            if field in remove:
                if value:
                    raise ValueError("Cannot replace and remove the same key")
                updates[envname] = ""
            elif value:
                updates[envname] = value
        if not updates:
            self.fail(400, "nothing_to_save", "Enter a key, or choose a saved key to remove.")
            return
        try:
            storage = save_provider_settings(updates)
        except OSError:
            self.fail(500, "provider_storage_write", STORAGE_WRITE_ERROR)
            return
        for k, v in updates.items():
            os.environ[k] = v
        # New generations read keys per request; only clear the changed providers' benches.
        ai_providers.reset(set(updates))
        self.forget_checks({name for name, spec in ai_providers.PROVIDERS.items() if spec["env"] in updates})
        self.send_json({
            "saved": sorted(updates),
            "applied": True,
            "cleanup_pending": storage["cleanup_pending"],
            "message": ("Keys saved and applied. Older plaintext entries could not be removed from .env; check file permissions and save again."
                        if storage["cleanup_pending"] else "Provider settings saved. New generations use them right away."),
        })

    def serve_index(self, filename="index.html", content_type="text/html; charset=utf-8"):
        p = os.path.join(BASE_DIR, filename)
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            self.fail(500, "server_error", "index.html missing")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


SETTINGS_AI_MESSAGES = {
    "unknown_key": "Marteloio doesn't recognise this key. Copy the whole key from Google AI Studio, Groq, "
                   "OpenRouter or FreeLLMAPI, then paste it again.",
    "invalid_key": "This key looks incomplete. Copy the whole key, then paste it again.",
    "invalid_url": "Use the FreeLLMAPI address from this computer or your home network. It starts with http://.",
    "nothing_to_save": "Paste a key first.",
}


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    exclusive = True

    def server_bind(self):
        if os.name == "nt":
            # SO_REUSEADDR lets a second program share a port on Windows: claim it instead.
            self.allow_reuse_address = False
            if self.exclusive:
                self.socket.setsockopt(socket.SOL_SOCKET,
                                       getattr(socket, "SO_EXCLUSIVEADDRUSE", ~socket.SO_REUSEADDR), 1)
        super().server_bind()


class _PlainBindServer(ThreadingHTTPServer):
    exclusive = False


def port_listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def bind_server(port):
    """The relay's listening server. On Windows the last copy's closing connections can keep
    an exclusively bound port blocked for a few minutes; when nothing listens on it, a plain
    bind (still without SO_REUSEADDR, so no second copy can share it) is used instead."""
    try:
        return ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        if os.name != "nt" or port_listening(port):
            raise
    print("[relay] Port %d is still closing from the last run; using it without exclusive use." % port,
          file=sys.stderr, flush=True)
    return _PlainBindServer(("127.0.0.1", port), Handler)


def report_unreadable_store():
    """Say in relay.log why saved keys can't be used (never their values)."""
    try:
        load_secrets()
    except OSError as error:
        if isinstance(error.__cause__, StoreUnreadable):
            print("[secrets] The saved keys could not be read: %s. The app still runs; paste the keys again in "
                  "Settings and the old file will be kept beside the new one." % _store_problem(error.__cause__),
                  file=sys.stderr, flush=True)
        else:
            print("[secrets] The saved keys could not be opened (the file may be in use, or not downloaded "
                  "from OneDrive yet). It was left as it is.", file=sys.stderr, flush=True)


def main():
    global PORT
    load_env()
    PORT = int(os.environ.get("PORT", "8080"))
    srv = bind_server(PORT)
    migrate_secrets()
    report_unreadable_store()
    try:
        print("Marteloio %s (build %s) on http://localhost:%d" % (VERSION, BUILD, PORT), flush=True)
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
