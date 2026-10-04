/* The tray icon's decisions. No Windows calls here; see decide.h. */
#include "decide.h"

#include <stdlib.h>
#include <string.h>
#include <wctype.h>

uint64_t quiet_ms = 5ull * 60ull * 1000ull;

/* What the machine says, without the person's override. */
static why_t underlying(const presence_t *p, uint64_t now_ms) {
  if (p->mode == STEP_ASIDE_NEVER) return WHY_RUNNING;
  if (p->games_running > 0 || p->fullscreen) return WHY_GAME;
  if (p->last_game_ms && now_ms - p->last_game_ms < quiet_ms) return WHY_AFTER_GAME;
  if (p->mode == STEP_ASIDE_ANY_USE && p->last_input_ms && now_ms - p->last_input_ms < quiet_ms) {
    return WHY_IN_USE;
  }
  return WHY_RUNNING;
}

why_t decide(const presence_t *p, uint64_t now_ms) {
  if (p->user_paused) return WHY_PAUSED_BY_YOU;
  if (p->user_override) return WHY_RUNNING;
  return underlying(p, now_ms);
}

void settle_override(presence_t *p, uint64_t now_ms) {
  if (p->user_override && underlying(p, now_ms) == WHY_RUNNING) p->user_override = 0;
}

uint64_t next_change_in(const presence_t *p, uint64_t now_ms) {
  uint64_t wait = 0;
  if (p->user_paused || p->mode == STEP_ASIDE_NEVER || p->games_running > 0 || p->fullscreen) return 0;
  if (p->last_game_ms && now_ms - p->last_game_ms < quiet_ms) {
    wait = quiet_ms - (now_ms - p->last_game_ms);
  }
  if (p->mode == STEP_ASIDE_ANY_USE && p->last_input_ms && now_ms - p->last_input_ms < quiet_ms) {
    uint64_t input_wait = quiet_ms - (now_ms - p->last_input_ms);
    if (input_wait > wait) wait = input_wait;
  }
  return wait;
}

/* Each entry is matched as a run of whole folder names: \steamapps\common\ . */
static const wchar_t *GAME_FOLDERS[] = {
  L"\\steamapps\\common\\",
  L"\\xboxgames\\",
  L"\\epic games\\",
  L"\\gog galaxy\\games\\",
  L"\\gog games\\",
  L"\\riot games\\",
  L"\\ea games\\",
  L"\\ubisoft game launcher\\games\\",
};

/* Programs that live in those folders and run all day. */
static const wchar_t *NEVER_GAMES[] = {
  L"epicgameslauncher.exe",
  L"epicwebhelper.exe",
  L"epiconlineserviceshost.exe",
  L"riotclientservices.exe",
  L"riotclientux.exe",
  L"riotclientuxrender.exe",
  L"riotclientcrashhandler.exe",
  L"wallpaper32.exe",
  L"wallpaper64.exe",
  L"webwallpaper32.exe",
  L"crashreportclient.exe",
  L"unitycrashhandler64.exe",
};

#define COUNT(a) (sizeof(a) / sizeof((a)[0]))

int is_game_path(const wchar_t *path) {
  if (!path || !path[0]) return 0;
  size_t n = wcslen(path);
  if (n >= 1024) return 0;
  wchar_t lower[1024];
  for (size_t i = 0; i <= n; i++) {
    wchar_t c = path[i] == L'/' ? L'\\' : path[i];
    lower[i] = (wchar_t)towlower(c);
  }
  const wchar_t *name = wcsrchr(lower, L'\\');
  name = name ? name + 1 : lower;
  for (size_t i = 0; i < COUNT(NEVER_GAMES); i++) {
    if (wcscmp(name, NEVER_GAMES[i]) == 0) return 0;
  }
  for (size_t i = 0; i < COUNT(GAME_FOLDERS); i++) {
    if (wcsstr(lower, GAME_FOLDERS[i])) return 1;
  }
  return 0;
}

int covers_monitor(long wl, long wt, long wr, long wb, long ml, long mt, long mr, long mb) {
  return wl <= ml && wt <= mt && wr >= mr && wb >= mb;
}

/* The text after "key": , or NULL. Enough for the flat config.json the service writes. */
static const char *value_of(const char *json, const char *key) {
  if (!json) return NULL;
  char quoted[64];
  size_t k = strlen(key);
  if (k + 3 > sizeof quoted) return NULL;
  quoted[0] = '"';
  memcpy(quoted + 1, key, k);
  quoted[k + 1] = '"';
  quoted[k + 2] = 0;
  const char *at = strstr(json, quoted);
  if (!at) return NULL;
  at += k + 2;
  while (*at == ' ' || *at == '\t' || *at == '\r' || *at == '\n') at++;
  if (*at != ':') return NULL;
  at++;
  while (*at == ' ' || *at == '\t' || *at == '\r' || *at == '\n') at++;
  return at;
}

step_aside_t parse_step_aside(const char *json) {
  const char *v = value_of(json, "stepAside");
  if (!v) return STEP_ASIDE_GAMES;
  if (strncmp(v, "\"any-use\"", 9) == 0) return STEP_ASIDE_ANY_USE;
  if (strncmp(v, "\"never\"", 7) == 0) return STEP_ASIDE_NEVER;
  return STEP_ASIDE_GAMES;
}

int parse_port(const char *json) {
  const char *v = value_of(json, "port");
  if (!v) return 8765;
  long port = strtol(v, NULL, 10);
  return port > 0 && port < 65536 ? (int)port : 8765;
}
