/**
 * IconSprout — Main Application Controller
 * Handles file upload, emoji rendering, event routing,
 * and orchestrates favicon generation, color detection,
 * and HTML snippet production.
 */

(function () {
  'use strict';

  // ─── DOM References ────────────────────────────────────────────────────────
  const uploadZone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const emojiInput = document.getElementById('emoji-input');
  const previewPanel = document.getElementById('preview-panel');
  const sourceCanvas = document.getElementById('source-canvas');
  const previewImg = document.getElementById('preview-img');
  const bgPreviewImg = document.getElementById('bg-preview-img');
  const downloadBtn = document.getElementById('download-btn');
  const downloadZipBtn = document.getElementById('download-zip-btn');
  const htmlSnippetBox = document.getElementById('html-snippet');
  const copyBtn = document.getElementById('copy-btn');
  const errorMsg = document.getElementById('error-msg');
  const statusText = document.getElementById('status-text');
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  // ─── State ─────────────────────────────────────────────────────────────────
  let currentMode = 'image'; // 'image' | 'emoji'
  let detectedBgColor = null;
  let generatedVariants = null;
  let generatedSnippet = '';
  let sourceImageData = null; // raw image data from uploaded file
  let emojiTextValue = '';

  // ─── Initialise ────────────────────────────────────────────────────────────
  function init() {
    bindUploadEvents();
    bindEmojiEvents();
    bindTabEvents();
    bindCopyEvent();
    bindDownloadEvents();
    updateStatus('Upload an image or enter an emoji to get started');
  }

  // ─── Upload Events ─────────────────────────────────────────────────────────
  function bindUploadEvents() {
    // Click to browse
    uploadZone.addEventListener('click', () => fileInput.click());

    // File picker change
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFile(file);
    });

    // Drag & Drop
    uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadZone.classList.add('drag-over');
    });

    uploadZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('drag-over');
    });

    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        setMode('image');
        handleFile(file);
      } else {
        showError('Please drop a valid image file.');
      }
    });
  }

  /**
   * Read an ImageFile and decode it onto the hidden source canvas.
   * Triggers the full processing pipeline.
   */
  function handleFile(file) {
    clearError();
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        setMode('image');
        // Draw image centered on a 512×512 canvas
        const size = 512;
        sourceCanvas.width = size;
        sourceCanvas.height = size;
        const ctx = sourceCanvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);

        // Preserve aspect ratio while filling the square canvas
        const scale = Math.min(size / img.width, size / img.height);
        const drawWidth = img.width * scale;
        const drawHeight = img.height * scale;
        const x = (size - drawWidth) / 2;
        const y = (size - drawHeight) / 2;

        ctx.drawImage(img, x, y, drawWidth, drawHeight);

        // Store raw pixels for colour detection (background is transparent by default)
        const imageData = ctx.getImageData(0, 0, size, size);
        sourceImageData = imageData;

        // Update the visible preview
        previewImg.src = sourceCanvas.toDataURL('image/png');

        // Process the pipeline
        processSource();
      };
      img.onerror = () => showError('Failed to load image. The file may be corrupted.');
      img.src = e.target.result;
    };
    reader.onerror = () => showError('Failed to read file.');
    reader.readAsDataURL(file);
  }

  // ─── Emoji Events ──────────────────────────────────────────────────────────
  function bindEmojiEvents() {
    emojiInput.addEventListener('input', debounce(() => {
      const value = emojiInput.value.trim();
      if (value.length > 0) {
        emojiTextValue = value;
        renderEmojiToCanvas(value);
        setMode('emoji');
      } else {
        clearOutput();
      }
    }, 300));
  }

  /**
   * Render an emoji string centred on the source canvas, then run the pipeline.
   */
  function renderEmojiToCanvas(text) {
    const size = 512;
    sourceCanvas.width = size;
    sourceCanvas.height = size;
    const ctx = sourceCanvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    // Scale font relative to canvas
    const fontSize = size * 0.65;
    ctx.font = `${fontSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(text, size / 2, size / 2 + fontSize * 0.08);

    sourceImageData = ctx.getImageData(0, 0, size, size);
    previewImg.src = sourceCanvas.toDataURL('image/png');
    processSource();
  }

  // ─── Tab Switching ─────────────────────────────────────────────────────────
  function bindTabEvents() {
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        tabBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        tabPanels.forEach((panel) => {
          panel.classList.toggle('active', panel.id === target);
        });
      });
    });
  }

  // ─── Copy Button ───────────────────────────────────────────────────────────
  function bindCopyEvent() {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(generatedSnippet);
        const original = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = original), 1500);
      } catch {
        showError('Failed to copy snippet to clipboard.');
      }
    });
  }

  // ─── Download Events ───────────────────────────────────────────────────────
  function bindDownloadEvents() {
    // Individual PNG download (first variant — 32×32 favicon)
    downloadBtn.addEventListener('click', () => {
      if (!generatedVariants || !generatedVariants.pngs || generatedVariants.pngs.length === 0) return;
      const smallest = generatedVariants.pngs[0]; // 32×32
      const link = document.createElement('a');
      link.download = `favicon-${smallest.width}x${smallest.height}.png`;
      link.href = smallest.dataUrl;
      link.click();
    });

    // ZIP bundle download
    downloadZipBtn.addEventListener('click', async () => {
      if (!generatedVariants) return;
      await downloadZipBundle();
    });
  }

  // ─── Core Pipeline ─────────────────────────────────────────────────────────
  /**
   * Run colour detection → generate favicon variants → produce snippet → update UI.
   */
  function processSource() {
    updateStatus('Detecting colours…');

    // Detect dominant background colour and apply contrasting fill
    const { bgColor, filledCanvas } = detectBackgroundColor(sourceCanvas);

    // Re-render emoji path if mode is emoji (filled canvas already has the emoji drawn)
    if (currentMode === 'emoji') {
      // The source canvas was already drawn; now we show the background behind it
      detectedBgColor = bgColor;
      bgPreviewImg.src = filledCanvas.toDataURL('image/png');
    }

    // Generate all favicon variants from the (possibly background-filled) canvas
    generatedVariants = generateFaviconVariants(filledCanvas || sourceCanvas);

    // Generate HTML snippet
    generatedSnippet = generateSnippet({
      bgColor: bgColor || '#ffffff',
      appleTouchIcon: generatedVariants.appleTouchIcon,
      androidChrome192: generatedVariants.android192,
      androidChrome512: generatedVariants.android512,
      favicon32: generatedVariants.favicon32,
      favicon16: generatedVariants.favicon16,
      ico: generatedVariants.ico,
    });

    // Populate UI
    populatePreviews();
    updateSnippetDisplay();
    updateStatus('Ready — download your favicon bundle below');
  }

  // ─── Preview Population ────────────────────────────────────────────────────
  function populatePreviews() {
    previewPanel.classList.remove('hidden');

    if (currentMode === 'image') {
      // Show both original and background-adjusted side by side
      document.getElementById('preview-original-label').textContent = 'Original';
      document.getElementById('preview-bg-label').textContent = 'With Background';
      document.getElementById('preview-original-img').src = sourceCanvas.toDataURL('image/png');
      if (detectedBgColor) {
        const { filledCanvas } = detectBackgroundColor(sourceCanvas);
        document.getElementById('preview-bg-img').src = filledCanvas.toDataURL('image/png');
      }
      document.getElementById('preview-bg-wrapper').style.display = '';
      document.getElementById('preview-original-wrapper').style.display = '';
    } else {
      // Emoji mode — single preview
      document.getElementById('preview-original-wrapper').style.display = 'none';
      document.getElementById('preview-bg-wrapper').style.display = 'none';
      document.getElementById('emoji-preview-img').src = sourceCanvas.toDataURL('image/png');
      document.getElementById('emoji-preview-img').style.display = '';
    }
  }

  // ─── Snippet Display ───────────────────────────────────────────────────────
  function updateSnippetDisplay() {
    htmlSnippetBox.value = generatedSnippet;
  }

  // ─── ZIP Bundle Download ───────────────────────────────────────────────────
  /**
   * Bundle all generated favicon files into a ZIP archive using JSZip and trigger download.
   */
  async function downloadZipBundle() {
    if (!generatedVariants) return;

    updateStatus('Creating ZIP bundle…');

    try {
      const JSZip = window.JSZip;
      if (!JSZip) {
        showError('JSZip library not loaded. Check that jszip.min.js is included.');
        updateStatus('Error');
        return;
      }

      const zip = new JSZip();
      const folder = zip.folder('iconsprout-favicons');

      // Add PNG variants
      if (generatedVariants.pngs) {
        generatedVariants.pngs.forEach((v) => {
          const name = `favicon-${v.width}x${v.height}.png`;
          const base64 = v.dataUrl.split(',')[1];
          folder.file(name, base64, { base64: true });
        });
      }

      // Add ICO if present
      if (generatedVariants.ico) {
        const base64 = generatedVariants.ico.dataUrl.split(',')[1];
        folder.file('favicon.ico', base64, { base64: true });
      }

      // Add Apple touch icon
      if (generatedVariants.appleTouchIcon) {
        const base64 = generatedVariants.appleTouchIcon.dataUrl.split(',')[1];
        folder.file('apple-touch-icon.png', base64, { base64: true });
      }

      // Add Android icons
      if (generatedVariants.android192) {
        const base64 = generatedVariants.android192.dataUrl.split(',')[1];
        folder.file('android-chrome-192x192.png', base64, { base64: true });
      }
      if (generatedVariants.android512) {
        const base64 = generatedVariants.android512.dataUrl.split(',')[1];
        folder.file('android-chrome-512x512.png', base64, { base64: true });
      }

      // Add manifest.json for Android
      const manifest = {
        name: 'IconSprout Favicon Bundle',
        short_name: 'IconSprout',
        start_url: '/',
        display: 'standalone',
        theme_color: detectedBgColor || '#ffffff',
        background_color: detectedBgColor || '#ffffff',
        icons: [
          { src: 'icons/iconsprout-favicons/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/iconsprout-favicons/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
      };
      folder.file('manifest.json', JSON.stringify(manifest, null, 2));

      // Add README
      folder.file('README.txt', 'IconSprout Favicon Bundle\nGenerated on ' + new Date().toISOString());

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'iconsprout-favicon-bundle.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      updateStatus('ZIP bundle downloaded!');
    } catch (err) {
      console.error('ZIP generation error:', err);
      showError('Failed to create ZIP bundle: ' + err.message);
      updateStatus('Error creating bundle');
    }
  }

  // ─── Utility: Set Mode ─────────────────────────────────────────────────────
  function setMode(mode) {
    currentMode = mode;
    if (mode === 'image') {
      uploadZone.style.display = '';
      emojiInput.parentElement.style.display = 'none';
    } else {
      uploadZone.style.display = 'none';
      emojiInput.parentElement.style.display = '';
      emojiInput.focus();
    }
  }

  // ─── Utility: Status ───────────────────────────────────────────────────────
  function updateStatus(msg) {
    if (statusText) statusText.textContent = msg;
  }

  // ─── Utility: Error ────────────────────────────────────────────────────────
  function showError(msg) {
    if (errorMsg) {
      errorMsg.textContent = msg;
      errorMsg.classList.remove('hidden');
    }
    updateStatus('Error');
  }

  function clearError() {
    if (errorMsg) {
      errorMsg.textContent = '';
      errorMsg.classList.add('hidden');
    }
  }

  function clearOutput() {
    previewPanel.classList.add('hidden');
    htmlSnippetBox.value = '';
    generatedVariants = null;
    generatedSnippet = '';
    detectedBgColor = null;
    sourceImageData = null;
  }

  // ─── Debounce Helper ───────────────────────────────────────────────────────
  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ─── Re-export module functions for other scripts ──────────────────────────
  // These are called by favicon-generator.js, color-detection.js, snippet-generator.js
  // which expect certain globals or functions to exist.

  /**
   * Expose the processSource pipeline so other modules can trigger it externally.
   */
  window.IconSprout = {
    processSource,
    getVariants: () => generatedVariants,
    getSnippet: () => generatedSnippet,
    getBgColor: () => detectedBgColor,
  };

  // ─── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();