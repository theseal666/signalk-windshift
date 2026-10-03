const assert = require('chai').assert;
const pluginFactory = require('../index.js');

function stubApp() {
  const errors = [], statuses = [];
  return {
    errors, statuses,
    debug: () => {},
    error: (m) => errors.push(m),
    setPluginStatus: (m) => statuses.push(m),
    setPluginError: (m) => statuses.push('ERR:' + m),
    handleMessage: () => {},
    savePluginOptions: () => {},
    selfContext: 'vessels.self',
    streambundle: { getSelfBus: () => ({ forEach: () => () => {} }) },
    registerHistoryProvider: () => {},
    getDataDirPath: () => require('fs').mkdtempSync(require('os').tmpdir() + '/ws-'),
  };
}

const base = {
  twd_buffer_time: 10, min_max_calc_time: 20, shift_threshold_deg: 4,
  dynamic_window: true, tack_lockout_s: 30, track_viva_stations: 0,
};

describe('windshift config validation', () => {
  it('rejects a wind ANGLE path as the TWD source', () => {
    // The exact Karukera misconfiguration on 2026-10-03.
    const app = stubApp();
    const p = pluginFactory(app);
    p.start(Object.assign({}, base, { twd_source_path: 'environment.wind.angleTrueWater' }));
    p.stop();
    const all = app.errors.concat(app.statuses).join(' ');
    assert.match(all, /wind ANGLE/, 'must say the path is an angle, not a direction');
    assert.match(all, /directionTrue/, 'must name the correct path');
  });

  ['angleApparent', 'angleTrueGround', 'angleTrue'].forEach((p0) => {
    it(`also rejects ${p0}`, () => {
      const app = stubApp();
      const p = pluginFactory(app);
      p.start(Object.assign({}, base, { twd_source_path: 'environment.wind.' + p0 }));
      p.stop();
      assert.isAbove(app.errors.length, 0, `${p0} should have been rejected`);
    });
  });

  it('accepts the default direction path without complaint', () => {
    const app = stubApp();
    const p = pluginFactory(app);
    p.start(Object.assign({}, base, { twd_source_path: 'environment.wind.directionTrue' }));
    p.stop();
    assert.deepEqual(app.errors, [], 'the correct path must not warn');
  });

  it('accepts a shore station direction path', () => {
    const app = stubApp();
    const p = pluginFactory(app);
    p.start(Object.assign({}, base, {
      twd_source_path: 'environment.observations.viva.vinga.wind.directionTrue' }));
    p.stop();
    assert.deepEqual(app.errors, []);
  });

  it('flags auto_calibrate combined with ignore_maneuvers', () => {
    // Both were set on Karukera, so calibrationOffset stayed 0.000 all day.
    const app = stubApp();
    const p = pluginFactory(app);
    p.start(Object.assign({}, base, {
      twd_source_path: 'environment.wind.directionTrue',
      auto_calibrate: true, ignore_maneuvers: true }));
    p.stop();
    assert.match(app.errors.join(' '), /calibration can never run/);
  });

  it('does not flag auto_calibrate when maneuvers are tracked', () => {
    const app = stubApp();
    const p = pluginFactory(app);
    p.start(Object.assign({}, base, {
      twd_source_path: 'environment.wind.directionTrue',
      auto_calibrate: true, ignore_maneuvers: false }));
    p.stop();
    assert.deepEqual(app.errors, []);
  });
});
