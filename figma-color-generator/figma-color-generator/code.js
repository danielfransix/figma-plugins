// ─── Init ─────────────────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 480, height: 600, title: 'Color Generator', themeColors: true });

// Send existing collections to UI immediately on open
(function sendCollections() {
  var cols = figma.variables.getLocalVariableCollections();
  figma.ui.postMessage({
    type: 'collections',
    collections: cols.map(function(c) { return { id: c.id, name: c.name }; })
  });
})();

// ─── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'resize') {
    figma.ui.resize(480, Math.min(Math.max(msg.height, 300), 900));
    return;
  }
  if (msg.type === 'open_url') {
    var allowed = [
      'https://x.com/danielfransix',
      'https://danielfransix.short.gy/buy-coffee',
    ];
    if (allowed.indexOf(msg.url) !== -1) {
      figma.openExternal(msg.url);
    }
    return;
  }
  if (msg.type === 'get_folders') {
    var folders = [];
    if (msg.collectionId) {
      var all = figma.variables.getLocalVariableCollections();
      var coll = null;
      for (var ci = 0; ci < all.length; ci++) {
        if (all[ci].id === msg.collectionId) { coll = all[ci]; break; }
      }
      if (coll) {
        var seen = Object.create(null);
        coll.variableIds.forEach(function(id) {
          var v = figma.variables.getVariableById(id);
          if (!v) return;
          var parts = v.name.split('/');
          for (var pi = 1; pi < parts.length; pi++) {
            var folder = parts.slice(0, pi).join('/');
            if (!seen[folder]) { seen[folder] = true; folders.push(folder); }
          }
        });
        folders.sort();
      }
    }
    figma.ui.postMessage({ type: 'folders', folders: folders });
    return;
  }
  if (msg.type === 'generate') {
    await handleGenerate(msg);
  }
};

// ─── Color math (OKLCH pipeline) ──────────────────────────────────────────────
// Uses OKLCH (perceptually uniform) color space so that chroma scales naturally
// with the sRGB gamut boundary, matching the output of professional Tailwind
// palette generators. Lighter shades lerp C toward 0 (white); darker shades are
// gamut-scaled at constant hue so deeper tones stay vivid without clipping.

function linearize(c) {
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLinearRgb(hex) {
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) hex = hex[0]+hex[0] + hex[1]+hex[1] + hex[2]+hex[2];
  return {
    r: linearize(parseInt(hex.slice(0, 2), 16)),
    g: linearize(parseInt(hex.slice(2, 4), 16)),
    b: linearize(parseInt(hex.slice(4, 6), 16))
  };
}

function linearRgbToOklab(r, g, b) {
  var l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b;
  var m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b;
  var s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b;
  var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553*l_ + 0.7936177850*m_ - 0.0040720468*s_,
    a: 1.9779984951*l_ - 2.4285922050*m_ + 0.4505937099*s_,
    b: 0.0259040371*l_ + 0.7827717662*m_ - 0.8086757660*s_
  };
}

function oklabToLinearRgb(L, a, b) {
  var l_ = L + 0.3963377774*a + 0.2158037573*b;
  var m_ = L - 0.1055613458*a - 0.0638541728*b;
  var s_ = L - 0.0894841775*a - 1.2914855480*b;
  var l = l_*l_*l_, m = m_*m_*m_, s = s_*s_*s_;
  return {
    r:  4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
    g: -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
    b: -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
  };
}

function gammaEncode(c) {
  c = Math.max(0, Math.min(1, c));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToOklch(hex) {
  var lin = hexToLinearRgb(hex);
  var lab = linearRgbToOklab(lin.r, lin.g, lin.b);
  var C   = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  var H   = Math.atan2(lab.b, lab.a) * 180 / Math.PI;
  if (H < 0) H += 360;
  return { L: lab.L, C: C, H: H };
}

// oklchToRgb01 returns { r, g, b } in 0-1 range (Figma-ready, clamped to sRGB)
function oklchToRgb01(L, C, H) {
  var Hrad = H * Math.PI / 180;
  var lin  = oklabToLinearRgb(L, C * Math.cos(Hrad), C * Math.sin(Hrad));
  return {
    r: gammaEncode(lin.r),
    g: gammaEncode(lin.g),
    b: gammaEncode(lin.b)
  };
}

// Binary search for the maximum in-gamut chroma at a given OKLCH L and H.
// 24 iterations → precision < 0.5/2^24 ≈ 0.00003, well below perceptible.
function maxChromaInGamut(L, H) {
  var Hrad = H * Math.PI / 180;
  var cosH = Math.cos(Hrad), sinH = Math.sin(Hrad);
  var lo = 0, hi = 0.5;
  for (var i = 0; i < 24; i++) {
    var mid = (lo + hi) / 2;
    var lin = oklabToLinearRgb(L, mid * cosH, mid * sinH);
    var ok  = lin.r >= -0.001 && lin.r <= 1.001 &&
              lin.g >= -0.001 && lin.g <= 1.001 &&
              lin.b >= -0.001 && lin.b <= 1.001;
    if (ok) lo = mid; else hi = mid;
  }
  return lo;
}

// OKLCH L ratios reverse-engineered from the Tailwind CSS Color Generator tool.
// Lighter shades: L = L500 + (1 - L500) * UP_RATIOS[shade]
// Darker shades:  L = L500 - L500 * DOWN_RATIOS[shade]
// Chroma is gamut-scaled: C = satRatio * maxChromaInGamut(L, H)
// where satRatio = C500 / maxChromaInGamut(L500, H)
var SHADE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950, 1000, 1100];
var UP_RATIOS   = { 50: 0.9196, 100: 0.8531, 200: 0.7272, 300: 0.5171, 400: 0.2567 };
var DOWN_RATIOS = { 600: 0.1091, 700: 0.1930, 800: 0.2905, 900: 0.3751, 950: 0.5344, 1000: 0.6941, 1100: 0.8317 };

function generatePalette(hex) {
  var ok   = hexToOklch(hex);
  var L500 = ok.L, C500 = ok.C, H = ok.H;

  var maxC500  = maxChromaInGamut(L500, H);
  var satRatio = maxC500 > 0 ? Math.min(1, C500 / maxC500) : 0;

  // Pre-compute exact 0-1 RGB for shade 500 directly from the input hex so that
  // the 500 shade always round-trips exactly regardless of OKLCH float drift.
  var h500 = hex.replace(/^#/, '');
  if (h500.length === 3) h500 = h500[0]+h500[0] + h500[1]+h500[1] + h500[2]+h500[2];
  var r500 = parseInt(h500.slice(0, 2), 16) / 255;
  var g500 = parseInt(h500.slice(2, 4), 16) / 255;
  var b500 = parseInt(h500.slice(4, 6), 16) / 255;

  return SHADE_STEPS.map(function(shade) {
    if (shade === 500) return { shade: 500, r: r500, g: g500, b: b500 };

    var L;
    if (shade < 500) L = L500 + (1 - L500) * UP_RATIOS[shade];
    else             L = L500 - L500 * DOWN_RATIOS[shade];
    L = Math.max(0.005, Math.min(0.995, L));
    var C   = satRatio * maxChromaInGamut(L, H);
    var rgb = oklchToRgb01(L, C, H);
    return { shade: shade, r: rgb.r, g: rgb.g, b: rgb.b };
  });
}

// ─── Generate ─────────────────────────────────────────────────────────────────

async function handleGenerate(msg) {
  var collectionId   = msg.collectionId;   // null when creating new
  var collectionName = msg.collectionName; // used only when collectionId is null
  var entries        = msg.entries;        // [{ hex, name }]
  var parentFolder   = msg.parentFolder || ''; // '' = root

  function fullPath(entryName) {
    return parentFolder ? parentFolder + '/' + entryName : entryName;
  }

  try {
    // Pre-flight 1: duplicate folder names within this run
    var nameSet = Object.create(null);
    for (var i = 0; i < entries.length; i++) {
      var n = entries[i].name;
      if (nameSet[n]) {
        return postError('Duplicate folder name: "' + n + '". Each entry must have a unique name.');
      }
      nameSet[n] = true;
    }

    // Get or create collection
    var collection;
    if (collectionId) {
      var all = figma.variables.getLocalVariableCollections();
      collection = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === collectionId) { collection = all[i]; break; }
      }
      if (!collection) {
        return postError('Selected collection no longer exists. Please close and reopen the plugin.');
      }
    } else {
      collection = figma.variables.createVariableCollection(collectionName);
    }

    var modeId = collection.defaultModeId;

    // Pre-flight 2: check for existing folders in the target collection
    var existingNames = collection.variableIds.map(function(id) {
      var v = figma.variables.getVariableById(id);
      return v ? v.name : null;
    }).filter(function(n) { return n !== null; });

    for (var i = 0; i < entries.length; i++) {
      var prefix = fullPath(entries[i].name) + '/';
      for (var k = 0; k < existingNames.length; k++) {
        if (existingNames[k].indexOf(prefix) === 0) {
          return postError(
            'Folder "' + fullPath(entries[i].name) + '" already exists in collection "' +
            collection.name + '". Remove it first or choose a different name.'
          );
        }
      }
    }

    // All checks passed — generate
    var frameX = 0;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];

      figma.ui.postMessage({
        type: 'progress',
        message: 'Generating "' + entry.name + '"…',
        current: i + 1,
        total: entries.length
      });

      var palette = generatePalette(entry.hex);

      // Create color variables
      for (var j = 0; j < palette.length; j++) {
        var sw = palette[j];
        var variable = figma.variables.createVariable(
          fullPath(entry.name) + '/' + sw.shade,
          collection,
          'COLOR'
        );
        variable.setValueForMode(modeId, { r: sw.r, g: sw.g, b: sw.b, a: 1 });
      }

      // Create swatch frame with vertical auto-layout
      var frame = figma.createFrame();
      frame.name = entry.name;
      frame.layoutMode = 'VERTICAL';
      frame.itemSpacing = 8;
      frame.paddingLeft   = 0;
      frame.paddingRight  = 0;
      frame.paddingTop    = 0;
      frame.paddingBottom = 0;
      frame.counterAxisSizingMode = 'AUTO'; // hug width
      frame.primaryAxisSizingMode = 'AUTO'; // hug height
      frame.fills = [];

      for (var j = 0; j < palette.length; j++) {
        var sw = palette[j];
        var rect = figma.createRectangle();
        rect.name = String(sw.shade);
        rect.resize(100, 100);
        rect.fills = [{ type: 'SOLID', color: { r: sw.r, g: sw.g, b: sw.b } }];
        frame.appendChild(rect);
      }

      // Position: first frame at (0,0), each subsequent 140px to the right
      frame.x = frameX;
      frame.y = 0;
      frameX += 140; // 100px frame width + 40px gap
    }

    figma.ui.postMessage({
      type: 'done',
      variableCount: entries.length * 13,
      frameCount: entries.length
    });
    log('info', 'Generated ' + entries.length + ' palette(s), ' + (entries.length * 13) + ' variables.');

  } catch (err) {
    postError(err.message || String(err));
  }
}

function postError(message) {
  figma.ui.postMessage({ type: 'error', message: message });
  log('error', message);
}

// ─── Log panel ──────────────────────────────────────────────────────────────

function log(level, message) {
  figma.ui.postMessage({ type: 'log', level: level, message: message, time: formatTime() });
}

function formatTime() {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
