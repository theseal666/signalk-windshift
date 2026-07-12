// Verification harness for windshift analyzer math.
// Drives the analyzer with synthetic TWD and checks drift/regime/trend triggers.
const createAnalyzer = require('./windshiftAnalysis.js')

const D2R = Math.PI / 180

function run (name, twdFnDeg, hours, expect) {
  const a = createAnalyzer()
  a.config({ buffer_timeout_s: 10, timeseries_timeout_s: 1200, shift_threshold_rad: 4 * D2R })
  const t0 = Date.now() - hours * 3600 * 1000
  const stepMs = 2000
  let m = null
  for (let t = t0; t <= t0 + hours * 3600 * 1000; t += stepMs) {
    const deg = twdFnDeg((t - t0) / 60000) // minutes since start
    a.appendWindDirection(((deg % 360) + 360) % 360 * D2R, new Date(t).toISOString(), (mm) => { m = mm })
  }
  console.log(`\n== ${name}`)
  console.log(`  gradientRate(1h) = ${m.gradientRate.toFixed(1)} deg/h   (expect ${expect.rate})`)
  console.log(`  meanDrift1h      = ${m.meanDrift1h.toFixed(1)} deg     (expect ${expect.drift})`)
  console.log(`  regime           = ${m.regime}   (expect ${expect.regime})`)
  console.log(`  trend            = ${m.trend}   cycle=${(m.cyclePeriod / 60).toFixed(1)}m certainty=${m.certainty.toFixed(2)}`)
  console.log(`  rapidShift       = ${m.rapidShiftDeg.toFixed(1)} deg, detected=${m.gradientDetected}`)
  return m
}

// 1. Pure oscillation: ±10°, 6-min period, mean 40° — NO drift
run('pure oscillation ±10° / 6min', (min) => 40 + 10 * Math.sin(2 * Math.PI * min / 6), 2,
  { rate: '~0', drift: '~0', regime: 'oscillating' })

// 2. Pure gradient veer 18.7°/h + small oscillation
run('veer 18.7°/h + osc ±5°', (min) => 20 + 18.7 * min / 60 + 5 * Math.sin(2 * Math.PI * min / 6), 2,
  { rate: '~18.7', drift: '~18.7', regime: 'mixed or drifting' })

// 3. Flat wind, then sudden -19° frontal step 5 min before the end
run('flat then -19° step in last 5min', (min) => (min < 115 ? 40 : 21) + 2 * Math.sin(2 * Math.PI * min / 6), 2,
  { rate: '??', drift: '~-19', regime: 'drifting' })

// 4. Oscillation ±15° with 20-min period (endpoint sensitivity check for meanDrift1h)
run('oscillation ±15° / 20min (no drift!)', (min) => 40 + 15 * Math.sin(2 * Math.PI * min / 20), 2,
  { rate: '~0', drift: 'SHOULD be ~0 — check endpoint bug', regime: 'oscillating (NOT drifting)' })

// 5. Wrap-around: oscillation around 358° with slow veer
run('veer 10°/h across 0° wrap', (min) => 350 + 10 * min / 60 + 5 * Math.sin(2 * Math.PI * min / 6), 2,
  { rate: '~10', drift: '~10', regime: 'mixed or drifting' })
