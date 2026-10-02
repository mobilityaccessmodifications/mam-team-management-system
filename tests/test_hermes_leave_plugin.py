import asyncio
import hashlib
import hmac
import importlib.util
import json
import os
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


PLUGIN_PATH = Path(__file__).resolve().parents[1] / "integrations" / "hermes-leave" / "__init__.py"
spec = importlib.util.spec_from_file_location("mam_hermes_leave", PLUGIN_PATH)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class FakeAdapter:
    def __init__(self):
        self.sent = []

    async def send(self, chat_id, text):
        self.sent.append((chat_id, text))
        return types.SimpleNamespace(success=True, message_id=f"OUT{len(self.sent)}")

    def format_message(self, text):
        return text.replace("\u200b", "")

    def _outgoing_chunk_limit(self):
        return 4096

    def truncate_message(self, text, limit):
        return [text] if len(text) <= limit else [text[:limit], text[limit:]]

    def set_busy_session_handler(self, handler):
        self._busy_session_handler = handler


class FakeGateway:
    def __init__(self, source):
        self.source = source
        self.adapter = FakeAdapter()
        self.authorized = True
        self.session_key = "whatsapp:dm:sample"
        self.session_store = types.SimpleNamespace(lookup_by_session_id=lambda session_id: types.SimpleNamespace(origin=self.source) if session_id == "session-1" else None)
        self._gateway_loop = asyncio.get_running_loop()

    def _is_user_authorized_for_source(self, source):
        return self.authorized and source is self.source

    def _session_key_for_source(self, source):
        return self.session_key

    def _delivery_adapter_for(self, source):
        return self.adapter if source is self.source else None


def event(source, text, message_id, timestamp=None, reply_to=None):
    return types.SimpleNamespace(source=source, text=text, message_id=message_id, raw_message={"timestamp": timestamp}, reply_to_message_id=reply_to)


class HermesLeaveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addAsyncCleanup(self.temp.cleanup)
        self.state_dir = patch.object(plugin, "STATE_DIR", Path(self.temp.name) / "leave-state")
        self.state_dir.start()
        self.addAsyncCleanup(self.state_dir.stop)
        self.wa_session = Path(self.temp.name) / "wa-session"
        self.wa_session.mkdir()
        def canonical(value):
            return str(value).split("@", 1)[0].replace("+", "")
        self.gateway_module = types.ModuleType("gateway")
        self.identity_module = types.ModuleType("gateway.whatsapp_identity")
        self.identity_module.canonical_whatsapp_identifier = canonical
        self.constants_module = types.ModuleType("hermes_constants")
        self.constants_module.get_hermes_dir = lambda *_: self.wa_session
        self.modules = patch.dict(sys.modules, {"gateway": self.gateway_module, "gateway.whatsapp_identity": self.identity_module, "hermes_constants": self.constants_module})
        self.modules.start()
        self.env = patch.dict(os.environ, {
            "MAM_HERMES_LEAVE_ENABLED": "true",
            "MAM_HERMES_LEAVE_BRIDGE_URL": "https://example.invalid/api/internal/integrations/openclaw/leave",
            "MAM_HERMES_LEAVE_BRIDGE_SECRET": "a" * 43,
            "MAM_HERMES_LEAVE_ACCOUNT": "default",
        })
        self.env.start()
        plugin._owner = plugin._Owner()
        self.source = types.SimpleNamespace(platform=types.SimpleNamespace(value="whatsapp"), chat_type="dm", user_id="61412345678@s.whatsapp.net", chat_id="61412345678@s.whatsapp.net")
        self.gateway = FakeGateway(self.source)
        self.requests = []
        self.summary = "Name: Sample Employee\nDates: 2026-10-20\nType: Annual leave\nNote:"
        self.real_bridge = plugin._bridge
        def fake_bridge(identity, operation, payload, inbound_id=None):
            self.requests.append((operation, payload, inbound_id, identity["sender"], identity["session"]))
            if operation == "prepare":
                return {
                    "code": "prepared", "consentVersion": 3,
                    "draftId": "123e4567-e89b-42d3-a456-426614174000",
                    "draftToken": "synthetic-token", "summary": self.summary,
                    "digest": hashlib.sha256(self.summary.encode()).hexdigest(),
                    "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
                }
            return {"code": "submitted", "status": "Pending"}
        self.bridge = patch.object(plugin, "_bridge", side_effect=fake_bridge)
        self.bridge.start()

    async def asyncTearDown(self):
        self.bridge.stop()
        self.env.stop()
        self.modules.stop()

    async def prepare(self):
        inbound = event(self.source, "I want leave", "IN01", int(time.time()))
        self.assertIsNone(await plugin._pre_gateway_dispatch(inbound, self.gateway))
        plugin._pre_llm_call("session-1", "session-1", "whatsapp", self.source.user_id)
        return await plugin._owner.prepare({"startDate": "2026-10-20", "endDate": "2026-10-20"}, "session-1", "session-1")

    async def test_prepare_and_confirm_use_trusted_sender_and_receipt(self):
        output = await self.prepare()
        self.assertEqual(output["code"], "prepared")
        self.assertNotIn("synthetic-token", json.dumps(output))
        self.assertNotIn("leaveType", self.requests[0][1])
        self.assertIsNone(self.requests[0][1]["startTime"])
        self.assertEqual(self.gateway.adapter.sent[0][1], f"```\n{self.summary}\n```")
        confirm = event(self.source, "Confirm", "IN02", int(time.time()) + 1, "OUT1")
        self.assertEqual((await plugin._pre_gateway_dispatch(confirm, self.gateway))["action"], "skip")
        self.assertEqual(self.requests[-1][0], "confirm")
        self.assertEqual(self.requests[-1][2], "IN02")
        self.assertEqual(self.requests[-1][3], "+61412345678")
        self.assertEqual(self.requests[-1][1]["shownMessageId"], "OUT1")
        self.assertEqual(self.gateway.adapter.sent[-1][1], "Your leave request has been submitted and is now pending manager approval.")
        await plugin._pre_gateway_dispatch(confirm, self.gateway)
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 1)

    async def test_session_key_change_replays_confirmation_with_draft_session(self):
        await self.prepare()
        original_session = self.requests[0][4]
        self.gateway.session_key = "whatsapp:dm:changed"
        confirm = event(self.source, "Confirm", "IN02", int(time.time()) + 1, "OUT1")
        self.assertEqual((await plugin._pre_gateway_dispatch(confirm, self.gateway))["action"], "skip")
        self.assertEqual(self.requests[-1][0], "confirm")
        self.assertEqual(self.requests[-1][4], original_session)

    async def test_redelivered_request_after_restart_keeps_delivered_summary(self):
        await self.prepare()
        identity = plugin._identity(self.source, self.gateway)
        plugin._owner = plugin._Owner()
        replay = event(self.source, "I want leave", "IN01", int(time.time()))
        self.assertEqual((await plugin._pre_gateway_dispatch(replay, self.gateway))["reason"], "mam-leave-redelivered-request")
        self.assertEqual(plugin._durable(identity["key"])["status"], "prepared")
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1, "OUT1"), self.gateway)
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 1)

    async def test_stale_or_unproven_confirm_does_not_submit(self):
        await self.prepare()
        stale = event(self.source, "Confirm", "IN02", int(time.time()) - 100)
        await plugin._pre_gateway_dispatch(stale, self.gateway)
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 0)

    async def test_same_second_confirm_before_summary_delivery_does_not_submit(self):
        await self.prepare()
        item = next(iter(plugin._owner.pending.values()))
        delivery_second = int(time.time())
        item["shown_at"] = delivery_second + 0.5
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", delivery_second), self.gateway)
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 0)

    async def test_busy_edit_invalidates_prepared_draft_before_queued_dispatch(self):
        await self.prepare()
        queued = []

        async def original(inbound, session_key):
            queued.append(inbound)
            return True

        self.gateway.adapter.set_busy_session_handler(original)
        plugin._wire_whatsapp_busy_handler(None, self.gateway.adapter)
        edit = event(self.source, "Change my dates", "IN02", int(time.time()) + 1)
        self.assertTrue(await self.gateway.adapter._busy_session_handler(edit, "whatsapp:dm:sample"))
        self.assertEqual(queued, [edit])
        self.assertEqual(plugin._owner.pending, {})
        self.assertIsNone(plugin._durable(plugin._identity(self.source, self.gateway)["key"]))
        self.assertIsNone(await plugin._pre_gateway_dispatch(edit, self.gateway))
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN03", int(time.time()) + 2), self.gateway)
        self.assertFalse(any(item[0] == "confirm" for item in self.requests))

    async def test_busy_confirm_is_rejected_without_queue_or_submit(self):
        await self.prepare()
        queued = []

        async def original(inbound, session_key):
            queued.append(inbound)
            return True

        self.gateway.adapter.set_busy_session_handler(original)
        plugin._wire_whatsapp_busy_handler(None, self.gateway.adapter)
        self.assertTrue(await self.gateway.adapter._busy_session_handler(event(self.source, "Confirm", "IN02", int(time.time()) + 1), "whatsapp:dm:sample"))
        self.assertEqual(queued, [])
        self.assertFalse(any(item[0] == "confirm" for item in self.requests))
        self.assertIn("send a new Confirm", self.gateway.adapter.sent[-1][1])

    async def test_older_busy_edit_cannot_reactivate_a_superseded_turn(self):
        await self.prepare()

        async def original(inbound, session_key):
            return True

        self.gateway.adapter.set_busy_session_handler(original)
        plugin._wire_whatsapp_busy_handler(None, self.gateway.adapter)
        first = event(self.source, "Change my dates", "IN02", int(time.time()) + 1)
        latest = event(self.source, "Make it October 22", "IN03", int(time.time()) + 2)
        await self.gateway.adapter._busy_session_handler(first, "whatsapp:dm:sample")
        await self.gateway.adapter._busy_session_handler(latest, "whatsapp:dm:sample")
        self.assertIsNone(await plugin._pre_gateway_dispatch(first, self.gateway))
        plugin._pre_llm_call("session-1", "task-first", "whatsapp", self.source.user_id)
        self.assertEqual((await plugin._owner.prepare({"startDate": "2026-10-21", "endDate": "2026-10-21"}, "session-1", "task-first"))["code"], "unavailable")
        self.assertIsNone(await plugin._pre_gateway_dispatch(latest, self.gateway))
        plugin._pre_llm_call("session-1", "task-latest", "whatsapp", self.source.user_id)
        self.assertEqual((await plugin._owner.prepare({"startDate": "2026-10-22", "endDate": "2026-10-22"}, "session-1", "task-latest"))["code"], "prepared")
        self.assertEqual(plugin._owner.turns[plugin._identity(self.source, self.gateway)["key"]], "IN03")

    async def test_owner_forwarded_message_cannot_start_or_confirm_employee_leave(self):
        forwarded = event(self.source, "I want leave", "IN01", int(time.time()))
        forwarded.metadata = {"whatsapp_from_owner": True}
        self.assertEqual((await plugin._pre_gateway_dispatch(forwarded, self.gateway))["reason"], "mam-leave-owner-forwarded")
        self.assertEqual(plugin._owner.turns, {})
        await self.prepare()
        owner_confirm = event(self.source, "Confirm", "IN02", int(time.time()) + 1)
        owner_confirm.raw_message["fromOwner"] = True
        self.assertEqual((await plugin._pre_gateway_dispatch(owner_confirm, self.gateway))["reason"], "mam-leave-owner-forwarded")
        self.assertFalse(any(item[0] == "confirm" for item in self.requests))
        queued = []

        async def original(inbound, session_key):
            queued.append(inbound)
            return True

        self.gateway.adapter.set_busy_session_handler(original)
        plugin._wire_whatsapp_busy_handler(None, self.gateway.adapter)
        self.assertTrue(await self.gateway.adapter._busy_session_handler(owner_confirm, "whatsapp:dm:sample"))
        self.assertEqual(queued, [])

    async def test_busy_edit_cancels_inflight_prepare_before_summary_send(self):
        inbound = event(self.source, "I want leave", "IN01", int(time.time()))
        await plugin._pre_gateway_dispatch(inbound, self.gateway)
        plugin._pre_llm_call("session-1", "session-1", "whatsapp", self.source.user_id)
        started = threading.Event()
        release = threading.Event()
        prior_bridge = plugin._bridge

        def delayed_bridge(*args, **kwargs):
            started.set()
            release.wait(3)
            return prior_bridge(*args, **kwargs)

        async def original(inbound, session_key):
            return True

        self.gateway.adapter.set_busy_session_handler(original)
        plugin._wire_whatsapp_busy_handler(None, self.gateway.adapter)
        with patch.object(plugin, "_bridge", side_effect=delayed_bridge):
            task = asyncio.create_task(plugin._owner.prepare({"startDate": "2026-10-20", "endDate": "2026-10-20"}, "session-1", "session-1"))
            self.assertTrue(await asyncio.to_thread(started.wait, 3))
            try:
                await self.gateway.adapter._busy_session_handler(event(self.source, "Change my dates", "IN02", int(time.time()) + 1), "whatsapp:dm:sample")
            finally:
                release.set()
            self.assertEqual((await task)["code"], "unavailable")
        self.assertEqual(self.gateway.adapter.sent, [])

    async def test_authorized_lid_resolves_to_verified_phone_mapping(self):
        self.wa_session.joinpath("lid-mapping-99912345678_reverse.json").write_text(json.dumps("61412345678"))
        self.wa_session.joinpath("lid-mapping-61412345678.json").write_text(json.dumps("99912345678"))
        self.source.user_id = "99912345678@lid"
        self.source.chat_id = "99912345678@lid"
        identity = plugin._identity(self.source, self.gateway)
        self.assertEqual(identity["sender"], "+61412345678")
        self.wa_session.joinpath("lid-mapping-61412345678.json").write_text(json.dumps("another-lid"))
        self.assertIsNone(plugin._identity(self.source, self.gateway))

    async def test_verified_lid_origin_binds_later_phone_jid_sender(self):
        self.wa_session.joinpath("lid-mapping-99912345678_reverse.json").write_text(json.dumps("61412345678"))
        self.wa_session.joinpath("lid-mapping-61412345678.json").write_text(json.dumps("99912345678"))
        self.source.user_id = "99912345678@lid"
        self.source.chat_id = "99912345678@lid"
        await plugin._pre_gateway_dispatch(event(self.source, "I want leave", "IN01", int(time.time())), self.gateway)
        plugin._pre_llm_call("session-1", "task-phone", "whatsapp", "61412345678@s.whatsapp.net")
        self.assertIn(("session-1", "task-phone"), plugin._owner.turn_ids)

    async def test_first_contact_phone_sender_with_lid_chat_uses_trusted_phone(self):
        self.source.chat_id = "99912345678@lid"
        identity = plugin._identity(self.source, self.gateway)
        self.assertEqual(identity["sender"], "+61412345678")
        self.wa_session.joinpath("lid-mapping-99912345678_reverse.json").write_text(json.dumps("61400000000"))
        self.wa_session.joinpath("lid-mapping-61400000000.json").write_text(json.dumps("99912345678"))
        self.assertIsNone(plugin._identity(self.source, self.gateway))
        with patch.object(self.identity_module, "canonical_whatsapp_identifier", return_value="same"):
            self.assertIsNone(plugin._identity(self.source, self.gateway))

    async def test_old_quoted_summary_cannot_confirm_newer_draft(self):
        await self.prepare()
        quoted = event(self.source, "Confirm", "IN02", int(time.time()) + 1, "OLD-OUT")
        await plugin._pre_gateway_dispatch(quoted, self.gateway)
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 0)

    async def test_unbound_tool_turn_cannot_prepare(self):
        self.assertEqual((await plugin._owner.prepare({}, "session-1", "forged-task"))["code"], "unavailable")
        self.assertFalse(self.requests)

    async def test_real_handler_kwargs_dispatch_to_bound_gateway_turn(self):
        await plugin._pre_gateway_dispatch(event(self.source, "I want leave", "IN01", int(time.time())), self.gateway)
        plugin._pre_llm_call("session-1", "session-1", "whatsapp", self.source.user_id)
        result = await asyncio.to_thread(plugin._tool, {"startDate": "2026-10-20", "endDate": "2026-10-20"}, session_id="session-1", task_id="session-1", user_task="I want leave")
        self.assertEqual(json.loads(result)["code"], "prepared")
        self.assertEqual(len(self.gateway.adapter.sent), 1)

    async def test_duplicate_inflight_prepare_sends_one_summary(self):
        await plugin._pre_gateway_dispatch(event(self.source, "I want leave", "IN01", int(time.time())), self.gateway)
        plugin._pre_llm_call("session-1", "session-1", "whatsapp", self.source.user_id)
        original = plugin._bridge
        def delayed(*args):
            time.sleep(0.02)
            return original(*args)
        with patch.object(plugin, "_bridge", side_effect=delayed):
            first, second = await asyncio.gather(
                plugin._owner.prepare({}, "session-1", "session-1"),
                plugin._owner.prepare({}, "session-1", "session-1"),
            )
        self.assertEqual(first["code"], "prepared")
        self.assertEqual(second["code"], "prepared")
        self.assertEqual(len([request for request in self.requests if request[0] == "prepare"]), 1)
        self.assertEqual(len(self.gateway.adapter.sent), 1)

    async def test_unknown_confirm_result_retries_original_packet(self):
        await self.prepare()
        real_bridge = plugin._bridge
        attempts = 0
        def uncertain(identity, operation, payload, inbound_id=None):
            nonlocal attempts
            if operation == "confirm":
                attempts += 1
                if attempts == 1:
                    self.requests.append((operation, payload, inbound_id, identity["sender"]))
                    return {"code": "unavailable"}
            return real_bridge(identity, operation, payload, inbound_id)
        with patch.object(plugin, "_bridge", side_effect=uncertain):
            await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1), self.gateway)
            await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN03", int(time.time()) + 2), self.gateway)
        confirms = [request for request in self.requests if request[0] == "confirm"]
        self.assertEqual([request[2] for request in confirms], ["IN02", "IN02"])
        self.assertEqual(confirms[0][1], confirms[1][1])

    async def test_gateway_restart_replays_exact_persisted_confirmation(self):
        await self.prepare()
        real_bridge = plugin._bridge
        attempts = 0
        sessions = []
        def uncertain(identity, operation, payload, inbound_id=None):
            nonlocal attempts
            if operation == "confirm":
                attempts += 1
                sessions.append(identity["session"])
                if attempts == 1:
                    self.requests.append((operation, payload, inbound_id, identity["sender"]))
                    return {"code": "unavailable"}
            return real_bridge(identity, operation, payload, inbound_id)
        with patch.object(plugin, "_bridge", side_effect=uncertain):
            await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1), self.gateway)
            plugin._owner = plugin._Owner()
            self.gateway._session_key_for_source = lambda _: "whatsapp:dm:mapped-alias-changed"
            blocked = await plugin._pre_gateway_dispatch(event(self.source, "New request", "IN03", int(time.time()) + 2), self.gateway)
            self.assertEqual(blocked["reason"], "mam-leave-unresolved")
            await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN04", int(time.time()) + 3), self.gateway)
        confirms = [request for request in self.requests if request[0] == "confirm"]
        self.assertEqual([request[2] for request in confirms], ["IN02", "IN02"])
        self.assertEqual(confirms[0][1], confirms[1][1])
        self.assertEqual(sessions, [sessions[0], sessions[0]])
        path = plugin._state_path(plugin._identity(self.source, self.gateway)["key"])
        self.assertEqual(plugin._durable(plugin._identity(self.source, self.gateway)["key"])["status"], "submitted")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)

    async def test_gateway_restart_can_confirm_verified_delivered_summary(self):
        await self.prepare()
        identity = plugin._identity(self.source, self.gateway)
        self.assertEqual(plugin._durable(identity["key"])["status"], "prepared")
        plugin._owner = plugin._Owner()
        response = await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1, "OUT1"), self.gateway)
        self.assertEqual(response["reason"], "mam-leave-confirm")
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 1)
        self.assertEqual(plugin._durable(identity["key"])["status"], "submitted")

    async def test_gateway_restart_never_confirms_summary_without_receipt(self):
        await self.prepare()
        identity = plugin._identity(self.source, self.gateway)
        record = plugin._durable(identity["key"])
        record.pop("message_id")
        record.pop("shown_at")
        record["status"] = "awaiting_receipt"
        plugin._write_state(plugin._state_path(identity["key"]), record)
        plugin._owner = plugin._Owner()
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1), self.gateway)
        self.assertFalse([request for request in self.requests if request[0] == "confirm"])
        self.assertIn("could not verify", self.gateway.adapter.sent[-1][1])

    async def test_confirmation_never_reaches_bridge_without_durable_packet(self):
        await self.prepare()
        with patch.object(plugin, "_write_state", side_effect=OSError("synthetic disk failure")):
            result = await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1), self.gateway)
        self.assertEqual(result["reason"], "mam-leave-hook-error")
        self.assertFalse([request for request in self.requests if request[0] == "confirm"])

    async def test_signed_bridge_packet_has_exact_identity(self):
        identity = plugin._identity(self.source, self.gateway)
        captured = {}
        class Response:
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def read(self, _):
                return b'{"code":"needs_input","missing":["startDate"]}'
        class Opener:
            def open(self, request, timeout):
                captured["request"] = request
                captured["timeout"] = timeout
                return Response()
        with patch.object(urllib.request, "build_opener", return_value=Opener()):
            result = self.real_bridge(identity, "prepare", {"employeeNote": ""})
        self.assertEqual(result["code"], "needs_input")
        request = captured["request"]
        body = json.loads(request.data)
        self.assertEqual(body["sender"], "+61412345678")
        self.assertEqual(body["channel"], "whatsapp")
        self.assertEqual(body["version"], 3)
        self.assertEqual(request.get_method(), "POST")
        timestamp = request.get_header("X-mam-timestamp")
        signature = hmac.new(b"a" * 43, b"POST\n" + plugin.PATH.encode() + b"\n" + timestamp.encode() + b"\n" + request.data, hashlib.sha256).hexdigest()
        self.assertEqual(request.get_header("X-mam-signature"), signature)

    async def test_bridge_auth_rejection_is_logged_without_identity_or_secret(self):
        identity = plugin._identity(self.source, self.gateway)
        error = urllib.error.HTTPError("https://example.invalid", 401, "Unauthorized", {}, None)
        self.addCleanup(error.close)
        class Opener:
            def open(self, request, timeout):
                raise error
        with patch.object(urllib.request, "build_opener", return_value=Opener()):
            with self.assertLogs("mam_hermes_leave", level="ERROR") as captured:
                result = self.real_bridge(identity, "prepare", {"employeeNote": ""})
        self.assertEqual(result, {"code": "unavailable"})
        self.assertIn("HTTP 401", captured.output[0])
        self.assertNotIn(identity["sender"], captured.output[0])
        self.assertNotIn("a" * 43, captured.output[0])

    async def test_new_message_invalidates_unsubmitted_draft(self):
        await self.prepare()
        await plugin._pre_gateway_dispatch(event(self.source, "Change the date", "IN03", int(time.time())), self.gateway)
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN04", int(time.time()) + 1), self.gateway)
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 0)

    async def test_same_turn_replacement_invalidates_old_durable_summary(self):
        await self.prepare()
        identity = plugin._identity(self.source, self.gateway)
        self.assertEqual(plugin._durable(identity["key"])["status"], "prepared")
        with patch.object(plugin, "_bridge", return_value={"code": "needs_input", "missing": ["startDate"]}):
            result = await plugin._owner.prepare({"startDate": "2026-10-21", "endDate": "2026-10-21"}, "session-1", "session-1")
        self.assertEqual(result["code"], "needs_input")
        self.assertIsNone(plugin._durable(identity["key"]))
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN04", int(time.time()) + 1), self.gateway)
        self.assertFalse([request for request in self.requests if request[0] == "confirm"])

    async def test_summary_that_transport_would_change_is_not_delivered(self):
        self.summary = "Name: Sample Employee\nNote: invisible\u200bcharacter"
        result = await self.prepare()
        self.assertEqual(result["code"], "needs_input")
        self.assertFalse(self.gateway.adapter.sent)
        identity = plugin._identity(self.source, self.gateway)
        self.assertIsNone(plugin._durable(identity["key"]))

    async def test_redelivery_keeps_current_draft(self):
        await self.prepare()
        replay = event(self.source, "I want leave", "IN01", int(time.time()))
        self.assertEqual((await plugin._pre_gateway_dispatch(replay, self.gateway))["action"], "skip")
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1), self.gateway)
        self.assertEqual(len([request for request in self.requests if request[0] == "confirm"]), 1)

    async def test_old_completed_records_are_pruned(self):
        await self.prepare()
        await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1), self.gateway)
        owner = plugin._owner
        self.assertTrue(owner.confirmations)
        self.assertTrue(owner.turn_ids)
        key, item = next(iter(owner.pending.items()))
        item["created_at"] = time.time() - 3601
        owner.confirmations = {key: (task, time.time() - 1) for key, (task, _) in owner.confirmations.items()}
        owner.turn_ids = {key: (*bound[:3], time.time() - 3601) for key, bound in owner.turn_ids.items()}
        owner.prune()
        self.assertFalse(owner.confirmations)
        self.assertFalse(owner.turn_ids)
        self.assertNotIn(key, owner.pending)
        self.assertNotIn(key, owner.unresolved_until)

    async def test_old_unverified_submission_discards_token_but_blocks_duplicate(self):
        await self.prepare()
        with patch.object(plugin, "_bridge", return_value={"code": "unavailable"}):
            await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time()) + 1), self.gateway)
        owner = plugin._owner
        key, item = next(iter(owner.pending.items()))
        self.assertIn("synthetic-token", json.dumps(item["packet"]))
        item["created_at"] = time.time() - 3601
        durable = plugin._durable(key)
        durable["created_at"] = int(item["created_at"])
        plugin._write_state(plugin._state_path(key), durable)
        owner.prune()
        self.assertNotIn(key, owner.pending)
        self.assertIn(key, owner.unresolved_until)
        self.assertEqual(owner.unresolved_until[key], item["created_at"] + 86400)
        self.assertEqual(plugin._durable(key)["status"], "unresolved")
        self.assertNotIn("synthetic-token", plugin._state_path(key).read_text())
        before = len(self.requests)
        response = await plugin._pre_gateway_dispatch(event(self.source, "New leave dates", "IN03", int(time.time()) + 2), self.gateway)
        self.assertEqual(response["reason"], "mam-leave-unresolved")
        self.assertIn("check your leave requests", self.gateway.adapter.sent[-1][1])
        self.assertEqual(len(self.requests), before)
        owner.unresolved_until[key] = time.time() - 1
        owner.prune()
        self.assertNotIn(key, owner.unresolved_until)

    async def test_group_and_unauthorized_sender_cannot_prepare_or_submit(self):
        self.source.chat_type = "group"
        self.assertIsNone(plugin._identity(self.source, self.gateway))
        self.source.chat_type = "dm"
        self.gateway.authorized = False
        self.assertIsNone(plugin._identity(self.source, self.gateway))
        result = await plugin._pre_gateway_dispatch(event(self.source, "Confirm", "IN02", int(time.time())), self.gateway)
        self.assertEqual(result["action"], "skip")
        self.assertFalse(self.requests)


if __name__ == "__main__":
    unittest.main()
