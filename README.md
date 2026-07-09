# signalk-windshift

SignalK plugin to analyze wind shifts and detect cyclic oscillations in True Wind Direction (TWD).

## Features

- **TWD Averaging**: Smooths raw wind data to identify trends.
- **Min/Max Tracking**: Tracks the spread of wind shifts over a configurable period.
- **Cycle Detection**: Detects peaks and troughs with a noise threshold to identify oscillating wind patterns.
- **Predictive Metrics**: Calculates average cycle period and estimates the time to the next shift.
- **Certainty Score**: Provides a confidence indicator based on the regularity of the detected cycles.
- **Dynamic Window (Auto-Tune)**: Automatically adjusts the tracking window to match detected wind cycles for more accurate spread calculations.
- **Tack-Aware Filtering**: Detects tacks/gybes and ignores wind data during maneuvers to prevent "chasing your own tacks" due to sensor noise or boat deceleration.
- **Auto-Calibration**: Compares the mean TWD between Port and Starboard tacks to automatically identify and correct for sensor misalignment or boat-induced errors.
- **Web Dashboard**: Built-in real-time visualization with tactical metrics and a "waterfall" time-series chart.
- **Multi-Station Tracking**: Optionally analyzes the N nearest ViVa shore stations in parallel with the boat, with a dashboard dropdown to switch between sources.

## How it works

### Smoothing

Raw TWD samples are collected into a short buffer (default 10 s) and reduced to
one averaged data point. The average is a proper *circular* mean (averaging the
sin/cos components), so a wind oscillating around north does not produce
nonsense values. These averaged points form the time series that everything
else is computed from.

### Shift detection (zigzag with threshold)

The averaged TWD is first *unwrapped* into a continuous series (no 0°/360°
jumps) and then run through a zigzag detector: while the wind is veering, the
running maximum is tracked as a candidate peak; only when the wind has come
**back** by at least the shift threshold (default 4°) is that candidate
confirmed as a real peak, and the detector flips to tracking a trough. Wiggles
smaller than the threshold never register, which keeps sensor noise from
flooding the cycle statistics. Confirmed peaks/troughs are timestamped at the
actual extreme, not at the moment of confirmation.

### Cycle period, certainty and prediction

The cycle period is the average interval between consecutive peaks and between
consecutive troughs (a full oscillation). Certainty is derived from how regular
those intervals are: tight spacing gives a score near 1.0, chaotic spacing
falls toward 0. Because peaks and troughs alternate, the next extreme is
expected about **half a cycle** after the last one — `timeToNextShift` counts
down from there and is recomputed on every emitted update. Old extremes expire
(3× the tracking window) so a shift from an hour ago cannot skew the estimate.

### Tack awareness

Two triggers mark the boat as "not settled" and pause data collection for the
lockout period: a heading change of more than ~11°, and the apparent wind angle
crossing from one side to the other. AWA samples very close to head-to-wind
(±3°) or dead downwind (beyond ±165°) are ignored for tack detection, since the
sign of AWA is pure noise there. (If you are sailing gennaker angles you should
never be past ~155° anyway — and if you are, you have other issues.)

### Auto-calibration

If the wind sensor is misaligned, the measured TWD on port and starboard tack
will differ systematically. The plugin keeps the recent averaged TWD readings
per tack (raw, uncorrected values, so the correction never feeds back into its
own estimate), takes the circular mean of each side, and computes half the
difference. The correction is then applied **per tack** — starboard readings
shifted one way, port readings the other — pulling both toward the common mean.
A single global offset could never fix a port/starboard asymmetry. The
correction is applied to the whole tracking window on the fly, so min/max/avg
stay consistent when the offset estimate drifts.

Note: if you tack *on* the shifts, part of the genuine oscillation shows up as
a port/starboard difference and will be partially calibrated away. Leave
Auto-Calibrate off unless you suspect sensor misalignment.

## Visuals

### Dashboard Overview
The plugin includes a web dashboard providing a tactical view of the wind.
- **Top Bar**: Real-time metrics for TWD, Delta (spread), Trend (Veering/Backing), Cycle Period, and Next Shift countdown.
- **Waterfall Chart**: Visualizes Raw TWD, Smoothed TWD, and the Min/Max bounds.

### Historical Analysis in Grafana
![Overview](https://github.com/theseal666/signalk-windshift/blob/main/IMG/Overview.png?raw=true)
*The green line is raw data, blue/orange lines represent the environment.wind.windshift.max/min spread.*

## SignalK Paths

The plugin emits the following paths:

| Path | Description | Unit |
| :--- | :--- | :--- |
| `environment.wind.windshift.avg` | Smoothed True Wind Direction | rad |
| `environment.wind.windshift.min` | Minimum TWD in the tracking period | rad |
| `environment.wind.windshift.max` | Maximum TWD in the tracking period | rad |
| `environment.wind.windshift.delta` | Spread between max and min | rad |
| `environment.wind.windshift.cyclePeriod` | Average time between wind shifts (full cycle) | s |
| `environment.wind.windshift.timeToNextShift` | Estimated time to next predicted shift | s |
| `environment.wind.windshift.certainty` | Confidence score (0.0 - 1.0) | - |
| `environment.wind.windshift.trend` | 1 (Veering), -1 (Backing), 0 (Steady) | - |
| `environment.wind.windshift.calibrationOffset` | Half the measured port/starboard difference | rad |
| `environment.wind.windshift.isSettled` | 1 if boat is settled, 0 during tack lockout | - |

Note: `min` and `max` are kept continuous with the tracking window (they may
fall slightly outside 0–2π when the wind straddles north) so that charting
tools can draw them without wrap artifacts.

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

## Multi-station tracking

With [signalk-viva](https://github.com/theseal666/signalk-viva-plugin) installed
and **Track ViVa Stations** set to N, the plugin runs an independent analyzer
for each of the N nearest stations, in parallel with the boat's own analysis.
Stations are discovered automatically from whatever viva publishes — no path
configuration — and ranked by the `distance` viva reports each poll, so the
active set follows the boat if it moves. Station results are published under
`environment.observations.viva.<station>.windshift.*`; the boat stays on
`environment.wind.windshift.*` as before.

The dashboard gets a **Source** dropdown (boat + active stations with their
distance). All sources are analyzed continuously in the background — switching
only changes what is displayed, and each source's chart is seeded from its own
server-side history. For pre-race preparation: start the plugin a day early,
and by start time each station around the course shows its own spread, cycle
period and trend.

Plugin HTTP endpoints (require a logged-in session):
- `/plugins/windshift/sources` — available sources for the dropdown
- `/plugins/windshift/history?source=<id>` — metrics history per source

## Testing against a shore station

For soak testing without going sailing, the plugin can analyze the TWD of a
nearby weather station instead of the masthead — for example a Sjöfartsverket
ViVa station published by
[signalk-viva](https://github.com/theseal666/signalk-viva-plugin):

- **TWD Source Path**: `environment.observations.viva.vinga.wind.directionTrue`
- **Ignore Maneuvers**: on — otherwise the boat swinging at the mooring with
  wind and current would keep triggering the maneuver lockout, even though the
  station's TWD is unaffected by what the hull is doing.

Station data arrives at polling rate (typically once a minute), so expect one
analyzed point every couple of minutes: coarse but plenty for verifying cycle
detection, prediction and long-run stability over a few days. Note that the
dashboard's "Raw" chart line always follows `environment.wind.directionTrue`,
so during station testing only the Average/Min/Max lines will draw.

## Accessing the Dashboard

Once the plugin is installed and started, you can access the dashboard at:
`http://<your-signalk-ip>:3000/@jwallinder/windshift`

---
*Still experimental and under development.*
