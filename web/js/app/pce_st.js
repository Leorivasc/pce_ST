// Entry point: boots the user interface once the document is ready.
(function () {
  "use strict";

  function main() {
    const p = window.PCE_STUI.boot();
    if (p && typeof p.then === "function") {
      p.catch(function (err) {
        window.setTimeout(function () { throw err; }, 0);
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
