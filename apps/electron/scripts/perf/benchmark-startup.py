"""Bounded real Electron startup on a SQLite backup; never opens a USB device."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import psutil

APP = Path(__file__).resolve().parents[2]
ROOT = APP.parents[1]
OUTPUT = ROOT / 'artifacts' / ('startup-' + time.strftime('%Y%m%d-%H%M%S'))
OUTPUT.mkdir(parents=True)
print(str(OUTPUT), flush=True)
process = psutil.Process()
original_affinity = process.cpu_affinity()
process.cpu_affinity(original_affinity[:6])
process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
if psutil.virtual_memory().available < 8 * 1024**3:
    raise SystemExit('Less than 8 GiB free RAM; benchmark not started')
# One HiDock per user: the app refuses a second instance, whatever its profile.
# A running HiDock would also load the machine and spoil the numbers. Only
# HiDock counts: the packaged exe, or an electron.exe started from a HiDock
# checkout. The headless --brain-only helper takes no lock and is ignored.
def is_running_hidock(proc):
    name = (proc.info['name'] or '').lower()
    args = proc.info['cmdline'] or []
    if any(a.startswith('--type=') for a in args) or '--brain-only' in args:
        return False
    if name in ('hidock next.exe', 'hidock-next.exe'):
        return True
    if name != 'electron.exe':
        return False
    try:
        where = (proc.exe() + ' ' + proc.cwd()).lower()
    except psutil.Error:
        return False
    # Any HiDock checkout, this one included, whatever the folder is called.
    return 'hidock' in where or str(ROOT).lower() in where


for other in psutil.process_iter(['name', 'cmdline']):
    try:
        if is_running_hidock(other):
            raise SystemExit(f'HiDock is running (pid {other.pid}); close it before benchmarking')
    except psutil.Error:
        pass

# Build sequentially and inherit the bounded CPU affinity; no dev watcher.
with (OUTPUT / 'build.log').open('w') as log:
    result = subprocess.run(['npm.cmd', 'run', 'build'], cwd=APP, stdout=log, stderr=log)
if result.returncode:
    raise SystemExit('Build failed; see build.log')
print('Build passed; preparing isolated SQLite snapshot', flush=True)
profile = OUTPUT / 'profile'
profile.mkdir()
data = OUTPUT / 'library'
(data / 'data').mkdir(parents=True)
source_profile = Path(os.environ['APPDATA']) / 'hidock-universal-knowledge-hub'
config = json.loads((source_profile / 'config.json').read_text(encoding='utf-8-sig'))
source_data = Path(config['storage']['dataPath']) / 'data'
# Routing checks actual installed model files before selecting a partition.
# Share model assets only; all writable library state remains in the snapshot.
model_assets = source_data.parent / 'models'
if model_assets.exists():
    import _winapi
    _winapi.CreateJunction(str(model_assets), str(data / 'models'))
source = sqlite3.connect((source_data / 'hidock.db').as_uri() + '?mode=ro', uri=True)
target = sqlite3.connect(data / 'data' / 'hidock.db')
source.backup(target, pages=1024, progress=lambda *_: time.sleep(0.005))
target.close()
source.close()
# Hold only the snapshot's queue. Keep transcription enabled so its dependent
# assistant/index and graph services still run during the benchmark.
with sqlite3.connect(data / 'data' / 'hidock.db') as snapshot:
    snapshot.execute("UPDATE transcription_queue SET status='cancelled' WHERE status IN ('pending','processing','failed')")
cache = source_data / 'vector-cache-v1.bin'
if cache.exists() and '--cold' not in sys.argv:
    with cache.open('rb') as src, (data / 'data' / cache.name).open('wb') as dst:
        while block := src.read(4 * 1024**2):
            dst.write(block)
            time.sleep(0.005)
config['storage'].update(dataPath=str(data), recordingsPath=str(data / 'recordings'), transcriptsPath=str(data / 'transcripts'))
config['device'] = {'autoConnect': False, 'autoDownload': False}
config['transcription']['autoTranscribe'] = False
config['autoTranscribeRestored2026_07'] = True
config['calendar'].update(syncEnabled=False, icsUrl='')
config.setdefault('features', {'preset': 'full', 'flags': {}}).setdefault('flags', {}).update({
    'device-sync': False, 'transcription': True, 'connector:m365': False,
    'connector:slack': False, 'connector:github': False, 'connector:ics': False,
})
# No credentials are needed to restore existing embeddings.
config['transcription']['geminiApiKey'] = ''
(profile / 'config.json').write_text(json.dumps(config), encoding='utf-8')
env = dict(os.environ, HIDOCK_DEV_USERDATA=str(profile), HIDOCK_BENCH_OUTPUT=str(OUTPUT),
           HIDOCK_DEV_CDP_PORT='9337', OMP_NUM_THREADS='6', MKL_NUM_THREADS='6')
env.pop('ELECTRON_RUN_AS_NODE', None)
env.pop('ELECTRON_RENDERER_URL', None)
if '--inference' in sys.argv:
    env['HIDOCK_BENCH_INFERENCE'] = '1'
print('Starting controlled app; 6 logical CPUs, 8 GiB process-tree ceiling, 150 seconds maximum', flush=True)
started = time.monotonic()
reason = 'normal-exit'
with (OUTPUT / 'app.log').open('w', encoding='utf-8') as log, (OUTPUT / 'resources.jsonl').open('w') as samples:
    child = subprocess.Popen([str(APP / 'node_modules/electron/dist/electron.exe'), str(Path(__file__).with_name('startup-probe.cjs'))],
                             cwd=APP, env=env, stdout=log, stderr=log)
    root = psutil.Process(child.pid)
    previous = {}
    kinds = {}
    while child.poll() is None:
        try:
            members = [root] + root.children(recursive=True)
        except psutil.NoSuchProcess:
            break
        rows = []
        for member in members:
            try:
                cpu = sum(member.cpu_times()[:2])
                # Keyed by pid and start time: a reused pid is a different process.
                key = (member.pid, member.create_time())
                if key not in kinds:
                    # Chromium names each child with --type=; the one without it is main.
                    try:
                        args = member.cmdline()
                        kind = next((a.split('=', 1)[1] for a in args if a.startswith('--type=')), 'main')
                        if kind == 'utility':
                            sub = next((a.split('=', 1)[1] for a in args if a.startswith('--utility-sub-type=')), '')
                            kind = 'utility ' + sub.rsplit('.', 1)[-1] if sub else kind
                    except psutil.Error:
                        # Unknown type, but keep sampling the process.
                        kind = 'unknown'
                    kinds[key] = kind
                rows.append({'pid': member.pid, 'rss': member.memory_info().rss,
                             'cpuSeconds': cpu, 'name': member.name(), 'type': kinds[key]})
            except psutil.Error:
                pass
        free = psutil.virtual_memory().available
        elapsed = time.monotonic() - started
        samples.write(json.dumps({'seconds': elapsed, 'freeBytes': free, 'processes': rows}) + '\n')
        samples.flush()
        if free < 5 * 1024**3 or sum(r['rss'] for r in rows) > 8 * 1024**3 or elapsed > 150:
            reason = 'watchdog-memory' if elapsed <= 150 else 'watchdog-timeout'
            # Only this isolated benchmark's processes, never other apps.
            for member in reversed(members):
                try:
                    member.kill()
                except psutil.Error:
                    pass
            break
        time.sleep(0.5)
    child.wait(timeout=10)
    if reason == 'normal-exit' and child.returncode != 0:
        reason = 'terminated-or-failed'
(OUTPUT / 'run.json').write_text(json.dumps({'reason': reason, 'exitCode': child.returncode,
    'elapsedSeconds': time.monotonic() - started, 'logicalCpuLimit': 6, 'cacheMode': 'cold' if '--cold' in sys.argv else 'warm',
    'excluded': ['USB', 'transcription', 'connector sync', 'calendar network sync', 'original audio and wiki folders']}, indent=2))
print(f'Benchmark finished: {reason}; {OUTPUT}', flush=True)
