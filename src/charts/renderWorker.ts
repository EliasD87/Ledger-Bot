/**
 * The chart helper process: turns SVGs into PNGs on request. It runs apart from the bot so the image
 * library's memory is handed back to the system when the bot recycles it (see pool.ts).
 */
import { toBarGif } from './barGif.js';
import { toPng } from './render.js';

process.on('message', (msg: { id: number; svg: string; gif?: boolean }) => {
  try {
    // "png" carries whichever image was asked for: a PNG, or the bar question's animated GIF.
    process.send!({ id: msg.id, png: msg.gif ? toBarGif(msg.svg) : toPng(msg.svg) });
  } catch (err) {
    process.send!({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
process.on('disconnect', () => process.exit(0));
