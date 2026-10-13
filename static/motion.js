/* motion.js - THE one place where data becomes motion on the wall.
   ---------------------------------------------------------------------------
   docs/contracts.md section 3 (motion grammar). Every animated thing on the wall
   that is driven by a measurement takes its curve from here, so "how fast
   does a busy device move" has exactly one answer, and nothing can exceed the
   caps below whatever the traffic does.

   RULES
   * dt-based and clamped: callers integrate with dt <= MOTION.DT_MAX (50 ms).
     Smoothing uses MOTION.ease(dt, rate) = 1 - exp(-dt*rate), never a fixed
     per-frame fraction.
   * Every mapping is log-scaled (traffic spans 6 decades) and CAPPED.
   * Absent measurement -> the "unmeasured" value, never the idle-0 value
     pretending to be a measurement (honesty rule from contracts section 1).

   TABLE (inputs are bits/s unless noted)
     actU(bps)        u = clamp((log10(bps) - 3) / 5, 0, 1)
                      1 kb/s -> 0, 100 Mb/s -> 1
     orbitOmega(u)    epicycle angular speed, rad/s
                      0.070 (90 s/rev, idle) .. 0.524 (12 s/rev) ; unmeasured 0.045
                      down -> 0 (the body stops IN PLACE)
     orbitRadius      fixed 0.22 x layout SPACING (wall: ~4 world units), so a
                      body never leaves its slot: max linear speed ~2 units/s
     spinOmega(cls,u) sprite self-spin, rad/s = manifest.spin x (0.5 + u), cap 0.6
     pulsePeriod(rtt) brightness breathing period, s = clamp(2 + 2*log10(1+rtt_ms), 2, 8)
                      0.4 ms -> 2.3 s, 10 ms -> 4.1 s, 100 ms -> 6.0 s; no rtt -> no pulse
     pulseDepth       +-12 % brightness (never a strobe; video safe)
     brightness(u)    0.66 + 0.34u ; unmeasured 0.7 ; idle 0.55 ; unknown 0.5 ; down 0.30 + desaturated
     flowLaps(u,len)  particle laps/s along a link = min((50 + 240u)/len, FLOW_LAPS_MAX)
     FLOW_LAPS_MAX    0.6 laps/s (a short chord can never whip particles round)
     flowCount(u,max) particles per direction = max(1, round(u*max)) (0 when idle)
     birth            new:true (first 10 min) -> a ring flare every 3.2 s at the
                      body's slot, envelope fades linearly over the 10 minutes,
                      keyed to first_seen so every screen shows the same age
   --------------------------------------------------------------------------- */
(function (root) {
  'use strict';
  var TAU = Math.PI * 2;
  var M = {
    DT_MAX: 0.05,
    OMEGA_MIN: TAU / 90, OMEGA_MAX: TAU / 12, OMEGA_UNMEASURED: TAU / 140,
    ORBIT_R_FRAC: 0.22,
    SPIN_MAX: 0.6,
    PULSE_MIN: 2, PULSE_MAX: 8, PULSE_DEPTH: 0.12,
    FLOW_LAPS_MAX: 0.6,
    BIRTH_S: 600, BIRTH_EVERY: 3.2,
    clampDt: function (dt) { dt = +dt; return dt > 0 ? (dt > M.DT_MAX ? M.DT_MAX : dt) : 0; },
    ease: function (dt, rate) { return 1 - Math.exp(-dt * rate); },
    actU: function (bps) {
      bps = +bps;
      if (!(bps > 1e3)) return bps >= 0 ? 0 : -1;          // -1 = not measured
      var u = (Math.log(bps) / Math.LN10 - 3) / 5;
      return u > 1 ? 1 : u;
    },
    orbitOmega: function (u, status) {
      if (status === 'down') return 0;
      if (u < 0) return M.OMEGA_UNMEASURED;
      return M.OMEGA_MIN + (M.OMEGA_MAX - M.OMEGA_MIN) * u;
    },
    spinOmega: function (base, u) {
      var s = (+base || 0.1) * (0.5 + Math.max(0, u));
      return s > M.SPIN_MAX ? M.SPIN_MAX : s;
    },
    pulsePeriod: function (rtt) {
      if (rtt == null || !(rtt >= 0)) return 0;              // 0 = no pulse
      var p = 2 + 2 * Math.log(1 + rtt) / Math.LN10;
      return p < M.PULSE_MIN ? M.PULSE_MIN : p > M.PULSE_MAX ? M.PULSE_MAX : p;
    },
    brightness: function (u, status) {
      if (status === 'down') return 0.30;
      if (status === 'unknown') return 0.5;
      if (status === 'idle') return 0.55;
      return u < 0 ? 0.7 : 0.66 + 0.34 * u;
    },
    flowLaps: function (u, len) {
      var r = (50 + 240 * u) / Math.max(1, len);
      return r > M.FLOW_LAPS_MAX ? M.FLOW_LAPS_MAX : r;
    }
  };
  root.NB_MOTION = M;
})(typeof window !== 'undefined' ? window : this);
