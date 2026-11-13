# Third-party notices for the Sei companion Factorio mod

The mod in this folder is MIT licensed (see `LICENSE`). Parts of it were
adapted from the following MIT-licensed projects. Their copyright notices and
license terms are reproduced here, as those licenses require.

## factorio-serf

- Source: https://github.com/stirby/factorio-serf (commit 51b106c)
- License: MIT, Copyright (c) 2026 Stephen Kirby (full text below).
- Used for: the UDP framing, chunking, per-machine outbox and per-player
  `recv_udp` loop (`scripts/link.lua`); walking with the game's pathfinder
  (`scripts/movement.lua`); the script-character body, its chunk requests and
  leave/rejoin (`scripts/body.lua`); the mining and crafting jobs
  (`scripts/verbs.lua`); and the small geometry and inventory helpers
  (`scripts/util.lua`).
- Modifications: rewritten around one companion per player with reflexes
  (follow, defend, retreat, respawn), a request-id reply cache, an event feed
  read by polling, and the verbs the Sei app calls.

```
MIT License

Copyright (c) 2026 Stephen Kirby

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Factorio Learning Environment (FLE)

- Source: https://github.com/JackHopkins/factorio-learning-environment (commit e2a829d)
- License: MIT, Copyright (c) 2025 Factorio Learning Environment Contributors
  (full text below).
- Used for: the recursive "what is missing to craft this" check and the
  harvest queue shape (`scripts/verbs.lua`, the craft and gather verbs).
- Modifications: rewritten in the mod's job engine; no FLE code runs outside it.

```
MIT License

Copyright (c) 2025 Factorio Learning Environment Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### License Notes

- The MIT License is a permissive license that allows for reuse with minimal restrictions
- This license applies to the Factorio Learning Environment code and documentation
- Factorio game assets and code are not covered by this license
- Contributors should ensure they have the right to license their contributions under MIT
```

## Design references (no code used)

Factorio LLM Use (the request-id rule: a resent request is answered from a
cache so an action never runs twice) and Factorio's own modding API
documentation informed the design. No code was copied from them.
