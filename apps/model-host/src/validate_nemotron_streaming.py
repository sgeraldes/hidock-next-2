"""Put the diagnostic and its native server in one bounded Windows Job before launch."""
import argparse
import importlib.util
import json
import os
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--resource-policy', required=True)
parser.add_argument('--node', required=True)
parser.add_argument('--harness', required=True)
opts, harness_args = parser.parse_known_args()
if sys.platform != 'win32':
    raise SystemExit('This proof requires native Windows Job enforcement')
threads = max(1, (os.cpu_count() or 1) // 2)
os.environ.update(HIDOCK_DIARIZATION_THREADS=str(threads), HIDOCK_WORKER_MEMORY_MB='8192',
                  HIDOCK_WORKER_PRIORITY='below-normal', OMP_NUM_THREADS=str(threads))
spec = importlib.util.spec_from_file_location('bounded_policy', opts.resource_policy)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
print(json.dumps({'resourcePolicy': policy.apply_resource_policy()}), flush=True)
# Import/enforcement above must succeed; no unbounded fallback is allowed.
try:
    child = subprocess.Popen([opts.node, opts.harness, *harness_args], creationflags=subprocess.CREATE_NO_WINDOW)
    raise SystemExit(child.wait(timeout=68))
except subprocess.TimeoutExpired:
    child.kill()
    print(json.dumps({'error': '68-second supervisor deadline; Job close terminates descendants'}), flush=True)
    raise SystemExit(124)
