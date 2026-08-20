/**
 * favicon-generator.js
 * Generates all favicon variants from a source image canvas.
 * Outputs: multiple PNG sizes, ICO binary, Apple touch icons, Android maskable icons.
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────────

  /**
   * Standard favicon sizes to generate.
   * Each entry describes a target dimension.
   */
  const FAVICON_SIZES = [16, 32, 48, 64, 96, 128, 256];

  /**
   * Apple touch icon sizes.
   * Apple recommends at minimum 180x180; we include additional sizes
   * for broader device coverage.
   */
  const APPLE_TOUCH_SIZES = [
    { size: 60,  filename: 'apple-touch-icon-60x60.png' },
    { size: 76,  filename: 'apple-touch-icon-76x76.png' },
    { size: 120, filename: 'apple-touch-icon-120x120.png' },
    { size: 152, filename: 'apple-touch-icon-152x152.png' },
    { size: 167, filename: 'apple-touch-icon-167x167.png' },
    { size: 180, filename: 'apple-touch-icon-180x180.png' },
  ];

  /**
   * Android maskable icon sizes (Material Design spec).
   * The safe-zone is 40% from edges; we provide 192 and 512 as required.
   */
  const ANDROID_MASKABLE_SIZES = [
    { size: 192, filename: 'android-chrome-192x192.png' },
    { size: 512, filename: 'android-chrome-512x512.png' },
  ];

  /**
   * ICO standard sizes embedded inside the binary container.
   * Windows favicons look best with these specific dimensions.
   */
  const ICO_SIZES = [16, 32, 48, 64, 128, 256];

  // ─── Helper: Draw source canvas onto a sized canvas ──────────────────────────

  /**
   * Creates a new canvas of the requested size, centres-crops the source
   * (maintaining aspect ratio), and draws it.
   *
   * @param {HTMLCanvasElement} source - Original image canvas.
   * @param {number} size - Target square dimension in px.
   * @returns {HTMLCanvasElement} A new canvas with the scaled icon.
   */
  function drawScaledIcon(source, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const srcRatio = source.width / source.height;
    const dstRatio = 1; // square output

    let sw, sh, sx, sy;

    if (srcRatio > dstRatio) {
      // Source is wider — crop horizontally
      sh = source.height;
      sw = sh;
      sx = (source.width - sw) / 2;
      sy = 0;
    } else {
      // Source is taller — crop vertically
      sw = source.width;
      sh = sw;
      sx = 0;
      sy = (source.height - sh) / 2;
    }

    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, size, size);

    return canvas;
  }

  // ─── Helper: Canvas → Blob ────────────────────────────────────────────────────

  /**
   * Converts a canvas to a Blob via toBlob (asynchronous, preserves quality).
   *
   * @param {HTMLCanvasElement} canvas
   * @param {string} mimeType
   * @returns {Promise<Blob>}
   */
  function canvasToBlob(canvas, mimeType = 'image/png') {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to convert canvas to blob.'));
        },
        mimeType,
        1.0
      );
    });
  }

  // ─── ICO binary format generator ──────────────────────────────────────────────

  /**
   * Builds a valid .ico file from an array of canvases (one per size).
   * The ICO format packs multiple resolutions into a single binary blob.
   *
   * Structure:
   *   ICONDIR (6 bytes)
   *   N × ICONDIRENTRY (16 bytes each)
   *   N × BMP image data (variable length)
   *
   * @param {Object[]} entries - Array of { size, canvas }.
   * @returns {Blob}
   */
  function buildICOBlob(entries) {
    // Sort largest first – some renderers prefer this ordering.
    entries.sort((a, b) => b.size - a.size);

    // Pre-render every BMP chunk so we know offsets.
    const chunks = entries.map(({ size, canvas }) => {
      const bmp = renderBMPForICO(canvas, size);
      return { size, bmp };
    });

    const totalHeaderSize = 6 + chunks.length * 16;
    let dataOffset = totalHeaderSize;
    const directoryEntries = chunks.map(({ size, bmp }) => {
      const entry = { size, offset: dataOffset };
      dataOffset += bmp.byteLength;
      return entry;
    });

    const buffer = new ArrayBuffer(totalHeaderSize + dataOffset - totalHeaderSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // ── ICONDIR header ──────────────────────────────────────────────────────
    view.setUint16(0, 0, true);       // Reserved
    view.setUint16(2, 1, true);      // Type: 1 = ICO
    view.setUint16(4, chunks.length, true); // Image count

    // ── ICONDIRENTRY × N ────────────────────────────────────────────────────
    chunks.forEach((chunk, i) => {
      const base = 6 + i * 16;
      const e = directoryEntries[i];

      // Width: 0 means 256px
      bytes[base] = chunk.size >= 256 ? 0 : chunk.size;
      // Height: same convention
      bytes[base + 1] = chunk.size >= 256 ? 0 : chunk.size;
      bytes[base + 2] = 0;             // Palette colour count
      bytes[base + 3] = 0;             // Reserved
      view.setUint16(base + 4, 1, true); // Colour planes
      view.setUint16(base + 6, 32, true); // Bits per pixel
      view.setUint32(base + 8, chunk.bmp.byteLength, true); // Image data size
      view.setUint32(base + 12, e.offset, true); // Offset to image data
    });

    // ── BMP image data chunks ───────────────────────────────────────────────
    chunks.forEach((chunk) => {
      bytes.set(chunk.bmp, directoryEntries.find((e) => e.size === chunk.size).offset);
    });

    return new Blob([buffer], { type: 'image/x-icon' });
  }

  /**
   * Renders a single icon resolution into ICO-compatible BMP format:
   *   BITMAPINFOHEADER (40 bytes) + BGRA pixel row-major data + AND mask.
   *
   * Height in the header is doubled to account for the colour plane
   * (XOR bitmap) + AND bitmask (transparent mask) required by ICO.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} size
   * @returns {Uint8Array}
   */
  function renderBMPForICO(canvas, size) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, size, size);
    const pixels = imageData.data;

    // Each row must be a multiple of 4 bytes (BITMAP line padding).
    const rowBytes = Math.ceil((size * 4) / 4) * 4; // 4 bytes per BGRA pixel
    const pixelDataSize = rowBytes * size;
    const andMaskSize = Math.ceil(size / 32) * 4 * size; // 1 bit per pixel, padded to 32-bit rows
    const headerSize = 40;

    const totalSize = headerSize + pixelDataSize + andMaskSize;
    const buf = new Uint8Array(totalSize);
    const view = new DataView(buf.buffer);

    // ── BITMAPINFOHEADER ────────────────────────────────────────────────────
    view.setUint32(0, headerSize, true);           // Header size
    view.setInt32(4, size, true);                  // Width
    view.setInt32(8, size * 2, true);              // Height (doubled: XOR + AND masks)
    view.setUint16(12, 1, true);                   // Colour planes
    view.setUint16(14, 32, true);                  // Bits per pixel (32-bit BGRA)
    view.setUint32(16, 0, true);                   // Compression (BI_RGB = 0)
    view.setUint32(20, pixelDataSize, true);       // Raw image size
    view.setInt32(24, 2835, true);                 // X pixels per metre (~72 DPI)
    view.setInt32(28, 2835, true);                 // Y pixels per metre
    view.setUint32(32, 0, true);                   // Colours in palette
    view.setUint32(36, 0, true);                   // Important colour count

    // ── Pixel data (BGRA, bottom-up row order for BMP) ──────────────────────
    let pixelOffset = headerSize;
    for (let row = size - 1; row >= 0; row--) {
      for (let col = 0; col < size; col++) {
        const srcIdx = (row * size + col) * 4;
        const b = pixels[srcIdx];
        const g = pixels[srcIdx + 1];
        const r = pixels[srcIdx + 2];
        const a = pixels[srcIdx + 3];
        buf[pixelOffset++] = b;
        buf[pixelOffset++] = g;
        buf[pixelOffset++] = r;
        buf[pixelOffset++] = a;
      }
      // Pad row to 4-byte boundary
      while (pixelOffset % 4 !== 0) buf[pixelOffset++] = 0;
    }

    // ── AND mask (1 bit per pixel, 0 = fully opaque, 1 = transparent) ──────
    // We pack 32 pixels per 32-bit word, left-to-right, top-to-bottom.
    let andOffset = headerSize + pixelDataSize;
    for (let row = 0; row < size; row++) {
      let word = 0;
      for (let col = 0; col < size; col++) {
        const srcIdx = (row * size + col) * 4;
        const a = pixels[srcIdx + 3];
        // Bit is 1 where pixel is transparent (alpha == 0)
        if (a === 0) {
          word |= 1 << (31 - col);
        }
      }
      view.setUint32(andOffset, word, true);
      andOffset += 4;
    }
    // Final row padding
    while (andOffset % 4 !== 0) andOffset++;

    return buf;
  }

  // ─── Main generator ───────────────────────────────────────────────────────────

  /**
   * Generates the full favicon bundle from a source canvas.
   *
   * Returns an object whose keys are filenames and values are Blobs ready
   * for download or ZIP packaging.
   *
   * @param {HTMLCanvasElement} sourceCanvas - The processed source image.
   * @param {string} basePath - URL path prefix for links (default '/').
   * @returns {Promise<Object<string, Blob>>} Map of filename → Blob.
   */
  async function generateFaviconBundle(sourceCanvas, basePath = '/') {
    const results = {};

    try {
      // ── 1. Standard favicon PNGs ────────────────────────────────────────────
      for (const size of FAVICON_SIZES) {
        const canvas = drawScaledIcon(sourceCanvas, size);
        const blob = await canvasToBlob(canvas);
        results[`favicon-${size}x${size}.png`] = blob;
      }

      // ── 2. favicon.ico (multi-resolution binary) ────────────────────────────
      const icoEntries = ICO_SIZES.map((size) => ({
        size,
        canvas: drawScaledIcon(sourceCanvas, size),
      }));
      const icoBlob = buildICOBlob(icoEntries);
      results['favicon.ico'] = icoBlob;

      // ── 3. Apple touch icons ────────────────────────────────────────────────
      for (const { size, filename } of APPLE_TOUCH_SIZES) {
        const canvas = drawScaledIcon(sourceCanvas, size);
        const blob = await canvasToBlob(canvas);
        results[filename] = blob;
      }

      // Also generate the generic apple-touch-icon.png at 180px (most common req.)
      {
        const canvas = drawScaledIcon(sourceCanvas, 180);
        const blob = await canvasToBlob(canvas);
        results['apple-touch-icon.png'] = blob;
      }

      // ── 4. Android maskable icons ───────────────────────────────────────────
      for (const { size, filename } of ANDROID_MASKABLE_SIZES) {
        const canvas = drawScaledIcon(sourceCanvas, size);
        const blob = await canvasToBlob(canvas);
        results[filename] = blob;
      }

      // ── 5. Site icon (WordPress / generic fallback) ─────────────────────────
      {
        const canvas = drawScaledIcon(sourceCanvas, 512);
        const blob = await canvasToBlob(canvas);
        results['site-icon.png'] = blob;
      }

    } catch (err) {
      throw new Error(`Favicon generation failed: ${err.message}`);
    }

    return results;
  }

  // ─── Export ───────────────────────────────────────────────────────────────────

  // Supports both module systems.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateFaviconBundle, drawScaledIcon, buildICOBlob };
  }

  // Also expose globally for browser script-tag usage.
  if (typeof window !== 'undefined') {
    window.FaviconGenerator = { generateFaviconBundle, drawScaledIcon, buildICOBlob };
  }

})();