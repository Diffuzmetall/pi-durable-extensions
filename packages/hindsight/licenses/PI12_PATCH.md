# Local cache-permission patch

The Pi 1.2 migration preserves the vendored Hindsight implementation and license, with this single local change in `src/vendor/pi.mjs`:

```diff
-    writeFileSync3(tmp, body);
+    writeFileSync3(tmp, body, { mode: 0o600 });
```

The atomic cache replacement formerly created its temporary file using the process umask (0644 under umask 022), replacing the adapter's 0600 cache with an insecure file. The adapter's strict private-file reader then correctly refused it. Creating the temporary file with 0600 keeps protection intact; no private-file validation was relaxed and the process umask is not changed.

The original-extract hashes and license evidence in EVIDENCE.json remain provenance records. The fresh distribution catalog records the SHA-256 of the complete packaged artifact containing this patch. Original license and third-party notices are retained.
