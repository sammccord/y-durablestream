---
"y-durablestream": minor
---

`YStreamClient` status now becomes `"disconnected"` once per `connect()` call, after the connection and any reconnect attempts have ended; between attempts it goes straight to `"reconnecting"`. Previously it reported `"disconnected"` after every failed attempt, so a listener that called `connect()` on `"disconnected"` started overlapping reconnect loops that could exhaust memory.
