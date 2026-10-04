# Test fixtures

## Image

`sample.heic` is a synthetic 16 x 12 solid-color image (RGB 20, 80, 140), generated with sharp and converted from PNG using macOS `sips`. It contains no personal photo data.

The HEIC integration test exercises the application's real `/usr/bin/sips` conversion and therefore requires macOS. All output stays in temporary directories; it does not access Messages or call a model service.

## Memory CLI

`memory-cli.py` is a fake subprocess boundary, not a memory backend. Tests copy it
into a temporary workspace. It records argv and returns configured JSON, with
explicit failure and cancellation modes. It does not read personal memories or
reimplement the store's validation, deduplication, or correction logic.

## Scheduler service

`scheduler-service.cjs` is a minimal external API fixture for the host adapters.
It supplies callback boundaries and fixed parse results, not cron/timezone/retry
algorithms. Application tests use temporary storage and faux models; the installed
shared service is checked separately using a code-only copy and temporary data.
