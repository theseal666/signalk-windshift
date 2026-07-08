# signalk-windshift

SignalK plugin to analyze wind shifts and detect cyclic oscillations in True Wind Direction (TWD).

## Features

- **TWD Averaging**: Smooths raw wind data to identify trends.
- **Min/Max Tracking**: Tracks the spread of wind shifts over a configurable period.
- **Cycle Detection**: Automatically detects peaks and troughs to identify oscillating wind patterns.
- **Predictive Metrics**: Calculates average cycle period and estimates the time to the next shift.
- **Certainty Score**: Provides a confidence indicator based on the regularity of the detected cycles.
- **Dynamic Window (Auto-Tune)**: Automatically adjusts the tracking window to match detected wind cycles for more accurate spread calculations.
- **Web Dashboard**: Built-in real-time visualization with tactical metrics and a "waterfall" time-series chart.

## Visuals

### Dashboard Overview
The plugin includes a web dashboard providing a tactical view of the wind.
- **Top Bar**: Real-time metrics for TWD, Delta (spread), Trend (Veering/Backing), Cycle Period, and Next Shift countdown.
- **Waterfall Chart**: Visualizes Raw TWD, Smoothed TWD, and the Min/Max bounds.

### Historical Analysis in Grafana
![Overview](https://github.com/theseal666/signalk-windshift/blob/main/IMG/Overview.png?raw=true)
*The green line is raw data, blue/orange lines represent the environment.wind.windshift.max/min spread.*

### Detecting Oscillations
![5 min oscillations 20° apart](https://github.com/theseal666/signalk-windshift/blob/main/IMG/what%20we%20want.png?raw=true)

## SignalK Paths

The plugin emits the following paths:

| Path | Description | Unit |
| :--- | :--- | :--- |
| `environment.wind.windshift.avg` | Smoothed True Wind Direction | rad |
| `environment.wind.windshift.min` | Minimum TWD in the tracking period | rad |
| `environment.wind.windshift.max` | Maximum TWD in the tracking period | rad |
| `environment.wind.windshift.delta` | Spread between max and min | rad |
| `environment.wind.windshift.cyclePeriod` | Average time between shifts | s |
| `environment.wind.windshift.timeToNextShift` | Estimated time to next predicted shift | s |
| `environment.wind.windshift.certainty` | Confidence score (0.0 - 1.0) | - |
| `environment.wind.windshift.trend` | 1 (Veering), -1 (Backing), 0 (Steady) | - |

## Configuration

You can adjust the following parameters in the plugin settings:
- **TWD Buffer Time**: How long to average TWD to smooth out noise (seconds).
- **Min/Max Calculation Time**: The window of time to keep data for calculating spread and detecting cycles (minutes).
- **Dynamic Window**: Enable auto-tuning. When the plugin detects a stable cycle (Confidence > 70%), it will automatically adjust the tracking window to 1.5x the cycle period. This ensures the Min/Max spread accurately reflects the true wind oscillation.

![Plugin conf settings](https://github.com/theseal666/signalk-windshift/blob/main/IMG/plugin%20config%20settings.png?raw=true)

## Accessing the Dashboard

Once the plugin is installed and started, you can access the dashboard at:
`http://<your-signalk-ip>:3000/@jwallinder/windshift`

---
*Still experimental and under development.*
