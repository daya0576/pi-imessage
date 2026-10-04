# Image fixture

`sample.heic` is a synthetic 16 x 12 solid-color image (RGB 20, 80, 140), generated with sharp and converted from PNG using macOS `sips`. It contains no personal photo data.

The HEIC integration test exercises the application's real `/usr/bin/sips` conversion and therefore requires macOS. All output stays in temporary directories; it does not access Messages or call a model service.
