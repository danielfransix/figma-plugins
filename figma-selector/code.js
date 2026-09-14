figma.showUI(__html__, { width: 600, height: 900, title: 'Figma Selector', themeColors: true });

// ─── Init ────────────────────────────────────────────────────────────────────

var sel = figma.currentPage.selection;
figma.ui.postMessage({
  type: 'init',
  hasSelection: sel.length > 0,
  selectionCount: sel.length,
});

figma.on('selectionchange', function() {
  var s = figma.currentPage.selection;
  figma.ui.postMessage({
    type: 'selectionChange',
    hasSelection: s.length > 0,
    selectionCount: s.length,
  });
});

// ─── Cancellation token ──────────────────────────────────────────────────────

var _cancelToken = 0;
var _contextCache = Object.create(null);
var SELECTION_CAP = 10000;

// ─── Message handler ─────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'resize') {
    figma.ui.resize(480, 600);
    return;
  }

  if (msg.type === 'open_url') {
    var allowed = [
      'https://twitter.com/danielfransix',
      'https://buymeacoffee.com/danielfransix'
    ];
    if (allowed.indexOf(msg.url) !== -1) {
      figma.openExternal(msg.url);
    }
    return;
  }

  if (msg.type === 'run') {
    _cancelToken++;
    var myToken = _cancelToken;
    var t0 = Date.now();

    try {
      var results = await executeFilterPipeline(msg.config, myToken);

      if (myToken !== _cancelToken) return;

      var capped = results.length > SELECTION_CAP;
      var finalResults = capped ? results.slice(0, SELECTION_CAP) : results;
      figma.currentPage.selection = finalResults;
      figma.ui.postMessage({ type: 'done', count: finalResults.length, total: results.length, duration: Date.now() - t0, capped: capped });
      log('info', 'Selected ' + finalResults.length + ' of ' + results.length + ' matching layers' + (capped ? ' (capped at ' + SELECTION_CAP + ')' : '') + ' in ' + (Date.now() - t0) + 'ms.');
    } catch (err) {
      if (myToken === _cancelToken) {
        var msgText = err.message || 'An unexpected error occurred.';
        figma.ui.postMessage({ type: 'error', message: msgText });
        log('error', msgText);
      }
    }
  }
};

// ─── Log panel ───────────────────────────────────────────────────────────────

function log(level, message) {
  figma.ui.postMessage({ type: 'log', level: level, message: message, time: formatTime() });
}

function formatTime() {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// ─── Yield helper ────────────────────────────────────────────────────────────

var _yieldCount = 0;
var _lastYield = Date.now();

async function yieldIfNeeded(token) {
  if (++_yieldCount % 100 !== 0) return true;
  if (Date.now() - _lastYield > 30) {
    await new Promise(function(r) { setTimeout(r, 0); });
    _lastYield = Date.now();
  }
  return token === _cancelToken;
}

// ─── Async DFS walk ──────────────────────────────────────────────────────────
// Replaces the synchronous findAllWithCriteria call that froze Figma on large
// files. Walks the subtree iteratively, yielding every 500 nodes so the event
// loop (and cancel token checks) stay responsive throughout the traversal.

async function walkAsync(roots, typeSet, token) {
  var results = [];
  var stack = [];
  var visited = 0;
  var lastProgress = 0;

  // Seed stack with children of each root (mirrors findAllWithCriteria which
  // returns descendants, not the root nodes themselves).
  for (var i = roots.length - 1; i >= 0; i--) {
    if ('children' in roots[i]) {
      var rc = roots[i].children;
      for (var j = rc.length - 1; j >= 0; j--) stack.push(rc[j]);
    }
  }

  while (stack.length > 0) {
    var node = stack.pop();
    visited++;

    if (!typeSet || typeSet[node.type]) results.push(node);

    if ('children' in node) {
      var ch = node.children;
      for (var k = ch.length - 1; k >= 0; k--) stack.push(ch[k]);
    }

    if (visited % 500 === 0) {
      if (token !== _cancelToken) return null; // cancelled
      await new Promise(function(r) { setTimeout(r, 0); });
      var now = Date.now();
      if (now - lastProgress > 80) {
        figma.ui.postMessage({ type: 'progress', phase: 'scan', visited: visited });
        lastProgress = now;
      }
    }
  }

  return results;
}

// ─── Scope collection ────────────────────────────────────────────────────────

function getSearchRoots(scope) {
  if (!scope || scope === 'page') {
    return [figma.currentPage];
  }
  var sel = figma.currentPage.selection;
  if (sel.length === 0) return null;

  if (scope === 'inside' || scope === 'children') {
    return Array.from(sel);
  }

  if (scope === 'siblings') {
    var siblingSet = new Set();
    var seenParents = new Set();
    for (var i = 0; i < sel.length; i++) {
      var parent = sel[i].parent;
      if (parent && !seenParents.has(parent.id)) {
        seenParents.add(parent.id);
        if ('children' in parent) {
          for (var j = 0; j < parent.children.length; j++) {
            siblingSet.add(parent.children[j]);
          }
        }
      }
    }
    // For siblings, return an array — we'll handle this as a flat list, skip findAllWithCriteria
    return { _siblings: true, nodes: Array.from(siblingSet) };
  }

  return [figma.currentPage];
}

// ─── Name filter ─────────────────────────────────────────────────────────────

function applyNameFilter(nodes, nf) {
  var val = nf.caseSensitive ? nf.value : nf.value.toLowerCase();
  return nodes.filter(function(node) {
    var name = nf.caseSensitive ? node.name : node.name.toLowerCase();
    if (nf.exactMatch) return name === val;
    return name.indexOf(val) !== -1;
  });
}

// ─── Context filter ───────────────────────────────────────────────────────────

function getAncestorContext(node) {
  // Walk up collecting ancestor IDs so we can fill the cache for the full path
  // (path compression — subsequent sibling/cousin nodes hit the cache immediately).
  var path = [];
  var cur = node.parent;
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    if (cur.id in _contextCache) {
      var cached = _contextCache[cur.id];
      for (var pi = 0; pi < path.length; pi++) _contextCache[path[pi]] = cached;
      return cached;
    }
    if (cur.type === 'INSTANCE') {
      for (var pi = 0; pi < path.length; pi++) _contextCache[path[pi]] = 'instance';
      _contextCache[cur.id] = 'instance';
      return 'instance';
    }
    if (cur.type === 'COMPONENT') {
      for (var pi = 0; pi < path.length; pi++) _contextCache[path[pi]] = 'master';
      _contextCache[cur.id] = 'master';
      return 'master';
    }
    path.push(cur.id);
    cur = cur.parent;
  }
  for (var pi = 0; pi < path.length; pi++) _contextCache[path[pi]] = 'standalone';
  return 'standalone';
}

function applyContextFilter(nodes, contextFilter) {
  return nodes.filter(function(node) {
    var ctx = getAncestorContext(node);
    if (contextFilter === 'instances-only')  return ctx === 'instance';
    if (contextFilter === 'not-instances')   return ctx !== 'instance';
    if (contextFilter === 'masters-only')    return ctx === 'master';
    if (contextFilter === 'standalone-only') return ctx === 'standalone';
    return true;
  });
}

// ─── Instance health helpers ─────────────────────────────────────────────────

function hasMissingVariant(instance) {
  var mc = instance.mainComponent;
  if (!mc) return false;
  var parent = mc.parent;
  if (!parent || parent.type !== 'COMPONENT_SET') return false;
  try {
    var instanceProps = instance.componentProperties;
    var defs = parent.componentPropertyDefinitions;
    for (var propName in defs) {
      var def = defs[propName];
      if (def.type !== 'VARIANT') continue;
      var prop = instanceProps[propName];
      if (!prop) continue;
      if (def.variantOptions && def.variantOptions.indexOf(String(prop.value)) === -1) {
        return true;
      }
    }
  } catch (e) {
    return false;
  }
  return false;
}

// ─── Status chip evaluator ───────────────────────────────────────────────────

function hasFills(node) {
  if (!('fills' in node)) return false;
  var fills = node.fills;
  if (fills === figma.mixed) return false;
  return fills.some(function(f) { return f.visible !== false; });
}

function hasStrokes(node) {
  if (!('strokes' in node)) return false;
  var strokes = node.strokes;
  return strokes && strokes.length > 0 && strokes.some(function(s) { return s.visible !== false; });
}

function evalStatusChips(node, chips) {
  for (var i = 0; i < chips.length; i++) {
    var chip = chips[i];
    var pass = false;
    if (chip === 'no-fill')      pass = !hasFills(node);
    else if (chip === 'has-fill')     pass = hasFills(node);
    else if (chip === 'no-stroke')    pass = !hasStrokes(node);
    else if (chip === 'has-stroke')   pass = hasStrokes(node);
    else if (chip === 'hidden')       pass = node.visible === false;
    else if (chip === 'locked')       pass = node.locked === true;
    else if (chip === 'masked')       pass = node.isMask === true;
    else if (chip === 'no-children')  pass = !('children' in node) || node.children.length === 0;
    else if (chip === 'has-children')  pass = 'children' in node && node.children.length > 0;
    else if (chip === 'has-export')    pass = node.exportSettings && node.exportSettings.length > 0;
    else if (chip === 'no-text-style') pass = node.type === 'TEXT' && (node.textStyleId === '' || node.textStyleId === figma.mixed);
    else if (chip === 'has-text-style') pass = node.type === 'TEXT' && !!node.textStyleId && node.textStyleId !== figma.mixed;
    else if (chip === 'broken-link')     pass = node.type === 'INSTANCE' && node.mainComponent === null;
    else if (chip === 'missing-variant') pass = node.type === 'INSTANCE' && hasMissingVariant(node);
    else if (chip === 'has-overrides')   pass = node.type === 'INSTANCE' && node.overrides != null && node.overrides.length > 0;
    if (!pass) return false;
  }
  return true;
}

// ─── Color matching ──────────────────────────────────────────────────────────

function colorMatchesHex(color, hex) {
  if (!color || !hex) return false;
  var h = hex.replace('#', '');
  if (h.length !== 6) return false;
  var r = parseInt(h.substring(0, 2), 16);
  var g = parseInt(h.substring(2, 4), 16);
  var b = parseInt(h.substring(4, 6), 16);
  return Math.abs(Math.round(color.r * 255) - r) < 2 &&
         Math.abs(Math.round(color.g * 255) - g) < 2 &&
         Math.abs(Math.round(color.b * 255) - b) < 2;
}

// ─── Condition evaluator ─────────────────────────────────────────────────────

function evalSingleCondition(node, cond) {
  var p = cond.property;
  var op = cond.operator;
  var val = cond.value;

  if (p === 'fill') {
    if (!('fills' in node) || node.fills === figma.mixed) return op === 'no-fill';
    var fills = node.fills.filter(function(f) { return f.visible !== false; });
    if (op === 'has-fill')          return fills.length > 0;
    if (op === 'no-fill')           return fills.length === 0;
    if (op === 'color-equals')      return fills.some(function(f) { return f.type === 'SOLID' && colorMatchesHex(f.color, val); });
    if (op === 'color-not-equals')  return !fills.some(function(f) { return f.type === 'SOLID' && colorMatchesHex(f.color, val); });
    if (op === 'linked-to-variable')return fills.some(function(f) { return f.boundVariables && f.boundVariables.color; });
    if (op === 'not-linked')        return !fills.some(function(f) { return f.boundVariables && f.boundVariables.color; });
  }

  if (p === 'stroke') {
    if (!('strokes' in node)) return op === 'no-stroke';
    var strokes = node.strokes.filter(function(s) { return s.visible !== false; });
    if (op === 'has-stroke')          return strokes.length > 0;
    if (op === 'no-stroke')           return strokes.length === 0;
    if (op === 'color-equals')        return strokes.some(function(s) { return s.type === 'SOLID' && colorMatchesHex(s.color, val); });
    if (op === 'color-not-equals')    return !strokes.some(function(s) { return s.type === 'SOLID' && colorMatchesHex(s.color, val); });
    if (op === 'linked-to-variable')  return strokes.some(function(s) { return s.boundVariables && s.boundVariables.color; });
    if (op === 'weight-equals')   return 'strokeWeight' in node && node.strokeWeight === Number(val);
    if (op === 'weight-gt')       return 'strokeWeight' in node && node.strokeWeight > Number(val);
    if (op === 'weight-lt')       return 'strokeWeight' in node && node.strokeWeight < Number(val);
    if (op === 'weight-between') {
      if (!('strokeWeight' in node)) return false;
      var swp = (val || '').split(':'); return node.strokeWeight >= Number(swp[0]) && node.strokeWeight <= Number(swp[1]);
    }
  }

  if (p === 'opacity') {
    var opac = ('opacity' in node ? node.opacity : 1) * 100;
    if (op === 'equals')   return Math.round(opac) === Number(val);
    if (op === 'gt')       return opac > Number(val);
    if (op === 'lt')       return opac < Number(val);
    if (op === 'between') {
      var opp = (val || '').split(':'); return opac >= Number(opp[0]) && opac <= Number(opp[1]);
    }
  }

  if (p === 'visible') {
    if (op === 'is-visible') return node.visible !== false;
    if (op === 'is-hidden')  return node.visible === false;
  }

  if (p === 'locked') {
    if (op === 'is-locked')   return node.locked === true;
    if (op === 'is-unlocked') return node.locked !== true;
  }

  if (p === 'effects') {
    if (!('effects' in node)) return op === 'no-effect';
    var effects = node.effects || [];
    if (op === 'has-effect')       return effects.length > 0;
    if (op === 'no-effect')        return effects.length === 0;
    if (op === 'has-drop-shadow')  return effects.some(function(e) { return e.type === 'DROP_SHADOW'; });
    if (op === 'has-inner-shadow') return effects.some(function(e) { return e.type === 'INNER_SHADOW'; });
    if (op === 'has-blur')         return effects.some(function(e) { return e.type === 'LAYER_BLUR'; });
    if (op === 'has-bg-blur')      return effects.some(function(e) { return e.type === 'BACKGROUND_BLUR'; });
  }

  if (p === 'auto-layout') {
    if (!('layoutMode' in node)) return op === 'no-auto-layout';
    if (op === 'has-auto-layout') return node.layoutMode !== 'NONE';
    if (op === 'no-auto-layout')  return node.layoutMode === 'NONE';
    if (op === 'is-horizontal')   return node.layoutMode === 'HORIZONTAL';
    if (op === 'is-vertical')     return node.layoutMode === 'VERTICAL';
    if (op === 'is-grid')         return node.layoutMode === 'GRID';
    // layoutWrap only exists (and only matters) on HORIZONTAL auto layout frames
    if (op === 'has-wrap')        return node.layoutMode === 'HORIZONTAL' && node.layoutWrap === 'WRAP';
    if (op === 'no-wrap')         return !(node.layoutMode === 'HORIZONTAL' && node.layoutWrap === 'WRAP');
  }

  // --- Auto Layout padding (individual sides + uniform "all sides") ---
  if (p === 'padding-left' || p === 'padding-right' || p === 'padding-top' || p === 'padding-bottom') {
    if (!('paddingLeft' in node) || node.layoutMode === 'NONE') return false;
    var padVal = p === 'padding-left' ? node.paddingLeft :
                 p === 'padding-right' ? node.paddingRight :
                 p === 'padding-top' ? node.paddingTop : node.paddingBottom;
    if (op === 'pad-equals')  return Math.round(padVal) === Number(val);
    if (op === 'pad-gt')      return padVal > Number(val);
    if (op === 'pad-lt')      return padVal < Number(val);
    if (op === 'pad-between') {
      var pdp = (val || '').split(':'); return padVal >= Number(pdp[0]) && padVal <= Number(pdp[1]);
    }
  }

  if (p === 'padding-all') {
    if (!('paddingLeft' in node) || node.layoutMode === 'NONE') return false;
    var padSides = [node.paddingLeft, node.paddingRight, node.paddingTop, node.paddingBottom];
    if (op === 'pad-equals')  return padSides.every(function(s) { return Math.round(s) === Number(val); });
    if (op === 'pad-gt')      return padSides.every(function(s) { return s > Number(val); });
    if (op === 'pad-lt')      return padSides.every(function(s) { return s < Number(val); });
    if (op === 'pad-between') {
      var pap = (val || '').split(':');
      return padSides.every(function(s) { return s >= Number(pap[0]) && s <= Number(pap[1]); });
    }
  }

  // --- Auto Layout gap (itemSpacing) ---
  if (p === 'gap') {
    if (!('itemSpacing' in node) || node.layoutMode === 'NONE') return false;
    var gapVal = node.itemSpacing;
    if (op === 'gap-equals')  return Math.round(gapVal) === Number(val);
    if (op === 'gap-gt')      return gapVal > Number(val);
    if (op === 'gap-lt')      return gapVal < Number(val);
    if (op === 'gap-between') {
      var gbp = (val || '').split(':'); return gapVal >= Number(gbp[0]) && gapVal <= Number(gbp[1]);
    }
  }

  if (p === 'children') {
    var hasKids = 'children' in node;
    var count = hasKids ? node.children.length : 0;
    if (op === 'has-children') return count > 0;
    if (op === 'no-children')  return count === 0;
    if (op === 'count-equals')  return count === Number(val);
    if (op === 'count-gt')      return count > Number(val);
    if (op === 'count-lt')      return count < Number(val);
    if (op === 'count-between') {
      var ccp = (val || '').split(':'); return count >= Number(ccp[0]) && count <= Number(ccp[1]);
    }
  }

  if (p === 'clips') {
    if (op === 'clips-content') return 'clipsContent' in node && node.clipsContent === true;
    if (op === 'no-clip')       return !('clipsContent' in node) || node.clipsContent === false;
  }

  if (p === 'export') {
    var hasExp = node.exportSettings && node.exportSettings.length > 0;
    if (op === 'has-export') return hasExp;
    if (op === 'no-export')  return !hasExp;
  }

  if (p === 'mask') {
    if (op === 'is-mask')     return node.isMask === true;
    if (op === 'is-not-mask') return node.isMask !== true;
  }

  if (p === 'width') {
    var w = node.width;
    if (op === 'w-equals')  return Math.round(w) === Number(val);
    if (op === 'w-gt')      return w > Number(val);
    if (op === 'w-lt')      return w < Number(val);
    if (op === 'w-between') {
      var wp = (val || '').split(':'); return w >= Number(wp[0]) && w <= Number(wp[1]);
    }
  }

  if (p === 'height') {
    var h = node.height;
    if (op === 'h-equals')  return Math.round(h) === Number(val);
    if (op === 'h-gt')      return h > Number(val);
    if (op === 'h-lt')      return h < Number(val);
    if (op === 'h-between') {
      var hp = (val || '').split(':'); return h >= Number(hp[0]) && h <= Number(hp[1]);
    }
  }

  // --- Typography (TEXT nodes only) ---
  if (p === 'font-size') {
    if (node.type !== 'TEXT') return false;
    var fs = node.fontSize;
    if (fs === figma.mixed) return false;
    if (op === 'size-equals')  return fs === Number(val);
    if (op === 'size-gt')      return fs > Number(val);
    if (op === 'size-lt')      return fs < Number(val);
    if (op === 'size-between') {
      var fsp = (val || '').split(':'); return fs >= Number(fsp[0]) && fs <= Number(fsp[1]);
    }
  }

  if (p === 'font-family') {
    if (node.type !== 'TEXT') return false;
    var fn = node.fontName;
    if (fn === figma.mixed) return false;
    var family = fn.family.toLowerCase();
    var fval = (val || '').toLowerCase().trim();
    if (!fval) return true;
    if (op === 'family-equals')   return family === fval;
    if (op === 'family-contains') return family.indexOf(fval) !== -1;
  }

  if (p === 'font-style') {
    if (node.type !== 'TEXT') return false;
    var fn2 = node.fontName;
    if (fn2 === figma.mixed) return false;
    var style = fn2.style.toLowerCase();
    var sval = (val || '').toLowerCase().trim();
    if (!sval) return true;
    if (op === 'style-equals')   return style === sval;
    if (op === 'style-contains') return style.indexOf(sval) !== -1;
  }

  return false;
}

function evalConditions(node, conditions, logic) {
  for (var i = 0; i < conditions.length; i++) {
    var pass = evalSingleCondition(node, conditions[i]);
    if (logic === 'AND' && !pass) return false;
    if (logic === 'OR'  && pass)  return true;
  }
  return logic === 'AND';
}

// ─── Property filter loop ────────────────────────────────────────────────────

async function applyPropertyFilters(nodes, config, token) {
  var results = [];
  var total = nodes.length;
  var lastProgress = Date.now();
  _yieldCount = 0;
  _lastYield = Date.now();

  for (var i = 0; i < total; i++) {
    var node = nodes[i];
    var ok = true;

    if (config.statusChips && config.statusChips.length > 0) {
      ok = evalStatusChips(node, config.statusChips);
    }

    if (ok && config.conditions && config.conditions.length > 0) {
      ok = evalConditions(node, config.conditions, config.conditionLogic || 'AND');
    }

    if (ok) results.push(node);

    var alive = await yieldIfNeeded(token);
    if (!alive) return [];

    if (total > 2000 && Date.now() - lastProgress > 150) {
      figma.ui.postMessage({ type: 'progress', phase: 'filter', processed: i + 1, total: total });
      lastProgress = Date.now();
    }
  }

  return results;
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

async function executeFilterPipeline(config, token) {
  _contextCache = Object.create(null); // fresh cache per scan

  // Determine search roots
  var roots = getSearchRoots(config.scope);
  if (!roots) {
    figma.ui.postMessage({ type: 'error', message: 'Nothing is selected.' });
    log('error', 'Nothing is selected.');
    return [];
  }

  // Siblings: flat list already collected, skip findAllWithCriteria descent
  var candidates = [];
  var isSiblings = roots._siblings === true;

  if (isSiblings) {
    candidates = roots.nodes.slice();
  } else {
    // Stage 0: async DFS walk — non-blocking replacement for findAllWithCriteria
    var types = config.types && config.types.length > 0 ? config.types : null;
    var wantsAutoLayout = types && types.indexOf('AUTO_LAYOUT') !== -1;
    var typeSet = null;
    if (types) {
      typeSet = Object.create(null);
      for (var ti = 0; ti < types.length; ti++) {
        if (types[ti] !== 'AUTO_LAYOUT') typeSet[types[ti]] = true;
      }
      if (wantsAutoLayout) typeSet['FRAME'] = true;
    }

    candidates = await walkAsync(roots, typeSet, token);
    if (candidates === null) return []; // cancelled mid-walk

    // Stage 0b: Auto Layout sub-filter
    if (wantsAutoLayout && types && types.indexOf('FRAME') === -1) {
      candidates = candidates.filter(function(n) {
        return n.type === 'FRAME' && n.layoutMode !== 'NONE';
      });
    }

    // Stage 1: Direct children restriction
    if (config.scope === 'children') {
      var rootIds = {};
      for (var ri = 0; ri < roots.length; ri++) rootIds[roots[ri].id] = true;
      candidates = candidates.filter(function(n) {
        return n.parent && rootIds[n.parent.id];
      });
    }
  }

  if (token !== _cancelToken) return [];

  // Siblings: apply type filter manually since we didn't use findAllWithCriteria
  if (isSiblings && config.types && config.types.length > 0) {
    var wantsAL = config.types.indexOf('AUTO_LAYOUT') !== -1;
    var wantsFrame = config.types.indexOf('FRAME') !== -1;
    var otherTypes = config.types.filter(function(t) { return t !== 'AUTO_LAYOUT'; });
    candidates = candidates.filter(function(n) {
      if (otherTypes.indexOf(n.type) !== -1) {
        if (n.type === 'FRAME') {
          if (wantsFrame && !wantsAL) return true;
          if (wantsAL && n.layoutMode !== 'NONE') return true;
          if (wantsFrame) return true;
          return false;
        }
        return true;
      }
      if (wantsAL && n.type === 'FRAME' && n.layoutMode !== 'NONE') return true;
      return false;
    });
  }

  // Stage 2: Name filter
  if (config.nameFilter && config.nameFilter.value && config.nameFilter.value.length > 0) {
    candidates = applyNameFilter(candidates, config.nameFilter);
  }

  if (token !== _cancelToken) return [];

  // Stage 3: Context filter
  if (config.contextFilter && config.contextFilter !== 'all') {
    candidates = applyContextFilter(candidates, config.contextFilter);
  }

  if (token !== _cancelToken) return [];

  // Stage 4 & 5: Status + conditions
  if ((config.statusChips && config.statusChips.length > 0) ||
      (config.conditions && config.conditions.length > 0)) {
    candidates = await applyPropertyFilters(candidates, config, token);
  }

  return candidates;
}
