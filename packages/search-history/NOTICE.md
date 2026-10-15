# Provenance

Search parsing/filtering is adapted from `disler/durable-pi`, MIT, Copyright (c) 2026 IndyDevDan.

Pinned source: https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-backend/src/history.ts

Tool design reference: https://github.com/disler/durable-pi/blob/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-backend/src/extensions.ts

Changes: native Pi Durable EntryRecord types (no DPI SDK); explicit bounded scan/completeness metadata; strict tool arguments; newest-first scan; historical context label rather than guessing compaction when a reset is outside the scan; exclusion of arbitrary event data; bounded tools/text output; no PocketHost or direct storage access.

This package is a local candidate, not an upstream release. No guarantee of byte-for-byte output compatibility with DPI or compatibility outside the tested runtime tuple.
