# signalk-windshift

A SignalK plugin that analyzes True Wind Direction (TWD) to detect, quantify
and **predict wind shifts** — for tactical sailing, race preparation and
plain curiosity about what the wind is doing.

Originally created by [Johan Wallinder](https://github.com/jwallinder/signalk-windshift),
extended in this fork with cycle prediction, tack awareness, multi-station
tracking and a live dashboard.

---

## Quick Start

**Prerequisites:**
- A running SignalK server, on whatever Node.js version your server already requires.
- Optional, only for multi-station tracking: [`signalk-viva`](https://github.com/theseal666/signalk-viva-plugin) installed and running first, so there are stations for this plugin to discover.

**1. Install and restart the server**

```bash
cd ~/.signalk
npm install "https://github.com/theseal666/signalk-windshift.git"
sudo systemctl restart signalk
```

Installing and restarting the server is not the same as turning the plugin
on — SignalK plugins ship disabled by default.

**2. Enable it and set the basics**

In the SignalK admin UI, go to **Server → Plugin Config** and find
**Windshift** in the list. Toggle it on, then set at minimum:

- **TWD Source Path** — which SignalK path to analyze (default
  `environment.wind.directionTrue`). If you don't have live wind instruments
  yet and just want to see the plugin working, point this at a shore
  station's path instead — see "Testing against a shore station" below.

**3. (Optional) Turn on multi-station tracking**

If `signalk-viva` is installed and publishing station data, set
**Track ViVa Stations** to however many of the nearest shore stations you
want analyzed in parallel with the boat (0 = off).

**4. Save**

Click **Submit**. This restarts only the plugin (not the whole SignalK
server) with your new configuration.

**5. Open the dashboard**

`http://<your-signalk-ip>/@jwallinder/windshift` — or via the admin UI's
**Webapps** menu, listed as "Windshift".

**Troubleshooting:**
- **Dashboard shows all zeros or dashes** — normal for the first ~30 minutes
  after a restart, or in very light/steady air: the plugin needs a few
  completed ≥4° swings before cycle metrics have anything to report.
- **Windshift doesn't appear in the Webapps menu** — check that it's toggled
  on in Plugin Config and that the server restarted cleanly; the SignalK
  debug log will show plugin startup messages if you filter for
  "windshift".
- **No stations show up in the Source dropdown** — confirm `signalk-viva`
  is installed, running, and actually publishing station data, and that
  **Track ViVa Stations** is set above 0.

---

## What we are trying to achieve

Wind is rarely steady. On most race days the True Wind Direction oscillates
around a mean — backing and veering in a semi-regular rhythm driven by
thermals, gradient interplay and terrain. A boat that tacks in phase with
those oscillations gains hugely on one that ignores them. The tactical
questions are always the same:

1. **How big are the shifts?** (the spread between min and max TWD)
2. **How often do they come?** (the oscillation period)
3. **Which phase are we in right now?** (lifted or headed, veering or backing)
4. **When is the next shift due?** (the countdown that decides "tack now or hold")

Raw masthead data doesn't answer any of this directly — it looks like the
green noise below. The underlying rhythm (hand-marked in red) is what we
want the plugin to extract automatically:

![What we want](IMG/what%20we%20want.png)
*Raw TWD (green) with the underlying oscillation traced by hand — the plugin's
job is to find this rhythm without the hand.*

![What we want 2](IMG/what%20we%20want%202.png)
*The same idea with the oscillation envelope marked: spread, period and phase
are the tactical currency.*

The second ambition is **pre-race preparation**: hours (or a day) before the
start, monitor the wind behavior at several weather stations around the
racecourse — is the oscillation local or course-wide, is there a gradient
between the inshore and offshore stations, what period should we expect where
we'll be sailing? With the multi-station feature and data from
[Sjöfartsverket ViVa](https://github.com/theseal666/signalk-viva-plugin),
that picture builds itself while the boat is still at the dock.

## How we do it

### Smoothing

Raw TWD samples are collected into a short buffer (default 10 s) and reduced
to one averaged data point using a proper *circular* mean (sin/cos
components), so a wind oscillating around north doesn't produce nonsense.
These averaged points form the time series everything else is computed from.

### Shift detection (zigzag with threshold)

The averaged TWD is *unwrapped* into a continuous series (no 0°/360° jumps)
and run through a zigzag detector: while the wind veers, the running maximum
is tracked as a candidate peak; only when the wind has come **back** by at
least the shift threshold (default 4°) is that candidate confirmed as a real
peak, and the detector flips to hunting a trough. Wiggles smaller than the
threshold never register — sensor noise cannot flood the statistics.
Confirmed extremes are timestamped at the actual turning point, not at the
moment of confirmation.

### Cycle period, certainty and prediction

The cycle period is the average interval between consecutive peaks and
between consecutive troughs (one full oscillation). **Certainty** measures
how regular those intervals are: metronomic shifts score near 1.0, chaos
scores 0 — and a low score is the honest answer in unstable conditions, not
a malfunction. Because peaks and troughs alternate, the next extreme is
expected about **half a cycle** after the last one; `timeToNextShift` counts
down live from there. Old extremes expire so a shift from hours ago cannot
skew the estimate.

### Tack awareness (boat source only)

Two triggers pause data collection during maneuvers (the "don't chase your
own tacks" filter): a heading change of more than ~11°, and the apparent
wind angle crossing sides. AWA samples within ~3° of head-to-wind or beyond
~165° are ignored, since the AWA sign is pure noise there. Shore stations
skip all of this — a lighthouse doesn't tack.

### Auto-calibration

A misaligned wind sensor reads systematically different TWD on port vs
starboard tack. The plugin keeps recent raw readings per tack, takes the
circular mean of each side, and applies **half the difference per tack** —
pulling both toward the common mean (a single global offset can never fix a
side-to-side asymmetry). The means are computed from uncorrected data so the
correction never feeds back into its own estimate. Caveat: if you tack *on*
the shifts, genuine oscillation shows up as a port/starboard difference and
gets partially calibrated away — leave this off unless you suspect sensor
misalignment.

### Gradient and persistent shift detection

Not all shifts are oscillations. A cold front, developing sea breeze, or
gradient wind change moves the mean TWD in one direction and keeps it there.
The plugin detects these at two timescales:

**Long-period regression** (1 h and 3 h windows): a circular linear regression
on `metricsHistory` gives a `gradientRate` in °/hr. The 3 h window is more
robust against oscillation noise; the 1 h window reacts faster. A net
`meanDrift1h` value (how far the mean has actually moved in the last hour,
regardless of the regression slope) catches fast frontal passages that the
slope alone might understate.

**Rapid shift detector** (5 min vs prior 20 min): compares the circular mean
of the last 5 minutes to the baseline of the 5–25 minutes before that.
When they diverge by ≥ 10° the `gradientShift.detected` flag fires.
Hysteresis prevents flickering at the edge — once triggered, it clears only
when the gap drops below 5°.

**Speed correlation**: each analyzer maintains a 30-minute rolling speed
history (`appendWindSpeed`). When a detected gradient shift is simultaneously
accompanied by a ≥ 20% increase in 5-min mean speed relative to the prior
15-min mean, `gradientShift.speedCorrelated` fires — the classic signature of
a squall line or frontal passage ("looks like a cyclic shift but bigger, with
more wind").

**Regime classification** (`regime` path): combines oscillation quality
(`certainty`) with gradient strength to report "oscillating", "drifting",
"mixed" (oscillations riding a drifting mean — the tactically hardest case),
or "unknown". Multi-station `stationConsensus` (fraction of active ViVa
stations agreeing on gradient direction) distinguishes synoptic events from
local terrain effects.

### Multi-station tracking

With [signalk-viva](https://github.com/theseal666/signalk-viva-plugin)
installed and **Track ViVa stations** set to N, the plugin runs an
independent analyzer for each of the N nearest stations, in parallel with
the boat. Stations self-discover from whatever viva publishes (no path
configuration) and are re-ranked by distance every poll, so the active set
follows the boat if it moves mid-race. Station results publish under
`environment.observations.viva.<station>.windshift.*`; the boat stays on
`environment.wind.windshift.*`.

### Dashboard

The built-in webapp shows a tactical metrics bar (average wind speed / gust,
TWD, delta, trend, cycle, next-shift countdown, certainty gauge) over a
"waterfall" chart of raw TWD, smoothed TWD, the min/max envelope, and wind
speed + gust on a right-side knots axis. A **Source** dropdown switches
between the boat and the tracked stations — every source is analyzed
continuously in the background, so switching is instant: the chart seeds from
server-side history and the metrics bar fills from the latest snapshot.
Station views overlay the boat's smoothed TWD as a purple reference line, so
a station and the boat can be compared directly on one chart. Cursor readouts
are in compass degrees (direction) or knots (speed), and "minutes ago" on the
time axis. **Drag** the chart to zoom in on a time window; **double-click**
or press the "Reset zoom" button to return to the full view.

**Time window buttons** (30m / 1h / 3h / 6h / 24h) let you zoom the x-axis
to any historical window. The plugin keeps 24 h of metrics history on disk, so
right after a page load you can step back a full day; as live data accumulates
the older history gradually rolls off (a page reload restores it).

**Shift overlay** (Last 2 / 3 / 5) replaces the waterfall with a comparison
chart: each of the last N detected shift half-cycles is plotted on a common
0–100% time axis, with Δ° from the shift start on the y-axis. The most recent
shift is drawn bright green, older ones in progressively dimmer shades. This
makes it easy to see whether the current shift is tracking the same shape and
amplitude as the last few — useful for building confidence before committing
to a tack. Click **Off** to return to the normal waterfall.

**Gradient metrics** in the header: a **Drift** readout shows the 1-hour
gradient rate as `↗ 8.1°/h` (veering) or `↘ 5.3°/h` (backing), coloured
white when negligible, orange above 3°/h, and green/red above 5°/h. A
**Regime** badge shows "Oscillating", "Drifting", or "Mixed" with a station
consensus percentage when multiple stations are active.

When a rapid gradient shift is detected, a **pulsing red alert banner** appears
below the controls bar: `⚠ GRADIENT SHIFT: 18° veering + wind increase`.
It clears automatically when the shift settles (gap back below 5°).

The "Avg Wind" header value is a 2-minute rolling average of received wind
speed samples, smoothing out short-term noise. Gust is the instrument's own
reported gust value — for ViVa shore stations this maps to *Byvind*; for the
boat it requires a gust sensor mapped to `environment.wind.gust` in the
instrument configuration.

## Current state (September 2026)

**Branches:** `feature/multi-station` and `feature/gradient-detection` have
been merged into `main` — `main` is now the single active branch and carries
every feature described in this README (multi-station tracking, gradient
detection, the full dashboard). The two feature branches have been deleted
on GitHub; there is nothing on them that isn't already in `main`.

Note: the multi-station → main merge went ahead of the original soak-test
gate described in `PLAN.md` (waiting for a real frontal passage to validate
the rapid-shift/speed-correlation triggers) — that validation is still
outstanding, see "Known limitations" below.

**Recent fix (September 2026):** the dashboard could grow taller than one
screen when the gradient-shift warning banner appeared, because the flex
layout wasn't allowed to shrink the chart area to make room. Fixed by giving
the chart container `min-height: 0` and pinning the header/controls-bar/alert
banner heights — the warning banner no longer pushes the app past a full
screen. No functional change, `public/style.css` only.

**Live soak test:** the plugin runs 24/7 on a Raspberry Pi (KarukeraPi),
analyzing the Vinga lighthouse TWD as the "boat" source plus the five nearest
ViVa stations on the Bohuslän coast. Cycle detection locks in within ~1 h on
oscillating days; certainty correctly stays low in messy morning gradient.
The gradient detector is accumulating real-world data — **still waiting for
a frontal passage** to validate the rapid-shift and speed-correlation
triggers in live conditions (validated so far only against synthetic test
scenarios in `test-verify.js`).

**Persistence:** 24 h metrics history per source, saved every 5 min and on
shutdown, restored on startup. The waterfall chart survives server restarts.
Analyzer state (cycles, calibration, gradient history) rebuilds from live
data within ~30 min.

**Known limitations:**
- Cycle metrics need a few completed ≥4° swings — expect zeros for the
  first ~30 min after a restart or in very light, steady air.
- The grey "Raw" line only draws when the source publishes raw TWD in real
  time (stations do; the boat does when instruments are live).
- Gradient thresholds (10° rapid-shift, 20% speed spike) are hard-coded
  — they will become config options once real-world data shows tuning needs.
- The gradient/rapid-shift detector has not yet been validated against a
  real frontal passage on the water (see "Live soak test" above) — treat its
  output with some caution until that happens.
- Not yet published to npm (install from GitHub, see below).

**Roadmap:** see [PLAN.md](PLAN.md) for the full milestone history and
upcoming work (upwind early warning, npm publish, forecast overlay).

## Screenshots

### Dashboard with multi-station dropdown
![Waterfall with dropdown](IMG/waterfall%20with%20dropdown.jpeg)
*Flipping between the boat and five ViVa stations (distances shown). Each
source keeps its own analysis, history and metrics.*

### Metrics bar in action
![Dashboard](IMG/webb-app.png)
*A detected 3.5-minute cycle with the next shift predicted in 44 seconds,
during a 68° spread — the certainty gauge stays humble about it.*

### Plugin configuration
![Plugin settings](IMG/plugin%20settings_new.png)
*Current settings during the soak test: shore-station source path, maneuvers
ignored (boat swings at the mooring), five stations tracked. The status line
at the top shows live per-source analysis point counts.*

### Historical analysis in Grafana
![Overview](IMG/Overview.png)
*Long-term view: raw data (green) inside the emitted min/max envelope
(blue/orange).*

## SignalK Paths

All paths are emitted for the boat and (where applicable) for each active
ViVa station. Boat prefix: `environment.wind.windshift.*`. Station prefix:
`environment.observations.viva.<slug>.windshift.*`.

### Cyclic shift (oscillation)

| Path | Description | Unit |
| :--- | :--- | :--- |
| `…windshift.avg` | Smoothed (averaged) True Wind Direction | rad |
| `…windshift.min` | Minimum TWD in the tracking period | rad |
| `…windshift.max` | Maximum TWD in the tracking period | rad |
| `…windshift.delta` | Cyclic shift amplitude (max − min) | rad |
| `…windshift.cyclePeriod` | Average time between wind shifts (full cycle) | s |
| `…windshift.timeToNextShift` | Estimated time to next predicted shift | s |
| `…windshift.certainty` | Oscillation confidence score (0.0–1.0) | - |
| `…windshift.trend` | Short-term direction: 1 veering, −1 backing, 0 steady | - |
| `…windshift.calibrationOffset` | Half the port/starboard tack asymmetry | rad |
| `…windshift.isSettled` | 1 if boat is settled, 0 during tack lockout | - |

### Gradient / persistent shift

| Path | Description | Unit |
| :--- | :--- | :--- |
| `…windshift.gradientRate` | Rate of change of mean TWD over last 1 h (+ veering) | rad/s |
| `…windshift.meanDrift1h` | Net circular drift of mean TWD over last 1 h | rad |
| `…windshift.regime` | 0 unknown, 1 oscillating, 2 drifting, 3 mixed | - |
| `…windshift.gradientShift.detected` | 1 when a sudden persistent shift ≥ 10° is active | - |
| `…windshift.gradientShift.degrees` | Magnitude and sign of the detected shift (+ veering) | rad |
| `…windshift.gradientShift.speedCorrelated` | 1 when a ≥ 20% speed increase accompanies the shift | - |

Note: `min`, `max`, and `meanDrift1h` are kept continuous through the 0°/360°
boundary so charting tools can draw them without wrap artifacts.

## Configuration

- **TWD Buffer Time**: How long to average TWD to smooth out noise (seconds).
- **Min/Max Calculation Time**: The window of time to keep data for calculating spread (minutes).
- **Shift Detection Threshold**: How far the wind must swing back before an extreme counts as a shift (degrees, default 4).
- **Dynamic Window**: Auto-tune tracking period based on detected cycle.
- **Auto-Calibrate**: Detect and correct for tack-induced errors by comparing Port vs Starboard means.
- **Tack Lockout Time**: Seconds to ignore data after a maneuver (default 60s).
- **TWD Source Path**: Which SignalK path to analyze (default `environment.wind.directionTrue`).
- **Ignore Maneuvers**: Skip heading/AWA tack detection entirely.
- **Track ViVa Stations**: Number of nearest shore stations to analyze in parallel (0 = off).

## Testing against a shore station

For soak testing without going sailing, point the "boat" analysis at a
nearby weather station instead of the masthead:

- **TWD Source Path**: `environment.observations.viva.vinga.wind.directionTrue`
- **Ignore Maneuvers**: on — otherwise the boat swinging at the mooring with
  wind and current keeps triggering the maneuver lockout, even though the
  station's TWD is unaffected by what the hull is doing.

Station data arrives at polling rate (30–60 s), so expect one analyzed point
every minute or two: coarse but plenty for verifying cycle detection,
prediction and long-run stability over days.

## HTTP endpoints

Served by the plugin (require a logged-in session):

- `/plugins/windshift/sources` — available sources for the dashboard dropdown
- `/plugins/windshift/history?source=<id>` — 24 h metrics history per source
- `/plugins/windshift/latest?source=<id>` — latest metrics snapshot per source,
  including `peaks` and `troughs` arrays (ms timestamps of detected shift extremes)
  used by the shift overlay

## Installation

`main` now carries every feature (multi-station tracking + gradient
detection) and is what's currently running on the Pi:

```bash
cd ~/.signalk
npm install "https://github.com/theseal666/signalk-windshift.git"
sudo systemctl restart signalk
```

## Accessing the Dashboard

Once the plugin is installed and started:
`http://<your-signalk-ip>/@jwallinder/windshift`

---
*Experimental and under active development — running a live 24/7 soak test
against Swedish west coast weather stations (Vinga + 5 ViVa stations).
See [PLAN.md](PLAN.md) for the full development history and roadmap.*
