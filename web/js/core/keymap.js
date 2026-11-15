// Maps KeyboardEvent.code to PCE key names (pce_key_from_string).
// The ST keyboard has no Page Up, Num Lock or Windows keys.
// The ST's Help and Undo are End and Page Down (names and codes are set by PCE).
(function (root) {
  "use strict";

  const MAP = {
    Escape: "ESC",
    F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5",
    F6: "F6", F7: "F7", F8: "F8", F9: "F9", F10: "F10",
    Backquote: "Backquote",
    Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5",
    Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9", Digit0: "0",
    Minus: "Minus", Equal: "Equal", Backspace: "Backspace", Tab: "Tab",
    BracketLeft: "LeftBracket", BracketRight: "RightBracket",
    Enter: "Return", Semicolon: "Semicolon", Quote: "Quote", Backslash: "Backslash",
    IntlBackslash: "Less",
    Comma: "Comma", Period: "Period", Slash: "Slash", Space: "Space",
    ShiftLeft: "ShiftLeft", ShiftRight: "ShiftRight",
    ControlLeft: "CtrlLeft", ControlRight: "CtrlRight",
    AltLeft: "AltLeft", AltRight: "AltRight",
    CapsLock: "CapsLock",
    Insert: "Insert", Delete: "Delete", Home: "Home",
    End: "End", PageDown: "PageDown",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Numpad0: "KP_0", Numpad1: "KP_1", Numpad2: "KP_2", Numpad3: "KP_3", Numpad4: "KP_4",
    Numpad5: "KP_5", Numpad6: "KP_6", Numpad7: "KP_7", Numpad8: "KP_8", Numpad9: "KP_9",
    NumpadDivide: "KP_Slash", NumpadMultiply: "KP_Star", NumpadSubtract: "KP_Minus",
    NumpadAdd: "KP_Plus", NumpadEnter: "KP_Enter", NumpadDecimal: "KP_Period",
  };
  for (let c = 65; c <= 90; c++) {
    MAP["Key" + String.fromCharCode(c)] = String.fromCharCode(c).toLowerCase();
  }

  function pceKeyName(code) {
    return Object.prototype.hasOwnProperty.call(MAP, code) ? MAP[code] : null;
  }

  const api = { pceKeyName: pceKeyName, MAP: MAP };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PCE_STKeymap = api;
})(typeof self !== "undefined" ? self : this);
