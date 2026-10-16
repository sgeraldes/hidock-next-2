"""Bounded real-worker benchmark: no app DB writes, USB, downloads or cloud calls."""
import argparse, json, os, subprocess, time
from pathlib import Path
import psutil

parser = argparse.ArgumentParser()
parser.add_argument('--python', required=True)
parser.add_argument('--audio', required=True)
parser.add_argument('--seconds', type=int, default=120)
parser.add_argument('--asr', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
prefix = 'spec013-asr-benchmark' if args.asr else 'spec013-audio-benchmark'
report = root / 'out' / (prefix + '.jsonl')
worker = root / 'resources' / 'speaker-linking' / 'worker.py'
if psutil.virtual_memory().available < 16 * 1024**3:
    raise SystemExit('Benchmark refused: less than 16 GB available')
threads = max(1, psutil.cpu_count() // 2)
env = dict(os.environ, CUDA_VISIBLE_DEVICES='-1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
    HF_TOKEN='offline-benchmark', HIDOCK_WORKER_MEMORY_MB='8192', HIDOCK_WORKER_PRIORITY='below-normal')
for name in ('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMEXPR_NUM_THREADS','TORCH_NUM_THREADS','HIDOCK_DIARIZATION_THREADS'):
    env[name] = str(threads)
env['FFMPEG_PATH'] = str(root / 'node_modules' / 'ffmpeg-static' / 'ffmpeg.exe')
with report.open('w', encoding='utf-8') as log, (root/'out'/(prefix+'.stderr')).open('w') as err, (root/'out'/(prefix+'.result.json')).open('w', encoding='utf-8') as output:
    def emit(data):
        log.write(json.dumps(dict(at=time.time(), **data))+'\n'); log.flush()
    began = time.monotonic()
    command = [args.python, str(worker), '--audio', args.audio, '--model', 'pyannote/speaker-diarization-3.1', '--fallback-model', 'pyannote/speaker-diarization-3.1']
    if args.asr:
        command = [args.python, str(root.parent/'model-host/src/asr_worker.py'), '--audio', args.audio, '--model', 'CohereLabs/cohere-transcribe-03-2026', '--language', 'es', '--worker-dir', str(worker.parent)]
    child = subprocess.Popen(command,
        env=env, stdout=output, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
    proc = psutil.Process(child.pid)
    known = {child.pid: proc}
    emit({'started': child.pid, 'threads': threads, 'cpuBudget': 50, 'memoryLimitMiB': 8192})
    reason = None
    try:
        while child.poll() is None:
            try:
                for member in [proc, *proc.children(recursive=True)]:
                    known.setdefault(member.pid, member)
                alive = [member for member in known.values() if member.is_running()]
                rss = sum(member.memory_info().rss for member in alive)
                cpu = sum(member.cpu_percent() for member in alive) / psutil.cpu_count()
                available = psutil.virtual_memory().available
                emit({'elapsed': time.monotonic()-began, 'rssMiB': rss/1024**2, 'cpuPercent': cpu,
                    'availableGiB': available/1024**3, 'processCount': len(alive)})
                if available < 12 * 1024**3: reason='memory headroom guard'; break
                if time.monotonic()-began >= args.seconds: reason='bounded benchmark timeout'; break
            except psutil.NoSuchProcess:
                pass
            time.sleep(1)
    finally:
        if child.poll() is None:
            # Only this owned worker. Its Job Object closes with it and kills descendants.
            child.kill()
        code = child.wait(timeout=10)
        time.sleep(.5)
        survivors = [pid for pid,p in known.items() if p.is_running()]
        emit({'finished': True, 'code': code, 'reason': reason, 'elapsed': time.monotonic()-began, 'survivors': survivors})
