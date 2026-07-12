const DEFAULT_AVG_BUFFER = 10; //seconds
const DEFAULT_MIN_MAX_BUFFER = 20; //mins
const DEFAULT_SHIFT_THRESHOLD = (4 * Math.PI) / 180;

// The sign of AWA is meaningless right at head-to-wind and dead downwind,
// where noise makes it flip constantly. Samples inside these dead-bands are
// ignored for tack detection so only real crossings count.
const AWA_HEAD_TO_WIND_DEADBAND = 0.05; // ~3 degrees
const AWA_DEAD_DOWNWIND_DEADBAND = Math.PI - 0.26; // ignore beyond ~165 degrees

// Rolling history of emitted metrics so the dashboard can seed its chart
// after a page reload instead of starting empty
const HISTORY_MAX_AGE_S = 24 * 3600;

const twdMapper = (datapoint) => datapoint[1];

function normalize(diff) {
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

function normalize2pi(angle) {
  return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function circularMean(angles) {
  const east = angles.reduce((a, v) => a + Math.sin(v), 0) / angles.length;
  const north = angles.reduce((a, v) => a + Math.cos(v), 0) / angles.length;
  return Math.atan2(east, north);
}

// Factory: each call returns an independent analyzer instance, so the plugin
// can analyze the boat's TWD and any number of shore stations concurrently.
function createAnalyzer() {
  var buffer = [];
  var data = []; // { t, v, tack } — v is the raw (uncalibrated) averaged TWD in [0, 2PI)
  var peaks = [];
  var troughs = [];
  var cyclePeriod = 0;
  var certainty = 0;
  var timeToNextShift = 0;
  var trend = 0;
  var last_corrected_twd = null;
  var unwrappedTWD = null;
  var metricsHistory = [];
  var lastMetrics = null;

  // Gradient (persistent) shift detection state
  var gradientRate   = 0;   // deg/hr from 1-h regression (+ = veering)
  var gradientRate3h = 0;   // deg/hr from 3-h regression
  var meanDrift1h    = 0;   // net circular drift over last hour, degrees
  var regime         = "unknown"; // "oscillating" | "drifting" | "mixed" | "unknown"

  // Oscillation tactics state — the numbers an oscillating-shift strategy
  // actually runs on: the mean wind (reference line), how far the wind is
  // currently displaced from it, how big a full swing is, and which tack
  // that displacement lifts (veer = TWD right of mean = starboard lifted).
  var oscillationMean = null; // rad, wrapped [0, 2π) — de-oscillated mean TWD
  var oscillationOffsetDeg = 0; // current TWD minus mean, degrees (+ = veered)
  var oscillationAmplitudeDeg = 0; // half of the average peak-to-trough swing
  var liftedTack = 0; // 1 = starboard lifted, -1 = port lifted, 0 = neutral/unknown

  // Rapid gradient shift detector: compares last 5-min mean to prior 5–25-min mean
  var gradientDetected = false; // true when a sudden persistent shift is active
  var rapidShiftDeg    = 0;    // magnitude and sign of the detected shift (degrees)
  var speedCorrelated  = false; // true when a ≥20% speed increase accompanies the shift

  // Rolling speed history fed by appendWindSpeed(); kept 30 min
  var speedHistory = []; // { t: ms, v: m/s }

  // Zigzag shift detector state
  var swingDir = 0; // 1 = veering, -1 = backing, 0 = not yet determined
  var candVal = null; // running extreme of the current swing (unwrapped)
  var candTime = null;

  // Tack & Calibration State
  var currentTack = null; // 'port' or 'starboard'
  var lastHeading = null;
  var isSettled = true;
  var lockoutTimer = null;
  var tackLockout_s = 60;
  var autoCalibrate = false;
  var dynamic_window = false;

  // Means for each tack (raw, uncalibrated values)
  var starboardMeans = [];
  var portMeans = [];
  var calibrationOffset = 0; // half the port/starboard difference, radians

  let buffer_timeout_s = DEFAULT_AVG_BUFFER;
  let timeseries_timeout_s = DEFAULT_MIN_MAX_BUFFER * 60;
  let shiftThreshold = DEFAULT_SHIFT_THRESHOLD;

  var debuglogger;

  const debug = (msg) => {
    if (debuglogger) debuglogger(msg);
  };

  // Calibration is applied per tack: a constant global offset cannot reduce a
  // port/starboard asymmetry, so instead both tacks are pulled toward their
  // common mean.
  function correctionFor(tack) {
    if (!autoCalibrate || !tack) return 0;
    return tack === "starboard" ? calibrationOffset : -calibrationOffset;
  }

  function startLockout(reason) {
    debug(reason + ", locking wind data for " + tackLockout_s + "s");
    isSettled = false;
    if (lockoutTimer) clearTimeout(lockoutTimer);
    lockoutTimer = setTimeout(() => {
      isSettled = true;
      debug("Boat settled, resuming wind data collection");
    }, tackLockout_s * 1000);
  }

  function calculateCycle() {
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push((peaks[i].time - peaks[i - 1].time) / 1000);
    }
    for (let i = 1; i < troughs.length; i++) {
      intervals.push((troughs[i].time - troughs[i - 1].time) / 1000);
    }

    if (intervals.length < 2) {
      certainty = 0;
      return;
    }

    const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
    const variance = intervals.reduce((a, b) => a + Math.pow(b - avgInterval, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);

    cyclePeriod = avgInterval;
    certainty = Math.max(0, 1 - (stdDev / (avgInterval / 2)));

    if (dynamic_window && certainty > 0.7) {
      timeseries_timeout_s = avgInterval * 1.5;
    }
  }

  function updatePrediction(now) {
    const lastShiftTime = Math.max(
      peaks.length > 0 ? peaks[peaks.length - 1].time : 0,
      troughs.length > 0 ? troughs[troughs.length - 1].time : 0
    );

    if (cyclePeriod <= 0 || lastShiftTime === 0) {
      timeToNextShift = 0;
      return;
    }

    // Peaks and troughs alternate, so the next extreme is expected about half
    // a full cycle after the last one
    const timeSinceLastShift = (now - lastShiftTime) / 1000;
    timeToNextShift = Math.max(0, cyclePeriod / 2 - timeSinceLastShift);
  }

  function pruneShiftHistory(now) {
    const maxAge_ms = timeseries_timeout_s * 3 * 1000;
    peaks = peaks.filter((p) => now - p.time < maxAge_ms);
    troughs = troughs.filter((p) => now - p.time < maxAge_ms);
  }

  // Re-unwrap a metricsHistory slice into { t, y } with y in degrees on a
  // continuous scale (metricsHistory stores wrapped [0, 2π) averages).
  function unwrapDeg(points) {
    if (points.length === 0) return [];
    const out = [{ t: points[0].t, y: points[0].avg * 180 / Math.PI }];
    for (let i = 1; i < points.length; i++) {
      const diff = normalize(points[i].avg - points[i - 1].avg) * 180 / Math.PI;
      out.push({ t: points[i].t, y: out[i - 1].y + diff });
    }
    return out;
  }

  // Trailing boxcar mean over `periodMs`. Averaging over exactly one full
  // oscillation period integrates the oscillation to ~zero regardless of
  // phase, while leaving any linear drift untouched. A plain least-squares
  // fit does NOT have this property: the slope of a raw sine over even a
  // whole number of periods is biased by up to ~3·amplitude/π² per period.
  function boxcarSmooth(series, periodMs) {
    const out = [];
    let j = 0;
    for (let i = 0; i < series.length; i++) {
      while (series[j].t < series[i].t - periodMs) j++;
      // Only emit points whose trailing window is (nearly) fully populated
      if (i > j && series[i].t - series[j].t >= 0.85 * periodMs) {
        let sum = 0;
        for (let k = j; k <= i; k++) sum += series[k].y;
        out.push({ t: series[i].t, y: sum / (i - j + 1) });
      }
    }
    return out;
  }

  // Least-squares slope of an { t, y } series in deg/hr, or null if too short.
  function lsSlopeDegPerHr(series) {
    const n = series.length;
    if (n < 3) return null;
    const t0 = series[0].t;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      sx += (series[i].t - t0) / 3600000;
      sy += series[i].y;
    }
    const mx = sx / n, my = sy / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const x = (series[i].t - t0) / 3600000 - mx;
      num += x * (series[i].y - my);
      den += x * x;
    }
    return den < 1e-9 ? null : num / den; // deg/hr
  }

  // De-oscillated series for gradient work: smooth over one detected cycle
  // when a credible cycle exists (so oscillations don't masquerade as drift),
  // otherwise over 5 min just to suppress sample noise.
  function gradientSeries(points, windowMs) {
    const smoothMs =
      certainty > 0.5 && cyclePeriod > 300 && cyclePeriod * 1000 < windowMs / 2
        ? cyclePeriod * 1000
        : 5 * 60 * 1000;
    return boxcarSmooth(unwrapDeg(points), smoothMs);
  }

  function computeGradientMetrics(now) {
    const win1h = 3600 * 1000;
    const win3h = 3 * 3600 * 1000;

    const s1series = gradientSeries(metricsHistory.filter((p) => p.t >= now - win1h), win1h);
    const s3series = gradientSeries(metricsHistory.filter((p) => p.t >= now - win3h), win3h);

    const s1 = lsSlopeDegPerHr(s1series);
    const s3 = lsSlopeDegPerHr(s3series);
    gradientRate   = s1 != null ? s1 : 0;
    gradientRate3h = s3 != null ? s3 : 0;

    // The last point of the de-oscillated series IS the current mean wind —
    // the reference line an oscillating-shift strategy is sailed against.
    oscillationMean = s1series.length
      ? normalize2pi(s1series[s1series.length - 1].y * Math.PI / 180)
      : null;

    // Net drift over the last hour: difference of the de-oscillated series
    // endpoints. Each endpoint is a full-cycle (or 5-min) mean, so neither
    // sample noise nor oscillation phase can masquerade as drift.
    meanDrift1h = s1series.length >= 2
      ? s1series[s1series.length - 1].y - s1series[0].y
      : 0;

    // Regime: combine oscillation quality with gradient strength.
    // A gradient shift is flagged when the 1-h slope exceeds 5 °/hr OR the
    // net 1-h drift exceeds 8° (a front can clock the wind faster than the
    // slope alone would suggest).
    const isDrifting    = Math.abs(gradientRate) > 5 || Math.abs(meanDrift1h) > 8;
    const isOscillating = certainty > 0.5 && cyclePeriod > 0;

    if (isOscillating && isDrifting) regime = "mixed";
    else if (isOscillating)          regime = "oscillating";
    else if (isDrifting)             regime = "drifting";
    else                             regime = "unknown";
  }

  // Offset from the mean wind, swing amplitude, and which tack is lifted.
  // Veer (TWD right of mean) lifts starboard: on starboard tack the wind
  // rotating clockwise moves away from the bow, letting the boat head up;
  // the mirror holds for port. Neutral inside a ±2° deadband.
  const LIFT_DEADBAND_DEG = 2;

  function computeOscillationMetrics(currentTwdRad) {
    if (oscillationMean == null) {
      oscillationOffsetDeg = 0;
      oscillationAmplitudeDeg = 0;
      liftedTack = 0;
      return;
    }
    oscillationOffsetDeg =
      normalize(currentTwdRad - oscillationMean) * 180 / Math.PI;

    // Amplitude: half the average swing between consecutive extremes.
    // Peaks/troughs store unwrapped values, so plain differences are safe.
    const extremes = peaks
      .map((p) => ({ t: p.time, v: p.value }))
      .concat(troughs.map((p) => ({ t: p.time, v: p.value })))
      .sort((a, b) => a.t - b.t);
    if (extremes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < extremes.length; i++) {
        sum += Math.abs(extremes[i].v - extremes[i - 1].v);
      }
      oscillationAmplitudeDeg =
        (sum / (extremes.length - 1)) / 2 * 180 / Math.PI;
    } else {
      oscillationAmplitudeDeg = 0;
    }

    const oscillating = certainty > 0.5 && cyclePeriod > 0;
    if (!oscillating || Math.abs(oscillationOffsetDeg) < LIFT_DEADBAND_DEG) {
      liftedTack = 0;
    } else {
      liftedTack = oscillationOffsetDeg > 0 ? 1 : -1;
    }
  }

  // Rapid gradient shift: compare circular mean of last 5 min ("recent") against
  // the prior 5–25 min ("baseline"). A sustained divergence ≥ RAPID_SHIFT_DEG
  // that doesn't reverse is a gradient/frontal event, not a cyclic oscillation.
  // Hysteresis: once detected, require the gap to drop below half the threshold
  // before clearing, so a noisy edge doesn't flicker the flag.
  const RAPID_SHIFT_DEG = 10;

  function detectRapidShift(now) {
    // A slow oscillation dwells near its extremes for half a cycle, which a
    // fixed 5-min recent window mistakes for a persistent level change. When
    // a credible cycle exists, the divergence must persist for most of a
    // cycle before it can count as a gradient event — by definition an
    // oscillation would have swung back by then.
    let recentMs = 5 * 60 * 1000;
    if (certainty > 0.5 && cyclePeriod > 300) {
      recentMs = Math.max(recentMs, 0.75 * cyclePeriod * 1000);
    }
    const recentStart   = now - recentMs;
    const baselineStart = recentStart - 20 * 60 * 1000;

    const recentPts   = metricsHistory.filter((p) => p.t >= recentStart);
    const baselinePts = metricsHistory.filter((p) => p.t >= baselineStart && p.t < recentStart);

    if (recentPts.length < 2 || baselinePts.length < 2) {
      rapidShiftDeg    = 0;
      gradientDetected = false;
      return;
    }

    const recentMean   = circularMean(recentPts.map((p) => p.avg));
    const baselineMean = circularMean(baselinePts.map((p) => p.avg));
    const diff = normalize(recentMean - baselineMean) * 180 / Math.PI;

    rapidShiftDeg = diff;
    const abs = Math.abs(diff);

    if (!gradientDetected) {
      gradientDetected = abs >= RAPID_SHIFT_DEG;
    } else {
      // Hysteresis: clear only when gap drops below half the threshold
      gradientDetected = abs >= RAPID_SHIFT_DEG / 2;
    }
  }

  // Speed correlation: a ≥20% mean speed increase in the last 5 min versus the
  // prior 15 min is a strong additional indicator that the incoming event is a
  // squall or frontal shift rather than a thermal oscillation.
  function computeSpeedCorrelation(now) {
    const fiveMinAgo    = now - 5  * 60 * 1000;
    const twentyMinAgo  = now - 20 * 60 * 1000;

    const recent   = speedHistory.filter((p) => p.t >= fiveMinAgo);
    const baseline = speedHistory.filter((p) => p.t >= twentyMinAgo && p.t < fiveMinAgo);

    if (recent.length < 3 || baseline.length < 3) { speedCorrelated = false; return; }

    const avgRecent   = recent.reduce((a, p) => a + p.v, 0) / recent.length;
    const avgBaseline = baseline.reduce((a, p) => a + p.v, 0) / baseline.length;

    speedCorrelated = avgBaseline > 0.1 && avgRecent > avgBaseline * 1.2;
  }

  // Zigzag detector on the unwrapped TWD: an extreme only counts as a shift
  // once the wind has come back by at least shiftThreshold, so wiggles below
  // the threshold never register as peaks or troughs.
  function detectShifts(time, u) {
    if (candVal === null) {
      candVal = u;
      candTime = time;
      return;
    }

    if (swingDir === 0) {
      // First swing: pick a direction once the wind has moved far enough, but
      // don't record the starting point as an extreme — it probably isn't one
      if (u - candVal >= shiftThreshold) swingDir = 1;
      else if (candVal - u >= shiftThreshold) swingDir = -1;
      if (swingDir !== 0) {
        candVal = u;
        candTime = time;
      }
      return;
    }

    if (swingDir === 1) {
      if (u >= candVal) {
        candVal = u;
        candTime = time;
      } else if (candVal - u >= shiftThreshold) {
        peaks.push({ time: candTime, value: candVal });
        if (peaks.length > 5) peaks.shift();
        calculateCycle();
        swingDir = -1;
        candVal = u;
        candTime = time;
      }
    } else {
      if (u <= candVal) {
        candVal = u;
        candTime = time;
      } else if (u - candVal >= shiftThreshold) {
        troughs.push({ time: candTime, value: candVal });
        if (troughs.length > 5) troughs.shift();
        calculateCycle();
        swingDir = 1;
        candVal = u;
        candTime = time;
      }
    }
  }

  return {
    logger: (logger) => (debuglogger = logger),

    history: () => metricsHistory,

    latest: () => lastMetrics,

    shifts: () => ({
      peaks: peaks.map((p) => ({ time: p.time, value: p.value })),
      troughs: troughs.map((t) => ({ time: t.time, value: t.value })),
    }),

    // Called by index.js whenever a new wind speed reading arrives for this source.
    appendWindSpeed: (speed, timestamp) => {
      const t = Date.parse(timestamp) || Date.now();
      speedHistory.push({ t, v: speed });
      const cutoff = Date.now() - 30 * 60 * 1000;
      speedHistory = speedHistory.filter((p) => p.t > cutoff);
    },

    // Preload persisted history (e.g. from disk after a server restart)
    seedHistory: (points) => {
      if (!Array.isArray(points)) return;
      const cutoff = Date.now() - HISTORY_MAX_AGE_S * 1000;
      metricsHistory = points.filter(
        (p) => p && typeof p.t === "number" && p.t > cutoff
      );
    },

    config: (config) => {
      debug("incoming config: " + JSON.stringify(config));
      buffer_timeout_s = config.buffer_timeout_s || DEFAULT_AVG_BUFFER;
      timeseries_timeout_s = config.timeseries_timeout_s || DEFAULT_MIN_MAX_BUFFER * 60;
      autoCalibrate = config.auto_calibrate || false;
      tackLockout_s = config.tack_lockout_s || 60;
      dynamic_window = config.dynamic_window || false;
      shiftThreshold = config.shift_threshold_rad || DEFAULT_SHIFT_THRESHOLD;
    },

    reset: () => {
      buffer = [];
      data = [];
      peaks = [];
      troughs = [];
      cyclePeriod = 0;
      certainty = 0;
      timeToNextShift = 0;
      trend = 0;
      last_corrected_twd = null;
      unwrappedTWD = null;
      swingDir = 0;
      candVal = null;
      candTime = null;
      gradientRate = 0;
      gradientRate3h = 0;
      meanDrift1h = 0;
      regime = "unknown";
      gradientDetected = false;
      rapidShiftDeg = 0;
      speedCorrelated = false;
      oscillationMean = null;
      oscillationOffsetDeg = 0;
      oscillationAmplitudeDeg = 0;
      liftedTack = 0;
      speedHistory = [];
      currentTack = null;
      lastHeading = null;
      isSettled = true;
      if (lockoutTimer) {
        clearTimeout(lockoutTimer);
        lockoutTimer = null;
      }
      starboardMeans = [];
      portMeans = [];
      calibrationOffset = 0;
      metricsHistory = [];
      lastMetrics = null;
    },

    setHeading: (heading) => {
      if (lastHeading !== null) {
        const diff = Math.abs(normalize(heading - lastHeading));
        if (diff > 0.2) { // Roughly 11 degrees turn detected
          startLockout("Maneuver detected");
        }
      }
      lastHeading = heading;
    },

    setAWA: (awa) => {
      const absAwa = Math.abs(awa);
      if (absAwa < AWA_HEAD_TO_WIND_DEADBAND || absAwa > AWA_DEAD_DOWNWIND_DEADBAND) return;

      const newTack = awa > 0 ? "starboard" : "port";
      if (newTack === currentTack) return;

      const tackWasKnown = currentTack !== null;
      currentTack = newTack;

      // Learning the tack at startup is not a maneuver
      if (tackWasKnown) {
        startLockout(`Tack change detected: ${newTack}`);
      }
    },

    appendWindDirection: (twd, timestamp_in, update) => {
      if (!isSettled) return;

      const timestamp = Date.parse(timestamp_in) || Date.now();

      // The buffer holds raw TWD; calibration is applied downstream so the
      // calibration means never feed back into themselves
      buffer.push([timestamp, twd]);
      const timediff = timestamp - buffer[0][0];

      if (timediff <= buffer_timeout_s * 1000) return;

      const raw_avg_twd = normalize2pi(circularMean(buffer.map(twdMapper)));
      buffer = [];
      data.push({ t: timestamp, v: raw_avg_twd, tack: currentTack });

      // AUTO-CALIBRATION LOGIC
      if (autoCalibrate && currentTack) {
        if (currentTack === "starboard") {
          starboardMeans.push(raw_avg_twd);
          if (starboardMeans.length > 50) starboardMeans.shift();
        } else {
          portMeans.push(raw_avg_twd);
          if (portMeans.length > 50) portMeans.shift();
        }

        if (starboardMeans.length > 10 && portMeans.length > 10) {
          const sAvg = circularMean(starboardMeans);
          const pAvg = circularMean(portMeans);
          calibrationOffset = normalize(pAvg - sAvg) / 2; // Split the difference
        }
      }

      data = data.filter((dp) => timestamp - dp.t < timeseries_timeout_s * 1000);
      pruneShiftHistory(timestamp);

      // Correction is applied on the fly so the whole window stays consistent
      // when the calibration offset drifts
      const corrected = data.map((dp) => normalize2pi(dp.v + correctionFor(dp.tack)));
      const current = corrected[corrected.length - 1];

      if (last_corrected_twd === null) {
        unwrappedTWD = current;
      } else {
        unwrappedTWD += normalize(current - last_corrected_twd);
      }
      last_corrected_twd = current;

      detectShifts(timestamp, unwrappedTWD);
      // Trend = direction of the current confirmed swing. The zigzag detector
      // only flips direction after a reversal ≥ shiftThreshold, so this shows
      // which way the wind is actually going instead of flickering with every
      // sub-degree wiggle between consecutive 10-s samples.
      trend = swingDir;
      updatePrediction(timestamp);

      const offsetRef = corrected[0];
      const diff_array = corrected.map((v) => normalize(v - offsetRef));
      const min = offsetRef + Math.min(...diff_array);
      const max = offsetRef + Math.max(...diff_array);

      metricsHistory.push({ t: timestamp, avg: current, min, max });
      metricsHistory = metricsHistory.filter(
        (p) => timestamp - p.t < HISTORY_MAX_AGE_S * 1000
      );

      computeGradientMetrics(timestamp);
      computeOscillationMetrics(current);
      detectRapidShift(timestamp);
      computeSpeedCorrelation(timestamp);

      lastMetrics = {
        timestamp: timestamp_in,
        maxTWD: max,
        minTWD: min,
        avgTWD: current,
        delta: max - min,
        cyclePeriod,
        certainty,
        timeToNextShift,
        trend,
        calibrationOffset,
        isSettled,
        gradientRate,      // deg/hr
        gradientRate3h,    // deg/hr
        meanDrift1h,       // degrees
        regime,            // string
        gradientDetected,  // boolean
        rapidShiftDeg,     // degrees (+ veering, − backing)
        speedCorrelated,   // boolean
        oscillationMean,        // rad [0, 2π), or null
        oscillationOffsetDeg,   // degrees, + = veered side of mean
        oscillationAmplitudeDeg, // degrees (half of average full swing)
        liftedTack,             // 1 = starboard, -1 = port, 0 = neutral
      };

      if (update) {
        update(lastMetrics);
      }
    },
  };
}

module.exports = createAnalyzer;
