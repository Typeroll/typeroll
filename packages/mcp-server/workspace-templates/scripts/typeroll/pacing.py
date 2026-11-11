"""Polite request pacing for read-only QA requests to websites.

Home connections (ISP, router, DNS resolver) can throttle or block many rapid
requests from one machine, so the local profile is slow by default. Cloud
runners may go faster. Override with TYPEROLL_REQUEST_PROFILE=local|cloud and
TYPEROLL_REQUEST_CONCURRENCY=N. Never used for MCP calls or mutations.
"""
import email.utils
import os
import sys
import threading
import time
import urllib.parse

PROFILES = {
    'local': {'concurrency': 2, 'interval': 0.3},
    'cloud': {'concurrency': 5, 'interval': 0.1},
}
CLOUD_MARKERS = ('CLAUDE_CODE_REMOTE', 'CODESPACES', 'GITHUB_ACTIONS', 'CI')
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_RETRIES = 3
MAX_DELAY = 60.0


def _set(value):
    return (value or '').strip().lower() not in ('', '0', 'false', 'no', 'off')


def select_profile(env=None):
    """Return the request profile for this environment: local unless told otherwise."""
    env = os.environ if env is None else env
    explicit = (env.get('TYPEROLL_REQUEST_PROFILE') or '').strip().lower()
    if explicit and explicit not in PROFILES:
        raise ValueError('TYPEROLL_REQUEST_PROFILE must be local or cloud')
    marker = next((name for name in CLOUD_MARKERS if _set(env.get(name))), None)
    name = explicit or ('cloud' if marker else 'local')
    reason = 'TYPEROLL_REQUEST_PROFILE' if explicit else marker or 'default'
    profile = dict(PROFILES[name], name=name, reason=reason)
    raw = (env.get('TYPEROLL_REQUEST_CONCURRENCY') or '').strip()
    if raw:
        if not raw.isdigit() or not 1 <= int(raw) <= 16:
            raise ValueError('TYPEROLL_REQUEST_CONCURRENCY must be a whole number from 1 to 16')
        profile['concurrency'] = int(raw)
    return profile


def describe(profile):
    hint = ('on a cloud runner set TYPEROLL_REQUEST_PROFILE=cloud' if profile['name'] == 'local'
            else 'set TYPEROLL_REQUEST_PROFILE=local on your own computer')
    return (f"Request profile: {profile['name']} ({profile['reason']}; {profile['concurrency']} concurrent, "
            f"{int(profile['interval'] * 1000)} ms between requests per host). "
            f"To change it, {hint}; TYPEROLL_REQUEST_CONCURRENCY=N sets concurrency.")


def retry_after(value, now=None):
    """Seconds requested by a Retry-After header (delta seconds or HTTP date), or None."""
    if value is None:
        return None
    value = str(value).strip()
    if value.isdigit():
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when is None or when.tzinfo is None:
        return None
    return max(0.0, when.timestamp() - (time.time() if now is None else now))


def retry_delay(attempt, status=None, header=None, now=None):
    """Seconds to wait before retry number attempt+1, or None to stop.

    status None means a network error. A Retry-After above MAX_DELAY stops
    instead of hammering a host that asked for a long pause.
    """
    if attempt >= MAX_RETRIES or (status is not None and status not in RETRY_STATUSES):
        return None
    hinted = retry_after(header, now)
    delay = hinted if hinted is not None else float(2 ** attempt)
    return None if delay > MAX_DELAY else delay


class Pacer:
    """Keep request starts to one host at least interval seconds apart (thread safe)."""

    def __init__(self, interval, clock=time.monotonic, sleep=time.sleep):
        self.interval, self.clock, self.sleep = interval, clock, sleep
        self.lock, self.next = threading.Lock(), {}

    def wait(self, url):
        host = (urllib.parse.urlsplit(url).hostname or '').lower()
        with self.lock:
            now = self.clock()
            start = max(now, self.next.get(host, now))
            self.next[host] = start + self.interval
        if start > now:
            self.sleep(start - now)


_profile = None
_pacer = None


def profile():
    """The active profile; prints one line to stderr the first time."""
    global _profile, _pacer
    if _profile is None:
        _profile = select_profile()
        _pacer = Pacer(_profile['interval'])
        print(describe(_profile), file=sys.stderr)
    return _profile


def pace(url):
    profile()
    _pacer.wait(url)
