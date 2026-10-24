import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const FONTS = ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-SemiBold.ttf'].map((name) =>
  fileURLToPath(new URL(`../../assets/fonts/${name}`, import.meta.url)),
);

/** An SVG chart as a PNG at twice its size, so it stays sharp on high-density screens. */
export function toPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: 2 },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' },
  });
  return resvg.render().asPng();
}
