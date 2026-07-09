const createAnalyzer = require("./windshiftAnalysis.js");

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

  const DEFAULT_AVG_BUFFER = 10; //seconds
  const DEFAULT_MIN_MAX_BUFFER = 20; //mins
  const DEFAULT_SHIFT_THRESHOLD_DEG = 4;

  const BOAT_PREFIX = "environment.wind.windshift.";
  const VIVA_RE = /^environment\.observations\.viva\.([^.]+)\.(wind\.directionTrue|distance)$/;

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

  function emitMetrics(prefix, metrics) {
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
    const ignoreManeuvers = options.ignore_maneuvers || false;
    maxStations = options.track_viva_stations || 0;

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
            emitMetrics(BOAT_PREFIX, metrics)
          );
        })
    );

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
            emitMetrics(stationPrefix(slug), metrics)
          );
        })
      );
    }
  };

  plugin.registerWithRouter = function (router) {
    // Sources for the dashboard dropdown: the boat plus active stations
    router.get("/sources", (req, res) => {
      const sources = [{ id: "boat", label: "Boat", distance: null }];
      for (const [slug, s] of stations) {
        if (s.active) sources.push({ id: slug, label: slug, distance: s.distance });
      }
      res.json(sources);
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
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    if (boatAnalyzer) boatAnalyzer.reset();
    boatAnalyzer = null;
    for (const [, s] of stations) s.analyzer.reset();
    stations.clear();
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
