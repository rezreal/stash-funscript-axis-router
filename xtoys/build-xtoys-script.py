#!/usr/bin/env python3
"""Generates funscriptAxisRouter.xtoys.json.

The script is repetitive - eight near-identical outputs, each with its own
channel entry, config box and updateComponent action - so it is generated rather
than hand-maintained. Change N and rerun.
"""
import json
import os

N = 8
LETTERS = "abcdefgh"

# Where messages arrive. The default is a Webhook block living inside the
# script: its ID is the only credential, so no token is involved.
#
# If you would rather feed the script from a custom webhook toy you already
# created at xtoys.app/me/custom-toys, point these at it instead. The type
# string has to match whatever XToys calls that toy in a script export - export
# a script with the toy attached and copy the name out of its "channels" map.
# A Webhook block inside the script; its ID is the only credential.
INPUT_CHANNEL = "webhook-a"
INPUT_CHANNEL_DEF = {"name": "stash", "type": "webhook", "outbound": False,
                     "hideWebhookInfo": False}

# To feed the script from a custom toy instead, swap in these two lines. The
# type string is confirmed from a real export; the letter suffix must match
# whichever slot your toy occupies.
# INPUT_CHANNEL = "generic-custom-toy-b"
# INPUT_CHANNEL_DEF = {"name": "stash", "type": "generic-custom-toy"}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "funscriptAxisRouter.xtoys.json")


def generic(i):
    return "generic-1-%s" % LETTERS[i - 1]


def set_volume(i, percent, ramp, condition=None):
    a = {
        "type": "updateComponent",
        "action": "setVolume",
        "channel": generic(i),
        "rampTime": ramp,
        "percentVolume": percent,
    }
    if condition:
        a["condition"] = condition
    return a


channels = {INPUT_CHANNEL: dict(INPUT_CHANNEL_DEF)}
for i in range(1, N + 1):
    channels[generic(i)] = {"name": "out%d" % i, "type": "generic-1"}

# A Control's name is the variable it sets, so these become {channel1}..{channelN}
controls = [{"name": "channel%d" % i, "type": "input"} for i in range(1, N + 1)]
controls += [
    {"name": "rampMs", "type": "input"},
    {"name": "watchdogMs", "type": "input"},
]

initial = [{"type": "updateVariable", "variable": "out%d" % i, "value": "0"} for i in range(1, N + 1)]
initial += [
    {"type": "updateVariable", "variable": "halted", "value": "0"},
    {"type": "updateVariable", "variable": "lastBeat", "value": "0"},
    {"type": "updateJob", "job": "Watchdog", "action": "start", "restart": False},
]

# Static trigger bindings cannot name a channel that is only known at runtime,
# which is why the plugin repeats the channel map as one JSON string.
apply_code = """
var map = {};
try { map = JSON.parse(payload) || {}; } catch (e) { map = {}; }

// case-insensitive, so "Roll" in the config box finds "roll" in the script
var lower = {};
for (var k in map) { if (map.hasOwnProperty(k)) lower[String(k).toLowerCase()] = map[k]; }

function pick(name) {
  if (!name) return null;
  var v = lower[String(name).trim().toLowerCase()];
  if (v === undefined || v === null || v === "") return null;
  var n = parseFloat(v);
  if (isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

var names = [%s];
for (var i = 0; i < names.length; i++) {
  var v = pick(names[i]);
  // -1 means "leave this output alone"
  setVariable("out" + (i + 1), v === null ? -1 : v);
}
""" % ", ".join("channel%d" % i for i in range(1, N + 1))

apply_vars = [{"name": "payload", "value": "trigger-payload", "expression": None}]
apply_vars += [
    {"name": "channel%d" % i, "value": "channel%d" % i, "expression": None}
    for i in range(1, N + 1)
]

axes_trigger = {
    "type": "componentState",
    "channel": INPUT_CHANNEL,
    "action": "axes",
    "parsedAction": "axes",
    "actions": [
        {
            "type": "customCode",
            "code": apply_code,
            "variables": apply_vars,
            "resultVar": "result",
            "storeResult": False,
        },
        {"type": "updateVariable", "variable": "lastBeat", "value": "0"},
    ]
    + [
        set_volume(i, "{out%d}" % i, "{rampMs}/1000", "{out%d} >= 0 && {halted} == 0" % i)
        for i in range(1, N + 1)
    ],
}

pause_trigger = {
    "type": "componentState",
    "channel": INPUT_CHANNEL,
    "action": "pause",
    "parsedAction": "pause",
    "variables": [{"name": "paused", "value": "trigger-pause", "expression": None}],
    "actions": [
        {"type": "updateVariable", "variable": "halted", "value": "{paused}"},
        {"type": "updateVariable", "variable": "lastBeat", "value": "0"},
    ]
    + [set_volume(i, "0", "{rampMs}/1000", "{paused} == 1") for i in range(1, N + 1)],
}

heartbeat_trigger = {
    "type": "componentState",
    "channel": INPUT_CHANNEL,
    "action": "heartbeat",
    "parsedAction": "heartbeat",
    "actions": [{"type": "updateVariable", "variable": "lastBeat", "value": "0"}],
}

# Counts up in 500ms steps; any incoming message resets it. Past the timeout the
# browser is assumed gone and everything is driven to zero.
watchdog = {
    "steps": {
        "START": {
            "actions": [],
            "triggers": [
                {
                    "type": "timer",
                    "amount": "0.5",
                    "actions": [
                        {"type": "updateVariable", "variable": "lastBeat", "value": "{lastBeat}+500"}
                    ]
                    + [
                        set_volume(i, "0", "0.1", "{lastBeat} > {watchdogMs}")
                        for i in range(1, N + 1)
                    ],
                }
            ],
        }
    }
}

script = {
    "initialActions": initial,
    "finalActions": [set_volume(i, "0", "0.1") for i in range(1, N + 1)],
    "globalTriggers": [axes_trigger, pause_trigger, heartbeat_trigger],
    "jobs": {"Watchdog": watchdog},
    "queues": [],
    "channels": channels,
    "controls": controls,
    "controlPresets": [],
    "media": {"audio": {}, "voices": {}, "patterns": {}},
    "customFunctions": "",
}

with open(OUT, "w") as f:
    json.dump(script, f, indent=1)
    f.write("\n")

print("wrote %s (%d outputs)" % (OUT, N))
