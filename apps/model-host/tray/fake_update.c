/* Test helper: stands in for the installer in tests/tray.e2e.test.mjs. It
 * writes ran.txt next to itself, with its arguments, and exits. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

int main(void) {
  wchar_t path[MAX_PATH];
  GetModuleFileNameW(NULL, path, MAX_PATH);
  wchar_t *slash = wcsrchr(path, L'\\');
  if (slash) wcscpy(slash + 1, L"ran.txt");
  FILE *f = _wfopen(path, L"w");
  if (!f) return 1;
  fwprintf(f, L"%ls\n", GetCommandLineW());
  fclose(f);
  return 0;
}
