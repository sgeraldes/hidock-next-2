/*
 * HiDock Model Host: the tray icon.
 *
 * The only thing that stays running on the gamestation. It starts the service
 * (node.exe src\main.mjs --ready) inside a Job Object and ends that job to
 * pause: Node, the Python worker and ffmpeg die together and nothing of the
 * service remains in memory.
 *
 * Nothing here polls. The thread sleeps in GetMessage and Windows wakes it for:
 *   - a menu click;
 *   - a foreground window change (SetWinEventHook): is it a game, does it cover
 *     the screen;
 *   - a game process exiting (RegisterWaitForSingleObject);
 *   - in the "any use" position only, a 60 s timer that reads GetLastInputInfo;
 *   - the end of a 5-minute quiet period.
 * The decisions themselves are in decide.c, which has its own tests.
 *
 * Build: see scripts/build-tray.mjs (zig cc, x86_64-windows-gnu).
 */
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <winhttp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "decide.h"

#define WM_APP_TRAY (WM_APP + 1)
#define WM_APP_GAME_EXIT (WM_APP + 2)
#define WM_APP_SERVICE_EXIT (WM_APP + 3)

#define TIMER_INPUT 1
#define TIMER_QUIET 2
#define TIMER_FS_RECHECK 3
#define TIMER_RESTART 4
#define TIMER_EXIT 5

#define CMD_START 100
#define CMD_PAUSE 101
#define CMD_QUIT 102
#define CMD_PAIR_CODE 110
#define CMD_PAIR_CANCEL 111
#define CMD_PAIR_RESUME 112
#define CMD_PAIR_RESET 113

#define MAX_GAMES 16
#define CLASS_NAME L"HiDockModelHostTray"

typedef struct {
  HANDLE process;
  HANDLE wait;
  DWORD pid;
} game_t;

static HWND g_wnd;
static HWINEVENTHOOK g_hook;
static NOTIFYICONDATAW g_nid;
static UINT g_taskbar_created;
static int g_no_icon;
static wchar_t g_dir[MAX_PATH];  /* where the program is installed */
static wchar_t g_root[MAX_PATH]; /* %LOCALAPPDATA%\HiDock Model Host */
static int g_port = 8765;
static presence_t g_p;
static game_t g_games[MAX_GAMES];
static HANDLE g_job, g_service, g_service_wait;
static int g_stopping;
static UINT g_restart_ms = 30 * 1000; /* a service that died starts again after this; tests shorten it */
static why_t g_last_why = (why_t)-1;
static HICON g_icons[3];

static uint64_t now_ms(void) { return GetTickCount64(); }

/* ---------- config.json, read at each decision (events only) ---------- */

static void read_config(void) {
  wchar_t path[MAX_PATH];
  swprintf(path, MAX_PATH, L"%ls\\config.json", g_root);
  HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                         OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) {
    g_p.mode = STEP_ASIDE_GAMES;
    return;
  }
  char buf[16384];
  DWORD got = 0;
  ReadFile(f, buf, sizeof buf - 1, &got, NULL);
  CloseHandle(f);
  buf[got] = 0;
  g_p.mode = parse_step_aside(buf);
  g_port = parse_port(buf);
}

/* ---------- the icon ---------- */

/* A 16x16 dot: green working, amber stepping aside, grey paused by you. */
static HICON make_dot(COLORREF color) {
  BITMAPV5HEADER bi;
  ZeroMemory(&bi, sizeof bi);
  bi.bV5Size = sizeof bi;
  bi.bV5Width = 16;
  bi.bV5Height = -16;
  bi.bV5Planes = 1;
  bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5RedMask = 0x00FF0000;
  bi.bV5GreenMask = 0x0000FF00;
  bi.bV5BlueMask = 0x000000FF;
  bi.bV5AlphaMask = 0xFF000000;
  void *bits = NULL;
  HDC dc = GetDC(NULL);
  HBITMAP color_bmp = CreateDIBSection(dc, (BITMAPINFO *)&bi, DIB_RGB_COLORS, &bits, NULL, 0);
  ReleaseDC(NULL, dc);
  if (!color_bmp) return LoadIconW(NULL, (LPCWSTR)IDI_APPLICATION);
  DWORD *px = (DWORD *)bits;
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      double dx = x - 7.5, dy = y - 7.5;
      double d = dx * dx + dy * dy;
      DWORD a = d <= 36.0 ? 255 : d <= 49.0 ? 128 : 0;
      DWORD r = GetRValue(color) * a / 255, g = GetGValue(color) * a / 255, b = GetBValue(color) * a / 255;
      px[y * 16 + x] = (a << 24) | (r << 16) | (g << 8) | b;
    }
  }
  HBITMAP mask = CreateBitmap(16, 16, 1, 1, NULL);
  ICONINFO ii = {TRUE, 0, 0, mask, color_bmp};
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(color_bmp);
  DeleteObject(mask);
  return icon;
}

static const wchar_t *why_text(why_t why) {
  switch (why) {
    case WHY_RUNNING: return L"HiDock Model Host: working";
    case WHY_PAUSED_BY_YOU: return L"HiDock Model Host: paused by you";
    case WHY_GAME: return L"HiDock Model Host: paused while a game runs";
    case WHY_AFTER_GAME: return L"HiDock Model Host: paused until 5 minutes after the game";
    case WHY_IN_USE: return L"HiDock Model Host: paused while this PC is in use";
  }
  return L"HiDock Model Host";
}

static void show_icon(why_t why, int add) {
  if (g_no_icon) return;
  /* It should be working but the service is not up (it died, or could not start): say so. */
  int down = why == WHY_RUNNING && !g_job;
  int which = why == WHY_RUNNING && !down ? 0 : why == WHY_PAUSED_BY_YOU ? 2 : 1;
  g_nid.cbSize = sizeof g_nid;
  g_nid.hWnd = g_wnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
  g_nid.uCallbackMessage = WM_APP_TRAY;
  g_nid.hIcon = g_icons[which];
  wcsncpy(g_nid.szTip, down ? L"HiDock Model Host: the service stopped; starting it again" : why_text(why), 127);
  Shell_NotifyIconW(add ? NIM_ADD : NIM_MODIFY, &g_nid);
}

/* Give back the pages touched by a menu or a start-up. */
static void trim(void) { SetProcessWorkingSetSize(GetCurrentProcess(), (SIZE_T)-1, (SIZE_T)-1); }

/* ---------- the service ---------- */

/*
 * Which start a service exit belongs to. A process that dies on its own just
 * before a stop and a new start would otherwise deliver its exit after the new
 * job exists, and closing that job (kill on close) would take the new service
 * down with it.
 */
static UINT_PTR g_service_gen;

static void CALLBACK on_service_exit(PVOID ctx, BOOLEAN timed_out) {
  (void)timed_out;
  PostMessageW(g_wnd, WM_APP_SERVICE_EXIT, (WPARAM)ctx, 0);
}

static void stop_service(void) {
  if (!g_job) return;
  g_stopping = 1;
  if (g_service_wait) {
    UnregisterWaitEx(g_service_wait, INVALID_HANDLE_VALUE);
    g_service_wait = NULL;
  }
  TerminateJobObject(g_job, 0);
  CloseHandle(g_job);
  g_job = NULL;
  if (g_service) {
    CloseHandle(g_service);
    g_service = NULL;
  }
  g_stopping = 0;
}

static void start_service(void) {
  if (g_job) return;
  g_job = CreateJobObjectW(NULL, NULL);
  if (!g_job) return;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits, sizeof limits);

  wchar_t log_path[MAX_PATH], logs[MAX_PATH], cmd[1024];
  swprintf(logs, MAX_PATH, L"%ls\\logs", g_root);
  CreateDirectoryW(g_root, NULL);
  CreateDirectoryW(logs, NULL);
  swprintf(log_path, MAX_PATH, L"%ls\\service.log", logs);
  SECURITY_ATTRIBUTES sa = {sizeof sa, NULL, TRUE};
  HANDLE log = CreateFileW(log_path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, NULL);
  swprintf(cmd, 1024, L"\"%ls\\node.exe\" \"%ls\\src\\main.mjs\" --ready", g_dir, g_dir);
  /* The service reads its folder from here; the child inherits it. */
  SetEnvironmentVariableW(L"HIDOCK_HOST_ROOT", g_root);

  STARTUPINFOW si;
  ZeroMemory(&si, sizeof si);
  si.cb = sizeof si;
  if (log != INVALID_HANDLE_VALUE) {
    /* No log file is no reason not to run: without it the service just writes nowhere. */
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = NULL;
    si.hStdOutput = log;
    si.hStdError = log;
  }
  PROCESS_INFORMATION pi;
  BOOL ok = CreateProcessW(NULL, cmd, NULL, NULL, TRUE,
                           CREATE_NO_WINDOW | CREATE_SUSPENDED | BELOW_NORMAL_PRIORITY_CLASS, NULL, g_dir, &si, &pi);
  if (log != INVALID_HANDLE_VALUE) CloseHandle(log);
  if (!ok) {
    CloseHandle(g_job);
    g_job = NULL;
    SetTimer(g_wnd, TIMER_RESTART, g_restart_ms, NULL); /* try again; the icon says it is down meanwhile */
    return;
  }
  AssignProcessToJobObject(g_job, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  g_service = pi.hProcess;
  g_service_gen++;
  RegisterWaitForSingleObject(&g_service_wait, g_service, on_service_exit, (PVOID)g_service_gen, INFINITE,
                              WT_EXECUTEONLYONCE);
}

/* ---------- deciding ---------- */

static void evaluate(void) {
  read_config();
  uint64_t now = now_ms();
  if (g_p.mode == STEP_ASIDE_ANY_USE) {
    LASTINPUTINFO lii = {sizeof lii, 0};
    if (GetLastInputInfo(&lii)) {
      DWORD idle = GetTickCount() - lii.dwTime; /* 32-bit tick arithmetic wraps correctly */
      g_p.last_input_ms = now > idle ? now - idle : 1;
    }
    SetTimer(g_wnd, TIMER_INPUT, 60 * 1000, NULL);
  } else {
    KillTimer(g_wnd, TIMER_INPUT);
    g_p.last_input_ms = 0;
  }
  settle_override(&g_p, now);
  why_t why = decide(&g_p, now);
  if (why == WHY_RUNNING) start_service();
  else stop_service();
  uint64_t wait = next_change_in(&g_p, now);
  if (wait) SetTimer(g_wnd, TIMER_QUIET, (UINT)(wait + 500), NULL);
  else KillTimer(g_wnd, TIMER_QUIET);
  /* Always: whether the service is actually up can change without the reason changing. */
  show_icon(why, 0);
  if (why != g_last_why) {
    g_last_why = why;
    trim();
  }
}

/* ---------- games ---------- */

static void CALLBACK on_game_exit(PVOID ctx, BOOLEAN timed_out) {
  (void)timed_out;
  PostMessageW(g_wnd, WM_APP_GAME_EXIT, (WPARAM)ctx, 0);
}

static void track_game(DWORD pid) {
  int free_slot = -1;
  for (int i = 0; i < MAX_GAMES; i++) {
    if (g_games[i].process && g_games[i].pid == pid) return;
    if (!g_games[i].process && free_slot < 0) free_slot = i;
  }
  if (free_slot < 0) return;
  HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return;
  g_games[free_slot].process = h;
  g_games[free_slot].pid = pid;
  if (!RegisterWaitForSingleObject(&g_games[free_slot].wait, h, on_game_exit, (PVOID)(INT_PTR)free_slot, INFINITE,
                                   WT_EXECUTEONLYONCE)) {
    CloseHandle(h);
    g_games[free_slot].process = NULL;
    return;
  }
  g_p.games_running++;
}

static void game_exited(int slot) {
  if (slot < 0 || slot >= MAX_GAMES || !g_games[slot].process) return;
  UnregisterWaitEx(g_games[slot].wait, NULL);
  CloseHandle(g_games[slot].process);
  g_games[slot].process = NULL;
  g_games[slot].pid = 0;
  if (g_p.games_running > 0) g_p.games_running--;
  g_p.last_game_ms = now_ms();
}

static int path_of(DWORD pid, wchar_t *out, DWORD size) {
  out[0] = 0;
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return 0;
  BOOL ok = QueryFullProcessImageNameW(p, 0, out, &size);
  CloseHandle(p);
  return ok;
}

/* The desktop, the lock screen and the shell cover the screen and are not games. */
static int is_shell_window(HWND hwnd, const wchar_t *path) {
  if (hwnd == GetShellWindow() || hwnd == GetDesktopWindow()) return 1;
  wchar_t cls[64];
  if (GetClassNameW(hwnd, cls, 64)) {
    if (wcscmp(cls, L"Progman") == 0 || wcscmp(cls, L"WorkerW") == 0 || wcscmp(cls, L"Shell_TrayWnd") == 0) return 1;
  }
  const wchar_t *name = wcsrchr(path, L'\\');
  name = name ? name + 1 : path;
  return _wcsicmp(name, L"LockApp.exe") == 0 || _wcsicmp(name, L"LogonUI.exe") == 0 ||
         _wcsicmp(name, L"explorer.exe") == 0;
}

/* Look at the foreground window: a game to wait on, or a full-screen window. */
static void look_at(HWND hwnd) {
  int was_fullscreen = g_p.fullscreen;
  g_p.fullscreen = 0;
  if (hwnd) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    wchar_t path[1024];
    path_of(pid, path, 1024);
    if (is_game_path(path)) track_game(pid);
    if (!is_shell_window(hwnd, path)) {
      HMONITOR mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL); /* no monitor (KVM away): never full screen */
      MONITORINFO mi;
      ZeroMemory(&mi, sizeof mi);
      mi.cbSize = sizeof mi;
      RECT wr;
      if (mon && GetMonitorInfoW(mon, &mi) && GetWindowRect(hwnd, &wr)) {
        /* A maximized browser covers the monitor too, but keeps its title bar. */
        LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        int has_caption = (style & WS_CAPTION) == WS_CAPTION;
        g_p.fullscreen = is_full_screen(wr.left, wr.top, wr.right, wr.bottom, mi.rcMonitor.left, mi.rcMonitor.top,
                                        mi.rcMonitor.right, mi.rcMonitor.bottom, has_caption);
      }
    }
  }
  if (was_fullscreen && !g_p.fullscreen) g_p.last_game_ms = now_ms();
}

static void CALLBACK on_foreground(HWINEVENTHOOK h, DWORD ev, HWND hwnd, LONG obj, LONG child, DWORD th, DWORD t) {
  (void)h; (void)ev; (void)obj; (void)child; (void)th; (void)t;
  look_at(hwnd);
  /* A game often comes to the front as a window and goes full screen a moment later. */
  SetTimer(g_wnd, TIMER_FS_RECHECK, 3000, NULL);
  evaluate();
}

/* Games already running when the icon starts (after a restart, say). Once. */
static void find_running_games(void) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  PROCESSENTRY32W e;
  e.dwSize = sizeof e;
  wchar_t path[1024];
  for (BOOL more = Process32FirstW(snap, &e); more; more = Process32NextW(snap, &e)) {
    if (path_of(e.th32ProcessID, path, 1024) && is_game_path(path)) track_game(e.th32ProcessID);
  }
  CloseHandle(snap);
}

/* ---------- talking to the service (loopback, for pairing) ---------- */

static int control(const char *action, char *out, DWORD out_size) {
  out[0] = 0;
  int ok = 0;
  HINTERNET session = WinHttpOpen(L"HiDockModelHostTray", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
                                  WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) return 0;
  WinHttpSetTimeouts(session, 2000, 2000, 5000, 5000);
  HINTERNET conn = WinHttpConnect(session, L"localhost", (INTERNET_PORT)g_port, 0);
  HINTERNET req = conn ? WinHttpOpenRequest(conn, L"POST", L"/control?format=json", NULL, WINHTTP_NO_REFERER,
                                            WINHTTP_DEFAULT_ACCEPT_TYPES, 0)
                       : NULL;
  if (req) {
    char body[64];
    int len = snprintf(body, sizeof body, "action=%s", action);
    if (WinHttpSendRequest(req, L"Content-Type: application/x-www-form-urlencoded\r\n", (DWORD)-1L, body, len, len,
                           0) &&
        WinHttpReceiveResponse(req, NULL)) {
      DWORD total = 0, got = 0;
      while (total + 1 < out_size && WinHttpReadData(req, out + total, out_size - 1 - total, &got) && got > 0) {
        total += got;
      }
      out[total] = 0;
      ok = total > 0;
    }
    WinHttpCloseHandle(req);
  }
  if (conn) WinHttpCloseHandle(conn);
  WinHttpCloseHandle(session);
  return ok;
}

/* The digits after "key":", or the number after "key":. Small, flat answers only. */
static int json_field(const char *json, const char *key, char *out, size_t size) {
  char quoted[48];
  snprintf(quoted, sizeof quoted, "\"%s\":", key);
  const char *at = strstr(json, quoted);
  if (!at) return 0;
  at += strlen(quoted);
  if (*at == '"') at++;
  size_t i = 0;
  while (at[i] && at[i] != '"' && at[i] != ',' && at[i] != '}' && i + 1 < size) {
    out[i] = at[i];
    i++;
  }
  out[i] = 0;
  return 1;
}

static void pairing_action(const char *action) {
  char answer[2048];
  if (!control(action, answer, sizeof answer)) {
    MessageBoxW(g_wnd, L"The service is not running. Press Start first, then pair.", L"HiDock Model Host",
                MB_OK | MB_ICONINFORMATION);
    return;
  }
  if (strcmp(action, "pair-code") == 0) {
    char code[16];
    if (json_field(answer, "code", code, sizeof code)) {
      wchar_t text[256];
      swprintf(text, 256,
               L"Pairing code: %.4hs %.4hs\n\nType it in HiDock: Settings > Transcription > Model host, then Pair. "
               L"It lasts five minutes.",
               code, code + 4);
      MessageBoxW(g_wnd, text, L"HiDock Model Host", MB_OK | MB_ICONINFORMATION);
    }
  } else if (strcmp(action, "pair-reset") == 0) {
    MessageBoxW(g_wnd,
                L"HiDock was disconnected. Automatic pairing is open for five minutes: press Pair in HiDock.",
                L"HiDock Model Host", MB_OK | MB_ICONINFORMATION);
  }
}

/* ---------- the menu ---------- */

static void show_menu(void) {
  HMENU menu = CreatePopupMenu();
  HMENU pairing = CreatePopupMenu();
  why_t why = decide(&g_p, now_ms());
  AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, why_text(why) + 19); /* without "HiDock Model Host: " */
  AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
  if (why == WHY_RUNNING) AppendMenuW(menu, MF_STRING, CMD_PAUSE, L"Pause");
  else AppendMenuW(menu, MF_STRING, CMD_START, L"Start");

  char status[2048];
  int up = g_job && control("status", status, sizeof status);
  UINT flags = up ? MF_STRING : MF_STRING | MF_GRAYED;
  AppendMenuW(pairing, flags, CMD_PAIR_CODE, L"Show a pairing code");
  char automatic[8] = "", remaining[24] = "0", paired[8] = "0";
  if (up) {
    json_field(status, "automatic", automatic, sizeof automatic);
    json_field(status, "remainingMs", remaining, sizeof remaining);
    json_field(status, "paired", paired, sizeof paired);
  }
  if (up && strcmp(automatic, "true") == 0) {
    wchar_t text[96];
    swprintf(text, 96, L"Cancel automatic pairing (%ld min left)", (atol(remaining) + 59999) / 60000);
    AppendMenuW(pairing, MF_STRING, CMD_PAIR_CANCEL, text);
  } else {
    AppendMenuW(pairing, (up && atoi(paired) == 0) ? MF_STRING : MF_STRING | MF_GRAYED, CMD_PAIR_RESUME,
                L"Resume automatic pairing");
  }
  AppendMenuW(pairing, flags, CMD_PAIR_RESET, L"Disconnect HiDock and start again");
  AppendMenuW(menu, MF_POPUP, (UINT_PTR)pairing, up ? L"Pairing" : L"Pairing (start first)");
  AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
  AppendMenuW(menu, MF_STRING, CMD_QUIT, L"Quit");

  POINT pt;
  GetCursorPos(&pt);
  SetForegroundWindow(g_wnd); /* the documented way to make the menu close on a click elsewhere */
  TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, g_wnd, NULL);
  PostMessageW(g_wnd, WM_NULL, 0, 0);
  DestroyMenu(menu);
  trim();
}

static void quit(void) {
  stop_service();
  if (g_hook) UnhookWinEvent(g_hook);
  if (!g_no_icon) Shell_NotifyIconW(NIM_DELETE, &g_nid);
  PostQuitMessage(0);
}

static LRESULT CALLBACK wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == g_taskbar_created && g_taskbar_created) {
    show_icon(g_last_why, 1); /* Explorer restarted and lost the icon */
    return 0;
  }
  switch (msg) {
    case WM_APP_TRAY:
      if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_LBUTTONUP || LOWORD(lp) == WM_CONTEXTMENU) show_menu();
      return 0;
    case WM_APP_GAME_EXIT:
      game_exited((int)wp);
      evaluate();
      return 0;
    case WM_APP_SERVICE_EXIT:
      if ((UINT_PTR)wp != g_service_gen) return 0; /* an exit from a service already replaced */
      if (g_service_wait) {
        UnregisterWaitEx(g_service_wait, NULL);
        g_service_wait = NULL;
      }
      if (!g_stopping && g_job) {
        /* It died on its own. Clear it and try again in 30 s if it should run. */
        CloseHandle(g_job);
        g_job = NULL;
        if (g_service) {
          CloseHandle(g_service);
          g_service = NULL;
        }
        SetTimer(hwnd, TIMER_RESTART, g_restart_ms, NULL);
        show_icon(decide(&g_p, now_ms()), 0); /* not "working" while it is down */
      }
      return 0;
    case WM_TIMER:
      if (wp == TIMER_FS_RECHECK || wp == TIMER_RESTART) KillTimer(hwnd, wp);
      if (wp == TIMER_FS_RECHECK) look_at(GetForegroundWindow());
      if (wp == TIMER_EXIT) {
        quit();
        return 0;
      }
      evaluate();
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wp)) {
        case CMD_START:
          g_p.user_paused = 0;
          g_p.user_override = 1; /* run now; the next game steps aside again */
          evaluate();
          break;
        case CMD_PAUSE:
          g_p.user_paused = 1;
          g_p.user_override = 0;
          evaluate();
          break;
        case CMD_PAIR_CODE: pairing_action("pair-code"); break;
        case CMD_PAIR_CANCEL: pairing_action("pair-cancel"); break;
        case CMD_PAIR_RESUME: pairing_action("pair-open"); break;
        case CMD_PAIR_RESET: pairing_action("pair-reset"); break;
        case CMD_QUIT: quit(); break;
      }
      return 0;
    case WM_QUERYENDSESSION:
      return TRUE;
    case WM_ENDSESSION:
    case WM_CLOSE:
      quit();
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmdline, int show) {
  (void)prev; (void)cmdline; (void)show;
  HANDLE single = CreateMutexW(NULL, TRUE, L"Local\\HiDockModelHostTray");
  if (GetLastError() == ERROR_ALREADY_EXISTS) return 0;

  int exit_after = 0;
  int no_foreground = 0;
  int argc = 0;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; i++) {
    if (wcscmp(argv[i], L"--no-icon") == 0) g_no_icon = 1; /* tests */
    if (wcscmp(argv[i], L"--no-foreground") == 0) no_foreground = 1; /* tests: the runner's own desktop must not decide */
    if (wcscmp(argv[i], L"--exit-after") == 0 && i + 1 < argc) exit_after = _wtoi(argv[++i]);
    if (wcscmp(argv[i], L"--root") == 0 && i + 1 < argc) wcsncpy(g_root, argv[++i], MAX_PATH - 1);
    if (wcscmp(argv[i], L"--restart-seconds") == 0 && i + 1 < argc) g_restart_ms = (UINT)_wtoi(argv[++i]) * 1000; /* tests */
    if (wcscmp(argv[i], L"--quiet-seconds") == 0 && i + 1 < argc) quiet_ms = (uint64_t)_wtoi(argv[++i]) * 1000ull; /* tests */
  }
  if (argv) LocalFree(argv);

  GetModuleFileNameW(NULL, g_dir, MAX_PATH);
  wchar_t *slash = wcsrchr(g_dir, L'\\');
  if (slash) *slash = 0;
  if (!g_root[0]) {
    wchar_t local[MAX_PATH];
    if (!GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH)) return 1;
    swprintf(g_root, MAX_PATH, L"%ls\\HiDock Model Host", local);
  }

  WNDCLASSW wc;
  ZeroMemory(&wc, sizeof wc);
  wc.lpfnWndProc = wndproc;
  wc.hInstance = inst;
  wc.lpszClassName = CLASS_NAME;
  RegisterClassW(&wc);
  /* A hidden top-level window (not message-only) so it hears WM_ENDSESSION and TaskbarCreated. */
  g_wnd = CreateWindowExW(0, CLASS_NAME, L"HiDock Model Host", 0, 0, 0, 0, 0, NULL, NULL, inst, NULL);
  g_taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");

  g_icons[0] = make_dot(RGB(46, 160, 67));
  g_icons[1] = make_dot(RGB(210, 140, 30));
  g_icons[2] = make_dot(RGB(140, 140, 140));

  read_config();
  find_running_games();
  if (!no_foreground) look_at(GetForegroundWindow());
  why_t first = decide(&g_p, now_ms());
  g_last_why = first;
  show_icon(first, 1);
  if (!no_foreground) g_hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, NULL, on_foreground, 0, 0,
                           WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  g_last_why = (why_t)-1;
  evaluate();
  if (exit_after > 0) SetTimer(g_wnd, TIMER_EXIT, (UINT)exit_after * 1000, NULL);
  trim();

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  ReleaseMutex(single);
  return 0;
}
