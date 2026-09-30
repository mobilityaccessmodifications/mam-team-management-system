import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager


PHONE = re.compile(r"^\+[1-9][0-9]{7,14}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
KEY = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
ROOT = Path(os.getenv("MAM_HERMES_ALLOWLIST_DIR", "/home/codex/.config/mam-hermes-allowlist"))
ENV_FILE = Path(os.getenv("MAM_HERMES_ENV_FILE", "/home/codex/.hermes/.env"))
STATE_FILE = ROOT / "state.json"
SECRET_FILE = ROOT / "secret"
STOP_REQUIRED_FILE = ROOT / "stop-required"
SERVICE = "hermes-gateway.service"
PROC_ROOT = Path("/proc")
try:
    MAX_STALE = max(0, int(os.getenv("MAM_HERMES_ALLOWLIST_MAX_STALE_SECONDS", "0")))
except ValueError:
    MAX_STALE = 0


def _fail(code):
    raise ValueError(code)


def _log(event, **fields):
    print(json.dumps({"event": event, **fields}, separators=(",", ":")))


def _digest(phones):
    body = json.dumps({"schemaVersion": 1, "phones": phones}, separators=(",", ":"))
    return hashlib.sha256(body.encode()).hexdigest()


def _phones(value):
    if not isinstance(value, list) or len(value) > 10_000:
        _fail("phones_invalid")
    previous = ""
    for phone in value:
        if not isinstance(phone, str) or not PHONE.fullmatch(phone) or phone <= previous:
            _fail("phones_invalid")
        previous = phone
    return value


def _state():
    try:
        value = json.loads(STATE_FILE.read_text())
        if set(value) != {"schemaVersion", "digest", "generatedAtMs", "lastAcceptedAt"} or value["schemaVersion"] != 1 or not DIGEST.fullmatch(value["digest"]) or type(value["generatedAtMs"]) is not int or type(value["lastAcceptedAt"]) is not int:
            return None
        return value
    except (OSError, ValueError, TypeError, KeyError):
        return None


def _env():
    lines = ENV_FILE.read_text().splitlines()
    values = {}
    for line in lines:
        match = KEY.fullmatch(line)
        if not match:
            continue
        name, value = match.groups()
        if name in values:
            _fail("env_duplicate")
        values[name] = value
    return lines, values


def _fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write(path, text):
    created_parent = not os.path.lexists(path.parent)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if created_parent:
        _fsync_directory(path.parent.parent)
    fd, temporary = tempfile.mkstemp(prefix=".mam-hermes-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _update_env(changes):
    lines, values = _env()
    output = []
    seen = set()
    for line in lines:
        match = KEY.fullmatch(line)
        if match and match.group(1) in changes:
            name = match.group(1)
            output.append(f"{name}={changes[name]}")
            seen.add(name)
        else:
            output.append(line)
    for name, value in changes.items():
        if name not in seen:
            output.append(f"{name}={value}")
    if any("\n" in value or "\r" in value for value in changes.values()):
        _fail("env_value_invalid")
    after = "\n".join(output) + "\n"
    before = "\n".join(lines) + "\n"
    if after != before:
        _atomic_write(ENV_FILE, after)
    return after != before, values.get("WHATSAPP_ENABLED", "false").lower() not in ("false", "0", "no", "off", "")


def _systemctl(action):
    result = subprocess.run(["/usr/bin/systemctl", "--user", action, SERVICE], timeout=20, capture_output=True, check=False)
    return result.returncode == 0


@contextmanager
def _controller_lock():
    created_root = not os.path.lexists(ROOT)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if created_root:
        _fsync_directory(ROOT.parent)
    directory = os.lstat(ROOT)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid() or stat.S_IMODE(directory.st_mode) != 0o700:
        _fail("controller_dir_invalid")
    fd = os.open(ROOT / ".controller.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            _fail("controller_lock_invalid")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _is_stopped():
    result = subprocess.run(["/usr/bin/systemctl", "--user", "is-active", SERVICE], timeout=20, capture_output=True, check=False, text=True)
    return result.returncode == 3 and result.stdout.strip() in ("inactive", "failed")


def _active_whatsapp_bridge():
    for process in PROC_ROOT.iterdir():
        if not process.name.isdigit():
            continue
        try:
            arguments = (process / "cmdline").read_bytes().split(b"\0")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if b"--session" in arguments and b"--mode" in arguments and b"--port" in arguments:
            return True
    return False


def _disable(reason):
    try:
        _, values = _env()
        was_enabled = values.get("WHATSAPP_ENABLED", "false").lower() not in ("false", "0", "no", "off", "")
    except Exception:
        was_enabled = True
    try:
        stop_required = was_enabled or STOP_REQUIRED_FILE.exists() or _active_whatsapp_bridge()
    except Exception:
        stop_required = True
    if stop_required:
        try:
            _atomic_write(STOP_REQUIRED_FILE, "1\n")
        except Exception:
            try:
                stopped = _systemctl("stop") and _is_stopped() and not _active_whatsapp_bridge()
            except Exception:
                stopped = False
            if not stopped:
                _log("gateway_hard_stop_failed", reason=reason)
                return False
    configuration_written = True
    try:
        _update_env({"WHATSAPP_ENABLED": "false", "WHATSAPP_ALLOW_ALL_USERS": "false", "WHATSAPP_ALLOWED_USERS": "", "WHATSAPP_DM_POLICY": "disabled", "WHATSAPP_GROUP_POLICY": "disabled"})
    except Exception:
        configuration_written = False
    if stop_required:
        try:
            stopped = _systemctl("stop") and _is_stopped() and not _active_whatsapp_bridge()
        except Exception:
            stopped = False
        if not stopped:
            _log("gateway_hard_stop_failed", reason=reason)
            return False
    if not configuration_written:
        _log("whatsapp_disable_configuration_failed", reason=reason)
        return False
    if stop_required:
        STOP_REQUIRED_FILE.unlink(missing_ok=True)
        _fsync_directory(STOP_REQUIRED_FILE.parent)
    _log("whatsapp_inbound_disabled", reason=reason)
    return True


def _snapshot():
    url = os.getenv("MAM_HERMES_ALLOWLIST_URL", "")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/api/internal/integrations/openclaw/whatsapp-allowlist":
        _fail("url_invalid")
    secret = SECRET_FILE.read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", secret):
        _fail("secret_invalid")
    request = urllib.request.Request(url, headers={"Accept": "application/json", "Authorization": f"Bearer {secret}"})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=12) as response:
        if response.status != 200 or int(response.headers.get("content-length", "0")) > 1_000_000:
            _fail("snapshot_http_invalid")
        body = response.read(1_000_001)
    if len(body) > 1_000_000:
        _fail("snapshot_too_large")
    snapshot = json.loads(body)
    if not isinstance(snapshot, dict) or set(snapshot) != {"schemaVersion", "digest", "generatedAt", "phones"} or snapshot["schemaVersion"] != 1 or not isinstance(snapshot["generatedAt"], str) or not isinstance(snapshot["digest"], str) or not DIGEST.fullmatch(snapshot["digest"]):
        _fail("snapshot_invalid")
    phones = _phones(snapshot["phones"])
    if _digest(phones) != snapshot["digest"]:
        _fail("snapshot_digest_mismatch")
    generated = datetime.fromisoformat(snapshot["generatedAt"].replace("Z", "+00:00"))
    if generated.tzinfo is None:
        _fail("snapshot_timestamp_invalid")
    generated_ms = int(generated.timestamp() * 1000)
    age = int(time.time() * 1000) - generated_ms
    if age > 300_000 or age < -60_000:
        _fail("snapshot_stale_or_future")
    return phones, snapshot["digest"], generated_ms


def _config_digest(values):
    if values.get("WHATSAPP_ALLOW_ALL_USERS", "false").lower() != "false" or values.get("WHATSAPP_DM_POLICY") != "allowlist" or values.get("WHATSAPP_GROUP_POLICY") != "disabled" or values.get("WHATSAPP_MODE") != "bot":
        return None
    raw = values.get("WHATSAPP_ALLOWED_USERS", "")
    if raw == "*":
        return None
    phones = [f"+{value}" for value in raw.split(",") if value]
    try:
        return _digest(_phones(phones))
    except ValueError:
        return None


def _sync_locked():
    if STOP_REQUIRED_FILE.exists():
        _disable("recovery_stop_required")
        return False
    try:
        old = _state()
        phones, digest, generated_ms = _snapshot()
        if old and generated_ms <= old["generatedAtMs"]:
            _fail("snapshot_replayed")
        _, values = _env()
        old_digest = _config_digest(values)
        if old_digest != digest or values.get("WHATSAPP_ALLOW_ALL_USERS") == "true":
            changed, was_enabled = _update_env({"WHATSAPP_ALLOWED_USERS": ",".join(phone[1:] for phone in phones), "WHATSAPP_ALLOW_ALL_USERS": "false", "WHATSAPP_DM_POLICY": "allowlist", "WHATSAPP_GROUP_POLICY": "disabled", "WHATSAPP_MODE": "bot"})
            if changed and was_enabled and not _systemctl("restart"):
                _fail("gateway_restart_failed")
        _atomic_write(STATE_FILE, json.dumps({"schemaVersion": 1, "digest": digest, "generatedAtMs": generated_ms, "lastAcceptedAt": int(time.time() * 1000)}, separators=(",", ":")) + "\n")
        _log("allowlist_sync_ok", digest=digest, phoneCount=len(phones))
        return True
    except Exception as error:
        state = _state()
        try:
            _, values = _env()
            matches = state and _config_digest(values) == state["digest"]
        except Exception:
            matches = False
        age = int(time.time() * 1000) - state["lastAcceptedAt"] if state else None
        if matches and MAX_STALE > 0 and age is not None and 0 <= age <= MAX_STALE * 1000:
            _log("allowlist_sync_lkg", ageSeconds=age // 1000)
            return True
        _disable(type(error).__name__)
        return False


def _watchdog_locked():
    if STOP_REQUIRED_FILE.exists():
        _disable("recovery_stop_required")
        return False
    state = _state()
    try:
        _, values = _env()
        digest = _config_digest(values)
    except Exception:
        digest = None
    age = int(time.time() * 1000) - state["lastAcceptedAt"] if state else None
    limit = MAX_STALE * 1000 if MAX_STALE > 0 else 360_000
    if not state or digest != state["digest"] or age is None or age < 0 or age > limit:
        _disable("watchdog_stale_or_policy_mismatch")
        return False
    _log("allowlist_watchdog_ok", ageSeconds=age // 1000)
    return True


def sync():
    try:
        with _controller_lock():
            return _sync_locked()
    except Exception:
        _disable("controller_lock_failure")
        return False


def watchdog():
    try:
        with _controller_lock():
            return _watchdog_locked()
    except Exception:
        _disable("controller_lock_failure")
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("sync", "watchdog"))
    command = parser.parse_args().command
    sys.exit(0 if (sync() if command == "sync" else watchdog()) else 1)
