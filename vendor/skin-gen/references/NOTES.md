# Open-source skin generator designs (research notes)

## Monadical minecraft_skin_generator (SDXL fine-tune, text→skin)

Source: `references/monadical/bin/minecraft-skins-sdxl.py`

- Model emits a 768x768 image; the skin atlas occupies the TOP HALF at ~12x scale
  of the legacy 64x32 layout.
- Post-processing (the part relevant to us):
  1. Crop top half, `resize((64,32), Image.NEAREST)` — nearest-neighbor, not
     dominant-color.
  2. Transparency restore: sample "background regions" that are never rendered
     ((32,0,40,8) and (56,0,64,8) — the hat-layer corners) to estimate the
     background color, then in each overlay (hat) region set pixels within
     Cartesian RGB distance <= 50 of that color to transparent.
  3. Whitespace enforcement: alpha-composite a hand-made mask
     (`images/half-transparency-mask.png`) that blanks all never-rendered areas.
- Layout reference they cite: https://github.com/minotar/skin-spec
- License: GPL-3.0 (scripts). We take design ideas only, no code.

## BLOCK / AliceKJ-BLOCKv0.5 (bi-stage MLLM→FLUX, image→skin)

Source: arxiv 2603.03964, HF model card AliceKJ/BLOCKv0.5 (CC BY 4.0)

- Stage 1: Nano Banana Pro (Gemini image model) converts an arbitrary character
  reference into a CANONICAL DUAL-PANEL PREVIEW: front + back full-body
  Minecraft-style renders, fixed framing/pose, 512x512 RGB.
- Stage 2: FLUX.2 LoRA translates preview → 512x512 atlas image, then
  deterministic downsample to 64x64 RGBA.
- Stage 2 prompt (from model card): "Reference-based image-to-image. Input is a
  front+back 3D Minecraft character reference image. Output a Minecraft skin UV
  texture atlas (64x64 pixel art layout)... anime-inspired, sharp edges, slim".
- Key takeaways for us:
  - Canonicalization first (any image → fixed front+back Minecraft render) is
    what makes the geometry problem tractable. Nano Banana is good at this.
  - The atlas step is the hard part; BLOCK needed a fine-tune. Our bet: Nano
    Banana Pro *itself* can emit the atlas when given a real skin atlas
    (Steve/Alex) as an in-context layout reference — or, failing consistency,
    we map the front+back panel to the atlas deterministically in code.
  - Their trained output is 512x512 → downsampled 8x to 64x64. We adopt the
    same 8x working scale.

## Our pipeline (lightweight, no local diffusion)

```
character image
  → [Gemini Nano Banana Pro]
      Branch A (preferred): emit flat 512x512 UV atlas, Steve/Alex atlas
        given as layout reference image
      Branch B (fallback): emit canonical front+back dual panel on a fixed
        grid → deterministic panel→atlas projection in code (sides/top/bottom
        synthesized from edge colors)
  → dominant-color (mode) downsample 8x → 64x64
  → enforce layout: blank whitespace, opaque base layer, alpha-restore overlays
  → validate → skin.png (+ preview render)
```

Format target: modern 64x64 RGBA (what Sei ships in resources/skins). Classic
(4px arms) by default.
