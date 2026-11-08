import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { toRgba } from './render.js';

/**
 * The bar question's picture: its chart in neon bar colours over the bar scene (an animated pixel-art
 * GIF), dimmed so the chart reads clearly. Runs in the chart helper process, like every other drawing.
 */

const SCENE = fileURLToPath(new URL('../../assets/bar/bar-scene.gif', import.meta.url));
/** A dark plum wash over the scene, so lines and text stand out. */
const OVERLAY = { r: 20, g: 9, b: 24, a: 0.74 };

/** The chart's colours swapped for the bar's: lime and pink neon on plum, no panel of its own. */
const BAR_INK: [string, string][] = [
  ['#8ea2ff', '#c9f37f'], // main line: the fridge-light lime
  ['#c9a46a', '#ff9ad5'], // second line: the neon pink
  ['#f0b232', '#ff9ad5'], // target
  ['#e6e7ea', '#fbeefc'], // title
  ['#9a9ea7', '#e4cbe9'], // subtitle, marks
  ['#8b8f98', '#d6bcdc'], // axis
  ['#5c6068', '#b996c0'], // fine print
  ['#2c2e34', '#5b3a61'], // grid
  ['#1e1f23', '#1c0e21'], // tag backings
];

export function barTheme(svg: string): string {
  // No panel: the scene is the background.
  let out = svg.replace(/<rect width="\d+" height="\d+" rx="16" fill="#1e1f23"\/>/, '');
  for (const [from, to] of BAR_INK) out = out.split(from).join(to);
  return out;
}

interface Scene {
  width: number;
  height: number;
  frames: { rgba: Uint8ClampedArray; delay: number }[];
}
let scene: Scene | null = null;

/** The scene's frames as full pictures (a GIF frame may only redraw part of the picture). */
function loadScene(): Scene {
  if (scene) return scene;
  const file = readFileSync(SCENE);
  const gif = parseGIF(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
  const { width, height } = gif.lsd;
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: Scene['frames'] = [];
  for (const f of decompressFrames(gif, true)) {
    const { left, top, width: w, height: h } = f.dims;
    const before = f.disposalType === 3 ? canvas.slice() : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 4;
        if (f.patch[src + 3] === 0) continue;
        const dst = ((top + y) * width + left + x) * 4;
        canvas[dst] = f.patch[src]!;
        canvas[dst + 1] = f.patch[src + 1]!;
        canvas[dst + 2] = f.patch[src + 2]!;
        canvas[dst + 3] = 255;
      }
    }
    frames.push({ rgba: canvas.slice(), delay: f.delay || 100 });
    if (f.disposalType === 2) {
      for (let y = 0; y < h; y++) canvas.fill(0, ((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4);
    } else if (before) canvas.set(before);
  }
  scene = { width, height, frames };
  return scene;
}

/** The chart over every frame of the bar scene, as an animated GIF. */
export function toBarGif(svg: string): Buffer {
  const { width, height, frames } = loadScene();
  const chart = toRgba(barTheme(svg), width, height);
  const composed = frames.map(({ rgba, delay }) => {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < out.length; i += 4) {
      const a = chart[i + 3]! / 255;
      for (let c = 0; c < 3; c++) {
        const washed = rgba[i + c]! * (1 - OVERLAY.a) + [OVERLAY.r, OVERLAY.g, OVERLAY.b][c]! * OVERLAY.a;
        // The chart's pixels come premultiplied by their alpha.
        out[i + c] = washed * (1 - a) + chart[i + c]!;
      }
      out[i + 3] = 255;
    }
    return { rgba: out, delay };
  });
  // One palette for every frame, from a few frames together, so colours don't flicker between frames.
  const sample = new Uint8ClampedArray(composed.length >= 3 ? 3 * width * height * 4 : composed[0]!.rgba.length);
  [0, Math.floor(composed.length / 2), composed.length - 1].slice(0, composed.length >= 3 ? 3 : 1).forEach((k, n) => sample.set(composed[k]!.rgba, n * width * height * 4));
  const palette = gifenc.quantize(sample, 256);
  const encoder = gifenc.GIFEncoder();
  composed.forEach(({ rgba, delay }, k) => {
    encoder.writeFrame(gifenc.applyPalette(rgba, palette), width, height, k === 0 ? { palette, delay, repeat: 0 } : { delay });
  });
  encoder.finish();
  return Buffer.from(encoder.bytes());
}
