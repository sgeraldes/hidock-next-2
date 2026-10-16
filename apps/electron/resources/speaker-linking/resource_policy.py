"""Bound model workers before importing native runtimes (SPEC-013).

Windows Job Objects enforce a CPU ceiling across descendants and kill remaining
children when the worker exits. CPU Sets avoid a 64-bit affinity-mask assumption.
Only the calling worker is assigned; the Electron parent is never modified.
"""
from __future__ import annotations

import ctypes
import json
import os
import struct
import sys
from ctypes import wintypes

_job_handle = None


def apply_resource_policy(target_pid: int | None = None) -> dict:
    """Fail closed if the operating system cannot enforce the worker budget."""
    threads = max(1, int(os.environ.get("HIDOCK_DIARIZATION_THREADS", "1")))
    priority = os.environ.get("HIDOCK_WORKER_PRIORITY", "below-normal")
    if priority not in ("low", "below-normal", "normal"):
        priority = "below-normal"
    priority_class = {"low": 0x40, "below-normal": 0x4000, "normal": 0x20}[priority]
    if sys.platform != "win32":
        if target_pid is not None:
            raise OSError("External worker resource policy requires Windows")
        if hasattr(os, "sched_getaffinity"):
            allowed = sorted(os.sched_getaffinity(0))
            os.sched_setaffinity(0, allowed[:threads])
        os.nice({"low": 10, "below-normal": 5, "normal": 0}[priority])
        return {"threads": threads, "priority": priority, "platform": sys.platform}

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = handle
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = handle
    kernel.SetInformationJobObject.argtypes = [handle, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [handle, handle]
    kernel.SetPriorityClass.argtypes = [handle, wintypes.DWORD]
    kernel.GetSystemCpuSetInformation.argtypes = [ctypes.c_void_p, wintypes.ULONG,
                                                 ctypes.POINTER(wintypes.ULONG), handle, wintypes.ULONG]
    kernel.SetProcessDefaultCpuSets.argtypes = [handle, ctypes.POINTER(wintypes.ULONG), wintypes.ULONG]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = handle
    process = (kernel.OpenProcess(0x100000 | 0x1000 | 0x200 | 0x100 | 1, False, target_pid)
               if target_pid is not None else kernel.GetCurrentProcess())
    if not process:
        raise OSError(ctypes.get_last_error(), "Cannot open supervised worker")

    def require(ok, operation: str) -> None:
        if not ok:
            raise OSError(ctypes.get_last_error(), f"Resource policy could not enforce {operation}")

    length = wintypes.ULONG()
    kernel.GetSystemCpuSetInformation(None, 0, ctypes.byref(length), process, 0)
    if not length.value:
        raise OSError("Resource policy could not enumerate CPU Sets")
    buffer = ctypes.create_string_buffer(length.value)
    require(kernel.GetSystemCpuSetInformation(buffer, length, ctypes.byref(length), process, 0), "CPU Sets")
    cpus = []
    offset = 0
    while offset < length.value:
        size, kind = struct.unpack_from("II", buffer, offset)
        if size < 20 or offset + size > length.value:
            raise OSError("Invalid CPU Set information")
        if kind == 0:
            identity, group, logical = struct.unpack_from("IHB", buffer, offset + 8)
            flags = buffer.raw[offset + 19]
            # Do not request CPUs exclusively allocated to another process.
            if not flags & 2 or flags & 4:
                cpus.append((identity, group, logical))
        offset += size
    if not cpus:
        raise OSError("No eligible CPU Sets")
    selected = cpus[:min(threads, len(cpus))]
    identifiers = (wintypes.ULONG * len(selected))(*(row[0] for row in selected))
    require(kernel.SetProcessDefaultCpuSets(process, identifiers, len(selected)), "CPU assignment")
    require(kernel.SetPriorityClass(process, priority_class), "process priority")

    class BasicLimits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                    ("flags", wintypes.DWORD), ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t),
                    ("active", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                    ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("io", ctypes.c_ulonglong * 6),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

    class CpuRate(ctypes.Structure):
        _fields_ = [("flags", wintypes.DWORD), ("rate", wintypes.DWORD)]

    global _job_handle
    _job_handle = kernel.CreateJobObjectW(None, None)
    require(_job_handle, "worker Job Object")
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000 | 0x20  # KILL_ON_JOB_CLOSE | PRIORITY_CLASS
    limits.basic.priority = priority_class
    if len({row[1] for row in cpus}) == 1:
        limits.basic.flags |= 0x10  # AFFINITY: applies to all descendants in this group.
        limits.basic.affinity = sum(1 << row[2] for row in selected)
    memory_mb = int(os.environ.get("HIDOCK_WORKER_MEMORY_MB", "0"))
    if memory_mb > 0:
        limits.basic.flags |= 0x200  # JOB_MEMORY
        limits.job_memory = memory_mb * 1024 * 1024
    require(kernel.SetInformationJobObject(_job_handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)), "job limits")
    rate = CpuRate(1 | 4, max(1, len(selected) * 10000 // len(cpus)))
    require(kernel.SetInformationJobObject(_job_handle, 15, ctypes.byref(rate), ctypes.sizeof(rate)), "CPU hard cap")
    require(kernel.AssignProcessToJobObject(_job_handle, process), "worker process tree")
    return {"threads": len(selected), "logicalProcessors": len(cpus), "cpuPercent": rate.rate / 100,
            "priority": priority, "memoryMb": memory_mb or None,
            "processorGroups": len({row[1] for row in cpus})}


if __name__ == "__main__":
    if len(sys.argv) == 3:
        target_pid, parent_pid = map(int, sys.argv[1:])
        print(json.dumps(apply_resource_policy(target_pid)), flush=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        handles = (wintypes.HANDLE * 2)(*(kernel.OpenProcess(0x100000, False, pid)
                                        for pid in (target_pid, parent_pid)))
        if not all(handles):
            raise SystemExit("Cannot monitor worker ownership")
        kernel.WaitForMultipleObjects.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE),
                                                  wintypes.BOOL, wintypes.DWORD]
        kernel.WaitForMultipleObjects(2, handles, False, 0xFFFFFFFF)
    else:
        print(json.dumps(apply_resource_policy()), flush=True)
