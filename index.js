const windshiftAnalysis = require("./windshiftAnalysis.js");

module.exports = function (app) {
  var plugin = {};

  plugin.id = "windshift";
  plugin.name = "Windshift";
  plugin.description = "Plugin to analyze the windshift";

  var unsubscribes = [];

  const DEFAULT_AVG_BUFFER = 10; //seconds
  const DEFAULT_MIN_MAX_BUFFER = 20; //mins
  const DEFAULT_SHIFT_THRESHOLD_DEG = 4;

  const meta = [
    {
      path: "environment.wind.windshift.max",
      value: {
        units: "rad",
        description: "Windshift max angle calculated from the buffering period",
        displayName: "Windshift max angle",
        shortName: "Windshift max angle",
      },
    },
    {
      path: "environment.wind.windshift.avg",
      value: {
        units: "rad",
        description: "Averaged TWD",
        displayName: "Windshift average TWD",
        shortName: "Avg TWD",
      },
    },
    {
      path: "environment.wind.windshift.min",
      value: {
        units: "rad",
        description: "Windshift min angle calculated from the buffering period",
        displayName: "Windshift min angle",
        shortName: "Windshift min angle",
      },
    },
    {
      path: "environment.wind.windshift.delta",
      value: {
        units: "rad",
        description: "Spread between max and min wind angle",
        displayName: "Windshift delta",
        shortName: "Windshift delta",
      },
    },
    {
      path: "environment.wind.windshift.cyclePeriod",
      value: {
        units: "s",
        description: "Average time between wind shifts",
        displayName: "Windshift cycle period",
        shortName: "Cycle period",
      },
    },
    {
      path: "environment.wind.windshift.timeToNextShift",
      value: {
        units: "s",
        description: "Estimated time to the next wind shift",
        displayName: "Time to next shift",
        shortName: "Next shift",
      },
    },
    {
      path: "environment.wind.windshift.certainty",
      value: {
        units: "",
        description: "Confidence in the detected cycle",
        displayName: "Windshift certainty",
        shortName: "Certainty",
      },
    },
    {
      path: "environment.wind.windshift.trend",
      value: {
        units: "",
        description: "Current wind trend (1: veering, -1: backing, 0: steady)",
        displayName: "Wind trend",
        shortName: "Trend",
      },
    },
    {
      path: "environment.wind.windshift.calibrationOffset",
      value: {
        units: "rad",
        description: "Current calculated calibration correction (half the port/starboard difference)",
        displayName: "Windshift calibration offset",
        shortName: "Calibration",
      },
    },
    {
      path: "environment.wind.windshift.isSettled",
      value: {
        units: "",
        description: "1 if boat is settled, 0 during tack lockout",
        displayName: "Windshift settled",
        shortName: "Settled",
      },
    },
  ];

  plugin.start = function (options, restartPlugin) {
    app.debug("Plugin Windshift started");
    app.debug("options:" + JSON.stringify(options));

    const buffer_timeout_s = options.twd_buffer_time || DEFAULT_AVG_BUFFER;
    const timeseries_timeout_s =
      (options.min_max_calc_time || DEFAULT_MIN_MAX_BUFFER) * 60;
    const twdSourcePath =
      options.twd_source_path || "environment.wind.directionTrue";
    const ignoreManeuvers = options.ignore_maneuvers || false;

    app.debug("buffers: ", buffer_timeout_s, timeseries_timeout_s);
    windshiftAnalysis.logger(app.debug);
    windshiftAnalysis.reset();
    windshiftAnalysis.config({
      buffer_timeout_s,
      timeseries_timeout_s,
      dynamic_window: options.dynamic_window || false,
      auto_calibrate: options.auto_calibrate || false,
      tack_lockout_s: options.tack_lockout_s || 60,
      shift_threshold_rad:
        ((options.shift_threshold_deg || DEFAULT_SHIFT_THRESHOLD_DEG) * Math.PI) / 180,
    });

    app.handleMessage(plugin.id, { updates: [{ meta }] });

    unsubscribes.push(
      app.streambundle
        .getSelfBus(twdSourcePath)
        .forEach((stream_value) => {
          const value = stream_value.value;
          if (typeof value !== "number" || isNaN(value)) return;

          windshiftAnalysis.appendWindDirection(
            value,
            stream_value.timestamp,
            (metrics) => {
              let signalk_delta = {
                context: "vessels." + app.selfId,
                updates: [
                  {
                    timestamp: metrics.timestamp,
                    values: [
                      { path: "environment.wind.windshift.max", value: metrics.maxTWD },
                      { path: "environment.wind.windshift.min", value: metrics.minTWD },
                      { path: "environment.wind.windshift.avg", value: metrics.avgTWD },
                      { path: "environment.wind.windshift.delta", value: metrics.delta },
                      { path: "environment.wind.windshift.cyclePeriod", value: metrics.cyclePeriod },
                      { path: "environment.wind.windshift.timeToNextShift", value: metrics.timeToNextShift },
                      { path: "environment.wind.windshift.certainty", value: metrics.certainty },
                      { path: "environment.wind.windshift.trend", value: metrics.trend },
                      { path: "environment.wind.windshift.calibrationOffset", value: metrics.calibrationOffset },
                      { path: "environment.wind.windshift.isSettled", value: metrics.isSettled ? 1 : 0 },
                    ],
                  },
                ],
              };
              app.handleMessage(plugin.id, signalk_delta);
            }
          );
        })
    );

    // When analyzing a shore station's TWD (e.g. for testing at the mooring),
    // the boat swinging with wind and current must not lock out data
    // collection, so heading/AWA are not subscribed at all
    if (!ignoreManeuvers) {
      unsubscribes.push(
        app.streambundle
          .getSelfBus("navigation.headingTrue")
          .forEach((stream_value) => {
            if (typeof stream_value.value === "number" && !isNaN(stream_value.value)) {
              windshiftAnalysis.setHeading(stream_value.value);
            }
          })
      );

      unsubscribes.push(
        app.streambundle
          .getSelfBus("environment.wind.angleApparent")
          .forEach((stream_value) => {
            if (typeof stream_value.value === "number" && !isNaN(stream_value.value)) {
              windshiftAnalysis.setAWA(stream_value.value);
            }
          })
      );
    }
  };

  plugin.stop = function () {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    windshiftAnalysis.reset();
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
    },
  };

  return plugin;
};
