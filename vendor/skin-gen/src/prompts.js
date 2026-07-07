// Prompt templates for Nano Banana Pro.

// Branch A: direct flat UV atlas, with a real skin atlas as layout reference.
export const ATLAS_PROMPT = `TASK: Create a Minecraft player skin texture atlas for the character shown in the SECOND image.

The FIRST image is a real Minecraft skin texture atlas (64x64 format, shown upscaled 8x to 512x512). Use it as an exact LAYOUT REFERENCE: your output must place every body-part region in exactly the same position as the reference — head faces in the top-left block, hat/overlay layer in the top-right block, right leg / body / right arm in the middle band, left leg / left arm and their overlays in the bottom band.

OUTPUT REQUIREMENTS:
- A single flat 2D texture atlas. NOT a 3D character render, NOT a character preview, no mannequin. No text, no labels, no grid lines, no borders.
- Same layout as the reference: wherever the reference has background, output background; wherever the reference has a textured body-part face, output the character's corresponding texture.
- Background (unused areas): solid pure black #000000.
- Blocky pixel-art style with hard square edges, as if a 64x64 image were upscaled with nearest-neighbor. No gradients, no anti-aliasing.
- Texture content: the character's face on the head front face; their hair color and style on the head top/sides/back and on the hat layer; their clothing on the body and arms; lower clothing and footwear on the legs.
- Classic 4-pixel-wide arms. Keep colors flat and consistent.`;

// Branch B stage 1: canonical dual-panel preview (BLOCK-style), used if the
// direct-atlas branch proves inconsistent.
export const PANEL_PROMPT = `TASK: Render the character from the image as a Minecraft player character (blocky, cubic limbs, pixel-art texture), shown as TWO full-body orthographic views side by side on a solid magenta (#FF00FF) background: FRONT view on the left half, BACK view on the right half.

STRICT LAYOUT: square image; each view centered in its half; character standing straight, arms at sides, legs together; head top at 5% image height, feet at 95%; no shadows, no props, no text, no ground; nothing magenta on the character itself.

HEAD AND FACE (most important): the head is a single clear cube occupying EXACTLY the top quarter (top 25%) of the standing figure, from the crown down to the neck; the shoulders and body begin at exactly one quarter of the way down. Everything that belongs to the head — the hair on top, any cat ears, horns, or hat, AND the face — must fit INSIDE that top quarter. Nothing may extend above the crown: the single topmost pixel of the whole character is the top of the head/hair, and ear tips, hair tufts, and accessories sit within the head cube, never poking above it. The two eyes and the mouth sit near the VERTICAL MIDDLE of the head cube (roughly 12-18% down the image), clearly above the neck line, and must NEVER fall onto the neck, shoulders, or body. Draw the face plain and readable: two clearly separated eyes and a mouth, front-facing and centered on the head cube. Even with long hair, heavy bangs, or a fringe, keep the eyes fully visible; hair frames the face around the edges but must not cover the eyes or the center of the face. The face is never mostly hair. Do not draw a portrait or close-up: it is a full-body character and the head is only the top quarter, with body, arms and legs filling the lower three quarters.

The character's face, hair, clothing and colors must match the input character faithfully, translated into Minecraft pixel-art style.`;
