# Publication verification

The builder now publishes both the accepted candidate and a readback-failure quarantine file through `publish_no_clobber()`. It creates the destination with `os.link()` and removes the owned `.partial` name only after the link succeeds. On the builder's WSL/POSIX path, destination creation is atomic and fails with `FileExistsError` when that name already exists, so a concurrent destination cannot be replaced.

The focused check imports the production helper and creates a temporary directory beside the builder, on the same mounted filesystem as `OUT`. It confirms both directories have the same device ID before exercising publication. Command run:

```text
wsl.exe --exec python3 /mnt/g/Code/hidock-next-2/research/rea/completion630-lab/hardware-vad-trace/firmware-integration/verify_publication.py
```

Observed result: `status=PASS`, `filesystem=posix`, `same_device_as_output=true`, Python 3.12.3.

- Success: destination contained all 17 payload bytes and the `.partial` name was removed.
- Final-name race simulation: after observing the destination absent, the check creates it as a competing publisher would; `FileExistsError` followed, with all 28 destination bytes and all 29 partial bytes intact.
- Rejected-name race simulation: the same absent-then-created sequence for `.REJECTED` raised `FileExistsError`, with all 31 destination bytes and all 32 partial bytes intact.

This check exercised only the publication helper against temporary files. It did not run the candidate builder, the rejection suite, the application, or hardware.
