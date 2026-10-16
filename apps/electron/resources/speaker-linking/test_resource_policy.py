"""Bounded Windows integration test. No models or CPU stress are used."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
from ctypes import wintypes


def main():
    if sys.platform != 'win32':
        raise SystemExit('This integration test requires Windows')
    env = dict(os.environ, HIDOCK_DIARIZATION_THREADS='12', HIDOCK_WORKER_MEMORY_MB='128',
               HIDOCK_WORKER_PRIORITY='below-normal')
    source = '''
import ctypes, json, subprocess, sys, time
from ctypes import wintypes
from resource_policy import apply_resource_policy
report = apply_resource_policy()
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.GetCurrentProcess.restype = wintypes.HANDLE
kernel.GetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p]
kernel.GetPriorityClass.argtypes = [wintypes.HANDLE]
mask, system = ctypes.c_size_t(), ctypes.c_size_t()
assert kernel.GetProcessAffinityMask(kernel.GetCurrentProcess(), ctypes.byref(mask), ctypes.byref(system))
report['affinityCores'] = mask.value.bit_count()
report['priorityClass'] = kernel.GetPriorityClass(kernel.GetCurrentProcess())
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
report['child'] = child.pid
try:
    allocation = bytearray(200 * 1024 * 1024)
    report['memory'] = 'NOT_ENFORCED'
except MemoryError:
    report['memory'] = 'MEMORY_LIMIT_ENFORCED'
print(json.dumps(report), flush=True)
time.sleep(30)
'''
    process = subprocess.Popen([sys.executable, '-c', source], cwd=Path(__file__).parent,
                               env=env, stdout=subprocess.PIPE, text=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    child_handle = None
    try:
        report = json.loads(process.stdout.readline())
        child_handle = kernel.OpenProcess(0x100000, False, report['child'])
        assert child_handle, 'Could not observe descendant'
        process.kill()
        process.wait(timeout=5)
        report['descendantExited'] = kernel.WaitForSingleObject(child_handle, 5000) == 0
        assert report['priorityClass'] == 0x4000
        assert report['memory'] == 'MEMORY_LIMIT_ENFORCED'
        assert report['descendantExited']
        if report['processorGroups'] == 1:
            assert report['affinityCores'] == min(12, report['logicalProcessors'])
        print(json.dumps(report))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if child_handle:
            kernel.CloseHandle(child_handle)

    # The ONNX utility worker starts idle, then a separate guardian attaches
    # before the parent sends model input. Its exit must kill that worker.
    target = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    guardian = subprocess.Popen([sys.executable, str(Path(__file__).with_name('resource_policy.py')),
                                 str(target.pid), str(os.getpid())], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        report = json.loads(guardian.stdout.readline())
        assert report['threads'] == 12
        assert report['memoryMb'] == 128
        guardian.kill()
        guardian.wait(timeout=5)
        target.wait(timeout=5)
        print(json.dumps({'externalWorkerGuard': 'enforced', 'workerExited': True}))
    finally:
        for owned in (guardian, target):
            if owned.poll() is None:
                owned.kill()
                owned.wait(timeout=5)


if __name__ == '__main__':
    main()
