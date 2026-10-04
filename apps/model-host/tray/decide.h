/*
 * The tray icon's decisions, without Windows calls, so they can be tested.
 * Times are GetTickCount64 milliseconds.
 */
#ifndef HIDOCK_DECIDE_H
#define HIDOCK_DECIDE_H

#include <stdint.h>
#include <wchar.h>

/* When the service steps aside. Set from HiDock, stored in config.json. */
typedef enum { STEP_ASIDE_GAMES = 0, STEP_ASIDE_ANY_USE = 1, STEP_ASIDE_NEVER = 2 } step_aside_t;

/* Five minutes after the last game or the last input, work starts again. Tests shorten it. */
extern uint64_t quiet_ms;

typedef struct {
  step_aside_t mode;
  int user_paused;          /* Pause from the menu: only Start undoes it. */
  int user_override;        /* Start from the menu while stepping aside: run until that reason is gone */
  int games_running;        /* game-folder processes being waited on */
  int fullscreen;           /* the foreground window covers its monitor */
  uint64_t last_game_ms;    /* when the last game or full-screen window went away; 0 never */
  uint64_t last_input_ms;   /* GetLastInputInfo, as a 64-bit tick; 0 unknown */
} presence_t;

typedef enum {
  WHY_RUNNING = 0,
  WHY_PAUSED_BY_YOU,
  WHY_GAME,
  WHY_AFTER_GAME,
  WHY_IN_USE,
} why_t;

/* Should the service run now, and if not, why. */
why_t decide(const presence_t *p, uint64_t now_ms);

/* Clears user_override once the reason it overrode is gone, so the next game steps aside again. */
void settle_override(presence_t *p, uint64_t now_ms);

/* Milliseconds until decide() can change by itself (a quiet period ending), or 0. */
uint64_t next_change_in(const presence_t *p, uint64_t now_ms);

/* A program installed in a game library, and not a launcher that runs all day. */
int is_game_path(const wchar_t *path);

/* The window covers the whole monitor. */
int covers_monitor(long wl, long wt, long wr, long wb, long ml, long mt, long mr, long mb);

/* "stepAside": "any-use" | "games" | "never" in config.json text; games when absent. */
step_aside_t parse_step_aside(const char *json);

/* "port": N in config.json text; 8765 when absent. */
int parse_port(const char *json);

#endif
