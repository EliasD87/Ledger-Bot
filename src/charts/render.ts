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
