# Notices and licensing boundary

- The upstream source dependency is `pi-antigravity` version `0.10.0`, authored by Rahul Arya and declared MIT in its `package.json`.
- The upstream MIT license text is retained at `notices/pi-antigravity-LICENSE.txt`.
- The source project `pi-antigravity-shim` declares `MIT` in its `package.json`, but no license file was present in the frozen source tree. The candidate therefore uses `UNLICENSED` metadata and is **not** a stable or distributable artifact. Do not publish or redistribute this candidate until the owner supplies an applicable license/notice for the shim's own source.
- This candidate does not copy the upstream provider implementation; it loads the separately installed upstream source at runtime. Any redistribution must separately satisfy that provider's license and its service/provider terms.
- Antigravity / Cloud Code Assist access is an unofficial integration. Live access, quotas, account authorization, and Google's terms are external requirements and were not exercised here.
