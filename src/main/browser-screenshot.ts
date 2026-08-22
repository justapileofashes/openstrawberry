/**
 * A picture of a page, for the rare question that text cannot answer.
 *
 * The snapshot is the primary way an agent sees a page here, and it should stay
 * that way: it is smaller, it names the things it describes, and a model reading
 * it can point at an element rather than estimate where one is. A screenshot
 * answers a different and much narrower question - is this laid out correctly,
 * what does this chart show, which of these looks selected - and it costs
 * roughly a page of text to ask.
 *
 * Two things are enforced here rather than hoped for:
 *
 *   - **A bound on the bytes.** An image goes into a transcript that is billed
 *     by the token and capped by the model's window. A full-resolution capture
 *     of a tall page on a high-density display is several megabytes, so the
 *     capture is scaled down before it is encoded, and if the encoding is still
 *     too large it is re-encoded lossily rather than sent.
 *
 *   - **Only what is on screen.** `capturePage` with no rect returns the visible
 *     viewport, which is what a person looking at the tab would see. Capturing
 *     a whole scrolling document would put parts of a signed-in page into a
 *     transcript that the user never had on screen while deciding to allow this.
 */

/** The slice of Electron's NativeImage this module needs. */
export interface CapturedImage {
  readonly isEmpty: () => boolean;
  readonly getSize: () => { readonly width: number; readonly height: number };
  readonly resize: (options: { readonly width: number }) => CapturedImage;
  readonly toPNG: () => Buffer;
  readonly toJPEG: (quality: number) => Buffer;
}

/** The slice of a WebContents this module needs. */
export interface ScreenshotContentsPort {
  readonly capturePage: () => Promise<CapturedImage>;
}

/**
 * The widest a capture is sent at.
 *
 * Chosen against what models actually accept rather than against what looks
 * good: beyond roughly this width the image is downscaled at the other end
 * anyway, so the extra pixels are paid for and then discarded.
 */
export const MAX_SCREENSHOT_WIDTH = 1024;

/** The most one image may weigh, encoded, before quality is traded for size. */
export const MAX_SCREENSHOT_BYTES = 1_500_000;

/** JPEG quality used only when the lossless encoding will not fit. */
const FALLBACK_JPEG_QUALITY = 70;

export interface ScreenshotResult {
  readonly mediaType: "image/png" | "image/jpeg";
  /** Base64, ready for a tool result or a provider's image block. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Captures the visible area of a tab.
 *
 * Never throws. A destroyed view, a page that will not paint, and an image too
 * large to send even lossily all come back as null, which the caller reports as
 * a failed tool result the agent can react to.
 */
export async function captureScreenshot(
  contents: ScreenshotContentsPort
): Promise<ScreenshotResult | null> {
  let image: CapturedImage;
  try {
    image = await contents.capturePage();
  } catch {
    return null;
  }

  try {
    if (image.isEmpty()) return null;

    const original = image.getSize();
    if (original.width <= 0 || original.height <= 0) return null;

    const scaled =
      original.width > MAX_SCREENSHOT_WIDTH
        ? image.resize({ width: MAX_SCREENSHOT_WIDTH })
        : image;
    const size = scaled.getSize();

    const png = scaled.toPNG();
    if (png.byteLength <= MAX_SCREENSHOT_BYTES) {
      return {
        mediaType: "image/png",
        data: png.toString("base64"),
        width: size.width,
        height: size.height
      };
    }

    /*
     * Screenshots of dense pages do not compress losslessly. Re-encoding is
     * preferred to scaling further, because text that is too small to read is a
     * picture that answers nothing, whereas JPEG artefacts around it are ugly
     * and legible.
     */
    const jpeg = scaled.toJPEG(FALLBACK_JPEG_QUALITY);
    if (jpeg.byteLength > MAX_SCREENSHOT_BYTES) return null;

    return {
      mediaType: "image/jpeg",
      data: jpeg.toString("base64"),
      width: size.width,
      height: size.height
    };
  } catch {
    // Every method above is Electron's, but this runs against a port and a
    // broken one must not take a run down with it.
    return null;
  }
}
