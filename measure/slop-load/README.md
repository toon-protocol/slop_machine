# Slop load bench (throwaway)

Measurement harness for [Measure Slop load latency on real mobile networks](https://github.com/toon-protocol/slop_machine/issues/28).

```sh
node gen.mjs      # builds synthetic Slop s (≈95 KB), m (≈2.1 MB) and l (≈10.3 MB / 9.85 MiB) under slop/
node serve.mjs    # local: http://localhost:5180/
```

Published copy for the phone: https://allidoizcode.github.io/slop-load-bench/

## Tabs

- **Bench**: loads S/M/L three times each, cold (new URLs, browser and CDN miss) then warm (same URLs, CDN hit, browser cache bypassed). Records `load` (window load, the earliest a shim could send `slop-ready`), `ready` (all files fetched and scripts run) and `frame` (the game's first drawn frame).
- **Feed**: a one-ahead Feed. The landed Slop is visible, and the next preloads behind it after a simulated Pull round trip. Flick up to Pull. Each flick logs its dwell and whether it stalled on a loading card.
- **Gateway**: random old Arweave data of S/M/L size fetched twice through a public ar.io gateway. The first fetch is cold (gateway MISS) and the second warm, and `x-cache-status` is recorded.

## Phone checklist (iPhone)

Keep the screen awake and set the **Network** dropdown before each run.

1. On **Wi-Fi**, run **Bench** (reps 3). This is the baseline.
2. Turn Wi-Fi off. On **LTE/5G**: run **Bench**, then **Gateway** once on ardrive.net, then **Feed** (Mixed, Warm, 500 ms). Flick for ~2 minutes at your natural pace, tap End, then start a second session and skim as fast as you can for ~1 minute.
3. Settings › Developer › Network Link Conditioner › **3G** (set Network to "NLC 3G"). Run **Bench** (reps 1 is fine, L may take minutes), then **Feed** (Mixed, Warm), skimming for ~1 minute.
4. Optional: NLC **LTE** profile for a repeatable LTE number.
5. Turn NLC off, tap **Copy all results**, and paste the JSON back to Claude.
