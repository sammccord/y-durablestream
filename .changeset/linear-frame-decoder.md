---
"y-durablestream": patch
---

`createFrameDecoder` now decodes a frame that arrives in many chunks in linear time. It previously recopied the whole partial frame on every chunk, which cost about 480 ms of CPU for an 8 MB frame in 4 KB chunks.
