import json
import os
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, patch


class FixtureRequestTest(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(TemporaryDirectory())
        self.prefix = Path(self.directory, "test")
        self.request = self.prefix.with_name("test-request")
        self.unreal = MagicMock()
        self.unreal.EditorAssetLibrary.load_asset.return_value.get_path_name.return_value = "/Game/Mesh"
        self.enterContext(patch.dict(sys.modules, unreal=self.unreal))
        self.enterContext(patch.dict(os.environ, U5_PREFIX=str(self.prefix), U5_ASSET_LABEL="case",
                                    U5_RELOAD="1", UEMCP_OWNED_QUIT_FILE=str(self.prefix.with_name("quit"))))
        self.tick = runpy.run_path(str(Path(__file__).with_name("fixture.py")))["tick"]

    def assert_error(self, message):
        self.tick(0)
        error = json.loads(self.prefix.with_name("test-setup-error.json").read_text())
        self.assertIn("Traceback", error)
        self.assertIn(message, error)
        self.unreal.AnimBlendProbe.members.assert_not_called()

    def test_invalid_json(self):
        self.request.write_text("{")
        self.assert_error("JSONDecodeError")

    def test_read_error(self):
        self.request.mkdir()
        self.assert_error(str(self.request.name))

    def test_unlink_error(self):
        self.request.write_text('{"op": "members", "label": "answer"}')
        with patch.object(Path, "unlink", side_effect=PermissionError("unlink denied")):
            self.assert_error("unlink denied")

    def test_success_consumes_before_dispatch(self):
        self.request.write_text('{"op": "members", "label": "answer"}')
        def members(_):
            self.assertFalse(self.request.exists())
            return '["Drive"]'
        self.unreal.AnimBlendProbe.members.side_effect = members
        self.tick(0)
        self.assertEqual(json.loads(self.prefix.with_name("test-answer.json").read_text()), ["Drive"])
        self.assertFalse(self.prefix.with_name("test-setup-error.json").exists())


if __name__ == "__main__":
    unittest.main()
