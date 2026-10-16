"""Test-only idle worker; entered through the production supervised_runner."""
import ctypes
from ctypes import wintypes
import json
import subprocess
import sys
import time
import resource_policy

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
class CpuRate(ctypes.Structure):
    _fields_ = [("flags", wintypes.DWORD), ("rate", wintypes.DWORD)]
rate = CpuRate()
if not kernel.QueryInformationJobObject(resource_policy._job_handle, 15, ctypes.byref(rate), ctypes.sizeof(rate), None):
    raise OSError(ctypes.get_last_error(), "Cannot observe installed CPU Job limit")
child = subprocess.Popen([sys.executable, "-S", "-c", "import time; time.sleep(30)"], creationflags=subprocess.CREATE_NO_WINDOW)
print(json.dumps({"descendantPid": child.pid, "observedJobRatePercent": rate.rate / 100,
                  "observedJobFlags": rate.flags}), flush=True)
time.sleep(30)
