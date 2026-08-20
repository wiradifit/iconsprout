/**
 * color-detection.js
 *
 * Detects the dominant background color from an uploaded image and produces
 * a contrast-adjusted variant with a solid fill behind transparent content.
 *
 * Algorithm overview:
 *   1. Render the source image onto an offscreen canvas.
 *   2. Sample pixels along the image border to infer the background color.
 *   3. Cluster remaining sampled pixels by HSV similarity to discover the
 *      foreground / secondary colour palette.
 *   4. Pick the palette entry maximally distant (CIE76 Lab) from the
 *      background as the replacement fill colour.
 *   5. Paint a new canvas with the fill colour and composite the original
 *      image on top, preserving transparency.
 */

'use strict';

// ---------------------------------------------------------------------------
// Helpers: colour-space conversion & distance
// ---------------------------------------------------------------------------

/**
 * Convert an sRGB channel value (0-255) to linear RGB (0-1).
 * Used as the first step in RGB → XYZ → Lab conversion.
 */
function sRGBToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Convert RGB (0-255) to CIELAB (D65 illuminant).
 * Returns [L, a, b] where L ∈ [0, 100], a,b ∈ [-128, 127].
 */
function rgbToLab(r, g, b) {
  const rl = sRGBToLinear(r);
  const gl = sRGBToLinear(g);
  const bl = sRGBToLinear(b);

  // sRGB → XYZ (D65)
  let x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  let y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  let z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;

  // Normalize by D65 white point
  x /= 0.95047;
  y /= 1.00000;
  z /= 1.08883;

  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116;

  const l = (116 * f(y)) - 16;
  const a = 500 * (f(x) - f(y));
  const bVal = 200 * (f(y) - f(z));

  return [l, a, bVal];
}

/**
 * Euclidean distance in CIELAB space (CIE76 ΔE).
 * Good enough for relative colour-picking; avoids the expense of CIEDE2000.
 */
function labDistance(lab1, lab2) {
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Quantise an RGB triplet into HSV space with user-specified bucket counts.
 * Returns a compressed key string for grouping similar colours.
 */
function getQuantisedKey(r, g, b, hBuckets = 8, sBuckets = 4, vBuckets = 4) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max / 255;

  const hi = Math.floor((h / 360) * hBuckets) % hBuckets;
  const si = Math.floor(s * sBuckets);
  const vi = Math.floor(v * vBuckets);

  return `${hi}-${si}-${vi}`;
}

/**
 * Simple hex string from RGB components.
 */
function rgbToHex(r, g, b) {
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Sample pixels from the four borders of an ImageData buffer.
 * Returns an array of `{ r, g, b }` objects (no alpha check — we care about
 * the visible border colour regardless of underlying content).
 */
function sampleBorderPixels(imageData, borderThickness = 8) {
  const { data, width, height } = imageData;
  const samples = [];
  const w = width;
  const h = height;

  const push = (i) => {
    samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  };

  for (let y = 0; y < h; y++) {
    for (let dx = 0; dx < borderThickness; dx++) {
      // Left edge
      push(((y * w) + dx) * 4);
      // Right edge
      push(((y * w) + (w - 1 - dx)) * 4);
    }
  }

  for (let x = 0; x < w; x++) {
    for (let dy = 0; dy < borderThickness; dy++) {
      // Top edge
      push(((dy * w) + x) * 4);
      // Bottom edge
      push(((h - 1 - dy) * w) + x);
    }
  }

  return samples;
}

/**
 * Cluster colour samples by their HSV-quantised key.
 * Returns a Map keyed by quantised bucket with arrays of raw colours as values.
 */
function clusterByHSV(samples, hBuckets = 8, sBuckets = 4, vBuckets = 4) {
  const clusters = new Map();
  for (const { r, g, b } of samples) {
    const key = getQuantisedKey(r, g, b, hBuckets, sBuckets, vBuckets);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push({ r, g, b });
  }
  return clusters;
}

/**
 * Choose the representative colour for a cluster (centred mean).
 */
function clusterMean(colors) {
  const avgR = Math.round(colors.reduce((s, c) => s + c.r, 0) / colors.length);
  const avgG = Math.round(colors.reduce((s, c) => s + c.g, 0) / colors.length);
  const avgB = Math.round(colors.reduce((s, c) => s + c.b, 0) / colors.length);
  return { r: avgR, g: avgG, b: avgB };
}

/**
 * Determine the dominant background colour from the largest border cluster.
 * Heuristic: the background of a typical icon/logo fills most of the image
 * perimeter, so the biggest border cluster is our best guess.
 */
function detectBackgroundColour(samples) {
  if (!samples || samples.length === 0) {
    return { r: 0, g: 0, b: 0 }; // fallback to black
  }

  const clusters = clusterByHSV(samples);

  // Sort buckets by cluster size descending.
  const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);

  // The largest cluster is almost certainly the background.
  const background = clusterMean(sorted[0][1]);

  return background;
}

/**
 * From the non-background border clusters, pick the one most perceptually
 * distant from the background colour.  This becomes the "contrast fill".
 *
 * We skip clusters whose mean is within ~15 ΔE of the background (too similar
 * to be useful as a contrast colour).
 */
function pickContrastColour(samples, background) {
  const bgLab = rgbToLab(background.r, background.g, background.b);
  const clusters = clusterByHSV(samples);

  let bestDist = 0;
  let bestColor = null;

  for (const [, colors] of clusters) {
    const mean = clusterMean(colors);
    const dist = labDistance(rgbToLab(mean.r, mean.g, mean.b), bgLab);

    // Skip colours that are too close to the background.
    if (dist < 15) continue;
    if (dist > bestDist) {
      bestDist = dist;
      bestColor = mean;
    }
  }

  // If every cluster is too similar to background, invert the background.
  if (!bestColor) {
    return {
      r: 255 - background.r,
      g: 255 - background.g,
      b: 255 - background.b,
    };
  }

  return bestColor;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * detectBackgroundAndContrast(imageURL)
 *
 * @param {string} imageURL – Data URL, blob URL, or absolute/relative path
 *                             to an image the browser can decode.
 * @returns {Promise<{
 *   originalCanvas: HTMLCanvasElement,
 *   adjustedCanvas: HTMLCanvasElement,
 *   background:     { r, g, b, hex },
 *   contrast:       { r, g, b, hex },
 *   allColours:     Array<{ r, g, b, hex }>
 * }>}
 */
async function detectBackgroundAndContrast(imageURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        // ── Render source image to a memory canvas ──────────────────────────
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = img.naturalWidth;
        sourceCanvas.height = img.naturalHeight;
        const sourceCtx = sourceCanvas.getContext('2d');
        sourceCtx.drawImage(img, 0, 0);

        const { data: rawPixels, width, height } = sourceCtx.getImageData(
          0, 0, img.naturalWidth, img.naturalHeight
        );

        // ── Sample border pixels to infer the background ────────────────────
        const borderSamples = sampleBorderPixels(
          { data: rawPixels, width, height },
          /*borderThickness=*/ 8
        );

        const background = detectBackgroundColour(borderSamples);
        const contrast = pickContrastColour(borderSamples, background);

        // Gather all cluster means so callers can inspect the palette.
        const clusters = clusterByHSV(borderSamples);
        const allColours = [...clusters.values()]
          .map(clusterMean)
          .sort((a, b) => b.r + b.g + b.b - (a.r + a.g + a.b));

        // ── Build adjusted canvas: fill transparent areas with contrast colour ─
        const adjustedCanvas = document.createElement('canvas');
        adjustedCanvas.width = img.naturalWidth;
        adjustedCanvas.height = img.naturalHeight;
        const adjustedCtx = adjustedCanvas.getContext('2d');

        // Paint the contrast fill behind the image.
        adjustedCtx.fillStyle = rgbToHex(contrast.r, contrast.g, contrast.b);
        adjustedCtx.fillRect(0, 0, adjustedCanvas.width, adjustedCanvas.height);

        // Composite the original image on top.  Wherever the source is
        // transparent (alpha < threshold), the fill shows through; where the
        // source has opaque/semi-opaque pixels those are rendered as-is.
        const ALPHA_THRESHOLD = 10;
        adjustedCtx.drawImage(sourceCanvas, 0, 0);

        // Explicitly overwrite near-transparent pixels with the contrast colour
        // so there is no leftover fringe from anti-aliased edges.
        const adjData = adjustedCtx.getImageData(
          0, 0, adjustedCanvas.width, adjustedCanvas.height
        );
        for (let i = 0; i < adjData.data.length; i += 4) {
          if (rawPixels[i + 3] < ALPHA_THRESHOLD) {
            adjData.data[i]     = contrast.r;
            adjData.data[i + 1] = contrast.g;
            adjData.data[i + 2] = contrast.b;
            adjData.data[i + 3] = 255;
          }
        }
        adjustedCtx.putImageData(adjData, 0, 0);

        resolve({
          originalCanvas: sourceCanvas,
          adjustedCanvas,
          background: {
            ...background,
            hex: rgbToHex(background.r, background.g, background.b),
          },
          contrast: {
            ...contrast,
            hex: rgbToHex(contrast.r, contrast.g, contrast.b),
          },
          allColours: allColours.map((c) => ({
            ...c,
            hex: rgbToHex(c.r, c.g, c.b),
          })),
        });
      } catch (err) {
        reject(new Error(`Color detection failed: ${err.message}`));
      }
    };

    img.onerror = () =>
      reject(new Error('Failed to load image for color detection.'));

    img.src = imageURL;
  });
}

// Expose to the rest of the application.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectBackgroundAndContrast };
}