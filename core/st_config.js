// Core configuration (PCE libini text). Works in the browser (global
// PCE_STConfig) and in Node (module.exports).
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PCE_STConfig = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    model: "st",        // "st" or "mega"
    mono: true,         // monochrome (640x400) or color (320x200) monitor
    ramKB: 1024,
    romFile: "/tos.rom",
    romKB: 192,
    romAddress: 0xfc0000,
    sampleRate: 48000,
  };

  function build(options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    return [
      'path = "/"',
      "system {",
      '  model = "' + o.model + '"',
      "  fastboot = 1",
      "  mono = " + (o.mono ? 1 : 0),
      "  rtc = 1",
      "  frame_skip = 0",
      "}",
      "cpu {",
      '  model = "68000"',
      "  speed = 1",
      "}",
      "ram {",
      "  address = 0",
      "  size = " + o.ramKB + "K",
      "}",
      "rom {",
      '  file = "' + o.romFile + '"',
      "  address = 0x" + o.romAddress.toString(16),
      "  size = " + o.romKB + "K",
      "  default = 0xff",
      "}",
      "terminal {",
      '  driver = "null"',
      "}",
      "psg {",
      '  driver = "null"',
      "  sample_rate = " + o.sampleRate,
      "  lowpass = 0",
      "  highpass = 1",
      "}",
      "",
    ].join("\n");
  }

  return { build: build, DEFAULTS: DEFAULTS };
});
