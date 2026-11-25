"""Run an existing Python CLI inside the same resource boundary as diarization."""
import json
import os
import runpy
import sys
from resource_policy import apply_resource_policy

if __name__ == "__main__":
    policy = apply_resource_policy()
    print(f"[ResourcePolicy] {json.dumps(policy)}", file=sys.stderr, flush=True)
    sys.argv = sys.argv[1:]
    if not sys.argv:
        raise SystemExit("A runner path is required")
    # The existing shim selects its own virtual environment. Keep this outer
    # supervisor stdlib-only; model runtime CUDA fallback happens in that env.
    # The shim executes this entrypoint inside its own venv. It applies runtime
    # controls there, while the outer Job Object already covers all children.
    if len(sys.argv) > 1 and not sys.argv[1].endswith('.py'):
        sys.argv.insert(1, os.path.join(os.path.dirname(__file__), 'runtime_entry.py'))
    sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[0])))
    runpy.run_path(sys.argv[0], run_name="__main__")
