# Test fixtures

Everything in this folder was written by hand for this repository. None of it is a
capture of a real amplifier, cabinet or room, and none of it is copied from another
project, so the tests never depend on third-party files with unclear licences.

## `identity.nam`

The smallest Neural Amp Modeler model that does nothing: NAM's `Linear` architecture
(a plain FIR filter) with one tap of weight 1.0 and no bias.

```json
{"version":"0.5.4","architecture":"Linear","config":{"receptive_field":1,"bias":false},"weights":[1.0],"metadata":{"name":"identity"}}
```

- The schema follows NAM core's `Linear` loader (`NAM/linear.cpp`, `parse_config_json`):
  `receptive_field` and `bias` are required, the weights are the taps followed by the
  bias if there is one. `version` must be within the range NAM core accepts (0.5.0 to
  0.7.x at the commit the engine is built from).
- It has no `sample_rate`, so the engine reports the expected rate as unknown (-1) and no
  sample-rate mismatch is ever flagged for it. A one-tap filter is the same at any rate.
- It has no `loudness` metadata on purpose. The engine normalises models that report a
  loudness to -18 dB, which would move it away from unity.

What it does in the browser engine (Chromium, 2026-11-08): it loads in under 6 ms, and a
sine through it comes out at 0.000 dB. The only difference from the input is the engine's
own 10 Hz DC-blocking high-pass, which every model gets: against a reference sine through
the same one-pole high-pass, the largest sample difference is 4.5e-7.
