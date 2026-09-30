import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "integrations" / "hermes-leave" / "allowlist.py"
spec = importlib.util.spec_from_file_location("mam_hermes_allowlist", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HermesAllowlistTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patchers = [
            patch.object(module, "ROOT", self.root),
            patch.object(module, "STATE_FILE", self.root / "state.json"),
            patch.object(module, "STOP_REQUIRED_FILE", self.root / "stop-required"),
            patch.object(module, "ENV_FILE", self.root / ".env"),
            patch.object(module, "MAX_STALE", 0),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=false\nKEEP=synthetic\n")
        self.phones = ["+61400000001", "+61400000002"]
        self.calls = []
        self.systemctl = patch.object(module, "_systemctl", side_effect=lambda action: self.calls.append(action) or True)
        self.systemctl.start()
        self.addCleanup(self.systemctl.stop)
        self.stopped = patch.object(module, "_is_stopped", return_value=True)
        self.stopped.start()
        self.addCleanup(self.stopped.stop)
        self.real_active_bridge = module._active_whatsapp_bridge
        self.bridge = patch.object(module, "_active_whatsapp_bridge", return_value=False)
        self.bridge.start()
        self.addCleanup(self.bridge.stop)

    def test_sync_updates_allowlist_without_enabling_whatsapp(self):
        with patch.object(module, "_snapshot", return_value=(self.phones, module._digest(self.phones), int(time.time() * 1000))):
            self.assertTrue(module.sync())
        values = module._env()[1]
        self.assertEqual(values["WHATSAPP_ENABLED"], "false")
        self.assertEqual(values["WHATSAPP_ALLOWED_USERS"], "61400000001,61400000002")
        self.assertEqual(values["WHATSAPP_DM_POLICY"], "allowlist")
        self.assertEqual(values["WHATSAPP_GROUP_POLICY"], "disabled")
        self.assertEqual(values["WHATSAPP_MODE"], "bot")
        self.assertEqual(values["KEEP"], "synthetic")
        self.assertFalse(self.calls)
        self.assertTrue(module.watchdog())
        self.assertEqual(os.stat(module.ENV_FILE).st_mode & 0o777, 0o600)

    def test_active_gateway_restarts_when_allowlist_changes(self):
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=true\nWHATSAPP_ALLOWED_USERS=61400000001\n")
        with patch.object(module, "_snapshot", return_value=(self.phones, module._digest(self.phones), int(time.time() * 1000))):
            self.assertTrue(module.sync())
        self.assertEqual(self.calls, ["restart"])

    def test_stale_or_wildcard_state_disables_inbound(self):
        digest = module._digest(self.phones)
        module.STATE_FILE.write_text(json.dumps({"schemaVersion": 1, "digest": digest, "generatedAtMs": 1, "lastAcceptedAt": 1}))
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=true\nWHATSAPP_ALLOWED_USERS=*\nWHATSAPP_ALLOW_ALL_USERS=true\n")
        self.assertFalse(module.watchdog())
        values = module._env()[1]
        self.assertEqual(values["WHATSAPP_ENABLED"], "false")
        self.assertEqual(values["WHATSAPP_ALLOW_ALL_USERS"], "false")
        self.assertEqual(self.calls, ["stop"])

    def test_snapshot_failure_does_not_keep_stale_allowlist(self):
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=true\nWHATSAPP_ALLOWED_USERS=61400000001\n")
        with patch.object(module, "_snapshot", side_effect=ValueError("unavailable")):
            self.assertFalse(module.sync())
        self.assertEqual(module._env()[1]["WHATSAPP_ENABLED"], "false")

    def test_duplicate_env_key_fails_closed(self):
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=true\nWHATSAPP_ENABLED=false\n")
        self.assertFalse(module.watchdog())
        self.assertIn("stop", self.calls)

    def test_failed_gateway_stop_is_reported_as_failure(self):
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=true\n")
        with patch.object(module, "_systemctl", return_value=False), patch.object(module, "_log") as log:
            self.assertFalse(module._disable("synthetic_stale_allowlist"))
        log.assert_called_with("gateway_hard_stop_failed", reason="synthetic_stale_allowlist")
        self.assertTrue(module.STOP_REQUIRED_FILE.exists())

    def test_disabled_whatsapp_does_not_stop_shared_gateway(self):
        self.assertTrue(module._disable("synthetic_stale_allowlist"))
        self.assertFalse(self.calls)
        self.assertFalse(module.STOP_REQUIRED_FILE.exists())

    def test_live_bridge_stops_even_if_disk_env_says_whatsapp_disabled(self):
        with patch.object(module, "_active_whatsapp_bridge", side_effect=[True, False]), patch.object(module, "_fsync_directory", wraps=module._fsync_directory) as synced:
            self.assertTrue(module._disable("synthetic_stale_allowlist"))
        self.assertEqual(self.calls, ["stop"])
        self.assertFalse(module.STOP_REQUIRED_FILE.exists())
        self.assertGreaterEqual(synced.call_count, 3)

    def test_bridge_detector_accepts_configured_script_path(self):
        proc = self.root / "proc"
        process = proc / "1234"
        process.mkdir(parents=True)
        (process / "cmdline").write_bytes(b"node\0/other/install/custom.js\0--port\0" + b"3000\0--session\0/other/session\0--mode\0bot\0")
        with patch.object(module, "PROC_ROOT", proc):
            self.assertTrue(self.real_active_bridge())
            (process / "cmdline").write_bytes(b"node\0/other/install/custom.js\0--session\0/other/session\0--mode\0bot\0")
            self.assertFalse(self.real_active_bridge())

    def test_watchdog_rejects_self_chat_mode(self):
        with patch.object(module, "_snapshot", return_value=(self.phones, module._digest(self.phones), int(time.time() * 1000))):
            self.assertTrue(module.sync())
        module.ENV_FILE.write_text(module.ENV_FILE.read_text().replace("WHATSAPP_MODE=bot", "WHATSAPP_MODE=self-chat"))
        self.assertFalse(module.watchdog())
        self.assertFalse(self.calls)

    def test_failed_stop_marker_blocks_sync_and_watchdog_until_verified(self):
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=true\n")
        with patch.object(module, "_systemctl", return_value=False):
            self.assertFalse(module._disable("synthetic_stale_allowlist"))
            with patch.object(module, "_snapshot", return_value=(self.phones, module._digest(self.phones), int(time.time() * 1000))) as snapshot:
                self.assertFalse(module.sync())
                snapshot.assert_not_called()
            self.assertFalse(module.watchdog())
        self.assertTrue(module.STOP_REQUIRED_FILE.exists())
        self.assertFalse(module.sync())
        self.assertFalse(module.STOP_REQUIRED_FILE.exists())
        self.assertEqual(self.calls, ["stop"])

    def test_failed_disable_write_keeps_stop_required_marker(self):
        module.ENV_FILE.write_text("WHATSAPP_ENABLED=true\n")
        with patch.object(module, "_update_env", side_effect=OSError("synthetic write failure")), patch.object(module, "_log") as log:
            self.assertFalse(module._disable("synthetic_stale_allowlist"))
        self.assertTrue(module.STOP_REQUIRED_FILE.exists())
        self.assertEqual(self.calls, ["stop"])
        log.assert_called_with("whatsapp_disable_configuration_failed", reason="synthetic_stale_allowlist")

    def test_watchdog_waits_for_in_progress_allowlist_update(self):
        entered = threading.Event()
        release = threading.Event()
        original_update = module._update_env
        def paused_update(changes):
            result = original_update(changes)
            entered.set()
            release.wait(2)
            return result
        result = {}
        with patch.object(module, "_snapshot", return_value=(self.phones, module._digest(self.phones), int(time.time() * 1000))), patch.object(module, "_update_env", side_effect=paused_update):
            sync_thread = threading.Thread(target=lambda: result.update(sync=module.sync()))
            sync_thread.start()
            self.assertTrue(entered.wait(1))
            watchdog_thread = threading.Thread(target=lambda: result.update(watchdog=module.watchdog()))
            watchdog_thread.start()
            self.assertFalse(threading.Event().wait(0.05))
            self.assertNotIn("watchdog", result)
            release.set()
            sync_thread.join(2)
            watchdog_thread.join(2)
        self.assertEqual(result, {"sync": True, "watchdog": True})
        self.assertFalse(self.calls)


if __name__ == "__main__":
    unittest.main()
