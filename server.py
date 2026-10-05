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
import os
import secrets
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

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, ".env")
TOKEN_PATH = os.path.join(BASE_DIR, ".ebay_token.json")
SECRETS_PATH = os.path.join(BASE_DIR, ".marteloio-secrets.enc")
# Pre-rename store: read while the new file does not exist, removed after the
# first verified write of the new file.
LEGACY_SECRETS_PATH = os.path.join(BASE_DIR, ".lanzalister-secrets.enc")
PORT = int(os.environ.get("PORT", "8080"))
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
# The whole provider fallback must finish before the browser stops waiting (120 s).
COMPLETION_DEADLINE = 90
# Answer budget for a full listing; a request may ask for less (64 or more).
COMPLETION_MAX_TOKENS = 3000


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


UPSTREAM_ERROR_MESSAGE = "eBay returned an unreadable response. Try again shortly."


def env_lines(text):
    """Split .env text on newlines only; str.splitlines() also splits on U+2028 etc."""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return [line[:-1] if line.endswith("\r") else line for line in lines]


NO_PROVIDER_MESSAGE = "No AI provider key is configured. Add a key in Settings to start generating."


def provider_failure(reason, retry_after=None):
    """Safe, actionable errors for an ai_providers.NoProvider code.

    Never echo upstream bodies or credentials."""
    if reason == "no_provider":
        return 503, {"error": NO_PROVIDER_MESSAGE, "kind": "no_provider"}
    if reason in ("rate_limited", "unavailable"):
        seconds = 30 if reason == "rate_limited" else 15
        try:
            seconds = max(1, min(int(retry_after), 3600))
        except (TypeError, ValueError, OverflowError):
            pass
        message = ("The AI providers are rate-limited right now." if reason == "rate_limited" else
                   "The AI providers are temporarily unavailable or busy.")
        return (429 if reason == "rate_limited" else 503), {
            "error": message + " Your draft is safe. Wait at least %d seconds, then try again. Provider limits may take longer to reset." % seconds,
            "kind": "provider_busy", "retry_after": seconds}
    if reason == "key_rejected":
        return 502, {"error": "The AI provider rejected authentication. Check the provider keys in Settings.", "kind": "provider_auth"}
    if reason == "timeout":
        return 504, {"error": "The AI providers did not answer in time. Your draft is safe. Wait a moment, then try again.",
                     "kind": "provider_timeout"}
    return 502, {"error": "The AI provider could not process this request. Try again with shorter notes. Your draft is safe.", "kind": "provider_request"}

OAUTH_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
TRADING_URL = "https://api.ebay.com/ws/api.dll"
BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search"


def load_env():
    if not os.path.exists(ENV_PATH):
        return
    with open(ENV_PATH, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


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


def _store_read_raw(path=None):
    path = path or secrets_read_path()
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        blob = b64decode(f.read().strip())
    data = json.loads(dpapi_decrypt(blob).decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Invalid credential store structure")
    for name in ("ebay_client_id", "ebay_client_secret"):
        if name in data and not isinstance(data[name], str):
            raise ValueError("Invalid stored eBay credential")
    if data.get("token") is not None and not isinstance(data["token"], dict):
        raise ValueError("Invalid stored token structure")
    return data


def _store_write(data):
    blob = dpapi_encrypt(json.dumps(data).encode("utf-8"))
    if json.loads(dpapi_decrypt(blob).decode("utf-8")) != data:
        return False
    atomic_write(SECRETS_PATH, b64encode(blob).decode("ascii"))
    _retire_legacy_store(data)
    return True


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
    with _STORE_LOCK:
        try:
            data = _store_read_raw()
        except Exception:
            return False
        if cid:
            data["ebay_client_id"] = cid
        if csec:
            data["ebay_client_secret"] = csec
        try:
            return _store_write(data)
        except Exception:
            return False


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
        msg = "eBay rejected the request: HTTP %d" % e.code
        e.close()
        raise RuntimeError(msg)
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
        return {"error": "Could not obtain an eBay application token", "fallback": True}
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


def browse_reference(item_id):
    import re
    if not isinstance(item_id, str) or not re.fullmatch(r'v1\|[0-9]{1,20}\|[0-9]{1,20}', item_id):
        raise ValueError('Invalid eBay item identifier')
    token = app_token_fresh()
    if not token:
        raise ValueError('Could not obtain an eBay application token')
    status, text = http_get('https://api.ebay.com/buy/browse/v1/item/' + urllib.parse.quote(item_id, safe=''),
        timeout=15, headers={'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'})
    try:
        data = json.loads(text)
    except ValueError:
        raise UpstreamError('Invalid eBay listing response') from None
    if status != 200 or not isinstance(data, dict) or data.get('errors') or data.get('itemId') != item_id:
        raise ValueError('Could not retrieve the selected eBay listing')
    title, url = data.get('title'), data.get('itemWebUrl')
    if not isinstance(title, str) or not title.strip() or not isinstance(url, str):
        raise ValueError('Selected listing has no usable source information')
    link = urllib.parse.urlsplit(url)
    if link.scheme != 'https' or link.netloc not in ('www.ebay.com', 'ebay.com') or not link.path.startswith('/itm/') or link.path.rstrip('/').split('/')[-1] != item_id.split('|')[1]:
        raise ValueError('Selected listing has an invalid source link')
    specs = {}
    for key in ('brand', 'mpn', 'gtin'):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            specs[key.upper() if key != 'brand' else 'Brand'] = value.strip()[:1000]
    aspects = data.get('localizedAspects', [])
    if not isinstance(aspects, list):
        raise ValueError('Invalid listing specifications')
    for aspect in aspects[:100]:
        if not isinstance(aspect, dict):
            continue
        name, value = aspect.get('name'), aspect.get('value')
        if isinstance(name, str) and name.strip().lower() in REFERENCE_ASPECTS and isinstance(value, str) and value.strip():
            # Prefer explicit identifier fields when an aspect repeats them.
            if name.strip().lower() not in {k.lower() for k in specs}:
                specs[name.strip()] = value.strip()[:1000]
    if not specs:
        raise ValueError('This listing has no supported product specifications. Select another result or use your own observations.')
    return {'kind': 'ebay-listing', 'source': {'item_id': item_id,
        'title': title.strip()[:300], 'url': urllib.parse.urlunsplit((link.scheme, link.netloc, link.path, '', ''))},
        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'data': {'product_name': '', 'key_specs': specs}}


def try_search(keywords, limit, gtin=""):
    # Share identical work, but do not hold a global lock across network I/O.
    busy = {"error": "eBay search is busy. Please retry shortly.", "fallback": True}
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
        except urllib.error.HTTPError as e:
            result = {"error": "eBay search returned HTTP %d; check credentials and API access" % e.code,
                      "fallback": True}
            e.close()
        except Exception:
            result = {"error": "eBay search is temporarily unavailable. Please retry.", "fallback": True}
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

SETTING_KEYS = ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY")


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


PROVIDER_STORE_ERROR = "Encrypted provider settings could not be read. Use the original Windows account or restore the store."


def save_provider_settings(updates):
    """Save verified encrypted keys before removing their plaintext copies.

    Existing .env keys are not migrated at startup. Only keys explicitly saved
    through Settings are changed. Empty stored values prevent inherited keys
    from being reactivated after an explicit removal.
    """
    if not set(updates) <= set(SETTING_KEYS):
        raise ValueError("Unsupported provider setting")
    updates = {key: safe_value(value) for key, value in updates.items()}
    if not dpapi_available():
        write_env(updates)
        return {"encrypted": False, "cleanup_pending": False}
    with _ENV_LOCK:
        with _STORE_LOCK:
            try:
                store = _store_read_raw()
                provider_environment({}, store)  # Validate without reading or modifying another store.
                store["provider_keys"] = dict(store.get("provider_keys", {}), **updates)
                if not _store_write(store):
                    raise OSError("Could not verify encrypted provider settings.")
            except Exception as error:
                raise OSError("Could not save encrypted provider settings. Check the existing store and permissions.") from error
        try:
            rewrite_env_without(set(updates))
        except OSError:
            return {"encrypted": True, "cleanup_pending": True}
    return {"encrypted": True, "cleanup_pending": False}


def read_env():
    data = {}
    if not os.path.exists(ENV_PATH):
        return data
    with open(ENV_PATH, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            data[k.strip()] = v.strip()
    return data


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
        host = self.headers.get("Host", "").lower()
        origin = self.headers.get("Origin")
        if host not in hosts or (origin and origin != "http://" + host):
            self.reject_json({"error": "Request origin is not allowed"}, 403)
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.reject_json({"error": "Cross-site requests are not allowed"}, 403)
            return False
        app_token = self.headers.get("X-App-Token", "")
        if protected and (not app_token.isascii() or not secrets.compare_digest(app_token, SESSION_TOKEN)):
            self.reject_json({"error": "Session expired. Reload the app and retry."}, 403)
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

    def do_GET(self):
        if not self.validate_request():
            return
        try:
            self.route_get()
        except UpstreamError:
            self.send_json({"error": UPSTREAM_ERROR_MESSAGE}, 502)
        except ValueError as e:
            self.send_json({"error": str(e) or "Invalid request parameters"}, 400)
        except TypeError:
            self.send_json({"error": "Invalid request parameters"}, 400)
        except Exception:
            self.send_json({"error": "Request failed. Check service availability and credential storage."}, 502)

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
            providers = {k.replace("_API_KEY", "").lower(): bool(os.environ.get(k))
                         for k in SETTING_KEYS}
            try:
                ai_ready = ai_providers.status(effective_provider_environment())["ready"]
            except Exception:
                ai_ready = False
            self.send_json({
                "ok": True,
                "app": "Marteloio",
                "instance": APP_ID,
                "ebay_configured": bool(client_id()),
                "encrypted_storage": dpapi_available(),
                "ai_ready": ai_ready,
                "providers": providers,
            })
        elif path == "/session":
            self.send_json({"token": SESSION_TOKEN})
        elif not self.validate_request(protected=True):
            return
        elif path == "/ai/status":
            self.handle_ai_status()
        elif path == "/ebay/userstats":
            self.handle_userstats()
        elif path == "/ebay/reference":
            self.send_json(browse_reference(urllib.parse.parse_qs(parsed.query).get("item_id", [""])[0]))
        elif path == "/ebay/search":
            self.handle_search(urllib.parse.parse_qs(parsed.query))
        elif path == "/ebay/authorize-url":
            self.handle_authorize_url(parsed.query)
        elif path == "/settings":
            self.handle_settings_get()
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        if not self.validate_request(protected=True):
            return
        try:
            self.route_post()
        except UpstreamError:
            self.send_json({"error": UPSTREAM_ERROR_MESSAGE}, 502)
        except ValueError as e:
            self.reject_json({"error": str(e) or "Invalid request. Check field types, size and characters."}, 400)
        except TypeError:
            self.reject_json({"error": "Invalid request. Check field types, size and characters."}, 400)
        except Exception:
            self.send_json({"error": "Request failed. Check service availability and credential storage."}, 502)

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
                self.send_json({"error": "missing code"}, 400)
                return
            redirect = safe_value(body.get("redirect_uri", "")) \
                or os.environ.get("EBAY_REDIRECT_URI", "").strip()
            if not redirect:
                self.send_json({"error": "missing redirect_uri - enter your RuName in settings"}, 400)
                return
            state = safe_value(body.get("state", ""))
            with _OAUTH_LOCK:
                pending = _OAUTH_STATES.pop(state, None)
            if not pending or pending[0] < time.monotonic() or pending[1] != redirect:
                self.send_json({"error": "Connect again and paste the complete redirect URL, including state."}, 400)
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
                    self.send_json({"error": "no stored refresh token"}, 400)
                    return
                self.guard(lambda: exchange_grant({
                    "grant_type": "refresh_token",
                    "refresh_token": tok["refresh_token"],
                }))
        elif path == "/settings":
            self.handle_settings_post()
        elif path == "/settings/ebay":
            self.handle_settings_ebay_post()
        else:
            self.reject_json({"error": "not found"}, 404)

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
            else:
                self.send_json({"error": "eBay authorization failed"}, status if status >= 400 else 502)
        except Exception:
            self.send_json({"error": "Could not authorize or save the eBay connection"}, 502)

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
            if not isinstance(message.get("content"), str) or len(message["content"]) > 40000:
                raise ValueError("Invalid message content")
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
            self.send_json({"error": PROVIDER_STORE_ERROR, "kind": "provider_storage"}, 503)
            return
        if not any(keys.get(key, "").strip() for key in SETTING_KEYS):
            status, error = provider_failure("no_provider")
            self.send_json(error, status)
            return
        if not _COMPLETION_SLOTS.acquire(blocking=False):
            self.send_json({"error": "Three AI requests are already running in this app. Wait for a current lookup or generation to finish, then retry. Your draft is safe.",
                            "kind": "local_busy"}, 429)
            return
        try:
            try:
                text, provider, model = ai_providers.chat(
                    messages, keys=keys, max_tokens=max_tokens, temperature=temperature, json_mode=True,
                    deadline=time.monotonic() + COMPLETION_DEADLINE)
            except ai_providers.NoProvider as failure:
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
            self.send_json({"ready": False, "retry_in": 0, "providers": [], "error": PROVIDER_STORE_ERROR}, 503)
            return
        self.send_json(ai_providers.status(keys))

    def handle_userstats(self):
        tok = user_token_fresh()
        if not tok:
            self.send_json({"error": "not connected - complete the OAuth flow first", "fallback": True})
            return
        try:
            self.send_json(trading_get_user(tok["access_token"]))
        except Exception:
            self.send_json({"error": "Could not load eBay seller statistics. Check your connection and try again."}, 502)

    def handle_search(self, qs):
        keywords = (qs.get("keywords", [""])[0]).strip()
        raw_limit = qs.get("limit", ["20"])[0] or "20"
        try:
            limit = int(raw_limit)
        except (ValueError, TypeError):
            self.send_json({"error": "limit must be a number"}, 400)
            return
        limit = max(1, min(limit, 50))
        gtin = normalize_gtin(qs.get("gtin", [""])[0])
        if len(keywords) > 200:
            raise ValueError("Query too long")
        if not keywords and not gtin:
            self.send_json({"error": "Enter a product name or barcode"}, 400)
            return
        if not client_id():
            self.send_json({"error": "EBAY_CLIENT_ID not set", "fallback": True})
            return
        try:
            result = try_search('', limit, gtin=gtin) if gtin else try_search(keywords, limit)
        except ValueError as e:
            self.send_json({"error": "eBay search failed: %s" % str(e)}, 502)
            return
        if result:
            self.send_json(result)
        else:
            self.send_json({"error": "eBay search APIs unavailable (keyset may lack access)", "fallback": True})

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
            ebay_error = ("Stored eBay credentials could not be read. Restore the store "
                          "using the Windows account that created it before saving credentials.")
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
            self.send_json({"error": "nothing to save - enter a Client ID or Client Secret"}, 400)
            return
        if dpapi_available():
            if not set_ebay_creds(cid or None, csec or None):
                self.send_json({"error": "could not encrypt credentials"}, 500)
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
        except OSError as e:
            self.send_json({"error": "could not write .env: %s" % e}, 500)
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
        if not client_id():
            self.send_json({"error": "EBAY_CLIENT_ID not set - save it in Settings first"}, 400)
            return
        if not redirect:
            self.send_json({"error": "missing redirect_uri - enter your RuName in settings"}, 400)
            return
        url = ("https://auth.ebay.com/oauth2/authorize"
               + "?client_id=" + urllib.parse.quote(client_id())
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
            self.send_json({"error": "nothing to save - enter a key or select a saved key to remove"}, 400)
            return
        try:
            storage = save_provider_settings(updates)
        except OSError:
            self.send_json({"error": "Could not save provider settings. Check file permissions and the encrypted store; existing credentials were not intentionally cleared."}, 500)
            return
        for k, v in updates.items():
            os.environ[k] = v
        # New generations read keys per request; only clear the changed providers' benches.
        ai_providers.reset(set(updates))
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
            self.send_json({"error": "index.html missing"}, 500)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    load_env()
    PORT = int(os.environ.get("PORT", "8080"))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    migrate_secrets()
    try:
        print("Marteloio relay on http://localhost:%d" % PORT)
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
