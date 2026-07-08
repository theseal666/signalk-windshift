const windshiftAnalysis = require("./windshiftAnalysis.js");

module.exports = function (app) {
  var plugin = {};

  plugin.id = "windshift";
  plugin.name = "Windshift";
  plugin.description = "Plugin to analyze the windshift";

  var unsubscribes = [];

  const DEFAULT_AVG_BUFFER = 10; //seconds
  let buffer_timeout_s = DEFAULT_AVG_BUFFER;

  const DEFAULT_MIN_MAX_BUFFER = 20; //mins
  let timeseries_timeout_s = DEFAULT_MIN_MAX_BUFFER * 60;

  plugin.start = function (options, restartPlugin) {
    // Here we put our plugin logic
    app.debug("Plugin Windshift started");
    app.debug("options:" + JSON.stringify(options));

    buffer_timeout_s =
      options.twd_buffer_time || buffer_timeout_s || DEFAULT_AVG_BUFFER;
    timeseries_timeout_s =
      options.min_max_calc_time || timeseries_timeout_s || DEFAULT_AVG_BUFFER;

    timeseries_timeout_s *= 60;

    app.debug("buffers: ", buffer_timeout_s, timeseries_timeout_s);
    windshiftAnalysis.logger(app.debug);
    windshiftAnalysis.config({
      buffer_timeout_s,
      timeseries_timeout_s,
      dynamic_window: options.dynamic_window || false,
    });

    app.streambundle
      .getSelfBus("environment.wind.directionTrue")
      .forEach((stream_value) => {
        app.debug("incoming stream value", stream_value);
        value = stream_value.value;
        if (isNaN(value)) return;

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
                  ],
                },
              ],
            };
            app.handleMessage(plugin.id, signalk_delta);
          }
        );
      });
  };

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
  ];

  plugin.stop = function () {
    // Here we put logic we need when the plugin stops
    app.debug("Plugin Windshift stopped");
  };

  plugin.schema = {
    // The plugin schema

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
      dynamic_window: {
        type: "boolean",
        title: "Dynamic Window (Auto-tune tracking period based on detected cycle)",
        default: false,
      },
    },
  };

  return plugin;
};
