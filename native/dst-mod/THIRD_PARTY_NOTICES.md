# Third-party notices for the Sei DST helper mod

`native/dst-mod/sei` is MIT (see `sei/LICENSE`). It adapts code and design
from the projects below; nothing from Klei's own scripts is copied (they are
API reference only, per the modding guidelines).

## FAtiMA-DST (MIT)

- https://github.com/hineios/FAtiMA-DST
- Copyright (c) 2018 Fábio Almeida
- Adapted: the brain skeleton (`scripts/brains/seibrain.lua`): a
  PriorityNode whose command slot runs `DoAction` over a `BufferedAction`
  built from an external decision, with `AddSuccessAction` /
  `AddFailAction` bookkeeping and the "keep working until the `*_workable`
  tag drops" rule (`scripts/sei/commands.lua`); the perception encoder shape
  (`scripts/sei/perception.lua`: one `FindEntities` sweep excluding
  `INLIMBO/NOCLICK/CLASSIFIED/FX`, per-entity capability flags from tags,
  vitals, inventory and equip slots); the world-state watchers
  (`scripts/sei/events.lua`); `SetCanSleep(false)` on the body; the
  `TheSim:QueryServer` GET/POST transport with `(result, ok, code)`
  callbacks.

```
MIT License

Copyright (c) 2018 Fábio Almeida

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

## DST-AICompanion (MIT)

- https://github.com/votus777/DST-AICompanion
- Copyright (c) 2024 Hansae
- Adapted: the `Follow(inst, leaderfn, min, target, max)` leader wiring and
  the `RunAway(inst, hostilefn, see, safe)` low-health node placement in the
  brain's priority list (`scripts/brains/seibrain.lua`); spawning a
  survivor prefab other than Wilson with `skinner:SetSkinMode`.

```
MIT License

Copyright (c) 2024 Hansae

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

## Chat Announcements (CC0-1.0)

- https://github.com/gyroplast/mod-dont-starve-chat-announcements
- Adapted: the `TheSim:QueryServer(url, cb, "POST", json)` call shape and
  its success test (`isSuccessful and 200 <= code <= 299`) in
  `scripts/sei/net.lua`. CC0: no attribution required; listed for the
  record.

## Reference only (not copied)

- Klei Entertainment's Don't Starve Together scripts (copyrighted; read for
  API names: `BufferedAction`, `behaviours/*`, `components/builder.lua`,
  `Networking_Say`, `modsettings.lua` hooks).
- Artificial Wilson / DS-AI (unlicensed) and DST_Bridge (GPL-3.0): design
  reference for gather/light/cook loops and the chat hook; no code.
