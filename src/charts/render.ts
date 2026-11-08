import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { hasHan } from '../lang.js';

const font = (name: string) => fileURLToPath(new URL(`../../assets/fonts/${name}`, import.meta.url));
const FONTS = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf'].map(font);
/** Noto Sans SC is large (8 MB a weight): loaded only for charts with Chinese in them. */
const CHINESE = ['NotoSansSC-Regular.otf', 'NotoSansSC-Medium.otf'].map(font);

/** An SVG chart as a PNG at twice its size, so it stays sharp on high-density screens. */
export function toPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: 2 },
    font: { fontFiles: hasHan(svg) ? [...FONTS, ...CHINESE] : FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' },
  });
  return resvg.render().asPng();
}

/** An SVG drawn to exactly `width` × `height` as RGBA pixels (premultiplied by alpha), for compositing. */
export function toRgba(svg: string, width: number, height: number): Uint8ClampedArray {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: hasHan(svg) ? [...FONTS, ...CHINESE] : FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' },
  });
  const image = resvg.render();
  const px = new Uint8ClampedArray(width * height * 4);
  // A chart taller than the scene (a key under it) is cut at the scene's edge.
  const rows = Math.min(height, image.height);
  px.set(image.pixels.subarray(0, rows * image.width * 4).subarray(0, rows * width * 4));
  return px;
}
