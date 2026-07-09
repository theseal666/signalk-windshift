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
        const diff = normalize(current - last_corrected_twd);
        unwrappedTWD += diff;
        if (Math.abs(diff) > 0.001) trend = diff > 0 ? 1 : -1;
        else trend = 0;
      }
      last_corrected_twd = current;

      detectShifts(timestamp, unwrappedTWD);
      updatePrediction(timestamp);

      const offsetRef = corrected[0];
      const diff_array = corrected.map((v) => normalize(v - offsetRef));
      const min = offsetRef + Math.min(...diff_array);
      const max = offsetRef + Math.max(...diff_array);

      metricsHistory.push({ t: timestamp, avg: current, min, max });
      metricsHistory = metricsHistory.filter(
        (p) => timestamp - p.t < HISTORY_MAX_AGE_S * 1000
      );

      if (update) {
        update({
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
        });
      }
    },
  };
}

module.exports = createAnalyzer;
