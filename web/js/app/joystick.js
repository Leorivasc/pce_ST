// On-screen joystick: a draggable stick and a fire button. It reports its state as
// { up, down, left, right, fire } through onChange; the machine turns that into
// presses of the numeric-keypad keys that PCE uses to emulate a joystick.
(function (root) {
  "use strict";

  const MAX_DEFLECT_PX = 20;        // how far the stick head can move
  const DEAD_ZONE_PX = 10;          // deflection needed before a direction is reported

  function create(opts) {
    const area = opts.area;                  // the joystick body
    const stick = opts.stick;                // the moving head
    const fireButton = opts.fireButton;
    const glows = opts.glows || {};          // { up, down, left, right } indicator elements
    const onChange = opts.onChange;
    const state = { up: false, down: false, left: false, right: false, fire: false };
    let stickPointerId = null;
    let firePointerId = null;
    let center = { x: 0, y: 0 };

    function report() { onChange(Object.assign({}, state)); }

    function setDirection(up, down, left, right) {
      const next = { up: !!up, down: !!down, left: !!left, right: !!right };
      let changed = false;
      Object.keys(next).forEach(function (name) {
        if (state[name] === next[name]) return;
        state[name] = next[name];
        changed = true;
        if (glows[name]) glows[name].classList.toggle("active", next[name]);
      });
      if (changed) report();
    }

    function setFire(active) {
      const next = !!active;
      if (state.fire === next) return;
      state.fire = next;
      if (fireButton) fireButton.classList.toggle("active", next);
      report();
    }

    function stickCenter() {
      const boot = area.querySelector(".cx40-boot");
      const rect = (boot || area).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    function moveStick(dx, dy) {
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > MAX_DEFLECT_PX) {
        dx = dx / distance * MAX_DEFLECT_PX;
        dy = dy / distance * MAX_DEFLECT_PX;
      }
      stick.style.transform = "translate(" + dx + "px, " + dy + "px)";
    }

    function processMove(clientX, clientY) {
      const dx = clientX - center.x;
      const dy = clientY - center.y;
      moveStick(dx, dy);
      setDirection(dy < -DEAD_ZONE_PX, dy > DEAD_ZONE_PX, dx < -DEAD_ZONE_PX, dx > DEAD_ZONE_PX);
    }

    function resetStick() {
      stick.style.transform = "";
      setDirection(false, false, false, false);
    }

    function endPointer(pointerId) {
      let changed = false;
      if (pointerId === stickPointerId) {
        stickPointerId = null;
        stick.classList.remove("grabbing");
        resetStick();
        changed = true;
      }
      if (pointerId === firePointerId) {
        firePointerId = null;
        setFire(false);
        changed = true;
      }
      return changed;
    }

    area.addEventListener("pointerdown", function (e) {
      const isFire = e.target === fireButton || (e.target.closest && e.target.closest(".cx40-fire-housing"));
      if (isFire) {
        if (firePointerId !== null) return;
        firePointerId = e.pointerId;
        setFire(true);
      } else {
        if (stickPointerId !== null) return;
        stickPointerId = e.pointerId;
        center = stickCenter();
        stick.classList.add("grabbing");
        processMove(e.clientX, e.clientY);
      }
      try { area.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
      e.preventDefault();
    });
    area.addEventListener("pointermove", function (e) {
      if (e.pointerId !== stickPointerId) return;
      processMove(e.clientX, e.clientY);
      e.preventDefault();
    });
    function end(e) { if (endPointer(e.pointerId)) e.preventDefault(); }
    area.addEventListener("pointerup", end);
    area.addEventListener("pointercancel", end);
    area.addEventListener("lostpointercapture", end);

    return {
      getState: function () { return Object.assign({}, state); },
      // Releases the stick and the fire button (when the panel is hidden, for example).
      reset: function () {
        stickPointerId = null;
        firePointerId = null;
        stick.classList.remove("grabbing");
        resetStick();
        setFire(false);
      },
    };
  }

  root.PCE_STJoystick = { create: create };
})(typeof window !== "undefined" ? window : this);
