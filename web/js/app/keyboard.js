// On-screen Atari ST keyboard. The keys are generated from a layout table and
// placed on a CSS grid (46 columns: the main block, the cursor cluster and the
// numeric keypad). Each key sends KeyboardEvent.code values, the same ones the
// physical keyboard produces, so the machine sees no difference.
//
// Modifiers (Shift, Control, Alternate) work like on most on-screen keyboards:
// one tap holds the key down until the next key is released; a double tap locks
// it; another tap unlocks it. Pointers are tracked individually, so several keys
// can be held at once on a touch screen.
(function (root) {
  "use strict";

  const MODIFIER_LOCK_MS = 350;      // second tap within this time locks the modifier
  const COLUMNS = 46;                // 30 main + gap + 6 cluster + gap + 8 keypad

  // Grid placement: c = first column, s = column span, r = row, rs = row span.
  // Key types: "light" (character keys), "dark" (function and control keys).
  // Legends: top = shifted symbol, main = the key's own symbol or name, icon = Font Awesome icon.
  function buildLayout() {
    const keys = [];
    function add(code, c, r, s, type, legend, extra) {
      keys.push(Object.assign({ code: code, c: c, r: r, s: s, rs: 1, type: type }, legend, extra || {}));
    }

    // Function row (row 1) and the Help / Undo keys.
    for (let i = 1; i <= 10; i++) add("F" + i, 1 + (i - 1) * 3, 1, 3, "dark", { main: "F" + i });
    add("End", 32, 1, 3, "dark", { main: "Help" });
    add("PageDown", 35, 1, 3, "dark", { main: "Undo" });

    // Row 2: Esc, digits, - = `, Backspace.
    add("Escape", 1, 2, 2, "dark", { main: "Esc" });
    const digits = [["1", "!"], ["2", "@"], ["3", "#"], ["4", "$"], ["5", "%"], ["6", "^"], ["7", "&"], ["8", "*"], ["9", "("], ["0", ")"]];
    digits.forEach(function (d, i) { add("Digit" + d[0], 3 + i * 2, 2, 2, "light", { main: d[0], top: d[1] }); });
    add("Minus", 23, 2, 2, "light", { main: "-", top: "_" });
    add("Equal", 25, 2, 2, "light", { main: "=", top: "+" });
    add("Backquote", 27, 2, 2, "light", { main: "`", top: "~" });
    add("Backspace", 29, 2, 2, "dark", { main: "Bksp", label: "Backspace" });

    // Row 3: Tab, QWERTYUIOP, [ ], Delete.
    add("Tab", 1, 3, 3, "dark", { main: "Tab" });
    "QWERTYUIOP".split("").forEach(function (ch, i) { add("Key" + ch, 4 + i * 2, 3, 2, "light", { main: ch }); });
    add("BracketLeft", 24, 3, 2, "light", { main: "[", top: "{" });
    add("BracketRight", 26, 3, 2, "light", { main: "]", top: "}" });
    add("Delete", 28, 3, 3, "dark", { main: "Del", label: "Delete" });

    // Row 4: Control, ASDFGHJKL, ; ' \, Return.
    add("ControlLeft", 1, 4, 3, "dark", { main: "Control", modifier: true });
    "ASDFGHJKL".split("").forEach(function (ch, i) { add("Key" + ch, 4 + i * 2, 4, 2, "light", { main: ch }); });
    add("Semicolon", 22, 4, 2, "light", { main: ";", top: ":" });
    add("Quote", 24, 4, 2, "light", { main: "'", top: "\"" });
    add("Backslash", 26, 4, 2, "light", { main: "\\", top: "|" });
    add("Enter", 28, 4, 3, "dark", { main: "Return" });

    // Row 5: Shift, the ISO < > key, ZXCVBNM, , . /, Shift.
    add("ShiftLeft", 1, 5, 3, "dark", { main: "Shift", modifier: true });
    add("IntlBackslash", 4, 5, 2, "light", { main: "<", top: ">" });
    "ZXCVBNM".split("").forEach(function (ch, i) { add("Key" + ch, 6 + i * 2, 5, 2, "light", { main: ch }); });
    add("Comma", 20, 5, 2, "light", { main: ",", top: "<" });
    add("Period", 22, 5, 2, "light", { main: ".", top: ">" });
    add("Slash", 24, 5, 2, "light", { main: "/", top: "?" });
    add("ShiftRight", 26, 5, 5, "dark", { main: "Shift", modifier: true });

    // Row 6: Alternate, Space, Caps Lock.
    add("AltLeft", 1, 6, 5, "dark", { main: "Alternate", modifier: true });
    add("Space", 6, 6, 20, "light", { main: "", label: "Space" });
    add("CapsLock", 26, 6, 5, "dark", { main: "Caps Lock" });

    // Cursor cluster (columns 32-37).
    add("Insert", 32, 2, 3, "dark", { main: "Insert" });
    add("Home", 35, 2, 3, "dark", { main: "Clr Home", label: "Clear / Home" });
    add("ArrowUp", 34, 4, 2, "dark", { icon: "arrow-up", label: "Cursor up" });
    add("ArrowLeft", 32, 5, 2, "dark", { icon: "arrow-left", label: "Cursor left" });
    add("ArrowDown", 34, 5, 2, "dark", { icon: "arrow-down", label: "Cursor down" });
    add("ArrowRight", 36, 5, 2, "dark", { icon: "arrow-right", label: "Cursor right" });

    // Numeric keypad (columns 39-46). The ( and ) keys exist on the ST but PCE has
    // no key code for them, so they are drawn and disabled.
    function pad(code, c, r, s, type, main, rs) {
      add(code, c, r, s, type, { main: main }, { pad: true, rs: rs || 1, disabled: !code });
    }
    pad("", 39, 2, 2, "dark", "(");
    pad("", 41, 2, 2, "dark", ")");
    pad("NumpadDivide", 43, 2, 2, "dark", "/");
    pad("NumpadMultiply", 45, 2, 2, "dark", "*");
    pad("Numpad7", 39, 3, 2, "light", "7");
    pad("Numpad8", 41, 3, 2, "light", "8");
    pad("Numpad9", 43, 3, 2, "light", "9");
    pad("NumpadSubtract", 45, 3, 2, "dark", "-");
    pad("Numpad4", 39, 4, 2, "light", "4");
    pad("Numpad5", 41, 4, 2, "light", "5");
    pad("Numpad6", 43, 4, 2, "light", "6");
    pad("NumpadAdd", 45, 4, 2, "dark", "+");
    pad("Numpad1", 39, 5, 2, "light", "1");
    pad("Numpad2", 41, 5, 2, "light", "2");
    pad("Numpad3", 43, 5, 2, "light", "3");
    pad("NumpadEnter", 45, 5, 2, "dark", "Enter", 2);
    pad("Numpad0", 39, 6, 4, "light", "0");
    pad("NumpadDecimal", 43, 6, 2, "light", ".");
    return keys;
  }

  const MODIFIER_CODES = ["ShiftLeft", "ShiftRight", "ControlLeft", "AltLeft"];

  function create(opts) {
    const container = opts.container;
    const onKeyDown = opts.onKeyDown;
    const onKeyUp = opts.onKeyUp;
    const layout = buildLayout();
    const buttons = new Map();          // code -> button
    const held = new Map();             // pointerId -> code (a key held by a pointer)
    const modifiers = {};               // code -> { state: "off" | "latched" | "locked", at: ms of the last tap }
    const physical = new Set();         // codes held on the physical keyboard (highlight only)

    container.classList.add("stKeyboard");
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "On-screen Atari ST keyboard");
    container.style.setProperty("--st-columns", String(COLUMNS));

    const case_ = document.createElement("div");
    case_.className = "stKeyboardCase";
    container.appendChild(case_);

    layout.forEach(function (k) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "stKey stKey-" + k.type + (k.pad ? " stKey-pad" : "") + (k.modifier ? " stKey-mod" : "") +
        (!k.pad && k.type === "light" ? " stKey-char" : "");
      b.style.gridColumn = k.c + " / span " + k.s;
      b.style.gridRow = k.r + " / span " + k.rs;
      b.setAttribute("aria-label", k.label || (k.top ? k.main + " (" + k.top + ")" : k.main) || k.code);
      if (k.disabled) {
        b.disabled = true;
        b.title = "Not available: PCE has no key code for it";
      } else {
        b.dataset.code = k.code;
      }
      if (k.icon) {
        b.innerHTML = '<i class="fa-solid fa-' + k.icon + '" aria-hidden="true"></i>';
      } else {
        if (k.top) {
          const top = document.createElement("span");
          top.className = "stTop";
          top.textContent = k.top;
          b.appendChild(top);
        }
        const main = document.createElement("span");
        main.className = "stMain";
        main.textContent = k.main;
        b.appendChild(main);
      }
      if (k.modifier) modifiers[k.code] = { state: "off", at: 0 };
      case_.appendChild(b);
      if (!k.disabled) buttons.set(k.code, b);
    });

    // ---- visual state ----

    function refresh(code) {
      const b = buttons.get(code);
      if (!b) return;
      const heldByPointer = Array.from(held.values()).indexOf(code) >= 0;
      const m = modifiers[code];
      b.classList.toggle("pressed", heldByPointer || physical.has(code) || !!(m && m.state !== "off"));
      b.classList.toggle("latched", !!(m && m.state === "latched"));
      b.classList.toggle("locked", !!(m && m.state === "locked"));
      if (m) b.setAttribute("aria-pressed", m.state === "off" ? "false" : "true");
    }

    // ---- sending keys ----

    function setModifier(code, state) {
      const m = modifiers[code];
      if (m.state === state) return;
      const wasDown = m.state !== "off";
      const isDown = state !== "off";
      m.state = state;
      if (isDown && !wasDown) onKeyDown(code);
      else if (!isDown && wasDown) onKeyUp(code);
      refresh(code);
    }

    // After an ordinary key is released, one-shot modifiers let go.
    function releaseOneShotModifiers() {
      MODIFIER_CODES.forEach(function (code) {
        if (modifiers[code] && modifiers[code].state === "latched") setModifier(code, "off");
      });
    }

    function tapModifier(code) {
      const m = modifiers[code];
      const now = performance.now();
      if (m.state === "off") {
        setModifier(code, "latched");
        m.at = now;
      } else if (m.state === "latched" && now - m.at < MODIFIER_LOCK_MS) {
        setModifier(code, "locked");
      } else {
        setModifier(code, "off");
      }
    }

    function pressKey(pointerId, code) {
      held.set(pointerId, code);
      onKeyDown(code);
      refresh(code);
    }

    function releasePointer(pointerId) {
      if (!held.has(pointerId)) return false;
      const code = held.get(pointerId);
      held.delete(pointerId);
      onKeyUp(code);
      refresh(code);
      releaseOneShotModifiers();
      return true;
    }

    // ---- pointer input ----

    container.addEventListener("pointerdown", function (e) {
      const b = e.target.closest && e.target.closest("button.stKey");
      if (!b || !b.dataset.code) return;
      e.preventDefault();
      const code = b.dataset.code;
      if (modifiers[code]) { tapModifier(code); return; }
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
      pressKey(e.pointerId, code);
    });
    function end(e) { if (releasePointer(e.pointerId)) e.preventDefault(); }
    container.addEventListener("pointerup", end);
    container.addEventListener("pointercancel", end);
    container.addEventListener("lostpointercapture", end);
    container.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    return {
      // Highlights a key held on the physical keyboard (no event is sent).
      setPhysicalKey: function (code, down) {
        if (!buttons.has(code)) return;
        if (down) physical.add(code); else physical.delete(code);
        refresh(code);
      },
      // Lets go of everything held by pointers and of every latched modifier.
      releaseAll: function () {
        Array.from(held.keys()).forEach(function (id) {
          const code = held.get(id);
          held.delete(id);
          onKeyUp(code);
          refresh(code);
        });
        MODIFIER_CODES.forEach(function (code) { if (modifiers[code]) setModifier(code, "off"); });
        physical.clear();
        buttons.forEach(function (b, code) { refresh(code); });
      },
      getModifierState: function (code) { return modifiers[code] ? modifiers[code].state : null; },
      getKeyCodes: function () { return Array.from(buttons.keys()); },
      layout: layout,
    };
  }

  root.PCE_STKeyboard = { create: create, buildLayout: buildLayout, COLUMNS: COLUMNS };
})(typeof window !== "undefined" ? window : this);
