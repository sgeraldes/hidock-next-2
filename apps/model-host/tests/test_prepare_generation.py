import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('prepare', Path(__file__).parents[1] / 'src' / 'prepare_generation.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class Response(io.BytesIO):
    def __init__(self, body, status=206, header='bytes 3-5/6'):
        super().__init__(body)
        self.status = status
        self.headers = {'Content-Range': header, 'Content-Length': str(len(body))}
class DownloadTests(unittest.TestCase):
    def test_resume_and_wrong_range(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'model.gguf'; partial=p.with_suffix('.partial');partial.write_bytes(b'abc')
            with patch.object(m.urllib.request,'urlopen',return_value=Response(b'def')) as fetch:
                m.download_verified('https://example.test/fixed',p,hashlib.sha256(b'abcdef').hexdigest(),6)
                self.assertEqual(fetch.call_args.args[0].get_header('Range'),'bytes=3-')
                self.assertEqual(p.read_bytes(),b'abcdef')
            p.unlink();partial.write_bytes(b'abc')
            with patch.object(m.urllib.request,'urlopen',return_value=Response(b'def',header='bytes 2-4/6')):
                with self.assertRaises(ValueError):m.download_verified('https://example.test/fixed',p,'x',6)
                self.assertEqual(partial.read_bytes(),b'abc')
    def test_bad_hash_removes_only_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'model.gguf';p.write_bytes(b'old')
            with patch.object(m.urllib.request,'urlopen',return_value=Response(b'abcdef',status=200)):
                with self.assertRaises(ValueError):m.download_verified('https://example.test/fixed',p,'bad',6)
            self.assertEqual(p.read_bytes(),b'old');self.assertFalse(p.with_suffix('.partial').exists())
    def test_network_failure_preserves_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'model.gguf';p.with_suffix('.partial').write_bytes(b'abc')
            with patch.object(m.urllib.request,'urlopen',side_effect=OSError('disconnected')):
                with self.assertRaises(OSError):m.download_verified('https://example.test/fixed',p,'x',6)
            self.assertEqual(p.with_suffix('.partial').read_bytes(),b'abc')
if __name__=='__main__':unittest.main()
