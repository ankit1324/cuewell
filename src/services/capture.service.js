const os = require('os');
const { desktopCapturer, screen } = require('electron');
const logger = require('../core/logger').createServiceLogger('CAPTURE');

// Longest edge of a screenshot sent to the AI, in pixels (4K width).
const MAX_CAPTURE_EDGE = 3840;

// Captures that gave nothing to read. On macOS all three usually mean the
// Screen Recording permission is missing or belongs to an earlier build of
// the app (error-reporter.js words the message). `code` is set on the error.
const CAPTURE_FAILURES = Object.freeze({
  NO_SOURCES: 'No screen sources available for capture',
  EMPTY_IMAGE: 'Screen capture returned an empty image',
  BLANK_IMAGE: 'Screen capture returned a blank image',
});

// A pixel whose red, green and blue are all at most 3 counts as black
// (colour conversion can leave a 1 or 2 where macOS drew pure black).
const BLANK_CHANNEL_MASK = 0xFC;

function captureFailure(code) {
  const error = new Error(CAPTURE_FAILURES[code]);
  error.code = code;
  return error;
}

/**
 * True when every pixel of a 4-bytes-per-pixel bitmap (NativeImage
 * toBitmap(): BGRA or RGBA, alpha last) is fully transparent or black,
 * which is what macOS returns to an app it does not let record the screen.
 * Stops at the first visible pixel, so a real screenshot is decided within
 * its first few pixels; only an image that really is blank is read to the end.
 */
function isBlankBitmap(bitmap) {
  if (!bitmap || bitmap.length < 4) return true;
  const count = Math.floor(bitmap.length / 4);
  const words = bitmap.byteOffset % 4 === 0
    ? new Uint32Array(bitmap.buffer, bitmap.byteOffset, count)
    : new Uint32Array(Uint8Array.prototype.slice.call(bitmap, 0, count * 4).buffer);
  const c = BLANK_CHANNEL_MASK;
  const littleEndian = os.endianness() === 'LE';
  // Bytes [c0, c1, c2, alpha] read as one 32-bit word.
  const alphaMask = littleEndian ? 0xFF000000 : 0x000000FF;
  const colorMask = littleEndian ? (c | (c << 8) | (c << 16)) : ((c << 24) | (c << 16) | (c << 8)) >>> 0;
  for (let i = 0; i < count; i++) {
    const word = words[i];
    if ((word & alphaMask) !== 0 && (word & colorMask) !== 0) return false;
  }
  return true;
}

class CaptureService {
  constructor() {
    this.isProcessing = false;
  }

  listDisplays() {
    try {
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        touchSupport: d.touchSupport || 'unknown'
      }));
      return { success: true, displays };
    } catch (error) {
      logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Capture screenshot and return an image buffer.
   * options: { displayId?: number, area?: { x, y, width, height } }
   */
  async captureAndProcess(options = {}) {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      const { image, metadata } = await this.captureScreenshot(options);

      // Crop if area specified
      let finalImage = image;
      if (options.area && this._isValidArea(options.area)) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
        }
      }

      const buffer = finalImage.toPNG();
      logger.logPerformance('Screenshot capture', startTime, {
        bytes: buffer.length,
        dimensions: finalImage.getSize()
      });

      return {
        imageBuffer: buffer,
        mimeType: 'image/png',
        metadata: {
          timestamp: new Date().toISOString(),
          source: metadata,
          processingTime: Date.now() - startTime
        }
      };
    } finally {
      this.isProcessing = false;
    }
  }

  async captureScreenshot(options = {}) {
    const targetDisplay = this._getTargetDisplay(options.displayId);
    const thumbnailSize = this._thumbnailSize(targetDisplay);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize
    });

    if (!sources || sources.length === 0) throw captureFailure('NO_SOURCES');

    const source = this._pickSource(sources, targetDisplay, thumbnailSize);

    const image = source.thumbnail;
    if (!image || image.isEmpty()) throw captureFailure('EMPTY_IMAGE');
    if (this._isBlankImage(image)) throw captureFailure('BLANK_IMAGE');

    logger.debug('Screenshot captured successfully', {
      sourceName: source.name,
      displayId: targetDisplay.id,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: source.name,
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  /**
   * Thumbnail size in physical pixels. display.size is in DIPs, so on a 2x
   * Retina screen asking for it returns a half-resolution image and small code
   * text blurs. The longest edge is capped to keep the upload reasonable.
   */
  _thumbnailSize(display) {
    const size = (display && display.size) || { width: 1920, height: 1080 };
    const scale = (display && display.scaleFactor) || 1;
    let width = Math.round(size.width * scale);
    let height = Math.round(size.height * scale);
    const longest = Math.max(width, height);
    if (longest > MAX_CAPTURE_EDGE) {
      const ratio = MAX_CAPTURE_EDGE / longest;
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    return { width, height };
  }

  /**
   * The source for `display`: matched by display_id, then by size (sources
   * from older platforms may lack display_id), then the first one.
   */
  _pickSource(sources, display, thumbnailSize) {
    const byId = sources.find(s => s.display_id && String(s.display_id) === String(display.id));
    if (byId) return byId;
    const bySize = sources.find(s => {
      const size = s.thumbnail && s.thumbnail.getSize();
      return size && size.width === thumbnailSize.width && size.height === thumbnailSize.height;
    });
    return bySize || sources[0];
  }

  /**
   * The display to capture: the one asked for, otherwise the one under the
   * mouse pointer, which is where the user is working when they press the
   * shortcut. Falls back to the primary display.
   */
  _getTargetDisplay(displayId) {
    const all = screen.getAllDisplays();
    if (!all || all.length === 0) return screen.getPrimaryDisplay();
    if (displayId != null) {
      const found = all.find(d => d.id === displayId);
      if (found) return found;
    }
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch (_) {
      return screen.getPrimaryDisplay();
    }
  }

  _isBlankImage(image) {
    const startTime = Date.now();
    const blank = isBlankBitmap(image.toBitmap());
    if (blank) logger.warn('Screen capture came back blank', { imageSize: image.getSize(), ms: Date.now() - startTime });
    return blank;
  }

  _isValidArea(area) {
    return area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
      Number.isFinite(area.width) && Number.isFinite(area.height) &&
      area.width > 0 && area.height > 0;
  }
}

module.exports = new CaptureService();
module.exports.CAPTURE_FAILURES = CAPTURE_FAILURES;
module.exports.isBlankBitmap = isBlankBitmap;
