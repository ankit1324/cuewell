const { desktopCapturer, screen } = require('electron');
const logger = require('../core/logger').createServiceLogger('CAPTURE');

// Longest edge of a screenshot sent to the AI, in pixels (4K width).
const MAX_CAPTURE_EDGE = 3840;

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

    if (sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    const source = this._pickSource(sources, targetDisplay, thumbnailSize);

    const image = source.thumbnail;
    if (!image) throw new Error('Failed to capture screen thumbnail');

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

  _isValidArea(area) {
    return area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
      Number.isFinite(area.width) && Number.isFinite(area.height) &&
      area.width > 0 && area.height > 0;
  }
}

module.exports = new CaptureService();
