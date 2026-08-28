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

  // Envelope fields. An XToys script trigger dispatches on "action", and
  // "payload" carries the whole channel map as a JSON string so a script can
  // look up a channel whose name it only learns at runtime. A channel with one
  // of these names would collide, so it is skipped.
  var RESERVED = { action: true, payload: true };

  function reserved(key, cfg) {
    var k = String(key).toLowerCase();
    if (k === "payload") return !!cfg.includePayload;
    return RESERVED[k] === true;
  }

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
    this.webhookId = cfg.xtoysWebhookId;
    this.includePayload = cfg.includePayload;
    this.logged = {};
    this.onCommand = null;
    this.action = cfg.xtoysAction;
    this.heartbeatKey = cfg.heartbeatKey;
    this.heartbeatMs = cfg.heartbeatMs;
    this.heartbeatTimer = null;
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
    this.startHeartbeat();
  };

  // A deadman switch. It deliberately keeps running while playback is paused,
  // so the XToys side can tell "paused" (heartbeats, no axis values) apart from
  // "the browser is gone" (nothing at all) and shut its outputs down only for
  // the latter. Closing the tab, crashing, or losing the network all stop these.
  XToysSink.prototype.startHeartbeat = function () {
    if (this.heartbeatTimer !== null || !this.heartbeatKey || !this.heartbeatMs) {
      return;
    }
    var self = this;
    this.heartbeatTimer = setInterval(function () {
      var beat = {};
      beat[self.heartbeatKey] = 1;
      self.send(beat, "heartbeat");
    }, this.heartbeatMs);
  };

  XToysSink.prototype.stopHeartbeat = function () {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
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
      // name the webhook, so it can be compared against the one the XToys
      // Webhook block is bound to - a manifest cannot carry that binding, so
      // the two drifting apart looks exactly like nothing happening
      console.log(LOG, "XToys socket open, webhook id: " + self.webhookId);

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
        return;
      }
      // XToys only sends these when the webhook connection has "Script can send
      // outbound messages" ticked, and only over a websocket.
      if (parsed && self.onCommand) {
        console.log(LOG, "from XToys:", e.data);
        self.onCommand(parsed);
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

  XToysSink.prototype.send = function (values, action) {
    if (!this.ws || this.ws.readyState !== 1) return;

    var payload = {};
    Object.keys(values).forEach(function (k) {
      payload[k] = String(values[k]);
    });

    // XToys requires an action key on every webhook message; it selects which
    // trigger fires.
    //
    // "payload" repeats the same channel map as one JSON string, and is off by
    // default because it doubles every frame. It only helps the block-and-
    // trigger route, where bindings are static and so cannot read a channel
    // named at runtime. A script using registerTrigger gets the whole map in its
    // callback and has no use for it.
    if (this.action) {
      if (this.includePayload) payload.payload = JSON.stringify(payload);
      payload.action = action || this.action;
    }

    try {
      var frame = JSON.stringify(payload);

      // Log the first frame of each kind. Axis updates run at 10Hz, so logging
      // every one is useless - but seeing one of each is exactly what you need
      // to line the keys up with an XToys script.
      var kind = payload.action || "(no action)";
      if (!this.logged[kind]) {
        this.logged[kind] = true;
        console.log(LOG, "first " + kind + " frame:", frame);
      }

      // the trailing newline is part of the protocol, not cosmetic
      this.ws.send(frame + "\n");
    } catch (e) {
      console.error(LOG, "XToys send failed", e);
    }
  };

  /* ----------------------------------------------------------------- runner */

  // A standalone message rather than a key mixed in with the axis values, so a
  // script can match on it without having to ignore it everywhere else.
  // A jump larger than this is a seek rather than ordinary playback. Generous
  // enough to survive a slow tick or 2x playback at the default 10Hz.
  var SEEK_GAP_MS = 1000;

  function isEmpty(o) {
    for (var k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) return false;
    }
    return true;
  }

  function pauseEvent(key, paused) {
    var e = {};
    e[key] = paused ? 1 : 0;
    return e;
  }

  function AuxAxisRunner(sink, cfg) {
    this.sink = sink;
    this.cfg = cfg;
    this.intervalMs = Math.max(20, Math.round(1000 / cfg.updateHz));

    this.axes = [];
    this.timer = null;
    this.last = null;        // every channel's last sampled value
    this.sent = null;        // every channel's last value actually sent
    this.lastTickMs = null;  // previous sample position, to spot a seek
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
      if (reserved(ax.key, cfg)) {
        console.warn(
          LOG,
          'skipping channel "' + ax.key + '": that name is reserved by the message envelope'
        );
        return;
      }
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

  AuxAxisRunner.prototype.names = function () {
    var out = [];
    this.axes.forEach(function (ax) {
      out.push(ax.key);
    });
    return out;
  };

  AuxAxisRunner.prototype.start = function () {
    if (this.timer !== null || !this.hasAxes) return;
    this.sink.open();

    // Paired with the pause event below, so a script that halted on pause has
    // something to resume on. The timer guard above means this fires once per
    // real transition, not on every play() the player emits.
    if (this.cfg.pauseKey) this.sink.send(pauseEvent(this.cfg.pauseKey, false), "pause");

    var self = this;
    this.timer = setInterval(function () {
      self.tick();
    }, this.intervalMs);
  };

  AuxAxisRunner.prototype.stop = function () {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;

    // Three things can happen on stop, and they compose:
    //
    //   Stop Value  - park every channel at a set value. Zero is not a neutral
    //                 for every axis (50 is centre for roll and pitch, 0 is off
    //                 for a vibe), so this is opt-in.
    //   Pause Event - a single message your script can halt on, rather than
    //                 inferring a stop from values that went quiet.
    //   neither     - hold the last values, so nothing lurches.
    var stop = this.cfg.stopValue;
    var pauseKey = this.cfg.pauseKey;

    if (this.last && stop !== null) {
      var parked = {};
      Object.keys(this.last).forEach(function (k) {
        parked[k] = stop;
      });
      this.sink.send(parked);
    } else if (this.last && !pauseKey) {
      this.sink.send(this.last);
    }

    if (pauseKey) this.sink.send(pauseEvent(pauseKey, true), "pause");

    this.last = null;
    this.sent = null;
    this.lastTickMs = null;
  };

  AuxAxisRunner.prototype.sample = function (ms) {
    var values = {};
    this.axes.forEach(function (ax) {
      var v = ax.timeline.valueAt(ms);
      if (v !== null) values[ax.key] = Math.round(v);
    });
    return values;
  };

  // Only the channels that actually moved. XToys merges trigger data rather than
  // replacing it, so a channel left out keeps its previous value on that side -
  // which is exactly right when it has not moved, and cuts most of the traffic
  // on a script where one axis is busy and the others are still.
  AuxAxisRunner.prototype.delta = function (values) {
    var sent = this.sent;
    var deadband = this.cfg.deadband;
    var out = {};

    Object.keys(values).forEach(function (k) {
      if (sent[k] === undefined || Math.abs(values[k] - sent[k]) >= deadband) {
        out[k] = values[k];
      }
    });

    return out;
  };

  // A partial frame is only safe while playback is continuous. After a seek the
  // other side's held values describe a position we are no longer at, and a
  // channel that happens to land on its previous value would never be corrected.
  AuxAxisRunner.prototype.discontinuous = function (ms) {
    if (this.sent === null || this.lastTickMs === null) return true;
    if (ms < this.lastTickMs) return true;              // seeked backwards
    if (ms - this.lastTickMs > SEEK_GAP_MS) return true; // seeked forwards
    return Date.now() - this.lastSentAt >= this.cfg.maxIdleMs;
  };

  AuxAxisRunner.prototype.tick = function () {
    var player = InteractiveUtils.getPlayer();
    if (!player || player.paused()) return;

    // Read the clock every tick rather than tracking it from play(position).
    // ScenePlayer has no `seeked` handler, so this is what makes seeking work.
    var ms = player.currentTime() * 1000 + this.cfg.offsetMs;
    var values = this.sample(ms);
    var full = this.discontinuous(ms);
    var payload = full ? values : this.delta(values);

    this.lastTickMs = ms;
    this.last = values;

    if (!full && isEmpty(payload)) return;

    // only channels actually sent are remembered, so a value skipped by the
    // deadband is still compared against what the other side last heard
    if (this.sent === null) this.sent = {};
    var sent = this.sent;
    Object.keys(payload).forEach(function (k) {
      sent[k] = payload[k];
    });

    this.lastSentAt = Date.now();
    this.sink.send(payload);
  };

  /* ----------------------------------------------------------------- remote */

  // The socket runs both ways, so an XToys script can double as a remote: we
  // publish what the player is doing, and accept playback commands back.
  //
  // Commands are off by default. Whoever holds the XToys session can start,
  // stop and seek your player, which is the entire point when someone else is
  // driving a session - but it should be a deliberate choice, not a default.
  function PlayerRemote(sink, cfg) {
    this.sink = sink;
    this.cfg = cfg;
    this.timer = null;
    this.sceneId = null;
    this.title = "";
    this.channels = [];
    this.peers = [];
    this.last = null;
  }

  PlayerRemote.prototype.setChannels = function (names) {
    this.channels = names || [];
    this.last = null;
    this.publish();
  };

  PlayerRemote.prototype.setScene = function (url) {
    var m = /\/scene\/([^\/?#]+)\//.exec(String(url));
    var id = m ? m[1] : null;
    if (!id || id === this.sceneId) return;

    this.sceneId = id;
    this.title = "";
    this.channels = [];
    this.last = null;

    var self = this;
    try {
      var api = window.PluginApi;
      api.utils.StashService.getClient()
        .query({ query: api.GQL.FindSceneDocument, variables: { id: id } })
        .then(function (r) {
          var sc = r && r.data && r.data.findScene;
          if (!sc) return;
          var file = sc.files && sc.files[0];
          self.title = sc.title || (file && file.basename) || "Scene " + id;
          // republish straight away rather than leaving the title blank on
          // screen until the next status tick
          self.last = null;
          self.publish();
        })
        .catch(function (e) {
          console.warn(LOG, "could not read the scene title", e);
        });
    } catch (e) {
      console.warn(LOG, "could not read the scene title", e);
    }
  };

  PlayerRemote.prototype.start = function () {
    if (this.timer !== null || !this.cfg.statusMs) return;
    var self = this;
    this.publish();
    this.timer = setInterval(function () {
      self.publish();
    }, this.cfg.statusMs);
  };

  PlayerRemote.prototype.publish = function () {
    var p = InteractiveUtils.getPlayer();
    if (!p) return;

    var duration = p.duration();
    var status = {
      title: this.title,
      scene: this.sceneId || "",
      position: Math.round(p.currentTime() || 0),
      duration: Math.round(isFinite(duration) ? duration : 0),
      playing: p.paused() ? 0 : 1,
      rate: p.playbackRate ? p.playbackRate() : 1,
      // what this scene actually carries, so a remote can list the names that
      // are worth mapping to an output instead of the user guessing
      channels: this.channels.join(","),
    };

    // position ticks every second anyway, so only skip when truly unchanged
    var key = [
      status.title, status.position, status.duration, status.playing,
      status.channels, status.rate,
    ].join("|");
    if (key === this.last) return;
    this.last = key;

    this.sink.send(status, "status");
  };

  // XToys puts the action name in webhookAction and any extra fields in
  // webhookData, which with format "raw" is a k=v&k=v string. Accept that as
  // well as a plain {action: ...} object, since the exact envelope XToys wraps
  // an outbound message in is not documented.
  function normaliseCommand(msg) {
    if (!msg || typeof msg !== "object") return null;

    var out = {};
    var key;
    for (key in msg) {
      out[key] = msg[key];
    }

    if (!out.action && msg.webhookAction) out.action = msg.webhookAction;

    var raw = msg.webhookData;
    if (typeof raw === "string" && raw !== "") {
      if (raw.charAt(0) === "{") {
        try {
          var parsed = JSON.parse(raw);
          for (key in parsed) {
            if (out[key] === undefined) out[key] = parsed[key];
          }
        } catch (e) {
          // fall through to the k=v form
        }
      } else {
        var pairs = raw.split("&");
        for (var i = 0; i < pairs.length; i++) {
          var eq = pairs[i].indexOf("=");
          if (eq > 0) {
            var k = pairs[i].slice(0, eq);
            if (out[k] === undefined) out[k] = pairs[i].slice(eq + 1);
          }
        }
      }
    }

    return out;
  }

  // Playback rate bounds. Chrome refuses rates outside roughly 0.0625-16, and
  // anything past these is not useful for watching anyway.
  var RATE_MIN = 0.25;
  var RATE_MAX = 2;

  function setRate(player, rate) {
    var r = clamp(rate, RATE_MIN, RATE_MAX);
    // round to the nearest 0.05 so a slider does not report 1.2999999999
    r = Math.round(r * 20) / 20;
    player.playbackRate(r);
  }

  // XToys announces session membership over the same socket:
  //   {"event":"join","type":"guest","uid":"rezreal"}
  // Worth surfacing - it is the only signal of who is on the other end, which
  // matters when someone else is driving the session.
  PlayerRemote.prototype.session = function (msg) {
    if (!msg || !msg.event) return false;

    var uid = String(msg.uid || "?");
    var kind = String(msg.type || "peer");

    if (msg.event === "join") {
      if (this.peers.indexOf(uid) === -1) this.peers.push(uid);
      console.log(LOG, "XToys " + kind + " joined: " + uid +
                  " (" + this.peers.length + " connected)");
    } else if (msg.event === "leave") {
      var at = this.peers.indexOf(uid);
      if (at !== -1) this.peers.splice(at, 1);
      console.log(LOG, "XToys " + kind + " left: " + uid +
                  " (" + this.peers.length + " connected)");
    } else {
      return false;
    }

    return true;
  };

  PlayerRemote.prototype.command = function (raw) {
    if (this.session(raw)) return;

    // deliberately after the session check: knowing who is connected is not
    // remote control, and is useful even with commands disabled
    if (!this.cfg.remoteControl) return;

    var msg = normaliseCommand(raw);
    var action = String((msg && msg.action) || "").toLowerCase();
    if (!action) return;

    var p = InteractiveUtils.getPlayer();
    if (!p) return;

    var duration = p.duration();
    duration = isFinite(duration) ? duration : 0;

    function seekTo(t) {
      if (t < 0) t = 0;
      if (duration && t > duration) t = duration;
      p.currentTime(t);
    }

    switch (action) {
      case "play":
        p.play();
        break;
      case "pause":
        p.pause();
        break;
      case "toggle":
        if (p.paused()) p.play();
        else p.pause();
        break;
      case "seek":
        if (msg.percent !== undefined && duration) {
          seekTo((num(msg.percent, 0) / 100) * duration);
        } else if (msg.position !== undefined) {
          seekTo(num(msg.position, 0));
        }
        break;
      case "skip":
        seekTo((p.currentTime() || 0) + num(msg.seconds, 0));
        break;
      case "rate":
        // absolute when given a rate, otherwise a slider position mapped across
        // the useful range - a 0-100 control cannot express 1.0x on its own
        if (msg.rate !== undefined) {
          setRate(p, num(msg.rate, 1));
        } else if (msg.percent !== undefined) {
          var pct = clamp(num(msg.percent, 50), 0, 100) / 100;
          setRate(p, RATE_MIN + pct * (RATE_MAX - RATE_MIN));
        }
        break;
      default:
        return; // not ours; axes/pause/heartbeat echo back harmlessly
    }

    this.publish();
  };

  /* ----------------------------------------------------------------- client */

  function RouterClient(handy, runner, remote) {
    this.handy = handy;
    this.runner = runner;
    this.remote = remote;
    // stash gates the whole interactive pipeline on a non-empty handyKey (see
    // context.tsx uploadScript and ScenePlayer's `interactiveClient.handyKey`
    // check), so when there is no Handy we hand it a sentinel.
    //
    // It has to *change* on each configure() rather than just be non-empty.
    // context.tsx only calls initialise() when the key differs from what it was
    // before the call - a constant sentinel never trips that, so nothing ever
    // initialises and no script is ever uploaded. And initialise() reads
    // serverOffset from a stale closure, so the first call only syncs and the
    // second is the one that connects. Changing the key until connect() lands
    // gets both calls; after that it settles and stops re-initialising.
    this.fallbackKey = "";
    this.keySeq = 0;
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
      console.log(LOG, "interactive client ready");
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
    if (!this.handy && !this.up) {
      this.keySeq++;
      this.fallbackKey = PLUGIN_ID + "-" + this.keySeq;
    }
    return Promise.resolve(this.handy ? this.handy.configure(c) : undefined);
  };

  RouterClient.prototype.uploadScript = function (url, apiKey) {
    var self = this;
    this.runner.stop();
    console.log(LOG, "loading", url);

    if (this.remote) {
      this.remote.setScene(url);
      this.runner.sink.open();
      this.remote.start();
    }

    var load = fetch(withApiKey(url, apiKey), { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("funscript fetch failed: " + r.status);
        return r.json();
      })
      .then(function (json) {
        self.runner.load(json);
        if (self.remote) self.remote.setChannels(self.runner.names());
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
    if (this.remote) this.remote.publish();
    return Promise.resolve(this.handy ? this.handy.play(pos) : undefined);
  };

  RouterClient.prototype.pause = function () {
    this.runner.stop();
    if (this.remote) this.remote.publish();
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

    // unset falls back to "heartbeat"; explicitly blank disables the deadman
    var heartbeatKey = String(
      raw.heartbeatKey === undefined || raw.heartbeatKey === null
        ? "heartbeat"
        : raw.heartbeatKey
    ).trim();
    var heartbeatMs = clamp(num(raw.heartbeatMs, 1000), 200, 60000);

    // unset falls back to "pause"; explicitly blank disables the event
    var pauseKey = String(
      raw.pauseKey === undefined || raw.pauseKey === null ? "pause" : raw.pauseKey
    ).trim();

    // Off means "let the Handy have the stroke axis if one is configured"; this
    // plugin still takes it when there is no Handy, since otherwise nothing
    // would play it at all.
    var routeStrokeAxis = raw.routeStrokeAxis === true || raw.routeStrokeAxis === "true";

    return {
      routeStrokeAxis: routeStrokeAxis,
      xtoysWebhookId: String(raw.xtoysWebhookId || "").trim(),
      xtoysToken: String(raw.xtoysToken || "").trim(),
      includePayload: raw.includePayload === true || raw.includePayload === "true",
      xtoysAction: String(
        raw.xtoysAction === undefined || raw.xtoysAction === null ? "axes" : raw.xtoysAction
      ).trim(),
      stopValue: stopValue,
      pauseKey: pauseKey,
      heartbeatKey: heartbeatKey,
      heartbeatMs: heartbeatMs,
      remoteControl: raw.remoteControl === true || raw.remoteControl === "true",
      statusMs: clamp(num(raw.statusMs, 1000), 0, 60000),
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

    // When the box is ticked we decline the Handy even if one is configured: it
    // plays its uploaded script off *server* time while everything else is
    // ticked from the browser clock, so the only way to keep the axes in phase
    // is for one clock to drive all of them.
    var useHandy = !cfg.routeStrokeAxis && hasHandy;

    var handy =
      useHandy && opts.defaultClientProvider ? opts.defaultClientProvider(opts) : null;

    cfg.routeStroke = cfg.routeStrokeAxis || !handy;

    if (cfg.routeStrokeAxis && hasHandy) {
      console.warn(
        LOG,
        "Route Stroke Axis Here is on, so the configured Handy will not be used at all."
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

    var sink = new XToysSink(cfg);
    var runner = new AuxAxisRunner(sink, cfg);
    var remote = cfg.statusMs || cfg.remoteControl ? new PlayerRemote(sink, cfg) : null;

    if (remote) {
      sink.onCommand = function (m) {
        remote.command(m);
      };
      if (cfg.remoteControl) {
        console.log(LOG, "remote control enabled - XToys can drive this player");
      }
    }

    // Connect as soon as the plugin loads rather than waiting for a scene.
    // stash's interactive pipeline has to initialise before uploadScript is
    // ever called, and that is a long chain to be silently stuck in - an open
    // socket is something you can actually see.
    if (cfg.xtoysWebhookId) sink.open();

    return new RouterClient(handy, runner, remote);
  };
})();
