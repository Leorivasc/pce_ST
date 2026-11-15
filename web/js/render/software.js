// Canvas 2D fallback renderer, used when WebGL2 is not available. It has no CRT
// filter. The video is drawn into a small scratch canvas at the source size and
// scaled to the output canvas without smoothing.
(function (root) {
  "use strict";

  function create(opts) {
    const canvas = opts.canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("PCE_STSoftwareRenderer: 2D context is not available");
    let scratch = null;
    let scratchCtx = null;
    let image = null;

    // Draws one frame. rgb: Uint8Array with w*h*3 bytes (R, G, B per pixel).
    function paint(rgb, w, h) {
      if (!w || !h) return;
      if (!scratch || scratch.width !== w || scratch.height !== h) {
        scratch = new OffscreenCanvas(w, h);
        scratchCtx = scratch.getContext("2d", { alpha: false });
        image = scratchCtx.createImageData(w, h);
      }
      const dst = image.data;
      for (let i = 0, j = 0, n = w * h; i < n; i++, j += 3) {
        dst[i * 4] = rgb[j];
        dst[i * 4 + 1] = rgb[j + 1];
        dst[i * 4 + 2] = rgb[j + 2];
        dst[i * 4 + 3] = 255;
      }
      scratchCtx.putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    }

    return {
      paint: paint,
      setCrtEnabled: function () { /* no CRT filter in the 2D fallback */ },
      dispose: function () { scratch = null; scratchCtx = null; image = null; },
      backend: "2d",
    };
  }

  root.PCE_STSoftwareRenderer = { create: create };
})(typeof self !== "undefined" ? self : this);
