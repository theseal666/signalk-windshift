var buffer = [];
var data = [];
var peaks = [];
var troughs = [];
var cyclePeriod = 0;
var certainty = 0;
var timeToNextShift = 0;
var trend = 0;
var last_avg_twd = null;

// Tack & Calibration State
var currentTack = null; // 'port' or 'starboard'
var lastHeading = null;
var isSettled = true;
var lockoutTimer = null;
var tackLockout_s = 60;
var autoCalibrate = false;
var dynamic_window = false;

// Means for each tack
var starboardMeans = [];
var portMeans = [];
var calibrationOffset = 0; // The calculated correction in radians

const DEFAULT_AVG_BUFFER = 10; //seconds
let buffer_timeout_s = DEFAULT_AVG_BUFFER;

const DEFAULT_MIN_MAX_BUFFER = 20; //mins
let timeseries_timeout_s = DEFAULT_MIN_MAX_BUFFER * 60;
var debuglogger;

const debug = (msg) => {
  if (debuglogger) debuglogger(msg);
};

const twdMapper = (datapoint) => datapoint[1];

function normalize(diff) {
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
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

  const lastShiftTime = Math.max(
    peaks.length > 0 ? peaks[peaks.length - 1].time : 0,
    troughs.length > 0 ? troughs[troughs.length - 1].time : 0
  );

  if (lastShiftTime > 0) {
    const timeSinceLastShift = (Date.now() - lastShiftTime) / 1000;
    timeToNextShift = Math.max(0, cyclePeriod - timeSinceLastShift);
  }
}

function detectShifts() {
  if (data.length < 3) return;

  const p1 = data[data.length - 3][1];
  const p2 = data[data.length - 2][1];
  const p3 = data[data.length - 1][1];

  const offset = data[0][1];
  const n1 = normalize(p1 - offset);
  const n2 = normalize(p2 - offset);
  const n3 = normalize(p3 - offset);

  if (n2 > n1 && n2 > n3) {
    peaks.push({ time: data[data.length - 2][0], value: p2 });
    if (peaks.length > 5) peaks.shift();
    calculateCycle();
  } else if (n2 < n1 && n2 < n3) {
    troughs.push({ time: data[data.length - 2][0], value: p2 });
    if (troughs.length > 5) troughs.shift();
    calculateCycle();
  }
}

const windshiftAnalysis = {
  logger: (logger) => (debuglogger = logger),

  config: (config) => {
    debug("incoming config: " + JSON.stringify(config));
    buffer_timeout_s = config.buffer_timeout_s || DEFAULT_AVG_BUFFER;
    timeseries_timeout_s = config.timeseries_timeout_s || DEFAULT_MIN_MAX_BUFFER * 60;
    autoCalibrate = config.auto_calibrate || false;
    tackLockout_s = config.tack_lockout_s || 60;
    dynamic_window = config.dynamic_window || false;
  },

  setHeading: (heading) => {
    if (lastHeading !== null) {
      const diff = Math.abs(normalize(heading - lastHeading));
      if (diff > 0.2) { // Roughly 11 degrees turn detected
        debug("Maneuver detected, locking wind data");
        isSettled = false;
        if (lockoutTimer) clearTimeout(lockoutTimer);
        lockoutTimer = setTimeout(() => {
          isSettled = true;
          debug("Boat settled, resuming wind data collection");
        }, tackLockout_s * 1000);
      }
    }
    lastHeading = heading;
  },

  setAWA: (awa) => {
    const newTack = awa > 0 ? 'starboard' : 'port';
    if (newTack !== currentTack) {
      debug(`Tack change detected: ${newTack}`);
      currentTack = newTack;
      isSettled = false;
      if (lockoutTimer) clearTimeout(lockoutTimer);
      lockoutTimer = setTimeout(() => {
        isSettled = true;
        debug("Tack completed and settled");
      }, tackLockout_s * 1000);
    }
  },

  appendWindDirection: (twd, timestamp_in, update) => {
    if (!isSettled) return;

    const timestamp = Date.parse(timestamp_in) || Date.now();
    
    // APPLY CALIBRATION OFFSET
    const correctedTWD = normalize(twd + calibrationOffset);
    
    buffer.push([timestamp, correctedTWD]);
    const timediff = timestamp - buffer[0][0];

    if (timediff > buffer_timeout_s * 1000) {
      const u_east = buffer.map(twdMapper).map(Math.sin).reduce((a, b) => a + b) / buffer.length;
      const u_north = buffer.map(twdMapper).map(Math.cos).reduce((a, b) => a + b) / buffer.length;
      const avg_twd = normalize(Math.atan2(u_east, u_north));
      const normalized_avg_twd = (2 * Math.PI + avg_twd) % (2 * Math.PI);

      buffer = [];
      data.push([timestamp, normalized_avg_twd]);

      // AUTO-CALIBRATION LOGIC
      if (autoCalibrate && currentTack) {
        if (currentTack === 'starboard') {
          starboardMeans.push(normalized_avg_twd);
          if (starboardMeans.length > 50) starboardMeans.shift();
        } else {
          portMeans.push(normalized_avg_twd);
          if (portMeans.length > 50) portMeans.shift();
        }

        if (starboardMeans.length > 10 && portMeans.length > 10) {
          const sAvg = starboardMeans.reduce((a, b) => a + b) / starboardMeans.length;
          const pAvg = portMeans.reduce((a, b) => a + b) / portMeans.length;
          const diff = normalize(pAvg - sAvg);
          calibrationOffset = -diff / 2; // Split the difference
        }
      }

      const offset = data[0][1];
      const diff_array = data.map(twdMapper).map((twd) => normalize(twd - offset));
      const min = offset + Math.min(...diff_array);
      const max = offset + Math.max(...diff_array);

      detectShifts();

      if (last_avg_twd !== null) {
        const diff = normalize(normalized_avg_twd - last_avg_twd);
        if (Math.abs(diff) > 0.001) trend = diff > 0 ? 1 : -1;
        else trend = 0;
      }
      last_avg_twd = normalized_avg_twd;

      data = data.filter((dp) => timestamp - dp[0] < timeseries_timeout_s * 1000);

      if (update) {
        update({
          timestamp: timestamp_in,
          maxTWD: max,
          minTWD: min,
          avgTWD: normalized_avg_twd,
          delta: max - min,
          cyclePeriod,
          certainty,
          timeToNextShift,
          trend,
          calibrationOffset,
          isSettled
        });
      }
    }
  },
};

module.exports = windshiftAnalysis;
