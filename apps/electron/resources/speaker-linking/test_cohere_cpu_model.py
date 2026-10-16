"""CPU adapter isolation/loader contract; no native runtime or weights imported."""
import sys
import types
import unittest
from unittest.mock import Mock, patch, MagicMock

from cohere_cpu_model import create_cpu_model, load_cpu_checkpoint, MODEL_REVISION


class CpuLoaderTests(unittest.TestCase):
    def test_bf16_offline_load_preserves_shared_base_class(self):
        class Base:
            def load(self):
                raise AssertionError("shared loader must not run")
        original = Base.load
        bf16 = object()
        model = types.SimpleNamespace(device=types.SimpleNamespace(type="cpu"), dtype=bf16)
        loader = Mock(return_value=model)
        torch = types.SimpleNamespace(bfloat16=bf16)
        modules = {
            "torch": torch,
            "huggingface_hub": types.SimpleNamespace(snapshot_download=Mock(return_value="cached")),
            "asr_mcp.model": types.SimpleNamespace(TranscriptionModel=Base),
            "transformers": types.SimpleNamespace(
                AutoProcessor=types.SimpleNamespace(from_pretrained=Mock()),
                CohereAsrForConditionalGeneration=types.SimpleNamespace(from_pretrained=loader)),
        }
        with patch.dict(sys.modules, modules), patch("cohere_cpu_model.load_cpu_checkpoint", return_value=model):
            adapter = create_cpu_model()
            adapter.load()
            self.assertEqual(adapter._device, "cpu")
            self.assertIs(Base.load, original)
            model.device.type = "cuda"
            with self.assertRaisesRegex(RuntimeError, "no fallback"):
                adapter.load()


    def test_pread_and_strict_loading_errors(self):
        bf16 = object()
        tensor = Mock(dtype=bf16)
        tensor.is_floating_point.return_value = True
        reader = MagicMock()
        reader.__enter__.return_value = reader
        reader.keys.return_value = ["weight"]
        reader.get_tensor.return_value = tensor
        safe_open = Mock(return_value=reader)
        model = Mock()
        loader = Mock(return_value=(model, {}))
        cls = types.SimpleNamespace(config_class=types.SimpleNamespace(from_pretrained=Mock()), from_pretrained=loader)
        with patch.dict(sys.modules, {"safetensors": types.SimpleNamespace(safe_open=safe_open)}):
            load_cpu_checkpoint(cls, "cache", types.SimpleNamespace(bfloat16=bf16))
            self.assertEqual(safe_open.call_args.kwargs["backend"], "pread")
            self.assertIsNone(loader.call_args.args[0])
            self.assertFalse(loader.call_args.kwargs["ignore_mismatched_sizes"])
            for category in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs"):
                loader.return_value = (model, {category: ["invalid"]})
                with self.assertRaisesRegex(ValueError, category):
                    load_cpu_checkpoint(cls, "cache", types.SimpleNamespace(bfloat16=bf16))


if __name__ == "__main__":
    unittest.main()
