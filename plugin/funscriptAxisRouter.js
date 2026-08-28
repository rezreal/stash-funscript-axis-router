// Funscript Axis Router
// Copyright (C) 2026 Funscript Axis Router contributors
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option) any
// later version. See the LICENSE file for the full text.
//
// Replaces stash's interactive client with one that delegates the stroke axis
// to the stock Handy client and streams the remaining axes of a multi-axis
// funscript to an XToys webhook, under the names the script itself uses.

(function () {
  "use strict";

  var PLUGIN_ID = "funscriptAxisRouter";
  var LOG = "[funscript-axis-router]";

  var InteractiveUtils = window.PluginApi.utils.InteractiveUtils;

  /* -------------------------------------------------------------------- axes */

  // Canonical T-Code ids keyed by the aliases we expect to meet. This is only
  // used to recognise the stroke axis, and to let the `axes` setting be written
  // either way round. Channel names go out on the wire exactly as the funscript
  // spells them - we never rename them.
  var AXIS_ALIASES = {
    l0: "L0", stroke: "L0", pos: "L0", position: "L0",
    l1: "L1", surge: "L1",
    l2: "L2", sway: "L2",
    r0: "R0", twist: "R0",
    r1: "R1", roll: "R1",
    r2: "R2", pitch: "R2",
    a0: "A0", valve: "A0",
    a1: "A1", suck: "A1",
    a2: "A2", lube: "A2",
  };

  var STROKE_AXIS = "L0";

  // Who drives the stroke axis.
  //   auto   - the Handy when one is configured, this plugin otherwise
  //   router - always this plugin, on the same clock as every other axis; the
  //            Handy is not used at all
  //   handy  - always the Handy; nobody plays it if no key is configured
  var STROKE_MODES = { auto: true, router: true, handy: true };

  function canonicalAxis(key) {
    return AXIS_ALIASES[String(key).toLowerCase()] || null;
  }

  /* --------------------------------------------------------------- timeline */

  function AxisTimeline(actions, meta) {
    this.actions = actions
      .filter(function (a) {
        return a && typeof a.at === "number" && typeof a.pos === "number";
      })
      .slice()
      .sort(function (a, b) {
        return a.at - b.at;
      });

    // Same two normalisations stash applies when it converts a funscript for
    // the Handy, see ui/v2.5/src/hooks/Interactive/interactive.ts.
    this.inverted = !!(meta && meta.inverted);
    this.range =
      meta && typeof meta.range === "number" && meta.range > 0 ? meta.range : 100;

    this.cursor = 0;
  }

  AxisTimeline.prototype.normalise = function (pos) {
    var p = (pos / this.range) * 100;
    if (this.inverted) p = 100 - p;
    return p < 0 ? 0 : p > 100 ? 100 : p;
  };

  // Largest index i where actions[i].at <= ms, capped so i+1 stays in range.
  AxisTimeline.prototype.search = function (ms) {
    var a = this.actions;
    var lo = 0;
    var hi = a.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (a[mid].at <= ms) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, a.length - 2);
  };

  // Linear interpolation at `ms`. Playback is overwhelmingly monotonic, so walk
  // the cursor forward and only binary search on a real jump - that keeps the
  // tick O(1) on a script with tens of thousands of actions.
  AxisTimeline.prototype.valueAt = function (ms) {
    var a = this.actions;
    if (a.length === 0) return null;
    if (a.length === 1 || ms <= a[0].at) return this.normalise(a[0].pos);
    if (ms >= a[a.length - 1].at) return this.normalise(a[a.length - 1].pos);

    var c = this.cursor;
    if (c > a.length - 2) c = a.length - 2;

    if (a[c].at > ms) {
      c = this.search(ms); // seeked backwards
    } else {
      var steps = 0;
      while (c < a.length - 2 && a[c + 1].at <= ms) {
        if (++steps > 32) {
          c = this.search(ms); // seeked a long way forward
          break;
        }
        c++;
      }
    }
    this.cursor = c;

    var lo = a[c];
    var hi = a[c + 1];
    var span = hi.at - lo.at;
    var t = span > 0 ? (ms - lo.at) / span : 0;
    return this.normalise(lo.pos + (hi.pos - lo.pos) * t);
  };

  /* ------------------------------------------------------------------ parse */

  // Axes live in one of two containers: v1.1 uses an `axes` array keyed by
  // T-Code id, v2.0 replaced it with a `channels` object keyed by name. A
  // top-level `actions` array is always the stroke axis.
  //
  // Returns [{ key, id, stroke, timeline }] where `key` is verbatim from the
  // file and `id` is the canonical T-Code id, or null for a channel name we do
  // not recognise. Unrecognised channels are routed too - the name is the
  // contract, and an XToys script can read whatever it likes.
  function parseAxes(json) {
    var out = [];
    var seen = {};

    function add(key, node, isStroke) {
      var name = String(key);
      var id = canonicalAxis(name);

      // Dedupe on the canonical id where we know one, on the raw name where we
      // do not, so `axes: [{id: "R1"}]` and `channels: {roll: ...}` in the same
      // file resolve to a single axis.
      var dedupe = id || "name:" + name.toLowerCase();
      if (seen[dedupe]) return;

      var actions = Array.isArray(node) ? node : node && node.actions;
      if (!Array.isArray(actions) || actions.length === 0) return;

      seen[dedupe] = true;
      out.push({
        key: name,
        id: id,
        stroke: !!isStroke || id === STROKE_AXIS,
        timeline: new AxisTimeline(actions, Array.isArray(node) ? null : node),
      });
    }

    if (json && Array.isArray(json.actions)) add("stroke", json, true);

    if (json && Array.isArray(json.axes)) {
      json.axes.forEach(function (a) {
        if (a) add(a.id || a.axis || a.name, a, false);
      });
    }

    if (json && json.channels && typeof json.channels === "object") {
      Object.keys(json.channels).forEach(function (k) {
        add(k, json.channels[k], false);
      });
    }

    return out;
  }

  // The `axes` setting may name a channel as the file spells it ("roll") or as
  // a T-Code id ("R1"); either should select it.
  function matchesFilter(only, key, id) {
    if (!only) return true;
    if (only.raw.indexOf(String(key).toLowerCase()) !== -1) return true;
    return id !== null && only.ids.indexOf(id) !== -1;
  }

  /* ------------------------------------------------------------------- sink */

  // XToys accepts a newline-terminated JSON object per message, keyed by
  // whatever your script reads. We send one key per routed axis, value 0-100 as
  // a string:  {"roll":"62","pitch":"41"}\n
  //
  // The token goes in the query string. XToys documents an Authorization header
  // for custom toys, but a browser cannot set headers on a WebSocket; ?token=
  // is what actually works from one. A webhook block inside a script needs no
  // token at all, so leaving it blank is valid.
  //
  // On a good connection the server sends back {"success": true}. We do not gate
  // sending on it - a tokenless script webhook may never send one - but we do
  // report it, and warn if a token was given and no acknowledgement arrives.
  var ACK_TIMEOUT_MS = 5000;

  function XToysSink(cfg) {
    this.url =
      "wss://webhook.xtoys.app/" +
      cfg.xtoysWebhookId +
      (cfg.xtoysToken ? "?token=" + encodeURIComponent(cfg.xtoysToken) : "");
    this.hasToken = !!cfg.xtoysToken;
    this.ws = null;
    this.acked = false;
    this.ackTimer = null;
    this.retries = 0;
    this.retryTimer = null;
    this.closed = true;
  }

  XToysSink.prototype.open = function () {
    this.closed = false;
    this.connect();
  };

  XToysSink.prototype.connect = function () {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    var self = this;
    var ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      console.error(LOG, "XToys connect failed", e);
      this.scheduleRetry();
      return;
    }

    this.ws = ws;

    ws.onopen = function () {
      self.retries = 0;
      console.log(LOG, "XToys socket open");

      if (self.hasToken && !self.acked) {
        clearTimeout(self.ackTimer);
        self.ackTimer = setTimeout(function () {
          if (!self.acked) {
            console.warn(
              LOG,
              "XToys did not acknowledge the connection within " +
                ACK_TIMEOUT_MS / 1000 +
                "s - the token may be wrong, or this webhook may not need one."
            );
          }
        }, ACK_TIMEOUT_MS);
      }
    };

    ws.onmessage = function (e) {
      var parsed;
      try {
        parsed = JSON.parse(e.data);
      } catch (_err) {
        return;
      }
      if (parsed && parsed.success === true && !self.acked) {
        self.acked = true;
        clearTimeout(self.ackTimer);
        console.log(LOG, "XToys acknowledged the connection");
      }
    };

    ws.onerror = function () {
      // onclose always follows; the retry decision is made there
    };

    ws.onclose = function () {
      self.ws = null;
      clearTimeout(self.ackTimer);
      if (!self.closed) self.scheduleRetry();
    };
  };

  XToysSink.prototype.scheduleRetry = function () {
    if (this.retryTimer !== null || this.closed) return;
    var self = this;
    var delay = Math.min(30000, 1000 * Math.pow(2, this.retries++));
    this.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self.connect();
    }, delay);
  };

  XToysSink.prototype.send = function (values) {
    if (!this.ws || this.ws.readyState !== 1) return;

    var payload = {};
    Object.keys(values).forEach(function (k) {
      payload[k] = String(values[k]);
    });

    try {
      // the trailing newline is part of the protocol, not cosmetic
      this.ws.send(JSON.stringify(payload) + "\n");
    } catch (e) {
      console.error(LOG, "XToys send failed", e);
    }
  };

  /* ----------------------------------------------------------------- runner */

  function AuxAxisRunner(sink, cfg) {
    this.sink = sink;
    this.cfg = cfg;
    this.intervalMs = Math.max(20, Math.round(1000 / cfg.updateHz));

    this.axes = [];
    this.timer = null;
    this.last = null;
    this.lastSentAt = 0;
  }

  Object.defineProperty(AuxAxisRunner.prototype, "running", {
    get: function () {
      return this.timer !== null;
    },
  });

  Object.defineProperty(AuxAxisRunner.prototype, "hasAxes", {
    get: function () {
      return this.axes.length > 0;
    },
  });

  AuxAxisRunner.prototype.load = function (json) {
    var cfg = this.cfg;
    var picked = [];

    parseAxes(json).forEach(function (ax) {
      // The Handy plays the stroke axis off its own uploaded script. With no
      // Handy in play nothing else would, so route it like any other axis.
      if (ax.stroke && !cfg.routeStroke) return;
      if (!matchesFilter(cfg.only, ax.key, ax.id)) return;
      picked.push(ax);
    });

    this.axes = picked;
    this.last = null;

    var names = picked.map(function (a) {
      return a.key;
    });
    console.log(
      LOG,
      "routing " + names.length + " axis/axes:",
      names.length ? names.join(", ") : "(none)"
    );
    return names.length;
  };

  AuxAxisRunner.prototype.start = function () {
    if (this.timer !== null || !this.hasAxes) return;
    this.sink.open();
    var self = this;
    this.timer = setInterval(function () {
      self.tick();
    }, this.intervalMs);
  };

  AuxAxisRunner.prototype.stop = function () {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;

    // On stop, either hold the last values or drive every channel to a set
    // value. Holding is the safe default: zero is not a neutral for every axis
    // (50 is centre for roll and pitch, 0 is off for a vibe), so which one you
    // want depends on your hardware. Set Stop Value to 0 to park vibrations.
    if (this.last) {
      var stop = this.cfg.stopValue;
      if (stop === null) {
        this.sink.send(this.last);
      } else {
        var parked = {};
        Object.keys(this.last).forEach(function (k) {
          parked[k] = stop;
        });
        this.sink.send(parked);
      }
    }
    this.last = null;
  };

  AuxAxisRunner.prototype.sample = function (ms) {
    var values = {};
    this.axes.forEach(function (ax) {
      var v = ax.timeline.valueAt(ms);
      if (v !== null) values[ax.key] = Math.round(v);
    });
    return values;
  };

  // XToys custom toys have an explicit Max Message Frequency; there is no point
  // spending that budget resending a value nothing has moved off.
  AuxAxisRunner.prototype.changed = function (values) {
    if (!this.last) return true;
    if (Date.now() - this.lastSentAt >= this.cfg.maxIdleMs) return true;

    var last = this.last;
    var deadband = this.cfg.deadband;
    return Object.keys(values).some(function (k) {
      return last[k] === undefined || Math.abs(values[k] - last[k]) >= deadband;
    });
  };

  AuxAxisRunner.prototype.tick = function () {
    var player = InteractiveUtils.getPlayer();
    if (!player || player.paused()) return;

    // Read the clock every tick rather than tracking it from play(position).
    // ScenePlayer has no `seeked` handler, so this is what makes seeking work.
    var ms = player.currentTime() * 1000 + this.cfg.offsetMs;
    var values = this.sample(ms);

    if (!this.changed(values)) return;

    this.last = values;
    this.lastSentAt = Date.now();
    this.sink.send(values);
  };

  /* ----------------------------------------------------------------- client */

  function RouterClient(handy, runner) {
    this.handy = handy;
    this.runner = runner;
    // stash gates the whole interactive pipeline on a non-empty handyKey (see
    // context.tsx uploadScript and ScenePlayer's `interactiveClient.handyKey`
    // check), so when there is no Handy we hand it a sentinel.
    this.fallbackKey = handy ? "" : PLUGIN_ID;
    this.up = false;
  }

  Object.defineProperty(RouterClient.prototype, "handyKey", {
    get: function () {
      return this.handy ? this.handy.handyKey : this.fallbackKey;
    },
    set: function (v) {
      if (this.handy) this.handy.handyKey = v;
    },
  });

  Object.defineProperty(RouterClient.prototype, "connected", {
    get: function () {
      return this.handy ? this.handy.connected : this.up;
    },
  });

  Object.defineProperty(RouterClient.prototype, "playing", {
    get: function () {
      return this.handy ? this.handy.playing : this.runner.running;
    },
  });

  RouterClient.prototype.connect = function () {
    var self = this;
    return Promise.resolve(this.handy ? this.handy.connect() : null).then(function () {
      self.up = true;
    });
  };

  // stash stores this as `serverOffset` and refuses to finish initialising
  // while it is falsy, so never hand back a bare 0 - see context.tsx.
  RouterClient.prototype.sync = function () {
    return Promise.resolve(this.handy ? this.handy.sync() : 0).then(function (off) {
      return off || 1;
    });
  };

  RouterClient.prototype.configure = function (c) {
    return Promise.resolve(this.handy ? this.handy.configure(c) : undefined);
  };

  RouterClient.prototype.uploadScript = function (url, apiKey) {
    var self = this;
    this.runner.stop();

    var load = fetch(withApiKey(url, apiKey), { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("funscript fetch failed: " + r.status);
        return r.json();
      })
      .then(function (json) {
        self.runner.load(json);
      })
      .catch(function (e) {
        console.error(LOG, "could not load axes", e);
      });

    return Promise.all([
      this.handy ? this.handy.uploadScript(url, apiKey) : null,
      load,
    ]).then(function () {});
  };

  RouterClient.prototype.play = function (pos) {
    this.runner.start();
    return Promise.resolve(this.handy ? this.handy.play(pos) : undefined);
  };

  RouterClient.prototype.pause = function () {
    this.runner.stop();
    return Promise.resolve(this.handy ? this.handy.pause() : undefined);
  };

  RouterClient.prototype.ensurePlaying = function (pos) {
    this.runner.start();
    return Promise.resolve(this.handy ? this.handy.ensurePlaying(pos) : undefined);
  };

  RouterClient.prototype.setLooping = function (looping) {
    return Promise.resolve(this.handy ? this.handy.setLooping(looping) : undefined);
  };

  /* ----------------------------------------------------------------- config */

  function num(v, fallback) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function withApiKey(url, apiKey) {
    if (!apiKey) return url;
    try {
      var u = new URL(url, window.location.href);
      u.searchParams.set("apikey", apiKey);
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  function readConfig(stashConfig) {
    var plugins = (stashConfig && stashConfig.plugins) || {};
    var raw = plugins[PLUGIN_ID] || {};
    var iface = (stashConfig && stashConfig.interface) || {};

    var only = null;
    var tokens = String(raw.axes || "")
      .split(/[\s,]+/)
      .filter(Boolean);
    if (tokens.length) {
      only = {
        raw: tokens.map(function (t) {
          return t.toLowerCase();
        }),
        ids: tokens.map(canonicalAxis).filter(Boolean),
      };
    }

    // blank means "hold the last values"; a number parks every channel there
    var stopRaw = String(raw.stopValue === undefined ? "" : raw.stopValue).trim();
    var stopValue = stopRaw === "" ? null : clamp(num(stopRaw, 0), 0, 100);

    var strokeAxis = String(raw.strokeAxis || "").trim().toLowerCase() || "auto";
    if (!STROKE_MODES[strokeAxis]) {
      console.warn(LOG, 'unknown strokeAxis "' + strokeAxis + '", falling back to "auto"');
      strokeAxis = "auto";
    }

    return {
      strokeAxis: strokeAxis,
      xtoysWebhookId: String(raw.xtoysWebhookId || "").trim(),
      xtoysToken: String(raw.xtoysToken || "").trim(),
      stopValue: stopValue,
      only: only,
      routeStroke: false, // set by the provider once we know about the Handy
      updateHz: clamp(num(raw.updateHz, 10), 1, 50),
      deadband: clamp(num(raw.deadband, 2), 0, 50),
      maxIdleMs: 1000,
      // stash's own funscriptOffset never reaches the client: context.tsx
      // passes it as `offset` while the client reads `scriptOffset`, so we read
      // it off the config ourselves.
      offsetMs: num(raw.offsetMs, num(iface.funscriptOffset, 0)),
    };
  }

  /* --------------------------------------------------------------- register */

  InteractiveUtils.interactiveClientProvider = function (opts) {
    var cfg = readConfig(opts.stashConfig);
    var iface = (opts.stashConfig && opts.stashConfig.interface) || {};
    var hasHandy = !!String(iface.handyKey || "").trim();

    // "router" deliberately declines the Handy even when one is configured: the
    // Handy plays its uploaded script off *server* time while everything else is
    // ticked from the browser clock, so the only way to keep the axes in phase
    // is for one clock to drive all of them.
    var useHandy = cfg.strokeAxis === "router" ? false : hasHandy;

    var handy =
      useHandy && opts.defaultClientProvider ? opts.defaultClientProvider(opts) : null;

    cfg.routeStroke =
      cfg.strokeAxis === "router" || (cfg.strokeAxis === "auto" && !handy);

    if (cfg.strokeAxis === "router" && hasHandy) {
      console.warn(
        LOG,
        'strokeAxis is "router", so the configured Handy will not be used at all.'
      );
    }

    if (!cfg.xtoysWebhookId) {
      console.warn(
        LOG,
        "no XToys webhook id set, nothing will be routed." +
          " Set one in Settings > Plugins > Funscript Axis Router."
      );
    }

    console.log(
      LOG,
      "installed;",
      handy
        ? "stroke axis delegated to the Handy"
        : cfg.routeStroke
          ? "stroke axis routed through this plugin (single clock)"
          : "stroke axis not played",
      "| axes:",
      cfg.only ? cfg.only.raw.join(", ") : "all",
      "| " + cfg.updateHz + "Hz"
    );

    return new RouterClient(handy, new AuxAxisRunner(new XToysSink(cfg), cfg));
  };
})();
