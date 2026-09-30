/* gaultb.com — access-code entry
 *
 * Flow: 4 digits -> SHA-256(salt + code) -> look up entry in config/codes.js
 *       -> PBKDF2(code) derives an AES-GCM key -> decrypt the share URL -> redirect.
 * Neither codes nor share links appear in plain text in the page source.
 */
(function () {
  "use strict";

  var CFG = window.GAULTB_CONFIG || { entries: [] };
  var LENGTH = 4;
  var MAX_FAILS = 5;              // wrong tries before a cool-down
  var BASE_LOCK_MS = 30 * 1000;   // first cool-down; doubles each time, capped
  var MAX_LOCK_MS = 10 * 60 * 1000;
  var MIN_CHECK_MS = 450;         // keeps the "checking" feel consistent
  var STORE_KEY = "gaultb.access.rl";
  var ALLOWED_HOSTS = CFG.allowedHosts || ["files.gaultb.com"];

  var form = document.getElementById("code-form");
  var wrap = document.getElementById("digits");
  var boxes = Array.prototype.slice.call(wrap.querySelectorAll(".digit"));
  var statusEl = document.getElementById("status");
  var busy = false;
  var lockTimer = null;

  var enc = new TextEncoder();

  /* ---------- helpers ---------- */

  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (kind ? " is-" + kind : "");
  }

  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return ("0" + b.toString(16)).slice(-2);
    }).join("");
  }

  function b64(str) {
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function code() { return boxes.map(function (b) { return b.value; }).join(""); }

  function refreshFilled() {
    boxes.forEach(function (b) { b.classList.toggle("filled", b.value !== ""); });
  }

  function clearBoxes() {
    boxes.forEach(function (b) { b.value = ""; });
    refreshFilled();
  }

  function setDisabled(on) {
    boxes.forEach(function (b) { b.disabled = on; });
  }

  function focusBox(i) {
    var b = boxes[Math.max(0, Math.min(LENGTH - 1, i))];
    b.focus();
    // select so the next keystroke replaces the digit
    try { b.setSelectionRange(0, b.value.length); } catch (e) { /* ignore */ }
  }

  /* ---------- rate limiting (client-side, gentle) ---------- */

  function loadRL() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { fails: 0, level: 0, until: 0 }; }
    catch (e) { return { fails: 0, level: 0, until: 0 }; }
  }
  function saveRL(rl) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(rl)); } catch (e) { /* private mode */ }
  }
  var rl = loadRL();

  function lockedFor() { return Math.max(0, rl.until - Date.now()); }

  function startLockCountdown() {
    clearInterval(lockTimer);
    setDisabled(true);
    setTimeout(clearBoxes, 600);
    var tick = function () {
      var ms = lockedFor();
      if (ms <= 0) {
        clearInterval(lockTimer);
        setDisabled(false);
        wrap.classList.remove("error");
        setStatus("");
        clearBoxes();
        focusBox(0);
        return;
      }
      var s = Math.ceil(ms / 1000);
      var t = s >= 60 ? Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2) : s + "s";
      setStatus("Too many tries. Please wait " + t + ".", "error");
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  function registerFailure() {
    rl.fails += 1;
    if (rl.fails >= MAX_FAILS) {
      rl.until = Date.now() + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * Math.pow(2, rl.level));
      rl.level += 1;
      rl.fails = 0;
    }
    saveRL(rl);
  }

  function registerSuccess() {
    rl = { fails: 0, level: 0, until: 0 };
    saveRL(rl);
  }

  /* ---------- crypto ---------- */

  function sha256Hex(text) {
    return crypto.subtle.digest("SHA-256", enc.encode(text)).then(hex);
  }

  function decryptUrl(entry, digits) {
    var kdf = CFG.kdf || {};
    return crypto.subtle.importKey("raw", enc.encode(digits), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", hash: kdf.hash || "SHA-256", salt: b64(entry.kdfSalt), iterations: kdf.iterations || 600000 },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"]
        );
      })
      .then(function (key) {
        return crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64(entry.iv), additionalData: enc.encode(entry.hash) },
          key,
          b64(entry.ct)
        );
      })
      .then(function (pt) { return new TextDecoder().decode(pt); });
  }

  function safeUrl(u) {
    try {
      var url = new URL(u);
      return url.protocol === "https:" && ALLOWED_HOSTS.indexOf(url.hostname) !== -1 ? url.href : null;
    } catch (e) { return null; }
  }

  /* ---------- check ---------- */

  function fail(msg) {
    busy = false;
    wrap.classList.remove("busy", "shake");
    void wrap.offsetWidth; // restart the animation
    wrap.classList.add("error", "shake");
    if (lockedFor() > 0) { startLockCountdown(); return; }
    setStatus(msg || "Code not recognized", "error");
    setDisabled(false);
    setTimeout(function () { if (!busy && lockedFor() <= 0) { clearBoxes(); focusBox(0); } }, 1100);
  }

  function check() {
    if (busy) return;
    if (lockedFor() > 0) { startLockCountdown(); return; }
    var digits = code();
    if (!/^\d{4}$/.test(digits)) return;

    if (!window.crypto || !crypto.subtle) {
      setStatus("This browser can't check codes here (secure connection required).", "error");
      return;
    }

    busy = true;
    wrap.classList.remove("error", "shake");
    wrap.classList.add("busy");
    setStatus("Checking\u2026");
    setDisabled(true);

    var started = Date.now();
    sha256Hex((CFG.salt || "") + digits)
      .then(function (h) {
        var entry = (CFG.entries || []).filter(function (e) { return e.hash === h; })[0];
        if (!entry) return null;
        return decryptUrl(entry, digits).then(safeUrl, function () { return null; });
      })
      .then(function (url) {
        return sleep(Math.max(0, MIN_CHECK_MS - (Date.now() - started))).then(function () { return url; });
      })
      .then(function (url) {
        if (!url) { registerFailure(); fail(); return; }
        registerSuccess();
        wrap.classList.remove("busy");
        wrap.classList.add("ok");
        setStatus("Opening your files\u2026", "ok");
        setTimeout(function () { window.location.assign(url); }, 350);
      })
      .catch(function () { registerFailure(); fail(); });
  }

  /* ---------- input behaviour ---------- */

  function fillFrom(i, text) {
    var ds = (text || "").replace(/\D/g, "").split("");
    if (!ds.length) return false;
    for (var k = 0; k < ds.length && i + k < LENGTH; k++) boxes[i + k].value = ds[k];
    refreshFilled();
    var next = Math.min(LENGTH - 1, i + ds.length);
    if (code().length === LENGTH) { boxes[LENGTH - 1].blur(); check(); }
    else focusBox(next);
    return true;
  }

  boxes.forEach(function (box, i) {
    box.addEventListener("input", function () {
      if (wrap.classList.contains("error")) { wrap.classList.remove("error"); setStatus(""); }
      var v = box.value.replace(/\D/g, "");
      if (v.length > 1) { box.value = ""; fillFrom(i, v); return; } // autofill / fast typing
      box.value = v;
      refreshFilled();
      if (v) {
        if (i < LENGTH - 1) focusBox(i + 1);
        else if (code().length === LENGTH) check();
      }
    });

    box.addEventListener("keydown", function (e) {
      if (e.key === "Backspace") {
        if (box.value === "" && i > 0) {
          e.preventDefault();
          boxes[i - 1].value = "";
          refreshFilled();
          focusBox(i - 1);
        }
      } else if (e.key === "ArrowLeft" && i > 0) {
        e.preventDefault(); focusBox(i - 1);
      } else if (e.key === "ArrowRight" && i < LENGTH - 1) {
        e.preventDefault(); focusBox(i + 1);
      } else if (e.key === "Enter") {
        e.preventDefault(); check();
      } else if (e.key.length === 1 && /\d/.test(e.key) && box.value !== "") {
        // replace an existing digit and move on
        e.preventDefault();
        box.value = e.key;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
      }
    });

    box.addEventListener("paste", function (e) {
      var t = (e.clipboardData || window.clipboardData).getData("text");
      e.preventDefault();
      var ds = (t || "").replace(/\D/g, "");
      // a full 4-digit paste always fills every box
      fillFrom(ds.length >= LENGTH ? 0 : i, ds.slice(0, LENGTH));
    });

    box.addEventListener("focus", function () {
      try { box.setSelectionRange(0, box.value.length); } catch (e) { /* ignore */ }
    });
  });

  form.addEventListener("submit", function (e) { e.preventDefault(); check(); });

  // Restore a pending cool-down after reload; otherwise focus the first box.
  if (lockedFor() > 0) startLockCountdown();
  else if (!("ontouchstart" in window)) focusBox(0);
})();
