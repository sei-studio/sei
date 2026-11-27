# Sea looks

Look files for `scripts/render-sea-loop.mjs`, which bakes Fleet Battle's water
video (`src/renderer/src/components/battleship/three/sea-loop.mp4`).

A look names a tileable 1024x1024 texture (relative to the look file) and how
to scroll and color it:

- `tileA`, `tileB`: on-screen size in pixels of one tile of each layer, at the
  default 1920x960 output.
- `rotA`, `rotB`: layer angles in degrees.
- `dirA`, `dirB`: drift per loop in whole tiles of that layer's lattice. Keep
  them integers or the loop is not seamless.
- `mixB`: weight of layer B.
- `normal: true`: the texture is a normal map, lit into the `lo`/`mid`/`hi`
  ramp, with `bump` and `contrast`. Otherwise the texture is a color map, graded
  by `contrast` and `mul` (or mapped onto the ramp by luminance with
  `palette: true`).
- `swell`: strength of the very slow lighter and darker bands.

## Sources

`water-002-normal.jpg` is the normal map of "Water 002" by Katsukagi,
3dtextures.me (https://3dtextures.me/2018/11/29/water-002/), unchanged.
License: CC0 ("All textures on this site are licensed as CC0",
https://3dtextures.me/about/). No attribution required.
