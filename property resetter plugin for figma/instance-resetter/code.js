figma.showUI(__html__, { width: 600, height: 900, title: 'Instance Property Resetter', themeColors: true });

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'resize') {
    figma.ui.resize(480, 900);
    return;
  }
  if (msg.type === 'run') {
    try {
      await runReset(msg.scope, msg.properties, msg.widthFilter);
    } catch (err) {
      var errMsg = err.message || 'An unexpected error occurred. Try a smaller selection and run again.';
      figma.ui.postMessage({ type: 'error', message: errMsg });
      log('error', errMsg);
    }
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
  }
};

// ─────────────────────────────────────────────────────────────────────────────

function isMixed(value) {
  return value === figma.mixed;
}

var _widthFilter = { enabled: false, min: 0, max: null };

function passesWidthFilter(node) {
  if (!_widthFilter.enabled) return true;
  if (node.width < _widthFilter.min) return false;
  if (_widthFilter.max !== null && node.width > _widthFilter.max) return false;
  return true;
}

var _fontCache = {};
var _mainComponentCache = new Map();
function clearCaches() { 
  _fontCache = {}; 
  _mainComponentCache.clear();
}

async function getMainComponentCached(instance) {
  var id = instance.mainComponentId;
  if (id) {
    if (_mainComponentCache.has(id)) {
      return _mainComponentCache.get(id);
    }
    var main = await instance.getMainComponentAsync();
    _mainComponentCache.set(id, main);
    
    // Figma limits plugin memory (usually ~1GB). 
    // Cap cache at 1000 items to prevent Out of Memory crashes on massive files.
    if (_mainComponentCache.size > 1000) {
      var firstKey = _mainComponentCache.keys().next().value;
      _mainComponentCache.delete(firstKey);
    }
    return main;
  }
  return await instance.getMainComponentAsync();
}

async function ensureFont(fontName) {
  var key = fontName.family + '::' + fontName.style;
  if (!_fontCache[key]) {
    _fontCache[key] = true;
    await figma.loadFontAsync(fontName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runReset(scope, properties, widthFilter) {
  _widthFilter = widthFilter || { enabled: false, min: 0, max: null };
  clearCaches();

  var totalReset   = 0;
  var totalSkipped = 0;
  var totalRenamed = 0;

  var hasInstanceProps = !!(
    properties.size || properties.fills || properties.strokes ||
    properties.cornerRadius || properties.effects || properties.opacity ||
    properties.clipsContent || properties.autoLayout || properties.padding || properties.spacing ||
    properties.textStyle || properties.textFill || properties.textStroke || properties.textContent
  );

  var layerNameOpts = null;
  if (properties.layerName) {
    layerNameOpts = {
      includeComponents: !!properties.layerNameIncludeComponents,
      includeInstances:  !!properties.layerNameIncludeInstances,
    };
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  if (scope === 'selection') {
    var selection = figma.currentPage.selection;
    if (!selection || selection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'Nothing selected. Select at least one layer.' });
      log('error', 'Nothing selected. Select at least one layer.');
      return;
    }

    var instances = [];
    if (hasInstanceProps) {
      instances = await collectFromSelection(selection);
      if (instances.length === 0 && !layerNameOpts) {
        figma.ui.postMessage({ type: 'error', message: 'No instances found in selection.' });
        log('error', 'No instances found in selection.');
        return;
      }
    }

    if (instances.length > 0) {
      if (properties.textStyle || properties.textContent) {
        await preloadFonts(instances);
      }
      var r = await processInstances(instances, 'Selection', properties);
      totalReset   += r.reset;
      totalSkipped += r.skipped;
    }

    if (layerNameOpts) {
      for (var si = 0; si < selection.length; si++) {
        totalRenamed += await resetNamesInSubtree(selection[si], layerNameOpts);
      }
    }

    var notifyMsg = buildNotifyMessage(totalReset, totalRenamed);
    if (notifyMsg) figma.notify(notifyMsg + ' in selection');
    figma.ui.postMessage({ type: 'done', count: totalReset, renamed: totalRenamed, skipped: totalSkipped, pages: 1, scope: 'selection' });
    log('info', (notifyMsg || 'Nothing to reset') + ' in selection' + (totalSkipped > 0 ? ' (' + totalSkipped + ' skipped)' : '') + '.');
    return;
  }

  // ── This Page / All Pages ──────────────────────────────────────────────────
  var pages = scope === 'all'
    ? figma.root.children.slice()
    : [figma.currentPage];

  var multiPage = pages.length > 1;

  if (multiPage) {
    await figma.loadAllPagesAsync();
  }

  for (var pi = 0; pi < pages.length; pi++) {
    var page     = pages[pi];
    var topLevel = page.children;

    for (var ci = 0; ci < topLevel.length; ci++) {
      var frame = topLevel[ci];

      var instances = hasInstanceProps ? await collectFromFrame(frame) : [];
      if (instances.length === 0 && !layerNameOpts) continue;

      var label = multiPage ? page.name + ' / ' + frame.name : frame.name;

      try {
        if (instances.length > 0) {
          if (properties.textStyle || properties.textContent) {
            await preloadFonts(instances);
          }
          var r = await processInstances(instances, label, properties);
          totalReset   += r.reset;
          totalSkipped += r.skipped;
        }

        if (layerNameOpts) {
          totalRenamed += await resetNamesInSubtree(frame, layerNameOpts);
        }
      } catch (e) {
        if (instances.length > 0) totalSkipped += instances.length;
      }
    }
  }

  var notifyMsg = buildNotifyMessage(totalReset, totalRenamed);
  if (notifyMsg) figma.notify(notifyMsg);
  figma.ui.postMessage({ type: 'done', count: totalReset, renamed: totalRenamed, skipped: totalSkipped, pages: pages.length, scope: scope });
  log('info', (notifyMsg || 'Nothing to reset') + ' across ' + pages.length + ' page(s)' + (totalSkipped > 0 ? ' (' + totalSkipped + ' skipped)' : '') + '.');
}

// ─── Log panel ────────────────────────────────────────────────────────────────

function log(level, message) {
  figma.ui.postMessage({ type: 'log', level: level, message: message, time: formatTime() });
}

function formatTime() {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function buildNotifyMessage(reset, renamed) {
  var parts = [];
  if (reset   > 0) parts.push(reset   + ' instance' + (reset   !== 1 ? 's' : '') + ' reset');
  if (renamed > 0) parts.push(renamed + ' layer'    + (renamed !== 1 ? 's' : '') + ' renamed');
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────

async function collectFromFrame(frame) {
  var instances = [];
  var stack = [frame];
  while (stack.length > 0) {
    await yieldIfNeeded();
    var node = stack.pop();
    if (!node || node.removed) continue;
    if (node.type === 'INSTANCE') {
      if (passesWidthFilter(node)) instances.push(node);
    }
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        stack.push(node.children[i]);
      }
    }
  }
  return instances;
}

async function collectFromSelection(selection) {
  var seen = {};
  var instances = [];
  var stack = [];
  for (var si = 0; si < selection.length; si++) {
    stack.push(selection[si]);
  }
  
  while (stack.length > 0) {
    await yieldIfNeeded();
    var node = stack.pop();
    if (!node || node.removed) continue;
    
    if (node.type === 'INSTANCE' && !seen[node.id] && passesWidthFilter(node)) {
      seen[node.id] = true;
      instances.push(node);
    }
    if ('children' in node) {
      for (var i = 0; i < node.children.length; i++) {
        stack.push(node.children[i]);
      }
    }
  }
  return instances;
}

async function preloadFonts(instances) {
  var fontMap   = {};
  var seenMains = {};

  for (var i = 0; i < instances.length; i++) {
    var inst = instances[i];
    if (inst.removed) continue;

    var instTexts = inst.findAll(function(n) { return n.type === 'TEXT'; });
    for (var ti = 0; ti < instTexts.length; ti++) {
      collectFontsFromNode(instTexts[ti], fontMap);
    }

    var main = await getMainComponentCached(inst);
    if (main && !seenMains[main.id]) {
      seenMains[main.id] = true;
      var mainTexts = main.findAll(function(n) { return n.type === 'TEXT'; });
      for (var mi = 0; mi < mainTexts.length; mi++) {
        collectFontsFromNode(mainTexts[mi], fontMap);
      }
    }
  }

  var fonts = [];
  for (var key in fontMap) { fonts.push(fontMap[key]); }
  if (fonts.length === 0) return;

  var batchSize = 5;
  for (var fi = 0; fi < fonts.length; fi += batchSize) {
    var batch = fonts.slice(fi, fi + batchSize);
    await Promise.all(batch.map(function(f) {
      var k = f.family + '::' + f.style;
      if (!_fontCache[k]) {
        _fontCache[k] = true;
        return figma.loadFontAsync(f);
      }
      return Promise.resolve();
    }));
  }
}

// Uses getStyledTextSegments (O(segments)) instead of iterating per-character.
function collectFontsFromNode(textNode, fontMap) {
  try {
    var segments = textNode.getStyledTextSegments(['fontName']);
    for (var i = 0; i < segments.length; i++) {
      var fn = segments[i].fontName;
      if (fn && !isMixed(fn)) {
        fontMap[fn.family + '::' + fn.style] = fn;
      }
    }
  } catch (e) {
    if (!isMixed(textNode.fontName) && textNode.fontName) {
      fontMap[textNode.fontName.family + '::' + textNode.fontName.style] = textNode.fontName;
    }
  }
}

// Processes instances sequentially while yielding to save memory on large files
async function processInstances(instances, label, properties) {
  var reset   = 0;
  var skipped = 0;
  var total   = instances.length;
  var _lastProgressTime = 0;

  for (var i = 0; i < total; i++) {
    if (Date.now() - _lastProgressTime > 100) {
      figma.ui.postMessage({ type: 'progress', page: label, current: i, total: total });
      _lastProgressTime = Date.now();
    }
    
    var inst = instances[i];
    try {
      if (await resetInstance(inst, properties)) reset++;
      else skipped++;
    } catch (e) {
      skipped++;
    }
    await yieldIfNeeded();
  }

  return { reset: reset, skipped: skipped };
}

// ─────────────────────────────────────────────────────────────────────────────

async function resetInstance(instance, properties) {
  if (instance.removed) return false;
  var main = await getMainComponentCached(instance);
  if (!main) return false;

  // Fast-path: if all supported properties are selected, use native reset overrides
  var allProps = properties.size && properties.fills && properties.strokes &&
                 properties.cornerRadius && properties.effects && properties.opacity && properties.clipsContent &&
                 properties.autoLayout && properties.padding && properties.spacing &&
                 properties.textStyle && properties.textFill && properties.textStroke && properties.textContent;
  
  if (allProps) {
    try {
      instance.resetOverrides();
      return true;
    } catch (e) {}
  }

  if (properties.size) {
    if (instance.width !== main.width || instance.height !== main.height) {
      try { instance.resize(main.width, main.height); } catch (e) {}
    }
  }

  var overriddenIds = null;
  if (instance.overrides) {
    overriddenIds = new Set();
    for (var i = 0; i < instance.overrides.length; i++) {
      overriddenIds.add(instance.overrides[i].id);
    }
    overriddenIds.add(instance.id); // ensure root is checked
  }

  await walkTree(instance, main, properties, overriddenIds);
  return true;
}

async function walkTree(node, mainNode, properties, overriddenIds) {
  await yieldIfNeeded();
  if (!node || !mainNode || node.removed) return;

  var isOverridden = !overriddenIds || overriddenIds.has(node.id);

  if (isOverridden) {
    if (node.type === 'TEXT' && mainNode.type === 'TEXT') {
      await resetTextNode(node, mainNode, properties);
    } else {
      resetLayerNode(node, mainNode, properties);
    }
  }

  if ('children' in node && 'children' in mainNode) {
    var len = Math.min(node.children.length, mainNode.children.length);
    for (var i = 0; i < len; i++) {
      await walkTree(node.children[i], mainNode.children[i], properties, overriddenIds);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function resetLayerNode(node, mainNode, props) {
  if (props.fills && 'fills' in node) {
    var nFills = node.fills, mFills = mainNode.fills;
    if (!isMixed(mFills) && !isMixed(nFills)) {
      try {
        if (!isEqual(nFills, mFills)) node.fills = deepClone(mFills);
      } catch (e) {}
    }
  }
  if (props.strokes && 'strokes' in node) {
    var nStrokes = node.strokes, mStrokes = mainNode.strokes;
    if (!isMixed(mStrokes) && !isMixed(nStrokes)) {
      try {
        if (!isEqual(nStrokes, mStrokes)) node.strokes = deepClone(mStrokes);
      } catch (e) {}
    }
  }
  if (props.effects && 'effects' in node) {
    var nEffects = node.effects, mEffects = mainNode.effects;
    if (!isMixed(mEffects) && !isMixed(nEffects)) {
      try {
        if (!isEqual(nEffects, mEffects)) node.effects = deepClone(mEffects);
      } catch (e) {}
    }
  }
  if (props.opacity && 'opacity' in node) {
    var mOpacity = mainNode.opacity;
    if (node.opacity !== mOpacity) {
      try { node.opacity = mOpacity; } catch (e) {}
    }
  }
  if (props.clipsContent && 'clipsContent' in node && 'clipsContent' in mainNode) {
    var mClipsContent = mainNode.clipsContent;
    if (node.clipsContent !== mClipsContent) {
      try { node.clipsContent = mClipsContent; } catch (e) {}
    }
  }
  if (props.cornerRadius) {
    resetCornerRadius(node, mainNode);
  }
  if (props.autoLayout) {
    resetAutoLayout(node, mainNode);
  }
  if (props.padding) {
    resetPadding(node, mainNode);
  }
  if (props.spacing) {
    resetSpacing(node, mainNode);
  }
}

function resetCornerRadius(node, mainNode) {
  try {
    if ('topLeftRadius' in node) {
      var tl = mainNode.topLeftRadius     || 0;
      var tr = mainNode.topRightRadius    || 0;
      var bl = mainNode.bottomLeftRadius  || 0;
      var br = mainNode.bottomRightRadius || 0;
      if (node.topLeftRadius !== tl || node.topRightRadius !== tr ||
          node.bottomLeftRadius !== bl || node.bottomRightRadius !== br) {
        node.topLeftRadius     = tl;
        node.topRightRadius    = tr;
        node.bottomLeftRadius  = bl;
        node.bottomRightRadius = br;
      }
    } else if ('cornerRadius' in node && !isMixed(mainNode.cornerRadius)) {
      if (node.cornerRadius !== mainNode.cornerRadius) {
        node.cornerRadius = mainNode.cornerRadius;
      }
    }
  } catch (e) {}
}

function resetAutoLayout(node, mainNode) {
  if (!('layoutMode' in node) || !('layoutMode' in mainNode)) return;
  try {
    var mLayoutMode = mainNode.layoutMode;
    if (node.layoutMode !== mLayoutMode) node.layoutMode = mLayoutMode;
    
    var mPrimarySizing = mainNode.primaryAxisSizingMode;
    if (node.primaryAxisSizingMode !== mPrimarySizing) node.primaryAxisSizingMode = mPrimarySizing;

    var mCounterSizing = mainNode.counterAxisSizingMode;
    if (node.counterAxisSizingMode !== mCounterSizing) node.counterAxisSizingMode = mCounterSizing;

    if ('layoutSizingVertical' in node && 'layoutSizingVertical' in mainNode) {
      var mSizingV = mainNode.layoutSizingVertical;
      if (node.layoutSizingVertical !== mSizingV) node.layoutSizingVertical = mSizingV;
    }
    if ('layoutSizingHorizontal' in node && 'layoutSizingHorizontal' in mainNode) {
      var mSizingH = mainNode.layoutSizingHorizontal;
      if (node.layoutSizingHorizontal !== mSizingH) node.layoutSizingHorizontal = mSizingH;
    }

    var mPrimaryAlign = mainNode.primaryAxisAlignItems;
    if (node.primaryAxisAlignItems !== mPrimaryAlign) node.primaryAxisAlignItems = mPrimaryAlign;

    var mCounterAlign = mainNode.counterAxisAlignItems;
    if (node.counterAxisAlignItems !== mCounterAlign) node.counterAxisAlignItems = mCounterAlign;

    var mWrap = mainNode.layoutWrap;
    if (node.layoutWrap !== mWrap) node.layoutWrap = mWrap;
  } catch(e) {}
  
  try {
    if ('layoutPositioning' in node) {
      var mPos = mainNode.layoutPositioning;
      if (node.layoutPositioning !== mPos) node.layoutPositioning = mPos;
    }
    if ('layoutAlign' in node) {
      var mAlign = mainNode.layoutAlign;
      if (node.layoutAlign !== mAlign) node.layoutAlign = mAlign;
    }
    if ('layoutGrow' in node) {
      var mGrow = mainNode.layoutGrow;
      if (node.layoutGrow !== mGrow) node.layoutGrow = mGrow;
    }
  } catch(e) {}
}

function resetPadding(node, mainNode) {
  if (!('paddingLeft' in node) || !('paddingLeft' in mainNode)) return;
  try {
    var mLeft = mainNode.paddingLeft;
    if (node.paddingLeft !== mLeft) node.paddingLeft = mLeft;
    var mRight = mainNode.paddingRight;
    if (node.paddingRight !== mRight) node.paddingRight = mRight;
    var mTop = mainNode.paddingTop;
    if (node.paddingTop !== mTop) node.paddingTop = mTop;
    var mBottom = mainNode.paddingBottom;
    if (node.paddingBottom !== mBottom) node.paddingBottom = mBottom;
  } catch(e) {}
}

function resetSpacing(node, mainNode) {
  try {
    if ('itemSpacing' in node && 'itemSpacing' in mainNode) {
      var mSpacing = mainNode.itemSpacing;
      if (node.itemSpacing !== mSpacing) node.itemSpacing = mSpacing;
    }
  } catch(e) {}
  try {
    if ('counterAxisSpacing' in node && 'counterAxisSpacing' in mainNode) {
      var mCounterSpacing = mainNode.counterAxisSpacing;
      if (node.counterAxisSpacing !== mCounterSpacing) node.counterAxisSpacing = mCounterSpacing;
    }
  } catch(e) {}
}

// ─────────────────────────────────────────────────────────────────────────────

async function resetTextNode(node, mainNode, props) {
  if (props.textStyle) {
    await resetTextStyle(node, mainNode);
  }
  if (props.textFill) {
    var mFills = mainNode.fills, nFills = node.fills;
    if (!isMixed(mFills) && !isMixed(nFills)) {
      try {
        if (!isEqual(nFills, mFills)) node.fills = deepClone(mFills);
      } catch (e) {}
    }
  }
  if (props.textStroke) {
    var mStrokes = mainNode.strokes, nStrokes = node.strokes;
    if (!isMixed(mStrokes) && !isMixed(nStrokes)) {
      try {
        if (!isEqual(nStrokes, mStrokes)) node.strokes = deepClone(mStrokes);
      } catch (e) {}
    }
  }
  if (props.textContent) {
    var mChars = mainNode.characters;
    if (node.characters !== mChars) {
      try {
        node.characters = mChars;
      } catch (e) {
        try {
          await loadAllFonts(node);
          node.characters = mChars;
        } catch (e2) {}
      }
    }
  }
}

async function resetTextStyle(node, mainNode) {
  try {
    var mainStyleId = mainNode.textStyleId;
    if (mainStyleId && !isMixed(mainStyleId)) {
      if (node.textStyleId !== mainStyleId) node.textStyleId = mainStyleId;
      return;
    }

    var mFontName = mainNode.fontName;
    if (!isMixed(mFontName) && mFontName) {
      await ensureFont(mFontName);
    }

    // Scalars: plain !== is sufficient.
    var mFontSize = mainNode.fontSize, mTextCase = mainNode.textCase;
    var mTextDecoration = mainNode.textDecoration, mParagraphSpacing = mainNode.paragraphSpacing;
    
    if (!isMixed(mFontSize)       && node.fontSize       !== mFontSize)       node.fontSize       = mFontSize;
    if (!isMixed(mTextCase)       && node.textCase       !== mTextCase)       node.textCase       = mTextCase;
    if (!isMixed(mTextDecoration) && node.textDecoration !== mTextDecoration) node.textDecoration = mTextDecoration;
    if (mParagraphSpacing !== undefined && node.paragraphSpacing !== mParagraphSpacing) node.paragraphSpacing = mParagraphSpacing;

    // Objects: isEqual comparison to avoid writing equal structs.
    var nFontName = node.fontName;
    if (!isMixed(mFontName) && !isEqual(nFontName, mFontName)) node.fontName = mFontName;

    var mLineHeight = mainNode.lineHeight, nLineHeight = node.lineHeight;
    if (!isMixed(mLineHeight) && !isEqual(nLineHeight, mLineHeight)) node.lineHeight = mLineHeight;

    var mLetterSpacing = mainNode.letterSpacing, nLetterSpacing = node.letterSpacing;
    if (!isMixed(mLetterSpacing) && !isEqual(nLetterSpacing, mLetterSpacing)) node.letterSpacing = mLetterSpacing;
  } catch (e) {}
}

async function loadAllFonts(textNode) {
  var fontMap = {};
  collectFontsFromNode(textNode, fontMap);
  var fonts = [];
  for (var key in fontMap) { fonts.push(fontMap[key]); }
  
  var batchSize = 5;
  for (var i = 0; i < fonts.length; i += batchSize) {
    var batch = fonts.slice(i, i + batchSize);
    await Promise.all(batch.map(function(f) { return ensureFont(f); }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer Name Reset

var NODE_DEFAULT_NAMES = {
  FRAME:           'Frame',
  GROUP:           'Group',
  SECTION:         'Section',
  COMPONENT:       'Component',
  COMPONENT_SET:   'Component Set',
  INSTANCE:        'Instance',
  TEXT:            'Text',
  RECTANGLE:       'Rectangle',
  ELLIPSE:         'Ellipse',
  POLYGON:         'Polygon',
  STAR:            'Star',
  LINE:            'Line',
  VECTOR:          'Vector',
  BOOLEAN_OPERATION: null,  // resolved from node.booleanOperation
  SLICE:           'Slice',
  CONNECTOR:       'Connector',
  SHAPE_WITH_TEXT: 'Shape',
  STICKY:          'Sticky',
  STAMP:           'Stamp',
  WIDGET:          'Widget',
  EMBED:           'Embed',
  LINK_UNFURL:     'Link',
  MEDIA:           'Media',
  HIGHLIGHT:       'Highlight',
  WASHI_TAPE:      'Washi Tape',
  CODE_BLOCK:      'Code Block',
  TABLE:           'Table',
  TABLE_CELL:      'Cell',
};

var BOOLEAN_OP_NAMES = {
  UNION:     'Union',
  SUBTRACT:  'Subtract',
  INTERSECT: 'Intersect',
  EXCLUDE:   'Exclude',
};

function defaultNameForNode(node) {
  if (node.type === 'BOOLEAN_OPERATION') {
    return BOOLEAN_OP_NAMES[node.booleanOperation] || 'Boolean';
  }
  return NODE_DEFAULT_NAMES[node.type] || node.type;
}

async function targetNameForNode(node) {
  if (node.type === 'INSTANCE') {
    var main = await node.getMainComponentAsync();
    return (main && main.name) ? main.name : defaultNameForNode(node);
  }
  return defaultNameForNode(node);
}

async function renameNode(node) {
  var target = await targetNameForNode(node);
  if (!target || node.name === target) return 0;
  try { node.name = target; return 1; } catch (e) { return 0; }
}

// Iterative DFS walk — avoids call-stack limits on deeply nested files.
// Key rules:
//   INSTANCE       → renamed if includeInstances; children never touched
//                    (descending would create unwanted name overrides)
//   COMPONENT /
//   COMPONENT_SET  → skip entire subtree if !includeComponents
//   Everything else → rename and recurse normally
async function resetNamesInSubtree(root, opts) {
  var renamed = 0;
  var stack = [root];

  while (stack.length > 0) {
    await yieldIfNeeded();
    var node = stack.pop();
    if (!node || node.removed) continue;

    if (node.type === 'INSTANCE') {
      if (opts.includeInstances) renamed += await renameNode(node);
      continue; // never descend into instance children
    }

    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      if (!opts.includeComponents) continue; // skip whole subtree
      renamed += await renameNode(node);
      // fall through to push children
    } else {
      renamed += await renameNode(node);
      // fall through to push children
    }

    if ('children' in node) {
      var children = node.children;
      for (var i = 0; i < children.length; i++) {
        stack.push(children[i]);
      }
    }
  }

  return renamed;
}

// ─────────────────────────────────────────────────────────────────────────────

function deepClone(value) {
  try {
    return structuredClone(value);
  } catch (e) {
    return JSON.parse(JSON.stringify(value));
  }
}

function isEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  
  // Fast path for Figma properties which are typically serializable
  try {
    if (JSON.stringify(a) === JSON.stringify(b)) return true;
  } catch (e) {}

  var keysA = Object.keys(a), keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (var i = 0; i < keysA.length; i++) {
    if (!keysB.includes(keysA[i])) return false;
    if (!isEqual(a[keysA[i]], b[keysA[i]])) return false;
  }
  return true;
}

var _lastYieldTime = Date.now();
var _yieldCounter = 0;
async function yieldIfNeeded() {
  if (++_yieldCounter % 50 !== 0) return; // Only check time every 50 calls to save Date.now() overhead
  if (Date.now() - _lastYieldTime > 30) {
    await new Promise(function(resolve) { setTimeout(resolve, 0); });
    _lastYieldTime = Date.now();
  }
}

