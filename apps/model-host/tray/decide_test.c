/* Tests for decide.c. Build and run: zig cc -target x86_64-windows-gnu decide.c decide_test.c -o decide_test.exe */
#include <stdio.h>
#include <string.h>
#include "decide.h"

static int failures = 0;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (!(cond)) {                                                      \
      fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);    \
      failures++;                                                       \
    }                                                                   \
  } while (0)

static presence_t quiet(step_aside_t mode) {
  presence_t p;
  memset(&p, 0, sizeof p);
  p.mode = mode;
  return p;
}

#define MIN (60ull * 1000ull)
#define T0 (100ull * MIN)

static void test_runs_when_nothing_is_happening(void) {
  presence_t p = quiet(STEP_ASIDE_GAMES);
  CHECK(decide(&p, T0) == WHY_RUNNING);
}

static void test_pause_from_the_menu_wins_over_everything(void) {
  presence_t p = quiet(STEP_ASIDE_NEVER);
  p.user_paused = 1;
  CHECK(decide(&p, T0) == WHY_PAUSED_BY_YOU);
}

static void test_a_game_stops_it_and_five_quiet_minutes_bring_it_back(void) {
  presence_t p = quiet(STEP_ASIDE_GAMES);
  p.games_running = 1;
  CHECK(decide(&p, T0) == WHY_GAME);
  p.games_running = 0;
  p.last_game_ms = T0;
  CHECK(decide(&p, T0 + 4 * MIN) == WHY_AFTER_GAME);
  CHECK(next_change_in(&p, T0 + 4 * MIN) == 1 * MIN);
  CHECK(decide(&p, T0 + 5 * MIN) == WHY_RUNNING);
}

static void test_full_screen_counts_as_a_game(void) {
  presence_t p = quiet(STEP_ASIDE_GAMES);
  p.fullscreen = 1;
  CHECK(decide(&p, T0) == WHY_GAME);
}

static void test_never_ignores_games_and_input(void) {
  presence_t p = quiet(STEP_ASIDE_NEVER);
  p.games_running = 2;
  p.fullscreen = 1;
  p.last_input_ms = T0;
  CHECK(decide(&p, T0) == WHY_RUNNING);
}

static void test_any_use_steps_aside_for_input_too(void) {
  presence_t p = quiet(STEP_ASIDE_ANY_USE);
  p.last_input_ms = T0 - 2 * MIN;
  CHECK(decide(&p, T0) == WHY_IN_USE);
  CHECK(next_change_in(&p, T0) == 3 * MIN);
  CHECK(decide(&p, T0 + 3 * MIN) == WHY_RUNNING);
}

static void test_games_mode_ignores_input(void) {
  presence_t p = quiet(STEP_ASIDE_GAMES);
  p.last_input_ms = T0;
  CHECK(decide(&p, T0) == WHY_RUNNING);
}

static void test_start_during_a_game_holds_until_that_game_ends(void) {
  presence_t p = quiet(STEP_ASIDE_GAMES);
  p.games_running = 1;
  p.user_override = 1; /* Start from the menu while the game runs */
  settle_override(&p, T0);
  CHECK(p.user_override == 1);
  CHECK(decide(&p, T0) == WHY_RUNNING);
  p.games_running = 0;
  p.last_game_ms = T0;
  settle_override(&p, T0 + MIN); /* the 5-minute wait still counts as that game */
  CHECK(decide(&p, T0 + MIN) == WHY_RUNNING);
  settle_override(&p, T0 + 5 * MIN);
  CHECK(p.user_override == 0);
  p.games_running = 1; /* the next game steps aside again */
  CHECK(decide(&p, T0 + 6 * MIN) == WHY_GAME);
}

static void test_game_folders(void) {
  CHECK(is_game_path(L"D:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe"));
  CHECK(is_game_path(L"C:\\XboxGames\\Forza Horizon 5\\Content\\ForzaHorizon5.exe"));
  CHECK(is_game_path(L"C:\\Program Files\\Epic Games\\Fortnite\\FortniteClient-Win64-Shipping.exe"));
  CHECK(is_game_path(L"C:\\Riot Games\\VALORANT\\live\\VALORANT.exe"));
  CHECK(is_game_path(L"C:\\Users\\Sebasti\x00e1n\\GOG Games\\Witcher 3\\witcher3.exe"));
  /* Launchers and helpers that live there and run all day. */
  CHECK(!is_game_path(L"C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe"));
  CHECK(!is_game_path(L"C:\\Riot Games\\Riot Client\\RiotClientServices.exe"));
  CHECK(!is_game_path(L"D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe"));
  /* Steam itself is not a game. */
  CHECK(!is_game_path(L"C:\\Program Files (x86)\\Steam\\steam.exe"));
  CHECK(!is_game_path(L"C:\\Windows\\explorer.exe"));
  CHECK(!is_game_path(L""));
  /* A folder name that only contains the words is not a game library. */
  CHECK(!is_game_path(L"C:\\notsteamapps\\commonplace\\x.exe"));
}

static void test_covers_monitor(void) {
  CHECK(covers_monitor(0, 0, 2560, 1440, 0, 0, 2560, 1440));
  CHECK(covers_monitor(-8, -8, 2568, 1448, 0, 0, 2560, 1440));
  CHECK(!covers_monitor(0, 0, 2560, 1400, 0, 0, 2560, 1440));
  CHECK(covers_monitor(2560, 0, 5120, 1440, 2560, 0, 5120, 1440));
}

static void test_parse_config(void) {
  CHECK(parse_step_aside("{\"port\": 8765, \"stepAside\": \"any-use\"}") == STEP_ASIDE_ANY_USE);
  CHECK(parse_step_aside("{\"stepAside\":\"never\"}") == STEP_ASIDE_NEVER);
  CHECK(parse_step_aside("{\"stepAside\": \"games\"}") == STEP_ASIDE_GAMES);
  CHECK(parse_step_aside("{}") == STEP_ASIDE_GAMES);
  CHECK(parse_step_aside(NULL) == STEP_ASIDE_GAMES);
  CHECK(parse_step_aside("{\"stepAside\": \"sometimes\"}") == STEP_ASIDE_GAMES);
  CHECK(parse_port("{\"port\": 9000}") == 9000);
  CHECK(parse_port("{}") == 8765);
  CHECK(parse_port("{\"port\": 99999}") == 8765);
}

int main(void) {
  test_runs_when_nothing_is_happening();
  test_pause_from_the_menu_wins_over_everything();
  test_a_game_stops_it_and_five_quiet_minutes_bring_it_back();
  test_full_screen_counts_as_a_game();
  test_never_ignores_games_and_input();
  test_any_use_steps_aside_for_input_too();
  test_games_mode_ignores_input();
  test_start_during_a_game_holds_until_that_game_ends();
  test_game_folders();
  test_covers_monitor();
  test_parse_config();
  if (failures) {
    fprintf(stderr, "%d failed\n", failures);
    return 1;
  }
  printf("decide: all passed\n");
  return 0;
}
