import { type Media, type Slide, type SlideDrawing, slideContent } from '@ordo/domain';
import { stillHash } from '../../services/thumbs.ts';

/** What the editor canvas draws of a slide, with the file of its picture. */
export type CanvasContent = SlideDrawing & {
  /** The file hash of `pictureMediaId` (an image itself, a video's poster), when the library has it. */
  pictureHash?: string;
};

/**
 * What the editor's slide canvas draws (design/27 §5, §7.4): what every screen draws (`slideContent`), so
 * the editor shows the slide as the outputs will. A slide set to show its PowerPoint picture shows that
 * picture and only the objects added in ordo, which are the ones the canvas can select; a picture slide
 * shows its page picture under its objects.
 */
export function canvasContent(slide: Slide, media: (id: string) => Media | undefined): CanvasContent {
  const drawn = slideContent(slide);
  const pictureHash = drawn.pictureMediaId ? stillHash(media(drawn.pictureMediaId)) : undefined;
  return pictureHash ? { ...drawn, pictureHash } : drawn;
}
