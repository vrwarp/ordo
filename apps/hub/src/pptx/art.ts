/**
 * Worker side of the `pptx-art` pool task (design/27 §2, §5 step 4; M3 item D): a hybrid slide's
 * transparent art picture from the same page printed twice by LibreOffice, over a forced white background
 * and over a forced black one.
 *
 * Per pixel and channel c (0-255): alpha = 1 − max_c(white_c − black_c)/255, and colour_c = black_c / alpha
 * (0 where alpha is 0), clamped to 0-255. Only `input.box` is considered; the result is cropped to the
 * bounding box of the pixels whose alpha is not 0. Pure arithmetic over the two rasters: no decoding here
 * (the job hands over raw pixels and encodes the PNG).
 */
import type { ArtTaskInput, ArtTaskOutput } from './shared.ts';
import { notYet } from './shared.ts';

export function artTask(input: ArtTaskInput): ArtTaskOutput {
  void input;
  throw notYet('D', 'the pptx-art task');
}
