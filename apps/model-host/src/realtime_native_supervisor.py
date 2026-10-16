"""Own the native live process inside a fail-closed Windows resource Job."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    parser.add_argument('--exe', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--port', required=True, type=int)
    args = parser.parse_args()
    if sys.platform != 'win32' or not 1024 <= args.port <= 65535:
        raise ValueError('Native Windows and a loopback port are required')
    if not Path(args.exe).is_file() or not Path(args.model).is_file():
        raise ValueError('Prepared executable and model are required')
    spec = importlib.util.spec_from_file_location('resource_policy', args.policy)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    policy = module.apply_resource_policy()
    print(json.dumps({'resourcePolicy': policy}), flush=True)
    child = subprocess.Popen([args.exe, 'serve', '--asr-model', args.model, '--host', '127.0.0.1',
                              '--port', str(args.port), '--device', 'cuda', '--threads',
                              str(policy['threads']), '--no-ui', '--max-upload-mb', '1'],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    print(json.dumps({'nativePid': child.pid}), flush=True)
    stopped = threading.Event()
    stderr_tail = bytearray()
    def drain_stderr() -> None:
        while True:
            chunk = child.stderr.read(1024)
            if not chunk:
                break
            stderr_tail.extend(chunk)
            del stderr_tail[:-4000]
    reader = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()
    # Node closes the pipe on disconnect, cancellation or shutdown. Native descendants
    # also die when this supervisor exits and its kill-on-close Job handle closes.
    def wait_for_close() -> None:
        sys.stdin.buffer.read(1)
        stopped.set()
        if child.poll() is None:
            child.kill()
    threading.Thread(target=wait_for_close, daemon=True).start()
    try:
        code = child.wait(timeout=3660)
        reader.join(timeout=1)
        print(json.dumps({'nativeExitCode': code, 'nativeTerminatedOnStop': stopped.is_set(),
                          'nativeStderrTail': stderr_tail.decode('utf-8', errors='replace')}, ensure_ascii=True), flush=True)
        raise SystemExit(0 if stopped.is_set() else code)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)
        print(json.dumps({'nativeExitCode': child.returncode, 'forcedTermination': True}), flush=True)
        raise SystemExit(124)


if __name__ == '__main__':
    main()
