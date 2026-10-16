/*
 * HiDock Model Host: process-family sampler.
 *
 * One small native helper that stays running next to the service and answers a
 * one-letter request with one line of JSON: the CPU time and memory of the service
 * process and of every process it started, directly or not. It exists because Node
 * cannot ask Windows about another process, and because starting PowerShell or WMI
 * on every telemetry tick would cost more than the thing being measured.
 *
 * Protocol (stdin/stdout, one command per line):
 *   S   take a sample, answer with one JSON line
 *   Q   quit
 * It also quits when stdin closes, so it never outlives the service that started it.
 *
 * What it looks at, and nothing else:
 *   - the process list (id, parent id, image name) from a Toolhelp snapshot, which is
 *     the only way to discover children. Nothing else about an unrelated process is read.
 *   - the root process (--root-pid), and every process whose recorded parent is a
 *     process this helper already owns. A candidate is opened only to read its creation
 *     time. A process whose creation time is earlier than its supposed parent's is a
 *     parent id that Windows reused for someone else, and is dropped.
 *   - CPU times and memory counters of the processes it owns.
 * It holds an open handle to each owned process, so the handle names that one process
 * for as long as it is open (an id cannot be reused under it) and its final CPU time
 * can still be read after it exits. A process that starts and exits between two
 * samples is never seen and is not counted.
 *
 * Memory: private working set (PROCESS_MEMORY_COUNTERS_EX2) where this Windows
 * supports it, otherwise null. The working set counts shared pages once per process.
 * PrivateUsage is private COMMIT, which is not physical RAM, and is named that way.
 *
 * No privilege is requested, nothing is written, nothing is terminated, and the
 * helper never opens a process it does not own except to read a creation time.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_MEMBERS 256
#define NAME_BYTES 96
#define OUT_CAPACITY (1024 * 1024)
#define FILETIME_UNIX_EPOCH 116444736000000000ULL

typedef struct {
  DWORD pid;
  DWORD ppid;
  HANDLE process;
  uint64_t created; /* FILETIME ticks: 100 ns since 1601 */
  int alive;
  int is_root;
  int orphan;
  char name[NAME_BYTES];
} Member;

typedef struct {
  DWORD pid;
  DWORD ppid;
  char name[NAME_BYTES];
} Entry;

typedef struct {
  char *data;
  size_t len;
  size_t cap;
  int overflow;
} Out;

typedef struct {
  unsigned unverified;
  unsigned rejected;
  int truncated;
} Counters;

/* PROCESS_MEMORY_COUNTERS_EX2 is newer than the headers that ship with the compiler. */
typedef struct {
  DWORD cb;
  DWORD PageFaultCount;
  SIZE_T PeakWorkingSetSize;
  SIZE_T WorkingSetSize;
  SIZE_T QuotaPeakPagedPoolUsage;
  SIZE_T QuotaPagedPoolUsage;
  SIZE_T QuotaPeakNonPagedPoolUsage;
  SIZE_T QuotaNonPagedPoolUsage;
  SIZE_T PagefileUsage;
  SIZE_T PeakPagefileUsage;
  SIZE_T PrivateUsage;
  SIZE_T PrivateWorkingSetSize;
  ULONG64 SharedCommitUsage;
} HkMemoryCountersEx2;

static Member g_members[MAX_MEMBERS];
static size_t g_count = 0;
static DWORD g_helper_pid = 0;
static unsigned long g_sequence = 0;
/* 2 = EX2 (private working set), 1 = EX (private commit only), 0 = base counters only. */
static int g_memory_level = 2;

static uint64_t ft_u64(FILETIME f) { return ((uint64_t)f.dwHighDateTime << 32) | f.dwLowDateTime; }

static void out_printf(Out *o, const char *fmt, ...) {
  va_list ap;
  int n;
  if (o->overflow) return;
  va_start(ap, fmt);
  n = vsnprintf(o->data + o->len, o->cap - o->len, fmt, ap);
  va_end(ap);
  if (n < 0 || (size_t)n >= o->cap - o->len) {
    o->overflow = 1;
    return;
  }
  o->len += (size_t)n;
}

static void out_json_string(Out *o, const char *s) {
  out_printf(o, "\"");
  for (; *s; ++s) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') out_printf(o, "\\%c", c);
    else if (c < 0x20) out_printf(o, "\\u%04x", (unsigned)c);
    else out_printf(o, "%c", c);
  }
  out_printf(o, "\"");
}

static void write_all(const char *data, size_t len) {
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  size_t done = 0;
  while (done < len) {
    DWORD wrote = 0;
    DWORD chunk = (DWORD)((len - done) > 65536 ? 65536 : (len - done));
    if (!WriteFile(out, data + done, chunk, &wrote, NULL) || wrote == 0) return;
    done += wrote;
  }
}

static void write_error_line(const char *what, unsigned long code) {
  char line[160];
  int n = snprintf(line, sizeof line, "{\"v\":1,\"error\":\"%s\",\"code\":%lu}\n", what, code);
  if (n > 0) write_all(line, (size_t)n);
}

static void utf8_name(const WCHAR *wide, char *dest, size_t size) {
  int n = WideCharToMultiByte(CP_UTF8, 0, wide, -1, dest, (int)size, NULL, NULL);
  if (n <= 0) snprintf(dest, size, "(unnamed)");
}

/* Returns 0 on success or a Windows error code. The caller frees *out. */
static DWORD take_snapshot(Entry **out, size_t *count) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  PROCESSENTRY32W pe;
  Entry *list = NULL;
  size_t n = 0, cap = 0;
  *out = NULL;
  *count = 0;
  if (snap == INVALID_HANDLE_VALUE) return GetLastError();
  pe.dwSize = sizeof pe;
  if (Process32FirstW(snap, &pe)) {
    do {
      if (n == cap) {
        size_t next = cap ? cap * 2 : 256;
        Entry *grown = (Entry *)realloc(list, next * sizeof *list);
        if (!grown) {
          free(list);
          CloseHandle(snap);
          return ERROR_NOT_ENOUGH_MEMORY;
        }
        list = grown;
        cap = next;
      }
      list[n].pid = pe.th32ProcessID;
      list[n].ppid = pe.th32ParentProcessID;
      utf8_name(pe.szExeFile, list[n].name, sizeof list[n].name);
      ++n;
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  *out = list;
  *count = n;
  return 0;
}

static Member *alive_by_pid(DWORD pid) {
  size_t i;
  for (i = 0; i < g_count; ++i) {
    if (g_members[i].alive && g_members[i].pid == pid) return &g_members[i];
  }
  return NULL;
}

static const Entry *entry_by_pid(const Entry *ents, size_t n, DWORD pid) {
  size_t i;
  for (i = 0; i < n; ++i) {
    if (ents[i].pid == pid) return &ents[i];
  }
  return NULL;
}

static int is_running(HANDLE h) { return WaitForSingleObject(h, 0) == WAIT_TIMEOUT; }

/* Add every process whose recorded parent is a process we own and is plausibly its child. */
static void discover(const Entry *ents, size_t n, Counters *counters) {
  int changed;
  do {
    size_t i;
    changed = 0;
    for (i = 0; i < n; ++i) {
      const Entry *e = &ents[i];
      Member *parent;
      HANDLE h;
      FILETIME created, exited, kernel, user;
      uint64_t created_ticks;
      Member *m;
      if (e->pid == 0 || e->pid == g_helper_pid) continue;
      if (alive_by_pid(e->pid)) continue;
      parent = alive_by_pid(e->ppid);
      if (!parent) continue;
      if (g_count >= MAX_MEMBERS) {
        counters->truncated = 1;
        continue;
      }
      h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, e->pid);
      if (!h) {
        counters->unverified++;
        continue;
      }
      if (!GetProcessTimes(h, &created, &exited, &kernel, &user)) {
        CloseHandle(h);
        counters->unverified++;
        continue;
      }
      created_ticks = ft_u64(created);
      if (created_ticks < parent->created) {
        /* Created before the process it claims as its parent: the id was reused. */
        CloseHandle(h);
        counters->rejected++;
        continue;
      }
      if (!is_running(h)) {
        CloseHandle(h);
        continue;
      }
      m = &g_members[g_count++];
      memset(m, 0, sizeof *m);
      m->pid = e->pid;
      m->ppid = e->ppid;
      m->process = h;
      m->created = created_ticks;
      m->alive = 1;
      snprintf(m->name, sizeof m->name, "%s", e->name);
      changed = 1;
    }
  } while (changed);
}

static int read_memory(HANDLE h, HkMemoryCountersEx2 *counters, DWORD *error) {
  while (1) {
    DWORD size;
    memset(counters, 0, sizeof *counters);
    if (g_memory_level == 2) size = (DWORD)sizeof(HkMemoryCountersEx2);
    else if (g_memory_level == 1) size = (DWORD)sizeof(PROCESS_MEMORY_COUNTERS_EX);
    else size = (DWORD)sizeof(PROCESS_MEMORY_COUNTERS);
    counters->cb = size;
    if (GetProcessMemoryInfo(h, (PROCESS_MEMORY_COUNTERS *)counters, size)) return 1;
    *error = GetLastError();
    if (g_memory_level > 0 && (*error == ERROR_INSUFFICIENT_BUFFER || *error == ERROR_INVALID_PARAMETER)) {
      g_memory_level--; /* this Windows does not know the larger structure; remember and retry */
      continue;
    }
    return 0;
  }
}

static const char *member_link(const Member *m) {
  if (m->is_root) return "root";
  return m->orphan ? "orphan" : "descendant";
}

static void emit_member(Out *o, const Member *m, int exited) {
  FILETIME created, exit_time, kernel, user;
  int have_times = GetProcessTimes(m->process, &created, &exit_time, &kernel, &user);
  out_printf(o, "{\"pid\":%lu,\"ppid\":%lu,\"name\":", (unsigned long)m->pid, (unsigned long)m->ppid);
  out_json_string(o, m->name);
  out_printf(o, ",\"link\":\"%s\",\"creationFiletime\":\"%llu\",\"createdAtMs\":%llu", member_link(m),
             (unsigned long long)m->created,
             (unsigned long long)(m->created >= FILETIME_UNIX_EPOCH ? (m->created - FILETIME_UNIX_EPOCH) / 10000ULL : 0));
  if (have_times) {
    out_printf(o, ",\"cpuKernel100ns\":%llu,\"cpuUser100ns\":%llu", (unsigned long long)ft_u64(kernel),
               (unsigned long long)ft_u64(user));
  } else {
    out_printf(o, ",\"cpuKernel100ns\":null,\"cpuUser100ns\":null");
  }
  if (exited) {
    DWORD code = 0;
    out_printf(o, ",\"exited\":true");
    if (GetExitCodeProcess(m->process, &code)) out_printf(o, ",\"exitCode\":%lu", (unsigned long)code);
    else out_printf(o, ",\"exitCode\":null");
    out_printf(o, ",\"workingSetBytes\":null,\"peakWorkingSetBytes\":null,\"privateWorkingSetBytes\":null,"
                  "\"privateCommitBytes\":null,\"memoryError\":null}");
    return;
  }
  {
    HkMemoryCountersEx2 mem;
    DWORD error = 0;
    out_printf(o, ",\"exited\":false,\"exitCode\":null");
    if (read_memory(m->process, &mem, &error)) {
      out_printf(o, ",\"workingSetBytes\":%llu,\"peakWorkingSetBytes\":%llu", (unsigned long long)mem.WorkingSetSize,
                 (unsigned long long)mem.PeakWorkingSetSize);
      if (g_memory_level >= 2) {
        out_printf(o, ",\"privateWorkingSetBytes\":%llu", (unsigned long long)mem.PrivateWorkingSetSize);
      } else {
        out_printf(o, ",\"privateWorkingSetBytes\":null");
      }
      if (g_memory_level >= 1) out_printf(o, ",\"privateCommitBytes\":%llu", (unsigned long long)mem.PrivateUsage);
      else out_printf(o, ",\"privateCommitBytes\":null");
      out_printf(o, ",\"memoryError\":null}");
    } else {
      out_printf(o, ",\"workingSetBytes\":null,\"peakWorkingSetBytes\":null,\"privateWorkingSetBytes\":null,"
                    "\"privateCommitBytes\":null,\"memoryError\":%lu}",
                 (unsigned long)error);
    }
  }
}

static void sample(Out *o) {
  Entry *ents = NULL;
  size_t n = 0;
  size_t i;
  Counters counters;
  LARGE_INTEGER qpc, freq;
  FILETIME now;
  uint64_t now_ticks, monotonic_us;
  DWORD error;
  int first = 1;

  memset(&counters, 0, sizeof counters);
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&qpc);
  GetSystemTimePreciseAsFileTime(&now);
  now_ticks = ft_u64(now);
  monotonic_us = freq.QuadPart > 0
                     ? (uint64_t)(qpc.QuadPart / freq.QuadPart) * 1000000ULL +
                           (uint64_t)(qpc.QuadPart % freq.QuadPart) * 1000000ULL / (uint64_t)freq.QuadPart
                     : 0;

  error = take_snapshot(&ents, &n);
  if (error) {
    write_error_line("snapshot-failed", (unsigned long)error);
    return;
  }

  /* Who is still running. A member that stopped keeps its handle until it has been reported. */
  for (i = 0; i < g_count; ++i) {
    if (g_members[i].alive && !is_running(g_members[i].process)) g_members[i].alive = 0;
  }
  discover(ents, n, &counters);
  for (i = 0; i < g_count; ++i) {
    Member *m = &g_members[i];
    Member *parent;
    if (!m->alive || m->is_root) continue;
    parent = alive_by_pid(m->ppid);
    m->orphan = !(parent && parent->created <= m->created);
  }

  out_printf(o,
             "{\"v\":1,\"seq\":%lu,\"monotonicUs\":%llu,\"sampledAtMs\":%llu,\"sampledFiletime\":\"%llu\","
             "\"logicalProcessors\":%lu,\"processorGroups\":%lu,\"helperPid\":%lu,\"memoryApi\":\"%s\",",
             ++g_sequence, (unsigned long long)monotonic_us,
             (unsigned long long)(now_ticks >= FILETIME_UNIX_EPOCH ? (now_ticks - FILETIME_UNIX_EPOCH) / 10000ULL : 0),
             (unsigned long long)now_ticks, (unsigned long)GetActiveProcessorCount(ALL_PROCESSOR_GROUPS),
             (unsigned long)GetActiveProcessorGroupCount(), (unsigned long)g_helper_pid,
             g_memory_level >= 2 ? "ex2" : g_memory_level == 1 ? "ex" : "base");
  for (i = 0; i < g_count; ++i) {
    if (g_members[i].is_root) {
      out_printf(o, "\"root\":{\"pid\":%lu,\"createdAtMs\":%llu,\"creationFiletime\":\"%llu\",\"alive\":%s},",
                 (unsigned long)g_members[i].pid,
                 (unsigned long long)((g_members[i].created - FILETIME_UNIX_EPOCH) / 10000ULL),
                 (unsigned long long)g_members[i].created, g_members[i].alive ? "true" : "false");
      break;
    }
  }
  out_printf(o, "\"counters\":{\"unverifiedCandidates\":%u,\"rejectedByCreationTime\":%u,\"truncated\":%s},\"members\":[",
             counters.unverified, counters.rejected, counters.truncated ? "true" : "false");
  for (i = 0; i < g_count; ++i) {
    const Member *m = &g_members[i];
    if (!first) out_printf(o, ",");
    first = 0;
    emit_member(o, m, !m->alive);
  }
  out_printf(o, "]}\n");

  /* Everything reported as stopped is reported exactly once, then released. */
  {
    size_t kept = 0;
    for (i = 0; i < g_count; ++i) {
      if (g_members[i].alive) {
        if (kept != i) g_members[kept] = g_members[i];
        ++kept;
      } else {
        CloseHandle(g_members[i].process);
      }
    }
    g_count = kept;
  }
  free(ents);
}

static int read_command(HANDLE in, char *command) {
  char c;
  char first_char = 0;
  int have = 0;
  DWORD got;
  for (;;) {
    if (!ReadFile(in, &c, 1, &got, NULL) || got == 0) return 0;
    if (c == '\r') continue;
    if (c == '\n') {
      if (have) {
        *command = first_char;
        return 1;
      }
      continue;
    }
    if (!have) {
      have = 1;
      first_char = c;
    }
  }
}

int main(int argc, char **argv) {
  DWORD root_pid = 0;
  int i;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char command;
  Out out;
  Entry *ents = NULL;
  size_t n = 0;
  HANDLE root;
  FILETIME created, exited, kernel, user;
  Member *m;
  const Entry *root_entry;

  for (i = 1; i + 1 < argc; ++i) {
    if (strcmp(argv[i], "--root-pid") == 0) root_pid = (DWORD)strtoul(argv[i + 1], NULL, 10);
  }
  if (root_pid == 0) {
    write_error_line("usage: --root-pid <pid>", 2);
    return 2;
  }
  g_helper_pid = GetCurrentProcessId();

  root = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, root_pid);
  if (!root || !GetProcessTimes(root, &created, &exited, &kernel, &user)) {
    write_error_line("root-unavailable", (unsigned long)GetLastError());
    return 3;
  }
  m = &g_members[g_count++];
  memset(m, 0, sizeof *m);
  m->pid = root_pid;
  m->process = root;
  m->created = ft_u64(created);
  m->alive = 1;
  m->is_root = 1;
  snprintf(m->name, sizeof m->name, "(root)");
  if (take_snapshot(&ents, &n) == 0) {
    root_entry = entry_by_pid(ents, n, root_pid);
    if (root_entry) {
      snprintf(m->name, sizeof m->name, "%s", root_entry->name);
      m->ppid = root_entry->ppid;
    }
  }
  free(ents);

  out.cap = OUT_CAPACITY;
  out.data = (char *)malloc(out.cap);
  if (!out.data) {
    write_error_line("out-of-memory", ERROR_NOT_ENOUGH_MEMORY);
    return 4;
  }

  while (read_command(in, &command)) {
    if (command == 'Q') break;
    if (command != 'S') {
      write_error_line("unknown-command", (unsigned long)(unsigned char)command);
      continue;
    }
    out.len = 0;
    out.overflow = 0;
    sample(&out);
    if (out.overflow) {
      write_error_line("output-overflow", 0);
    } else if (out.len > 0) {
      write_all(out.data, out.len);
    }
  }
  free(out.data);
  for (i = 0; (size_t)i < g_count; ++i) CloseHandle(g_members[i].process);
  return 0;
}
