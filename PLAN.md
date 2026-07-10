# signalk-windshift — Development Plan

This document is the living record of what's been built, what's running now,
and what comes next. Updated with each significant change.

---

## Branches

| Branch | Version | Status |
|---|---|---|
| `main` | v0.0.6 | Stable, single-source, original upstream + minor fixes |
| `feature/multi-station` | v0.3.5 | Multi-station, soak test on Pi, **merge pending** |
| `feature/gradient-detection` | v0.4.0 | Gradient shift detection, **currently deployed on Pi** |

---

## Completed milestones

### M0 — Original plugin (upstream)
Johan Wallinder's original: single TWD source, rolling min/max window,
delta (spread), basic trend. No cycle detection, no prediction.

### M1 — Cycle detection
- Zigzag detector with threshold: tracks running extremes, only confirms a
  peak/trough once the wind reverses by ≥ threshold. Filters sensor noise.
- `cyclePeriod`: average interval between consecutive same-type extremes.
- `certainty`: 1 − (std dev / half-period). Metronomic → 1.0, chaotic → 0.
- `timeToNextShift`: counts down from last extreme + half cycle.
- Extremes expire so stale data can't skew predictions.

### M2 — Tack awareness
- Heading-change trigger: >~11° heading swing → lockout starts.
- AWA-crossing trigger: apparent wind crosses bow → tack detected → lockout.
- Dead-bands at head-to-wind and dead downwind (AWA sign unreliable there).
- `isSettled` path published; `tack_lockout_s` configurable.
- Shore stations bypass all of this — lighthouses don't tack.

### M3 — Auto-calibration
- Tracks circular mean TWD per tack (port / starboard independently).
- Correction = half the port/starboard difference, applied per tack.
- Computed from uncalibrated data so it can't feed back into itself.
- Caveat: don't use this if you systematically tack on the shifts.

### M4 — Multi-station (factory analyzer pattern)
- `createAnalyzer()` factory: each call returns a fully independent instance.
- Plugin runs one analyzer for the boat + one per tracked ViVa station.
- Stations self-discover from whatever signalk-viva publishes (no hardcoding).
- `track_viva_stations` config: N nearest stations active, re-ranked by
  distance as the boat moves; disabled stations are reset to avoid stale data.
- Boat paths: `environment.wind.windshift.*`
- Station paths: `environment.observations.viva.<slug>.windshift.*`

### M5 — Dashboard (v0.3.x)
- uPlot waterfall: raw TWD (grey), smoothed avg (green), min/max envelope
  (orange/blue dashed), wind speed + gust on right-side knots axis.
- Source dropdown: boat + active stations, distance in nm shown.
- Metrics bar: TWD, avg wind / gust, delta, trend, cycle, next shift, certainty.
- Boat avg shown as purple reference line on station views.
- Drag-to-zoom + double-click / button reset.
- `latestBoatAvg` tracked regardless of displayed source for the reference line.

### M6 — Persistence
- `metricsHistory` in each analyzer: 24 h rolling buffer of `{t, avg, min, max}`.
- Saved to `windshift-history.json` every 5 min + on shutdown (atomic tmp+rename).
- Restored on startup: chart seeds from history so restarts don't start blank.
- Speed/gust tagged onto history points and seeded back into chart header on load.

### M7 — Dashboard v0.3.5
- **Time window buttons** (30m / 1h / 3h / 6h / 24h): zooms uPlot x-axis.
  `loadHistory` seeds full 24 h from server (removed 1700-point cap).
- **Shift overlay** (Last 2 / 3 / 5): replaces waterfall with a comparison
  chart — last N shift half-cycles overlaid on a 0–100% normalized time axis,
  y = Δ° from each shift's start. Brightest = most recent.
- `/latest` endpoint now includes `peaks[]` and `troughs[]` (ms timestamps)
  so the overlay can compute cycle boundaries client-side.

### M8 — Gradient/persistent shift detection (v0.4.0)
- **Long-period regression** (`computeGradientMetrics`):
  - `gradientRate`: linear regression slope on 1 h of `metricsHistory`, deg/hr.
  - `gradientRate3h`: same over 3 h (lower noise from oscillation averaging).
  - `meanDrift1h`: net circular change of mean TWD over 1 h, degrees.
  - `regime`: "oscillating" / "drifting" / "mixed" / "unknown" — classifies
    whether cyclic oscillation, persistent gradient, or both are active.
- **Station consensus** (`computeConsensus` in index.js): fraction of active
  ViVa stations whose 1 h gradient rate agrees in sign with the boat.
  Published in `/latest?source=boat`. Synoptic events → all stations agree.
- Dashboard: **Drift** (deg/hr with arrow + colour) and **Regime** badge
  (green / orange / cyan for oscillating / drifting / mixed).

### M9 — Rapid shift detector + speed correlation (v0.4.0 cont.)
- **`detectRapidShift`**: compares circular mean of last 5 min ("recent") to
  prior 5–25 min ("baseline"). Flags `gradientDetected` when gap ≥ 10°.
  Hysteresis: clears only at 5° to prevent edge flickering.
- **`computeSpeedCorrelation`**: `appendWindSpeed()` method feeds a 30-min
  rolling speed history into each analyzer. Flags `speedCorrelated` when the
  5-min mean speed is ≥ 20% above the prior 15-min mean simultaneously with
  a gradient detection — the classic squall / frontal signature.
- Speed data wired from both the boat subscription and all ViVa station
  subscriptions in `index.js`.
- **New SK paths** (boat + all tracked stations):
  - `…windshift.gradientShift.detected` (0/1)
  - `…windshift.gradientShift.degrees` (rad, + veering)
  - `…windshift.gradientShift.speedCorrelated` (0/1)
- **Dashboard alert**: pulsing red banner "⚠ GRADIENT SHIFT: 18° veering +
  wind increase" between the controls bar and chart. Auto-clears when shift
  settles. Smoke test: pure 8° oscillation → no trigger; sudden 20° shift
  + 25% speed spike → rapidShiftDeg = 19.4°, speedCorrelated = true. ✓

---

## Currently running on Pi (KarukeraPi, 192.168.0.120)

Branch: `feature/gradient-detection` (v0.4.0)

Config (soak test mode, boat at mooring):
- TWD source: `environment.observations.viva.vinga.wind.directionTrue`
- Ignore maneuvers: on
- Track ViVa stations: 5

Observations so far:
- Cycle detection locks in within ~1 h on oscillating days.
- Certainty stays low in messy morning gradient — correct behaviour.
- Persistence works: Pi restarts don't blank the chart.
- Speed correlation not yet exercised by a real frontal passage.

**⚠ After each deploy:** SignalK restart requires `sudo systemctl restart signalk`
via a TTY session (SSH without `-t` cannot provide the sudo password prompt).

---

## Roadmap

### Near term

**R1 — Upwind station early warning**
Each station already runs its own gradient detector. The missing piece:
- Compute bearing from boat to each station using boat's GPS position.
- Determine which stations are "upwind" (within ±60° of TWD).
- When an upwind station fires `gradientDetected` and the boat hasn't,
  estimate propagation ETA: `distance / wind_speed` (rough first pass).
- Emit `environment.wind.windshift.gradientShift.approachingETA` (seconds).
- Dashboard: "Gradient shift approaching from Vinga — ETA ~8 min".

**R2 — Merge feature/multi-station → main + npm publish**
- Run soak test until at least one frontal passage is captured with
  `gradientDetected` firing correctly.
- Merge feature/multi-station to main (v1.0.0).
- Merge gradient-detection on top.
- `npm publish` (requires 2FA OTP).

**R3 — Notification / alarm output**
- When `gradientDetected` fires, emit an alarm on a configurable SignalK
  notification path (e.g., `notifications.windshift.gradientShift`).
- Allows integration with chartplotter alarms or an on-board alarm sounder.

### Medium term

**R4 — Forecast verification overlay**
- Companion plugin `signalk-forecast-skill` already fetches and archives
  Open-Meteo model data at the ViVa station locations (M1 complete).
- Overlay forecast TWD on the windshift waterfall chart for direct comparison.
- Score models against observed shifts: was a cyclic day predicted?
  Did the gradient shift timing match?
- Decoupled design: forecast-skill provides a REST endpoint;
  windshift dashboard optionally fetches and renders it.

**R5 — Outlier-shift classifier**
- Track the amplitude of the last N detected half-cycles.
- Flag when the current half-cycle amplitude is > 1.5× the recent average.
- Combined with gradient detection: large outlier + no reversal = gradient.
- Distinguishes "one big oscillation" from "the mean just moved".

**R6 — Historical regime analysis**
- Store the `regime` classification with each history point.
- Dashboard: colour-code the waterfall background by regime
  (faint green = oscillating, orange = drifting, cyan = mixed).
- Per-race-day summary: "3 h oscillating SW, then 45-min gradient shift to W".

### Long term

**R7 — Course layline integration**
- Given boat position, mark laylines for both tacks on the chart.
- Show whether a predicted shift would lift or knock on each tack.
- Requires knowing the mark position (entered manually or from active route).

**R8 — Multi-boat aggregation**
- If several boats run the plugin and share a SignalK fleet network,
  aggregate shift detections across the fleet.
- Fleet-wide `certainty` is much higher than a single boat's.
- Relevant for club racing with multiple plugin-equipped boats.

---

## Architecture notes

- **Factory pattern**: `createAnalyzer()` in `windshiftAnalysis.js` returns
  a closure with independent state. Adding a new source is a single `createAnalyzer()`
  call — no shared mutable globals.
- **24 h history** is the boundary between "live" and "archived" data.
  In-memory `metricsHistory` + disk persistence cover restarts.
  Client seeds the chart from the history endpoint on load.
- **Speed correlation** requires speed to flow into the analyzer via
  `appendWindSpeed()`. Boat gets it from its TWD-matching speed path;
  stations get it from `environment.observations.viva.<slug>.wind.averageSpeed`.
- **Gradient thresholds** (RAPID_SHIFT_DEG = 10°, speed spike = 20%) are
  hard-coded constants for now. They should become plugin config options once
  real-world data shows whether they need tuning.
