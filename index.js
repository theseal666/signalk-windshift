const createAnalyzer = require("./windshiftAnalysis.js");
const fs = require("fs");
const path = require("path");
const os = require("os");

module.exports = function (app) {
  var plugin = {};

  plugin.id = "windshift";
  plugin.name = "Windshift";
  plugin.description = "Plugin to analyze the windshift";

  var unsubscribes = [];
  var boatAnalyzer = null;
  var stations = new Map(); // slug -> { analyzer, distance, active }
  var stationSettings = null;
  var maxStations = 0;
  var persistTimer = null;
  var persistedHistory = {};
  var boatTwdSourcePath = "environment.wind.directionTrue"; // kept for /sources
  var latestSourceSpeed = new Map(); // sourceId -> { speed, gust } in m/s

  const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

  function historyFilePath() {
    const dir =
      typeof app.getDataDirPath === "function"
        ? app.getDataDirPath()
        : path.join(os.homedir(), ".signalk");
    return path.join(dir, "windshift-history.json");
  }

  function loadPersistedHistory() {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyFilePath(), "utf8"));
      return parsed && parsed.sources ? parsed.sources : {};
    } catch (e) {
      return {}; // no file yet, or unreadable — start fresh
    }
  }

  // Written atomically (tmp + rename) so a crash mid-write can't corrupt
  // the previous good snapshot
  function persistHistory() {
    const sources = {};
    if (boatAnalyzer && boatAnalyzer.history().length) {
      sources.boat = boatAnalyzer.history();
    }
    for (const [slug, s] of stations) {
      if (s.analyzer.history().length) {
        sources[slug] = s.analyzer.history();
      }
    }
    try {
      const file = historyFilePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), sources }));
      fs.renameSync(tmp, file);
    } catch (e) {
      app.error("Failed to persist windshift history: " + e.message);
    }
  }

  const DEFAULT_AVG_BUFFER = 10; //seconds
  const DEFAULT_MIN_MAX_BUFFER = 20; //mins
  const DEFAULT_SHIFT_THRESHOLD_DEG = 4;

  const BOAT_PREFIX = "environment.wind.windshift.";
  const VIVA_RE = /^environment\.observations\.viva\.([^.]+)\.(wind\.directionTrue|distance)$/;
  const VIVA_SPEED_RE = /^environment\.observations\.viva\.([^.]+)\.wind\.(averageSpeed|gust)$/;

  const stationPrefix = (slug) => `environment.observations.viva.${slug}.windshift.`;

  const metaFor = (prefix) => [
    {
      path: prefix + "max",
      value: {
        units: "rad",
        description: "Windshift max angle calculated from the buffering period",
        displayName: "Windshift max angle",
        shortName: "Windshift max angle",
      },
    },
    {
      path: prefix + "avg",
      value: {
        units: "rad",
        description: "Averaged TWD",
        displayName: "Windshift average TWD",
        shortName: "Avg TWD",
      },
    },
    {
      path: prefix + "min",
      value: {
        units: "rad",
        description: "Windshift min angle calculated from the buffering period",
        displayName: "Windshift min angle",
        shortName: "Windshift min angle",
      },
    },
    {
      path: prefix + "delta",
      value: {
        units: "rad",
        description: "Spread between max and min wind angle",
        displayName: "Windshift delta",
        shortName: "Windshift delta",
      },
    },
    {
      path: prefix + "cyclePeriod",
      value: {
        units: "s",
        description: "Average time between wind shifts",
        displayName: "Windshift cycle period",
        shortName: "Cycle period",
      },
    },
    {
      path: prefix + "timeToNextShift",
      value: {
        units: "s",
        description: "Estimated time to the next wind shift",
        displayName: "Time to next shift",
        shortName: "Next shift",
      },
    },
    {
      path: prefix + "certainty",
      value: {
        units: "",
        description: "Confidence in the detected cycle",
        displayName: "Windshift certainty",
        shortName: "Certainty",
      },
    },
    {
      path: prefix + "trend",
      value: {
        units: "",
        description: "Current wind trend (1: veering, -1: backing, 0: steady)",
        displayName: "Wind trend",
        shortName: "Trend",
      },
    },
    {
      path: prefix + "calibrationOffset",
      value: {
        units: "rad",
        description: "Current calculated calibration correction (half the port/starboard difference)",
        displayName: "Windshift calibration offset",
        shortName: "Calibration",
      },
    },
    {
      path: prefix + "isSettled",
      value: {
        units: "",
        description: "1 if boat is settled, 0 during tack lockout",
        displayName: "Windshift settled",
        shortName: "Settled",
      },
    },
  ];

  var pointCounts = {}; // sourceId -> emitted analysis points

  // Live status in the admin UI so data flow is visible without log access
  function updateStatus() {
    const parts = [`boat: ${pointCounts.boat || 0}`];
    for (const [slug, s] of stations) {
      if (s.active) parts.push(`${slug}: ${pointCounts[slug] || 0}`);
    }
    app.setPluginStatus(`Analysis points — ${parts.join(" | ")}`);
  }

  function emitMetrics(sourceId, prefix, metrics) {
    pointCounts[sourceId] = (pointCounts[sourceId] || 0) + 1;
    updateStatus();

    // Tag the just-pushed history record with current speed/gust so that
    // both the /history endpoint and disk persistence carry wind data.
    const spd = latestSourceSpeed.get(sourceId);
    if (spd) {
      const analyzer = sourceId === "boat" ? boatAnalyzer : (stations.get(sourceId) || {}).analyzer;
      if (analyzer) {
        const hist = analyzer.history();
        if (hist.length > 0) {
          const last = hist[hist.length - 1];
          if (spd.speed != null) last.speed = spd.speed;
          if (spd.gust != null) last.gust = spd.gust;
        }
      }
    }

    app.handleMessage(plugin.id, {
      context: "vessels." + app.selfId,
      updates: [
        {
          timestamp: metrics.timestamp,
          values: [
            { path: prefix + "max", value: metrics.maxTWD },
            { path: prefix + "min", value: metrics.minTWD },
            { path: prefix + "avg", value: metrics.avgTWD },
            { path: prefix + "delta", value: metrics.delta },
            { path: prefix + "cyclePeriod", value: metrics.cyclePeriod },
            { path: prefix + "timeToNextShift", value: metrics.timeToNextShift },
            { path: prefix + "certainty", value: metrics.certainty },
            { path: prefix + "trend", value: metrics.trend },
            { path: prefix + "calibrationOffset", value: metrics.calibrationOffset },
            { path: prefix + "isSettled", value: metrics.isSettled ? 1 : 0 },
          ],
        },
      ],
    });
  }

  function getStation(slug) {
    if (!stations.has(slug)) {
      const analyzer = createAnalyzer();
      analyzer.logger((msg) => app.debug(`[${slug}] ${msg}`));
      analyzer.config(stationSettings);
      analyzer.seedHistory(persistedHistory[slug] || []);
      stations.set(slug, { analyzer, distance: null, active: false });
      app.debug(`Discovered ViVa station '${slug}' for windshift tracking`);
      app.handleMessage(plugin.id, { updates: [{ meta: metaFor(stationPrefix(slug)) }] });
    }
    return stations.get(slug);
  }

  // Keep only the N nearest stations analyzing; ranking updates whenever a
  // station's distance changes (the boat may move during a race)
  function updateActiveSet() {
    const ranked = [...stations.entries()]
      .filter(([, s]) => s.distance !== null)
      .sort((a, b) => a[1].distance - b[1].distance);
    ranked.forEach(([slug, s], i) => {
      const nowActive = i < maxStations;
      if (nowActive !== s.active) {
        s.active = nowActive;
        app.debug(
          `ViVa station '${slug}' windshift tracking ${nowActive ? "enabled" : "disabled"} (distance ${Math.round(s.distance)} m)`
        );
        if (!nowActive) s.analyzer.reset();
        updateStatus();
      }
    });
  }

  plugin.start = function (options, restartPlugin) {
    app.debug("Plugin Windshift started");
    app.debug("options:" + JSON.stringify(options));

    const buffer_timeout_s = options.twd_buffer_time || DEFAULT_AVG_BUFFER;
    const timeseries_timeout_s =
      (options.min_max_calc_time || DEFAULT_MIN_MAX_BUFFER) * 60;
    const shift_threshold_rad =
      ((options.shift_threshold_deg || DEFAULT_SHIFT_THRESHOLD_DEG) * Math.PI) / 180;
    const twdSourcePath =
      options.twd_source_path || "environment.wind.directionTrue";
    boatTwdSourcePath = twdSourcePath;
    const ignoreManeuvers = options.ignore_maneuvers || false;
    maxStations = options.track_viva_stations || 0;
    pointCounts = {};
    app.setPluginStatus("Waiting for wind data");

    boatAnalyzer = createAnalyzer();
    boatAnalyzer.logger(app.debug);
    boatAnalyzer.config({
      buffer_timeout_s,
      timeseries_timeout_s,
      dynamic_window: options.dynamic_window || false,
      auto_calibrate: options.auto_calibrate || false,
      tack_lockout_s: options.tack_lockout_s || 60,
      shift_threshold_rad,
    });

    persistedHistory = loadPersistedHistory();
    boatAnalyzer.seedHistory(persistedHistory.boat || []);
    const restored = Object.entries(persistedHistory)
      .map(([id, pts]) => `${id}: ${pts.length}`)
      .join(", ");
    if (restored) app.debug("Restored persisted history — " + restored);
    persistTimer = setInterval(persistHistory, PERSIST_INTERVAL_MS);

    // Shore stations don't tack, so no maneuver handling or calibration
    stationSettings = {
      buffer_timeout_s,
      timeseries_timeout_s,
      dynamic_window: options.dynamic_window || false,
      auto_calibrate: false,
      shift_threshold_rad,
    };

    app.handleMessage(plugin.id, { updates: [{ meta: metaFor(BOAT_PREFIX) }] });

    unsubscribes.push(
      app.streambundle
        .getSelfBus(twdSourcePath)
        .forEach((stream_value) => {
          const value = stream_value.value;
          if (typeof value !== "number" || isNaN(value)) return;

          boatAnalyzer.appendWindDirection(value, stream_value.timestamp, (metrics) =>
            emitMetrics("boat", BOAT_PREFIX, metrics)
          );
        })
    );

    // Track boat wind speed/gust; follows twdSourcePath so soak-test mode
    // (ViVa as TWD source) picks up the station's speed automatically
    const boatSpeedGust = speedGustPaths(twdSourcePath);
    [
      [boatSpeedGust.speedPath, "speed"],
      [boatSpeedGust.gustPath, "gust"],
    ].forEach(([p, kind]) => {
      unsubscribes.push(
        app.streambundle.getSelfBus(p).forEach((pv) => {
          if (typeof pv.value !== "number" || isNaN(pv.value)) return;
          const cur = latestSourceSpeed.get("boat") || {};
          latestSourceSpeed.set("boat", { ...cur, [kind]: pv.value });
        })
      );
    });

    if (!ignoreManeuvers) {
      unsubscribes.push(
        app.streambundle
          .getSelfBus("navigation.headingTrue")
          .forEach((stream_value) => {
            if (typeof stream_value.value === "number" && !isNaN(stream_value.value)) {
              boatAnalyzer.setHeading(stream_value.value);
            }
          })
      );

      unsubscribes.push(
        app.streambundle
          .getSelfBus("environment.wind.angleApparent")
          .forEach((stream_value) => {
            if (typeof stream_value.value === "number" && !isNaN(stream_value.value)) {
              boatAnalyzer.setAWA(stream_value.value);
            }
          })
      );
    }

    if (maxStations > 0) {
      // Stations self-discover from whatever the viva plugin publishes;
      // no path configuration needed
      unsubscribes.push(
        app.streambundle.getSelfBus().forEach((pathValue) => {
          // Track speed/gust for all ViVa slugs (for history persistence)
          const ms = VIVA_SPEED_RE.exec(pathValue.path);
          if (ms && typeof pathValue.value === "number" && !isNaN(pathValue.value)) {
            const spSlug = ms[1];
            const kind = ms[2] === "averageSpeed" ? "speed" : "gust";
            const cur = latestSourceSpeed.get(spSlug) || {};
            latestSourceSpeed.set(spSlug, { ...cur, [kind]: pathValue.value });
          }

          const m = VIVA_RE.exec(pathValue.path);
          if (!m) return;
          const slug = m[1];

          if (m[2] === "distance") {
            if (typeof pathValue.value === "number" && !isNaN(pathValue.value)) {
              getStation(slug).distance = pathValue.value;
              updateActiveSet();
            }
            return;
          }

          if (typeof pathValue.value !== "number" || isNaN(pathValue.value)) return;
          const station = getStation(slug);
          if (!station.active) return;
          station.analyzer.appendWindDirection(pathValue.value, pathValue.timestamp, (metrics) =>
            emitMetrics(slug, stationPrefix(slug), metrics)
          );
        })
      );
    }
  };

  // Derive speed/gust paths that match a given TWD source path.
  // If TWD comes from a ViVa station, use that same station's speed/gust.
  const VIVA_DIR_RE2 = /^environment\.observations\.viva\.([^.]+)\.wind\.directionTrue$/;
  function speedGustPaths(twdPath) {
    const m = VIVA_DIR_RE2.exec(twdPath);
    if (m) {
      return {
        speedPath: `environment.observations.viva.${m[1]}.wind.averageSpeed`,
        gustPath: `environment.observations.viva.${m[1]}.wind.gust`,
      };
    }
    return { speedPath: "environment.wind.speedTrue", gustPath: "environment.wind.gust" };
  }

  plugin.registerWithRouter = function (router) {
    // Sources for the dashboard dropdown: the boat plus active stations.
    // speedPath/gustPath let the dashboard subscribe to the right paths
    // even when the boat's TWD source is a shore station.
    router.get("/sources", (req, res) => {
      const boatPaths = speedGustPaths(boatTwdSourcePath);
      const sources = [{ id: "boat", label: "Boat", distance: null, ...boatPaths }];
      for (const [slug, s] of stations) {
        if (s.active) sources.push({
          id: slug, label: slug, distance: s.distance,
          speedPath: `environment.observations.viva.${slug}.wind.averageSpeed`,
          gustPath: `environment.observations.viva.${slug}.wind.gust`,
        });
      }
      res.json(sources);
    });

    // Latest metrics snapshot per source, so the dashboard can fill the
    // metrics bar immediately when switching sources instead of waiting
    // for the next live update
    router.get("/latest", (req, res) => {
      const src = req.query.source;
      const analyzer =
        !src || src === "boat"
          ? boatAnalyzer
          : (stations.get(src) || {}).analyzer;
      if (!analyzer) return res.json(null);
      const metrics = analyzer.latest();
      const { peaks, troughs } = analyzer.shifts();
      res.json(metrics ? { ...metrics, peaks, troughs } : null);
    });

    // Served at /plugins/windshift/history — lets the dashboard seed its
    // chart after a page reload instead of starting empty
    router.get("/history", (req, res) => {
      const src = req.query.source;
      if (!src || src === "boat") {
        return res.json(boatAnalyzer ? boatAnalyzer.history() : []);
      }
      const station = stations.get(src);
      res.json(station ? station.analyzer.history() : []);
    });
  };

  plugin.stop = function () {
    if (persistTimer) {
      clearInterval(persistTimer);
      persistTimer = null;
    }
    persistHistory(); // before reset wipes the analyzers
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    if (boatAnalyzer) boatAnalyzer.reset();
    boatAnalyzer = null;
    for (const [, s] of stations) s.analyzer.reset();
    stations.clear();
    latestSourceSpeed.clear();
    app.debug("Plugin Windshift stopped");
  };

  plugin.schema = {
    type: "object",
    required: ["twd_buffer_time", "min_max_calc_time"],
    properties: {
      twd_buffer_time: {
        type: "number",
        title: "How long an average for TWD is calculated (seconds)",
        default: 10,
      },
      min_max_calc_time: {
        type: "number",
        title:
          "How long time to keep TWD to calculate min and max from (minutes)",
        default: 20,
      },
      shift_threshold_deg: {
        type: "number",
        title:
          "Shift detection threshold (degrees the wind must swing back before an extreme counts as a shift)",
        default: 4,
      },
      dynamic_window: {
        type: "boolean",
        title: "Dynamic Window (Auto-tune tracking period based on detected cycle)",
        default: false,
      },
      auto_calibrate: {
        type: "boolean",
        title: "Auto-Calibrate (Detect and correct for tack-induced errors)",
        default: false,
      },
      tack_lockout_s: {
        type: "number",
        title: "Tack Lockout Time (Seconds to ignore data after a tack)",
        default: 60,
      },
      twd_source_path: {
        type: "string",
        title:
          "TWD source path (change to analyze another source, e.g. a shore station like environment.observations.viva.vinga.wind.directionTrue)",
        default: "environment.wind.directionTrue",
      },
      ignore_maneuvers: {
        type: "boolean",
        title:
          "Ignore maneuvers (skip heading/AWA tack detection — use when analyzing a shore station while the boat swings at the mooring)",
        default: false,
      },
      track_viva_stations: {
        type: "number",
        title:
          "Track ViVa stations (number of nearest stations from the signalk-viva plugin to analyze in parallel, 0 = off)",
        default: 0,
      },
    },
  };

  return plugin;
};
