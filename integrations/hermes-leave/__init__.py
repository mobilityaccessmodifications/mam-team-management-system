import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import ssl
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path


PATH = "/api/internal/integrations/openclaw/leave"
LOGGER = logging.getLogger("mam_hermes_leave")
PHONE = re.compile(r"^([1-9][0-9]{7,14})@s\.whatsapp\.net$")
LID = re.compile(r"^([1-9][0-9]{7,14})@lid$")
SAFE_ID = re.compile(r"^[A-Za-z0-9:_-]{1,128}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SECRET = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
CONFIRM = re.compile(r"^[ \t\r\n]*confirm[ \t\r\n]*$", re.I)
UNRESOLVED_TEXT = "I could not verify whether the previous leave request was submitted. Please check your leave requests with your manager before starting another one. Do not submit a duplicate request."
STATE_DIR = Path(os.getenv("MAM_HERMES_LEAVE_STATE_DIR", "/home/codex/.config/mam-hermes-leave"))
PREPARE_DESCRIPTION = (
    "Prepare leave only after this authenticated WhatsApp sender explicitly asks to apply for leave. "
    "Never use for greetings or general policy questions. The sender identity is supplied by the gateway, "
    "not by tool arguments or the message text. Pass only the leave details already supplied. "
    "Do not ask paid versus unpaid first; the server resolves eligible types and defaults casual/ABN to Unpaid. "
    "Never accept another person's name, phone, ID, manager, approver, status, or confirmation. "
    "A note is optional. On edits, prepare the complete updated details again. "
    "Only a later standalone Confirm from the same WhatsApp sender can submit. Never call this tool for Confirm."
)
SCHEMA = {
    "name": "mam_leave_prepare",
    "description": PREPARE_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "leaveType": {"type": "string"},
            "startDate": {"type": "string"},
            "endDate": {"type": "string"},
            "startTime": {"type": ["string", "null"]},
            "endTime": {"type": ["string", "null"]},
            "employeeNote": {"type": "string"},
        },
        "additionalProperties": False,
    },
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _config():
    if os.getenv("MAM_HERMES_LEAVE_ENABLED") != "true":
        return None
    url = os.getenv("MAM_HERMES_LEAVE_BRIDGE_URL", "").strip()
    secret = os.getenv("MAM_HERMES_LEAVE_BRIDGE_SECRET", "").strip()
    account = os.getenv("MAM_HERMES_LEAVE_ACCOUNT", "default").strip()
    try:
        parsed = urllib.parse.urlparse(url)
        port = parsed.port
    except ValueError:
        return None
    if not SECRET.fullmatch(secret) or not SAFE_ID.fullmatch(account):
        return None
    if parsed.scheme != "https" or not parsed.hostname or port not in (None, 443) or parsed.username or parsed.password or parsed.path != PATH or parsed.query or parsed.fragment:
        return None
    return url, secret, account


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _mapped_phone(lid):
    from hermes_constants import get_hermes_dir
    session_dir = get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")
    def mapping(name):
        fd = os.open(session_dir / f"lid-mapping-{name}.json", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 128:
                return None
            value = json.loads(os.read(fd, 129))
        finally:
            os.close(fd)
        return value if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{7,14}", value) else None
    try:
        phone = mapping(f"{lid}_reverse")
        if phone and mapping(phone) == lid:
            return phone
    except (OSError, ValueError, TypeError):
        pass
    return None


def _state_dir():
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = os.lstat(STATE_DIR)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise OSError("leave_state_dir_invalid")
    return STATE_DIR


def _state_path(key):
    return _state_dir() / f"{_sha(json.dumps(key[:2], separators=(',', ':')))}.json"


def _read_state(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 20_000:
            raise OSError("leave_state_file_invalid")
        data = os.read(fd, 20_001)
    finally:
        os.close(fd)
    if len(data) > 20_000:
        raise OSError("leave_state_file_invalid")
    record = json.loads(data)
    if not isinstance(record, dict) or record.get("version") != 1 or record.get("status") not in ("awaiting_receipt", "prepared", "unverified", "unresolved", "submitted") or type(record.get("created_at")) is not int:
        raise OSError("leave_state_invalid")
    if record["status"] in ("awaiting_receipt", "prepared"):
        if not SAFE_ID.fullmatch(str(record.get("session", ""))) or not SAFE_ID.fullmatch(str(record.get("inbound_id", ""))) or not isinstance(record.get("token"), str) or not 0 < len(record["token"]) <= 14000 or type(record.get("expires")) not in (int, float):
            raise OSError("leave_state_invalid")
        if record["status"] == "prepared" and (not SAFE_ID.fullmatch(str(record.get("message_id", ""))) or type(record.get("shown_at")) not in (int, float)):
            raise OSError("leave_state_invalid")
    if record["status"] == "unverified":
        packet = record.get("packet")
        if not SAFE_ID.fullmatch(str(record.get("session", ""))) or not isinstance(packet, dict) or not SAFE_ID.fullmatch(str(packet.get("event_id", ""))) or not isinstance(packet.get("payload"), dict) or not isinstance(packet["payload"].get("draftToken"), str):
            raise OSError("leave_state_invalid")
    return record


def _write_state(path, record):
    body = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > 20_000:
        raise OSError("leave_state_oversize")
    fd, temporary = tempfile.mkstemp(prefix=".mam-leave-", dir=_state_dir())
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(_state_dir(), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _delete_state(path):
    path.unlink(missing_ok=True)
    directory_fd = os.open(_state_dir(), os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _durable(key):
    path = _state_path(key)
    try:
        record = _read_state(path)
    except FileNotFoundError:
        return None
    now = int(time.time())
    if record["created_at"] > now + 60:
        raise OSError("leave_state_future")
    age = now - record["created_at"]
    if age >= 86400 or (age >= 3600 and record["status"] == "submitted") or (record["status"] in ("awaiting_receipt", "prepared") and (age >= 3600 or time.time() >= record["expires"])):
        _delete_state(path)
        return None
    if age >= 3600 and record["status"] == "unverified":
        record = {"version": 1, "status": "unresolved", "created_at": record["created_at"]}
        _write_state(path, record)
    return record


def _prune_durable():
    for path in _state_dir().iterdir():
        if re.fullmatch(r"[a-f0-9]{64}\.json", path.name):
            record = _read_state(path)
            now = int(time.time())
            if record["created_at"] > now + 60:
                raise OSError("leave_state_future")
            age = now - record["created_at"]
            if age >= 86400 or (age >= 3600 and record["status"] == "submitted") or (record["status"] in ("awaiting_receipt", "prepared") and (age >= 3600 or time.time() >= record["expires"])):
                _delete_state(path)
            elif age >= 3600 and record["status"] == "unverified":
                _write_state(path, {"version": 1, "status": "unresolved", "created_at": record["created_at"]})


def _identity(source, gateway):
    if getattr(getattr(source, "platform", None), "value", None) != "whatsapp" or getattr(source, "chat_type", None) != "dm":
        return None
    sender_id = getattr(source, "user_id", None)
    chat_id = getattr(source, "chat_id", None)
    if not isinstance(chat_id, str):
        return None
    from gateway.whatsapp_identity import canonical_whatsapp_identifier
    phone_sender = PHONE.fullmatch(sender_id or "")
    lid_chat = LID.fullmatch(chat_id)
    if phone_sender and lid_chat:
        from hermes_constants import get_hermes_dir
        session_dir = get_hermes_dir("platforms/whatsapp/session", "whatsapp/session")
        reverse_path = session_dir / f"lid-mapping-{lid_chat.group(1)}_reverse.json"
        forward_path = session_dir / f"lid-mapping-{phone_sender.group(1)}.json"
        if (os.path.lexists(reverse_path) or os.path.lexists(forward_path)) and _mapped_phone(lid_chat.group(1)) != phone_sender.group(1):
            return None
    elif canonical_whatsapp_identifier(sender_id) != canonical_whatsapp_identifier(chat_id):
        return None
    if not gateway._is_user_authorized_for_source(source):
        return None
    sender = PHONE.fullmatch(sender_id or "")
    lid = LID.fullmatch(sender_id or "")
    phone = sender.group(1) if sender else _mapped_phone(lid.group(1)) if lid else None
    if not phone:
        return None
    session_key = gateway._session_key_for_source(source)
    if not isinstance(session_key, str) or not session_key:
        return None
    account = "default"
    cfg = _config()
    if cfg:
        account = cfg[2]
    key = (account, f"+{phone}", _sha(session_key))
    return {"account": account, "sender": key[1], "session": f"s-{key[2]}", "session_key": session_key, "key": key, "source": source}


def _owner_forwarded(event):
    metadata = getattr(event, "metadata", None) or {}
    raw = getattr(event, "raw_message", None) or {}
    return isinstance(metadata, dict) and metadata.get("whatsapp_from_owner") is True or isinstance(raw, dict) and raw.get("fromOwner") is True


def _bridge(identity, operation, payload, inbound_id=None):
    cfg = _config()
    if not cfg or identity["account"] != cfg[2]:
        return {"code": "unavailable"}
    packet = {
        "version": 3,
        "account": identity["account"],
        "channel": "whatsapp",
        "sender": identity["sender"],
        "session": identity["session"],
        "eventId": f"wa-{_sha(json.dumps([identity['account'], identity['sender'], identity['session'], inbound_id], separators=(',', ':')))}" if inbound_id else f"ev-{os.urandom(16).hex()}",
        "operation": operation,
        "payload": payload,
    }
    body = json.dumps(packet, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    timestamp = str(int(time.time() * 1000))
    signature = hmac.new(cfg[1].encode(), b"POST\n" + PATH.encode() + b"\n" + timestamp.encode() + b"\n" + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(cfg[0], body, {"Content-Type": "application/json", "X-MAM-Timestamp": timestamp, "X-MAM-Signature": signature}, method="POST")
    try:
        opener = urllib.request.build_opener(_NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        with opener.open(request, timeout=30) as response:
            if response.status != 200:
                return {"code": "unavailable"}
            data = response.read(1_000_001)
        if len(data) > 1_000_000:
            return {"code": "unavailable"}
        result = json.loads(data)
        return result if isinstance(result, dict) and isinstance(result.get("code"), str) else {"code": "unavailable"}
    except urllib.error.HTTPError as error:
        if error.code == 401:
            LOGGER.error("MAM leave bridge rejected authentication (HTTP 401)")
        if error.code == 409:
            try:
                data = json.loads(error.read(4096))
                if data.get("code") in ("expired", "conflict"):
                    return {"code": data["code"]}
            except (ValueError, AttributeError, TypeError):
                pass
        return {"code": "unavailable"}
    except (OSError, ValueError):
        return {"code": "unavailable"}


def _visible(result, shown):
    if result.get("code") == "needs_input":
        return result
    if result.get("code") != "prepared":
        return {"code": "unavailable"}
    return {
        "code": "prepared",
        "delivery": "The exact summary has a verified delivery receipt. Do not send another copy." if shown else "The summary has no verified delivery receipt. Do not claim delivery or submission.",
        "instruction": "Reply only: Reply Confirm within 10 minutes to submit. Do not repeat the summary or claim submission.",
    }


def _confirmation_text(result):
    if result.get("code") == "submitted" and result.get("status") == "Pending":
        return "Your leave request has been submitted and is now pending manager approval."
    if result.get("code") == "expired":
        return "That leave confirmation has expired. Please start the leave request again."
    if result.get("code") == "conflict":
        return "That confirmation could not be matched to the exact leave summary. Please start the leave request again."
    return "I could not verify submission yet. Please send Confirm again shortly to check the same request; do not start a duplicate request."


def _confirmation_issue(event, shown_message_id, shown_at):
    raw = getattr(event, "raw_message", None)
    raw_timestamp = raw.get("timestamp") if isinstance(raw, dict) else None
    try:
        timestamp = float(raw_timestamp)
        if timestamp < 1e12:
            timestamp *= 1000
    except (TypeError, ValueError):
        timestamp = None
    reply_to = getattr(event, "reply_to_message_id", None)
    if reply_to and reply_to != shown_message_id:
        return "That is an older leave summary. Please review the latest summary and send Confirm without quoting the older message."
    if not shown_message_id or timestamp is None or timestamp <= shown_at * 1000:
        return "Please wait for your latest leave summary, then send a new Confirm message. Nothing has been submitted by this message."
    return None


class _Owner:
    def __init__(self):
        self.gateway = None
        self.turns = {}
        self.processing_turns = {}
        self.turn_seen = {}
        self.turn_ids = {}
        self.pending = {}
        self.preparing = {}
        self.confirmations = {}
        self.deliveries = {}
        self.unresolved_until = {}

    def prune(self):
        now = time.time()
        for turn_id, bound in list(self.turn_ids.items()):
            if bound[3] + 3600 <= now:
                self.turn_ids.pop(turn_id, None)
        for event_key, record in list(self.confirmations.items()):
            if record[1] <= now and record[0].done():
                self.confirmations.pop(event_key, None)
        for key, item in list(self.pending.items()):
            if item["created_at"] + 3600 <= now:
                if item.get("packet") and not item.get("result") and item["created_at"] + 86400 > now:
                    self.unresolved_until[key] = item["created_at"] + 86400
                self.pending.pop(key, None)
            elif item["expires"] <= now and not item.get("packet") and not item.get("result"):
                self.pending.pop(key, None)
        for key, deadline in list(self.unresolved_until.items()):
            if deadline <= now:
                self.unresolved_until.pop(key, None)
        for key, seen in list(self.turn_seen.items()):
            if seen + 3600 <= now and key not in self.pending and key not in self.preparing and key not in self.unresolved_until:
                self.turn_seen.pop(key, None)
                self.turns.pop(key, None)
                self.processing_turns.pop(key, None)

    async def send(self, identity, text):
        if not self.gateway or not self.gateway._is_user_authorized_for_source(identity["source"]):
            return None
        adapter = self.gateway._delivery_adapter_for(identity["source"])
        if adapter is None:
            return None
        result = await adapter.send(identity["source"].chat_id, text)
        message_id = getattr(result, "message_id", None)
        if not getattr(result, "success", False) or not isinstance(message_id, str) or not SAFE_ID.fullmatch(message_id):
            return None
        return message_id

    def invalidate(self, key, inbound_id, processing=True):
        durable = _durable(key)
        if durable and durable["status"] in ("awaiting_receipt", "prepared"):
            _delete_state(_state_path(key))
        self.turns[key] = inbound_id if isinstance(inbound_id, str) and SAFE_ID.fullmatch(inbound_id) else object()
        if processing:
            self.processing_turns[key] = self.turns[key]
        self.turn_seen[key] = time.time()
        self.pending.pop(key, None)
        self.preparing.pop(key, None)

    async def prepare(self, args, session_id, task_id):
        self.prune()
        bound = self.turn_ids.get((session_id, task_id))
        if not bound or bound[0] != session_id or not isinstance(bound[2], str) or not SAFE_ID.fullmatch(bound[2]) or not self.gateway:
            return {"code": "unavailable"}
        entry = self.gateway.session_store.lookup_by_session_id(session_id)
        identity = _identity(getattr(entry, "origin", None), self.gateway) if entry else None
        if not identity or identity["key"] != bound[1] or self.turns.get(bound[1]) != bound[2]:
            return {"code": "unavailable"}
        key = identity["key"]
        durable = _durable(key)
        if key in self.unresolved_until or (durable and durable["status"] == "unresolved"):
            return {"code": "unavailable", "message": UNRESOLVED_TEXT}
        if durable and durable["status"] == "unverified":
            return {"code": "unavailable", "message": "The previous submission has not been verified. Send Confirm again before starting another request."}
        payload = {name: args[name] for name in ("leaveType", "startDate", "endDate") if name in args and args[name] is not None}
        payload["startTime"] = args.get("startTime")
        payload["endTime"] = args.get("endTime")
        payload["employeeNote"] = args.get("employeeNote") or ""
        previous = self.pending.get(key)
        if previous and previous.get("packet") and not previous.get("result"):
            return {"code": "unavailable", "message": "The previous submission has not been verified. Send Confirm again before starting another request."}
        payload_hash = _sha(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        active = self.preparing.get(key)
        if active and active["turn_id"] == bound[2] and active["payload_hash"] == payload_hash:
            return await active["task"]
        if previous and previous.get("turn_id") == bound[2] and previous.get("payload_hash") == payload_hash and previous["expires"] > time.time():
            delivery = previous.get("delivery")
            if delivery:
                await delivery
            return _visible(previous["response"], previous.get("shown", False))
        revision = object()
        if durable and durable["status"] in ("awaiting_receipt", "prepared"):
            _delete_state(_state_path(key))
        self.pending.pop(key, None)
        self.preparing[key] = {"revision": revision, "turn_id": bound[2], "payload_hash": payload_hash, "task": asyncio.current_task()}
        result = await asyncio.to_thread(_bridge, identity, "prepare", payload)
        if self.preparing.get(key, {}).get("revision") is not revision or self.turns.get(key) != bound[2]:
            return {"code": "unavailable"}
        self.preparing.pop(key, None)
        if result.get("code") != "prepared":
            return result if result.get("code") == "needs_input" else {"code": "unavailable"}
        summary = result.get("summary")
        token = result.get("draftToken")
        digest = result.get("digest")
        expiry = result.get("expiresAt")
        try:
            expires = datetime.fromisoformat(expiry.replace("Z", "+00:00")).timestamp()
        except (AttributeError, ValueError):
            return {"code": "unavailable"}
        if result.get("consentVersion") != 3 or not isinstance(summary, str) or not isinstance(token, str) or not 0 < len(token) <= 14000 or not isinstance(digest, str) or not DIGEST.fullmatch(digest) or _sha(summary) != digest or not UUID.fullmatch(str(result.get("draftId", ""))) or expires <= time.time():
            return {"code": "unavailable"}
        display = f"```\n{summary}\n```"
        if len(display) > 4000 or "```" in summary:
            return {"code": "needs_input", "missing": ["employeeNote"], "message": "Please shorten the optional note or remove special formatting. Nothing has been submitted."}
        adapter = self.gateway._delivery_adapter_for(identity["source"])
        try:
            exact_chunks = adapter.truncate_message(adapter.format_message(display), adapter._outgoing_chunk_limit())
        except (AttributeError, TypeError, ValueError):
            return {"code": "unavailable"}
        if exact_chunks != [display]:
            return {"code": "needs_input", "missing": ["employeeNote"], "message": "Please remove unusual spaces or invisible characters from the optional note. Nothing has been submitted."}
        item = {"identity": identity, "token": token, "summary": summary, "digest": digest, "expires": expires, "created_at": time.time(), "response": result, "turn_id": bound[2], "payload_hash": payload_hash, "shown": False}
        _write_state(_state_path(key), {"version": 1, "status": "awaiting_receipt", "created_at": int(item["created_at"]), "session": identity["session"], "inbound_id": bound[2], "token": token, "expires": expires})
        self.pending[key] = item
        async def deliver():
            prior = self.deliveries.get(key)
            if prior:
                try:
                    await prior
                except Exception:
                    pass
            if self.pending.get(key) is not item or self.turns.get(key) != bound[2]:
                return
            message_id = await self.send(identity, display)
            if self.pending.get(key) is item and message_id:
                shown_at = time.time()
                try:
                    _write_state(_state_path(key), {"version": 1, "status": "prepared", "created_at": int(item["created_at"]), "session": identity["session"], "inbound_id": bound[2], "token": token, "expires": expires, "message_id": message_id, "shown_at": shown_at})
                except OSError:
                    return
                item["message_id"] = message_id
                item["shown_at"] = shown_at
                item["shown"] = True
        task = asyncio.create_task(deliver())
        item["delivery"] = task
        self.deliveries[key] = task
        try:
            await task
        finally:
            if self.deliveries.get(key) is task:
                self.deliveries.pop(key, None)
        if self.pending.get(key) is not item or not item["shown"]:
            if self.pending.get(key) is item:
                self.pending.pop(key, None)
                _delete_state(_state_path(key))
            return {"code": "unavailable", "message": "I could not deliver the confirmation summary. Please try again."}
        return _visible(result, True)

    async def submit_packet(self, identity, key, packet, created_at, session):
        replay_identity = {**identity, "session": session}
        result = await asyncio.to_thread(_bridge, replay_identity, "confirm", packet["payload"], packet["event_id"])
        if result.get("code") == "submitted" and result.get("status") == "Pending":
            _write_state(_state_path(key), {"version": 1, "status": "submitted", "created_at": created_at})
        elif result.get("code") in ("expired", "conflict"):
            _delete_state(_state_path(key))
        return result

    async def confirm(self, event, identity):
        self.prune()
        key = identity["key"]
        message_id = getattr(event, "message_id", None)
        if not isinstance(message_id, str) or not SAFE_ID.fullmatch(message_id):
            await self.send(identity, "I could not verify that message. Please send Confirm again.")
            return
        event_key = (key, message_id)
        if event_key in self.confirmations:
            await self.confirmations[event_key][0]
            return
        item = self.pending.get(key)
        async def process():
            if not item or key in self.preparing:
                durable = _durable(key)
                if durable and durable["status"] == "unverified":
                    result = await self.submit_packet(identity, key, durable["packet"], durable["created_at"], durable["session"])
                    text = _confirmation_text(result)
                elif durable and durable["status"] == "prepared":
                    issue = _confirmation_issue(event, durable["message_id"], durable["shown_at"])
                    if issue:
                        text = issue
                    else:
                        packet = {"event_id": message_id, "payload": {"draftToken": durable["token"], "shownMessageId": durable["message_id"], "replyToMessageId": getattr(event, "reply_to_message_id", None), "text": event.text}}
                        _write_state(_state_path(key), {"version": 1, "status": "unverified", "created_at": durable["created_at"], "session": durable["session"], "packet": packet})
                        result = await self.submit_packet(identity, key, packet, durable["created_at"], durable["session"])
                        text = _confirmation_text(result)
                elif durable and durable["status"] == "awaiting_receipt":
                    text = "I could not verify that your previous leave summary was delivered. Please tell me your leave dates again; nothing was submitted."
                elif durable and durable["status"] == "submitted":
                    text = _confirmation_text({"code": "submitted", "status": "Pending"})
                elif key in self.unresolved_until or (durable and durable["status"] == "unresolved"):
                    text = UNRESOLVED_TEXT
                else:
                    text = "There is no current leave summary to confirm. Please tell me your leave dates again."
            else:
                reply_to = getattr(event, "reply_to_message_id", None)
                issue = _confirmation_issue(event, item.get("message_id"), item.get("shown_at", 0))
                if not item.get("shown") or issue:
                    text = issue or "Please wait for your latest leave summary, then send a new Confirm message. Nothing has been submitted by this message."
                elif not item.get("result") and not item.get("packet") and item["expires"] <= time.time():
                    text = _confirmation_text({"code": "expired"})
                else:
                    if not item.get("result"):
                        if not item.get("packet"):
                            packet = {"event_id": message_id, "payload": {"draftToken": item["token"], "shownMessageId": item["message_id"], "replyToMessageId": reply_to, "text": event.text}}
                            _write_state(_state_path(key), {"version": 1, "status": "unverified", "created_at": int(item["created_at"]), "session": item["identity"]["session"], "packet": packet})
                            item["packet"] = packet
                        packet = item["packet"]
                        result = await self.submit_packet(identity, key, packet, int(item["created_at"]), item["identity"]["session"])
                        if result.get("code") == "submitted" and result.get("status") == "Pending":
                            item["result"] = result
                        elif result.get("code") in ("expired", "conflict"):
                            self.pending.pop(key, None)
                        text = _confirmation_text(result)
                    else:
                        text = _confirmation_text(item["result"])
            await self.send(identity, text)
        task = asyncio.create_task(process())
        self.confirmations[event_key] = (task, time.time() + 3600)
        await task


_owner = _Owner()


async def _pre_gateway_dispatch(event, gateway, **kwargs):
    source = getattr(event, "source", None)
    if getattr(getattr(source, "platform", None), "value", None) != "whatsapp":
        return None
    if _owner_forwarded(event):
        return {"action": "skip", "reason": "mam-leave-owner-forwarded"}
    is_confirm = isinstance(getattr(event, "text", None), str) and CONFIRM.fullmatch(event.text)
    try:
        cfg = _config()
        if not cfg:
            return {"action": "skip", "reason": "mam-leave-unconfigured"} if is_confirm else None
        _owner.gateway = gateway
        _owner.prune()
        identity = _identity(source, gateway)
        if not identity:
            return {"action": "skip", "reason": "mam-leave-invalid-identity"} if is_confirm else None
        key = identity["key"]
        durable = _durable(key)
        if key in _owner.unresolved_until or (durable and durable["status"] == "unresolved"):
            await _owner.send(identity, UNRESOLVED_TEXT)
            return {"action": "skip", "reason": "mam-leave-unresolved"}
        if is_confirm:
            await _owner.confirm(event, identity)
            return {"action": "skip", "reason": "mam-leave-confirm"}
        if durable and durable["status"] == "unverified":
            await _owner.send(identity, _confirmation_text({"code": "unavailable"}))
            return {"action": "skip", "reason": "mam-leave-unresolved"}
        previous = _owner.pending.get(key)
        if previous and previous.get("packet") and not previous.get("result"):
            await _owner.send(identity, _confirmation_text({"code": "unavailable"}))
            return {"action": "skip", "reason": "mam-leave-unresolved"}
        inbound_id = getattr(event, "message_id", None)
        if durable and durable["status"] == "prepared" and inbound_id == durable["inbound_id"]:
            return {"action": "skip", "reason": "mam-leave-redelivered-request"}
        if getattr(event, "_mam_leave_busy_observed", False):
            if not isinstance(inbound_id, str) or not SAFE_ID.fullmatch(inbound_id):
                return {"action": "skip", "reason": "mam-leave-invalid-busy-event"}
            _owner.processing_turns[key] = inbound_id
            return None
        if isinstance(inbound_id, str) and SAFE_ID.fullmatch(inbound_id) and _owner.turns.get(key) == inbound_id:
            return {"action": "skip", "reason": "mam-leave-duplicate-inbound"}
        _owner.invalidate(key, inbound_id)
        return None
    except Exception:
        return {"action": "skip", "reason": "mam-leave-hook-error"}


def _pre_llm_call(session_id, task_id, platform, sender_id, **kwargs):
    try:
        gateway = _owner.gateway
        if platform != "whatsapp" or not gateway or not isinstance(task_id, str) or not task_id:
            return None
        _owner.prune()
        entry = gateway.session_store.lookup_by_session_id(session_id)
        identity = _identity(getattr(entry, "origin", None), gateway) if entry else None
        sender_phone = PHONE.fullmatch(sender_id or "")
        sender_lid = LID.fullmatch(sender_id or "")
        verified_phone = sender_phone.group(1) if sender_phone else _mapped_phone(sender_lid.group(1)) if sender_lid else None
        if identity and (not sender_id or f"+{verified_phone}" == identity["sender"]):
            _owner.turn_ids[(session_id, task_id)] = (session_id, identity["key"], _owner.processing_turns.get(identity["key"]), time.time())
    except Exception:
        pass
    return None


def _tool(args, session_id="", task_id="", **kwargs):
    gateway = _owner.gateway
    loop = getattr(gateway, "_gateway_loop", None) if gateway else None
    if not _config() or not loop or not loop.is_running() or not isinstance(args, dict):
        return json.dumps({"code": "unavailable"})
    try:
        if asyncio.get_running_loop() is loop:
            return json.dumps({"code": "unavailable"})
    except RuntimeError:
        pass
    future = None
    try:
        future = asyncio.run_coroutine_threadsafe(_owner.prepare(args, session_id, task_id), loop)
        return json.dumps(future.result(timeout=70), ensure_ascii=False)
    except Exception:
        if future:
            future.cancel()
        return json.dumps({"code": "unavailable"})


def _wire_whatsapp_busy_handler(native, adapter):
    original = getattr(adapter, "_busy_session_handler", None)
    if not callable(original):
        raise RuntimeError("mam_leave_busy_handler_unavailable")
    if getattr(original, "_mam_leave_guard", False):
        return

    async def guarded(event, session_key):
        source = getattr(event, "source", None)
        if getattr(getattr(source, "platform", None), "value", None) != "whatsapp" or getattr(source, "chat_type", None) != "dm" or not _config():
            return await original(event, session_key)
        if _owner_forwarded(event):
            return True
        gateway = _owner.gateway
        if gateway is None:
            return True
        if not gateway._is_user_authorized_for_source(source):
            return await original(event, session_key)
        try:
            identity = _identity(source, gateway)
            if not identity:
                return True
            if CONFIRM.fullmatch(getattr(event, "text", "") or ""):
                await _owner.send(identity, "Please wait for the current reply to finish, then send a new Confirm message. Nothing was submitted by this message.")
                return True
            _owner.invalidate(identity["key"], getattr(event, "message_id", None), processing=False)
            event._mam_leave_busy_observed = True
        except Exception:
            return True
        return await original(event, session_key)

    guarded._mam_leave_guard = True
    adapter.set_busy_session_handler(guarded)


def register(ctx):
    ctx.register_tool(name="mam_leave_prepare", toolset="mam_hermes_leave", schema=SCHEMA, handler=_tool, check_fn=lambda: _config() is not None)
    ctx.register_hook("pre_gateway_dispatch", _pre_gateway_dispatch)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_platform_handler("whatsapp", _wire_whatsapp_busy_handler)


if __name__ == "__main__" and sys.argv[1:] == ["prune"]:
    _prune_durable()
