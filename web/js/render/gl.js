// WebGL2 renderer for the ST's RGB video: a decode pass that draws the source
// image into an offscreen "scene" texture (2x horizontal oversampling), and a
// CRT post-process pass (shader by Timothy Lottes, adapted) to the canvas.
// With the CRT filter off, the source is drawn straight to the canvas with
// nearest-neighbor sampling. The source size can change at any time (the ST has
// several resolutions); textures are rebuilt when it does.
(function (root) {
  "use strict";

  const SHADER_URLS = {
    vs: "js/render/shaders/vert.glsl",
    decodeFs: "js/render/shaders/decode.frag.glsl",
    crtFs: "js/render/shaders/crt.frag.glsl",
  };
  const SCENE_SCALE_X = 2;
  let shaderSources = null;

  function fetchText(url) {
    return fetch(url, { cache: "no-store" }).then(function (resp) {
      if (!resp.ok) throw new Error("Could not load shader " + url + " (" + resp.status + ")");
      return resp.text();
    });
  }

  // Loads the shader sources once. Call it before create().
  function loadShaderSources() {
    if (shaderSources) return Promise.resolve(shaderSources);
    return Promise.all([
      fetchText(SHADER_URLS.vs), fetchText(SHADER_URLS.decodeFs), fetchText(SHADER_URLS.crtFs),
    ]).then(function (texts) {
      shaderSources = { vs: texts[0], decodeFs: texts[1], crtFs: texts[2] };
      return shaderSources;
    });
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error("Shader compile error: " + log);
    }
    return shader;
  }

  function link(gl, vsSource, fsSource) {
    const program = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error("Program link error: " + log);
    }
    return program;
  }

  function createTexture(gl, unit) {
    const tex = gl.createTexture();
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function bindQuad(gl, buffer, posLoc, uvLoc) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
  }

  function create(opts) {
    const canvas = opts.canvas;
    if (!canvas) throw new Error("PCE_STGlRenderer: missing canvas");
    if (!shaderSources) throw new Error("PCE_STGlRenderer: shaders not loaded");
    const gl = canvas.getContext("webgl2", {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("PCE_STGlRenderer: WebGL2 is not available");

    let crtEnabled = opts.crtEnabled !== false;
    let disposed = false;
    let srcW = 0;
    let srcH = 0;
    let srcTex = null;
    let sceneTex = null;
    let sceneFbo = null;

    const decodeProgram = link(gl, shaderSources.vs, shaderSources.decodeFs);
    const crtProgram = link(gl, shaderSources.vs, shaderSources.crtFs);
    const decode = {
      pos: gl.getAttribLocation(decodeProgram, "a_pos"),
      uv: gl.getAttribLocation(decodeProgram, "a_uv"),
      rgb: gl.getUniformLocation(decodeProgram, "u_rgbTex"),
    };
    const crt = {
      pos: gl.getAttribLocation(crtProgram, "a_pos"),
      uv: gl.getAttribLocation(crtProgram, "a_uv"),
      scene: gl.getUniformLocation(crtProgram, "u_sceneTex"),
      sourceSize: gl.getUniformLocation(crtProgram, "u_sourceSize"),
      scanlineSize: gl.getUniformLocation(crtProgram, "u_scanlineSize"),
      outputSize: gl.getUniformLocation(crtProgram, "u_outputSize"),
    };

    // x, y, u, v. The decode quad flips v: the first source row is the top row.
    const decodeBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, decodeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1, -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0,
    ]), gl.STATIC_DRAW);
    const crtBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, crtBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0, -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1,
    ]), gl.STATIC_DRAW);

    gl.disable(gl.DITHER);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    function releaseTextures() {
      if (srcTex) gl.deleteTexture(srcTex);
      if (sceneTex) gl.deleteTexture(sceneTex);
      if (sceneFbo) gl.deleteFramebuffer(sceneFbo);
      srcTex = null; sceneTex = null; sceneFbo = null;
    }

    // Rebuilds the textures for a new source size.
    function setSourceSize(w, h) {
      releaseTextures();
      srcW = w;
      srcH = h;
      const sceneW = w * SCENE_SCALE_X;
      srcTex = createTexture(gl, gl.TEXTURE0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
      sceneTex = createTexture(gl, gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sceneW, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      sceneFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("PCE_STGlRenderer: framebuffer incomplete");
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(crtProgram);
      gl.uniform1i(crt.scene, 1);
      gl.uniform2f(crt.sourceSize, sceneW, h);
      gl.uniform2f(crt.scanlineSize, w, h);
      gl.useProgram(decodeProgram);
      gl.uniform1i(decode.rgb, 0);
    }

    // Draws one frame. rgb: Uint8Array with w*h*3 bytes (R, G, B per pixel).
    function paint(rgb, w, h) {
      if (disposed || !w || !h) return;
      if (w !== srcW || h !== srcH) setSourceSize(w, h);
      const outW = canvas.width | 0;
      const outH = canvas.height | 0;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.UNSIGNED_BYTE, rgb);

      gl.bindFramebuffer(gl.FRAMEBUFFER, crtEnabled ? sceneFbo : null);
      gl.viewport(0, 0, crtEnabled ? w * SCENE_SCALE_X : outW, crtEnabled ? h : outH);
      gl.useProgram(decodeProgram);
      bindQuad(gl, decodeBuf, decode.pos, decode.uv);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!crtEnabled) return;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(crtProgram);
      bindQuad(gl, crtBuf, crt.pos, crt.uv);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sceneTex);
      gl.uniform2f(crt.outputSize, outW, outH);
      gl.viewport(0, 0, outW, outH);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      releaseTextures();
      gl.deleteBuffer(decodeBuf);
      gl.deleteBuffer(crtBuf);
      gl.deleteProgram(decodeProgram);
      gl.deleteProgram(crtProgram);
    }

    return {
      paint: paint,
      setCrtEnabled: function (value) { crtEnabled = !!value; },
      dispose: dispose,
      backend: "webgl2",
    };
  }

  root.PCE_STGlRenderer = { loadShaderSources: loadShaderSources, create: create };
})(typeof self !== "undefined" ? self : this);
