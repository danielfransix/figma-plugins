// Figma Linter — code.js
// Pure vanilla JS, no build step
'use strict';

figma.showUI(__html__, { width: 480, height: 600, title: 'Figma Linter', themeColors: true });

// ── Globals ────────────────────────────────────────────────────────────────
var _scanToken = 0;
var _rerunDebounce = null;

var DEFAULT_SETTINGS = {
  lintVectors: false,
  warnHidden: true,
  warnNaming: true,
  showUnusedStyles: false,
  radiusAllowlist: [0, 2, 4, 8, 16, 24, 32, 9999],
  spacingAllowlist: [0, 2, 4, 8, 12, 16, 24, 32, 40, 48, 64],
  opacityAllowlist: [0, 0.08, 0.12, 0.16, 0.24, 0.32, 0.48, 0.64, 0.80, 0.88, 1]
};

// ── Helpers ────────────────────────────────────────────────────────────────
var _lastYield = Date.now();
async function yieldIfNeeded() {
  if (Date.now() - _lastYield > 16) {
    await new Promise(function(r) { setTimeout(r, 0); });
    _lastYield = Date.now();
  }
}

function colorToKey(r, g, b) {
  return r.toFixed(3) + ',' + g.toFixed(3) + ',' + b.toFixed(3);
}

function rgbToHex(r, g, b) {
  function c(x) {
    var h = Math.round(x * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
  }
  return '#' + c(r) + c(g) + c(b);
}

function colorsMatch(a, b) {
  return Math.abs(a.r - b.r) < 0.0001 &&
         Math.abs(a.g - b.g) < 0.0001 &&
         Math.abs(a.b - b.b) < 0.0001;
}

// ── Variable index ─────────────────────────────────────────────────────────
async function buildVariableIndex() {
  var colorVarMap = new Map();
  var numberVarMap = new Map();

  try {
    var colorVars = figma.variables.getLocalVariables('COLOR');
    var floatVars = figma.variables.getLocalVariables('FLOAT');
    var collections = figma.variables.getLocalVariableCollections();
    var collectionMap = {};
    collections.forEach(function(c) { collectionMap[c.id] = c; });

    colorVars.forEach(function(v) {
      var coll = collectionMap[v.variableCollectionId];
      if (!coll) return;
      var modeId = coll.defaultModeId;
      var val = v.valuesByMode[modeId];
      if (!val || typeof val !== 'object' || !('r' in val)) return;
      var key = colorToKey(val.r, val.g, val.b);
      if (!colorVarMap.has(key)) colorVarMap.set(key, []);
      colorVarMap.get(key).push({ id: v.id, name: v.name, collectionName: coll.name });
    });

    floatVars.forEach(function(v) {
      var coll = collectionMap[v.variableCollectionId];
      if (!coll) return;
      var modeId = coll.defaultModeId;
      var val = v.valuesByMode[modeId];
      if (typeof val !== 'number') return;
      if (!numberVarMap.has(val)) numberVarMap.set(val, []);
      numberVarMap.get(val).push({ id: v.id, name: v.name, collectionName: coll.name });
    });
  } catch (e) {
    // no variables in document — ignore
  }

  return { colorVarMap: colorVarMap, numberVarMap: numberVarMap };
}

// ── Local styles ───────────────────────────────────────────────────────────
async function getLocalStyles() {
  var paints = figma.getLocalPaintStyles();
  var texts = figma.getLocalTextStyles();
  var effects = figma.getLocalEffectStyles();
  return { paints: paints, texts: texts, effects: effects };
}

// ── Style matchers ─────────────────────────────────────────────────────────
function findMatchingPaintStyle(fill, styles) {
  if (!fill || fill.type === 'IMAGE' || fill.type === 'VIDEO') return null;
  if (!fill.color) return null;
  var exact = null, near = null;
  for (var i = 0; i < styles.length; i++) {
    var s = styles[i];
    if (!s.paints || s.paints.length !== 1) continue;
    var sp = s.paints[0];
    if (sp.type !== fill.type) continue;
    if (sp.type === 'SOLID' && fill.type === 'SOLID') {
      if (colorsMatch(sp.color, fill.color)) {
        exact = s;
        break;
      }
    }
  }
  return exact;
}

function findMatchingEffectStyle(node, styles) {
  if (!node.effects || node.effects.length === 0) return null;
  for (var i = 0; i < styles.length; i++) {
    var s = styles[i];
    if (!s.effects || s.effects.length !== node.effects.length) continue;
    var match = true;
    for (var j = 0; j < s.effects.length; j++) {
      var se = s.effects[j];
      var ne = node.effects[j];
      if (se.type !== ne.type) { match = false; break; }
      if (se.type === 'DROP_SHADOW' || se.type === 'INNER_SHADOW') {
        if (!colorsMatch(se.color, ne.color) ||
            Math.abs(se.radius - ne.radius) > 0.0001 ||
            Math.abs(se.offset.x - ne.offset.x) > 0.0001 ||
            Math.abs(se.offset.y - ne.offset.y) > 0.0001 ||
            Math.abs((se.spread || 0) - (ne.spread || 0)) > 0.0001 ||
            Math.abs((se.color.a || 1) - (ne.color.a || 1)) > 0.0001) {
          match = false; break;
        }
      } else if (se.type === 'LAYER_BLUR' || se.type === 'BACKGROUND_BLUR') {
        if (Math.abs(se.radius - ne.radius) > 0.0001) { match = false; break; }
      }
    }
    if (match) return s;
  }
  return null;
}

function textPropsMatch(node, style) {
  try {
    return style.fontName.family === node.fontName.family &&
           style.fontName.style === node.fontName.style &&
           style.fontSize === node.fontSize &&
           style.lineHeight.unit === node.lineHeight.unit &&
           (style.lineHeight.unit === 'AUTO' || Math.abs((style.lineHeight.value || 0) - (node.lineHeight.value || 0)) < 0.01) &&
           style.letterSpacing.unit === node.letterSpacing.unit &&
           Math.abs((style.letterSpacing.value || 0) - (node.letterSpacing.value || 0)) < 0.01 &&
           style.textCase === node.textCase &&
           Math.abs((style.paragraphSpacing || 0) - (node.paragraphSpacing || 0)) < 0.01 &&
           Math.abs((style.paragraphIndent || 0) - (node.paragraphIndent || 0)) < 0.01;
  } catch (e) {
    return false;
  }
}

function findMatchingTextStyle(node, styles) {
  if (node.fontName === figma.mixed || node.fontSize === figma.mixed) return null;
  for (var i = 0; i < styles.length; i++) {
    if (textPropsMatch(node, styles[i])) return styles[i];
  }
  return null;
}

// ── Lint rules ─────────────────────────────────────────────────────────────
var FILL_TYPES = ['FRAME','RECTANGLE','INSTANCE','COMPONENT','COMPONENT_SET',
                  'TEXT','ELLIPSE','POLYGON','STAR','SECTION'];
var STROKE_TYPES = ['FRAME','RECTANGLE','INSTANCE','COMPONENT','TEXT',
                    'ELLIPSE','POLYGON','STAR','LINE'];
var EFFECT_TYPES = ['FRAME','RECTANGLE','INSTANCE','COMPONENT','TEXT',
                    'ELLIPSE','POLYGON','STAR','LINE'];

function lintFill(node, styles, varMaps) {
  if (FILL_TYPES.indexOf(node.type) === -1) return [];
  var errors = [];
  var fills;
  try { fills = node.fills; } catch(e) { return []; }
  if (fills === figma.mixed) {
    return [{ ruleId: 'fill_mixed', severity: 'error',
              message: 'Mixed fills', value: 'mixed', property: 'fill' }];
  }
  if (!fills || fills.length === 0) return [];
  for (var i = 0; i < fills.length; i++) {
    var fill = fills[i];
    if (fill.type === 'IMAGE' || fill.type === 'VIDEO') continue;
    if (!fill.visible || fill.opacity === 0) continue;
    var hasStyleId = node.fillStyleId && node.fillStyleId !== '';
    var hasBoundVar = node.boundVariables && node.boundVariables.fills &&
                      node.boundVariables.fills[i];
    if (hasStyleId || hasBoundVar) continue;
    var hex = fill.type === 'SOLID' && fill.color ?
              rgbToHex(fill.color.r, fill.color.g, fill.color.b) : fill.type;
    var suggestedStyle = fill.type === 'SOLID' ? findMatchingPaintStyle(fill, styles.paints) : null;
    var suggestedVar = null;
    if (fill.type === 'SOLID' && fill.color && varMaps.colorVarMap) {
      var key = colorToKey(fill.color.r, fill.color.g, fill.color.b);
      var vars = varMaps.colorVarMap.get(key);
      if (vars && vars.length > 0) suggestedVar = vars[0];
    }
    errors.push({
      ruleId: 'fill_missing', severity: 'error',
      message: 'Missing fill style — ' + hex,
      value: hex, rawValue: fill.color || null,
      property: 'fill', fillIndex: i,
      suggestedStyleId: suggestedStyle ? suggestedStyle.id : null,
      suggestedStyleName: suggestedStyle ? suggestedStyle.name : null,
      suggestedVariableId: suggestedVar ? suggestedVar.id : null,
      suggestedVariableName: suggestedVar ? suggestedVar.name : null
    });
  }
  return errors;
}

function lintStroke(node, styles, varMaps) {
  if (STROKE_TYPES.indexOf(node.type) === -1) return [];
  var errors = [];
  var strokes;
  try { strokes = node.strokes; } catch(e) { return []; }
  if (!strokes || strokes.length === 0) return [];
  try {
    if (node.strokeWeight === figma.mixed) {
      return [{ ruleId: 'stroke_mixed', severity: 'error',
                message: 'Mixed stroke weights', value: 'mixed', property: 'stroke',
                suggestedStyleId: null, suggestedStyleName: null,
                suggestedVariableId: null, suggestedVariableName: null }];
    }
  } catch(e) {}
  var hasStyleId = node.strokeStyleId && node.strokeStyleId !== '';
  var hasBoundVar = node.boundVariables && node.boundVariables.strokes;
  if (hasStyleId || hasBoundVar) return [];
  for (var i = 0; i < strokes.length; i++) {
    var stroke = strokes[i];
    if (!stroke.visible) continue;
    var hex = stroke.type === 'SOLID' && stroke.color ?
              rgbToHex(stroke.color.r, stroke.color.g, stroke.color.b) : stroke.type;
    var suggestedStyle = stroke.type === 'SOLID' ? findMatchingPaintStyle(stroke, styles.paints) : null;
    var suggestedVar = null;
    if (stroke.type === 'SOLID' && stroke.color && varMaps.colorVarMap) {
      var key = colorToKey(stroke.color.r, stroke.color.g, stroke.color.b);
      var vars = varMaps.colorVarMap.get(key);
      if (vars && vars.length > 0) suggestedVar = vars[0];
    }
    errors.push({
      ruleId: 'stroke_missing', severity: 'error',
      message: 'Missing stroke style — ' + hex,
      value: hex, rawValue: stroke.color || null,
      property: 'stroke', fillIndex: i,
      suggestedStyleId: suggestedStyle ? suggestedStyle.id : null,
      suggestedStyleName: suggestedStyle ? suggestedStyle.name : null,
      suggestedVariableId: suggestedVar ? suggestedVar.id : null,
      suggestedVariableName: suggestedVar ? suggestedVar.name : null
    });
  }
  return errors;
}

function lintText(node, styles) {
  if (node.type !== 'TEXT') return [];
  if (node.textStyleId && node.textStyleId !== '' && node.textStyleId !== figma.mixed) return [];
  if (node.fontName === figma.mixed || node.fontSize === figma.mixed) {
    return [{ ruleId: 'text_mixed', severity: 'error',
              message: 'Mixed typography', value: 'mixed', property: 'text' }];
  }
  var matchedStyle = findMatchingTextStyle(node, styles.texts);
  var size = node.fontSize || '?';
  var family = (node.fontName && node.fontName.family) ? node.fontName.family : '?';
  return [{
    ruleId: matchedStyle ? 'text_suggested' : 'text_missing',
    severity: 'error',
    message: 'Missing text style — ' + family + ' ' + size,
    value: family + ' ' + size,
    property: 'text',
    suggestedStyleId: matchedStyle ? matchedStyle.id : null,
    suggestedStyleName: matchedStyle ? matchedStyle.name : null,
    suggestedVariableId: null, suggestedVariableName: null
  }];
}

function lintEffects(node, styles) {
  if (EFFECT_TYPES.indexOf(node.type) === -1) return [];
  var effects;
  try { effects = node.effects; } catch(e) { return []; }
  if (!effects || effects.length === 0) return [];
  if (node.effectStyleId && node.effectStyleId !== '') return [];
  var matchedStyle = findMatchingEffectStyle(node, styles.effects);
  return [{
    ruleId: 'effect_missing', severity: 'error',
    message: 'Missing effect style',
    value: effects.length + ' effect(s)', property: 'effect',
    suggestedStyleId: matchedStyle ? matchedStyle.id : null,
    suggestedStyleName: matchedStyle ? matchedStyle.name : null,
    suggestedVariableId: null, suggestedVariableName: null
  }];
}

function lintRadius(node, config, varMaps) {
  if (['FRAME','RECTANGLE','INSTANCE','COMPONENT','SECTION'].indexOf(node.type) === -1) return [];
  var errors = [];
  var radii = [];
  try {
    if (node.cornerRadius !== undefined && node.cornerRadius !== figma.mixed) {
      radii = [{ prop: 'cornerRadius', val: node.cornerRadius }];
    } else if (node.cornerRadius === figma.mixed) {
      radii = [
        { prop: 'topLeftRadius', val: node.topLeftRadius },
        { prop: 'topRightRadius', val: node.topRightRadius },
        { prop: 'bottomLeftRadius', val: node.bottomLeftRadius },
        { prop: 'bottomRightRadius', val: node.bottomRightRadius }
      ];
    }
  } catch(e) { return []; }

  var allowlist = config.radiusAllowlist || DEFAULT_SETTINGS.radiusAllowlist;
  radii.forEach(function(r) {
    if (r.val === 0) return;
    if (typeof r.val !== 'number') return;
    // pill check
    try {
      if (r.val >= (node.height / 2 - 0.5)) return;
    } catch(e) {}
    // variable bound check
    if (node.boundVariables && node.boundVariables[r.prop]) return;
    if (allowlist.indexOf(r.val) !== -1) return;
    var suggestedVar = null;
    if (varMaps.numberVarMap) {
      var vars = varMaps.numberVarMap.get(r.val);
      if (vars && vars.length > 0) suggestedVar = vars[0];
    }
    errors.push({
      ruleId: 'radius_off_token', severity: 'error',
      message: 'Off-token border radius — ' + r.val + 'px',
      value: r.val + 'px', property: r.prop,
      suggestedStyleId: null, suggestedStyleName: null,
      suggestedVariableId: suggestedVar ? suggestedVar.id : null,
      suggestedVariableName: suggestedVar ? suggestedVar.name : null
    });
  });
  return errors;
}

function lintSpacing(node, config, varMaps) {
  if (['FRAME','COMPONENT'].indexOf(node.type) === -1) return [];
  try { if (node.layoutMode === 'NONE') return []; } catch(e) { return []; }
  var errors = [];
  var props = ['paddingLeft','paddingRight','paddingTop','paddingBottom','itemSpacing','counterAxisSpacing'];
  var allowlist = config.spacingAllowlist || DEFAULT_SETTINGS.spacingAllowlist;
  props.forEach(function(prop) {
    var val;
    try { val = node[prop]; } catch(e) { return; }
    if (typeof val !== 'number' || val === 0) return;
    if (node.boundVariables && node.boundVariables[prop]) return;
    if (allowlist.indexOf(val) !== -1) return;
    var suggestedVar = null;
    if (varMaps.numberVarMap) {
      var vars = varMaps.numberVarMap.get(val);
      if (vars && vars.length > 0) suggestedVar = vars[0];
    }
    errors.push({
      ruleId: 'spacing_off_token', severity: 'error',
      message: 'Off-token spacing — ' + prop + ': ' + val + 'px',
      value: val + 'px', property: prop,
      suggestedStyleId: null, suggestedStyleName: null,
      suggestedVariableId: suggestedVar ? suggestedVar.id : null,
      suggestedVariableName: suggestedVar ? suggestedVar.name : null
    });
  });
  return errors;
}

function lintOpacity(node, config, varMaps) {
  if (node.type === 'SLICE') return [];
  var opacity;
  try { opacity = node.opacity; } catch(e) { return []; }
  if (typeof opacity !== 'number' || opacity === 1) return [];
  if (node.boundVariables && node.boundVariables.opacity) return [];
  var allowlist = config.opacityAllowlist || DEFAULT_SETTINGS.opacityAllowlist;
  var pct = Math.round(opacity * 100);
  var inList = allowlist.some(function(v) { return Math.abs(v - opacity) < 0.005; });
  if (inList) return [];
  var suggestedVar = null;
  if (varMaps.numberVarMap) {
    for (var _entry of varMaps.numberVarMap) {
      if (Math.abs(_entry[0] - opacity) < 0.005) { suggestedVar = _entry[1][0]; break; }
    }
  }
  return [{
    ruleId: 'opacity_off_token', severity: 'warning',
    message: 'Off-token opacity — ' + pct + '%',
    value: pct + '%', property: 'opacity',
    suggestedStyleId: null, suggestedStyleName: null,
    suggestedVariableId: suggestedVar ? suggestedVar.id : null,
    suggestedVariableName: suggestedVar ? suggestedVar.name : null
  }];
}

function lintVisibility(node) {
  if (!node.parent) return [];
  try { if (!node.visible) {
    return [{
      ruleId: 'hidden_layer', severity: 'warning',
      message: 'Hidden layer', value: 'hidden', property: 'visible',
      suggestedStyleId: null, suggestedStyleName: null,
      suggestedVariableId: null, suggestedVariableName: null
    }];
  }} catch(e) {}
  return [];
}

var DEFAULT_NAMES = ['Rectangle','Ellipse','Polygon','Star','Vector','Line',
                     'Frame','Group','Text','Component','Boolean Operation'];
var DEFAULT_NAME_RE = /^(Frame|Group|Rectangle|Ellipse|Vector|Text|Line|Component|Star|Polygon)\s+\d+$/;

function lintNaming(node) {
  if (node.type === 'INSTANCE') return [];
  var name = node.name || '';
  var flagged = DEFAULT_NAMES.indexOf(name) !== -1 ||
                DEFAULT_NAME_RE.test(name) ||
                /copy/i.test(name) ||
                (name.length <= 2 && /\p{Emoji}/u.test(name));
  if (!flagged) return [];
  return [{
    ruleId: 'naming_violation', severity: 'warning',
    message: 'Generic layer name — “' + name + '”',
    value: name, property: 'name',
    suggestedStyleId: null, suggestedStyleName: null,
    suggestedVariableId: null, suggestedVariableName: null
  }];
}

// ── Scan node ──────────────────────────────────────────────────────────────
async function scanNode(node, config, styles, varMaps, token, stats) {
  if (token !== _scanToken) return null;
  await yieldIfNeeded();

  if (node.locked) return null;
  if (node.type === 'SLICE') return null;
  var isVector = node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION';
  if (isVector && !config.lintVectors) return null;

  stats.total++;
  if (stats.total % 50 === 0) {
    figma.ui.postMessage({ type: 'scan_progress', current: stats.total });
  }

  // Track which styles are actively in use (for unused-style report)
  try {
    var fsi = node.fillStyleId;
    if (fsi && fsi !== figma.mixed && fsi !== '') stats.usedFillStyleIds.add(fsi);
    var ssi = node.strokeStyleId;
    if (ssi && ssi !== figma.mixed && ssi !== '') stats.usedStrokeStyleIds.add(ssi);
    var tsi = node.textStyleId;
    if (tsi && tsi !== figma.mixed && tsi !== '') stats.usedTextStyleIds.add(tsi);
    var esi = node.effectStyleId;
    if (esi && esi !== figma.mixed && esi !== '') stats.usedEffectStyleIds.add(esi);
  } catch(e) {}

  var errors = [];
  errors = errors.concat(lintFill(node, styles, varMaps));
  errors = errors.concat(lintStroke(node, styles, varMaps));
  errors = errors.concat(lintText(node, styles));
  errors = errors.concat(lintEffects(node, styles));
  errors = errors.concat(lintRadius(node, config, varMaps));
  errors = errors.concat(lintSpacing(node, config, varMaps));
  errors = errors.concat(lintOpacity(node, config, varMaps));
  if (config.warnHidden) errors = errors.concat(lintVisibility(node));
  if (config.warnNaming) errors = errors.concat(lintNaming(node));

  if (errors.length === 0) return null;
  return {
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    errors: errors.map(function(e) {
      return Object.assign({}, e, { nodeId: node.id, nodeName: node.name, nodeType: node.type });
    })
  };
}

// ── Walk tree ──────────────────────────────────────────────────────────────
async function walkTree(roots, config, styles, varMaps, token, stats, results) {
  for (var i = 0; i < roots.length; i++) {
    if (token !== _scanToken) return;
    var node = roots[i];
    var result = await scanNode(node, config, styles, varMaps, token, stats);
    if (result) results.push(result);
    if (node.children && node.children.length > 0) {
      await walkTree(node.children, config, styles, varMaps, token, stats, results);
    }
  }
}

// ── Report builder ─────────────────────────────────────────────────────────
function buildReport(results, styles, scanDuration, stats, config) {
  var errorCount = 0, warnCount = 0;
  var ruleBreakdown = {};

  results.forEach(function(r) {
    r.errors.forEach(function(e) {
      if (e.severity === 'error') errorCount++;
      else warnCount++;
      ruleBreakdown[e.ruleId] = (ruleBreakdown[e.ruleId] || 0) + 1;
    });
  });

  var report = {
    totalNodes: 0,
    errorCount: errorCount,
    warnCount: warnCount,
    ruleBreakdown: ruleBreakdown,
    scanDuration: scanDuration
  };

  if (config && config.showUnusedStyles && stats) {
    var usedPaint = stats.usedFillStyleIds;
    var usedStroke = stats.usedStrokeStyleIds;
    report.unusedPaints = styles.paints
      .filter(function(s) { return !usedPaint.has(s.id) && !usedStroke.has(s.id); })
      .map(function(s) { return { id: s.id, name: s.name }; });
    report.unusedTexts = styles.texts
      .filter(function(s) { return !stats.usedTextStyleIds.has(s.id); })
      .map(function(s) { return { id: s.id, name: s.name }; });
    report.unusedEffects = styles.effects
      .filter(function(s) { return !stats.usedEffectStyleIds.has(s.id); })
      .map(function(s) { return { id: s.id, name: s.name }; });
  }

  return report;
}

// ── Message handler ────────────────────────────────────────────────────────
figma.ui.onmessage = async function(msg) {

  if (msg.type === 'scan') {
    var token = ++_scanToken;
    var config = msg.config || DEFAULT_SETTINGS;
    var t0 = Date.now();

    figma.ui.postMessage({ type: 'scan_start' });

    var styles, varMaps;
    try {
      styles = await getLocalStyles();
      varMaps = await buildVariableIndex();
    } catch(e) {
      figma.ui.postMessage({ type: 'scan_error', message: e.message });
      log('error', e.message);
      return;
    }

    var roots = msg.scope === 'selection'
      ? figma.currentPage.selection.slice()
      : figma.currentPage.children.slice();

    if (roots.length === 0) {
      figma.ui.postMessage({ type: 'scan_done', results: [], report: null, duration: 0 });
      log('info', 'Nothing to scan — selection is empty.');
      return;
    }

    var stats = {
      total: 0,
      usedFillStyleIds:   new Set(),
      usedStrokeStyleIds: new Set(),
      usedTextStyleIds:   new Set(),
      usedEffectStyleIds: new Set()
    };
    var results = [];
    await walkTree(roots, config, styles, varMaps, token, stats, results);

    if (token !== _scanToken) return;

    var duration = Date.now() - t0;
    var report = buildReport(results, styles, duration, stats, config);
    report.totalNodes = stats.total;
    figma.ui.postMessage({ type: 'scan_done', results: results, report: report, duration: duration });
    log('info', 'Scanned ' + stats.total + ' layers in ' + duration + 'ms — ' + report.errorCount + ' error(s), ' + report.warnCount + ' warning(s).');
  }

  else if (msg.type === 'apply_style') {
    try {
      var node = figma.getNodeById(msg.nodeId);
      if (!node) return;
      if (msg.property === 'fill') node.fillStyleId = msg.styleId;
      else if (msg.property === 'stroke') node.strokeStyleId = msg.styleId;
      else if (msg.property === 'text') node.textStyleId = msg.styleId;
      else if (msg.property === 'effect') node.effectStyleId = msg.styleId;
      figma.ui.postMessage({ type: 'apply_done', nodeId: msg.nodeId });
      log('info', 'Applied ' + msg.property + ' style to "' + node.name + '".');
    } catch(e) {
      figma.ui.postMessage({ type: 'apply_error', message: e.message });
      log('error', e.message);
    }
  }

  else if (msg.type === 'apply_variable') {
    try {
      var node = figma.getNodeById(msg.nodeId);
      if (!node) return;
      var variable = figma.variables.getVariableById(msg.variableId);
      if (!variable) return;
      if (msg.property === 'fill') {
        var fills = JSON.parse(JSON.stringify(node.fills));
        fills[msg.fillIndex] = figma.variables.setBoundVariableForPaint(fills[msg.fillIndex], 'color', variable);
        node.fills = fills;
      } else if (msg.property === 'stroke') {
        var strokes = JSON.parse(JSON.stringify(node.strokes));
        strokes[msg.fillIndex] = figma.variables.setBoundVariableForPaint(strokes[msg.fillIndex], 'color', variable);
        node.strokes = strokes;
      } else if (msg.property === 'cornerRadius') {
        node.setBoundVariable('topLeftRadius', variable);
        node.setBoundVariable('topRightRadius', variable);
        node.setBoundVariable('bottomLeftRadius', variable);
        node.setBoundVariable('bottomRightRadius', variable);
      } else {
        node.setBoundVariable(msg.property, variable);
      }
      figma.ui.postMessage({ type: 'apply_done', nodeId: msg.nodeId });
      log('info', 'Bound variable "' + variable.name + '" to "' + node.name + '" (' + msg.property + ').');
    } catch(e) {
      figma.ui.postMessage({ type: 'apply_error', message: e.message });
      log('error', e.message);
    }
  }

  else if (msg.type === 'create_style') {
    try {
      var node = figma.getNodeById(msg.nodeId);
      if (!node) return;
      if (msg.property === 'fill') {
        var fillStyle = figma.createPaintStyle();
        fillStyle.name = msg.styleName || 'New Fill Style';
        fillStyle.paints = node.fills;
        node.fillStyleId = fillStyle.id;
      } else if (msg.property === 'stroke') {
        var strokeStyle = figma.createPaintStyle();
        strokeStyle.name = msg.styleName || 'New Stroke Style';
        strokeStyle.paints = node.strokes;
        node.strokeStyleId = strokeStyle.id;
      } else if (msg.property === 'effect') {
        var effectStyle = figma.createEffectStyle();
        effectStyle.name = msg.styleName || 'New Effect Style';
        effectStyle.effects = node.effects;
        node.effectStyleId = effectStyle.id;
      } else if (msg.property === 'text') {
        var textStyle = figma.createTextStyle();
        textStyle.name = msg.styleName || 'New Text Style';
        textStyle.fontName = node.fontName;
        textStyle.fontSize = node.fontSize;
        textStyle.lineHeight = node.lineHeight;
        textStyle.letterSpacing = node.letterSpacing;
        textStyle.textCase = node.textCase;
        textStyle.paragraphSpacing = node.paragraphSpacing;
        node.textStyleId = textStyle.id;
      }
      figma.ui.postMessage({ type: 'apply_done', nodeId: msg.nodeId });
      log('info', 'Created a new ' + msg.property + ' style from "' + node.name + '".');
    } catch(e) {
      figma.ui.postMessage({ type: 'apply_error', message: e.message });
      log('error', e.message);
    }
  }

  else if (msg.type === 'select_nodes') {
    try {
      var nodes = (msg.nodeIds || []).map(function(id) {
        return figma.getNodeById(id);
      }).filter(Boolean);
      figma.currentPage.selection = nodes;
      if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);
    } catch(e) {}
  }

  else if (msg.type === 'select_node') {
    try {
      var node = figma.getNodeById(msg.nodeId);
      if (node) {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
    } catch(e) {}
  }

  else if (msg.type === 'delete_node') {
    try {
      var node = figma.getNodeById(msg.nodeId);
      var name = node ? node.name : msg.nodeId;
      if (node) node.remove();
      figma.ui.postMessage({ type: 'apply_done', nodeId: msg.nodeId });
      log('info', 'Deleted "' + name + '".');
    } catch(e) {
      log('error', e.message);
    }
  }

  else if (msg.type === 'show_node') {
    try {
      var node = figma.getNodeById(msg.nodeId);
      if (node) node.visible = true;
      figma.ui.postMessage({ type: 'apply_done', nodeId: msg.nodeId });
      if (node) log('info', 'Unhid "' + node.name + '".');
    } catch(e) {
      log('error', e.message);
    }
  }

  else if (msg.type === 'load_settings') {
    try {
      var saved = await figma.clientStorage.getAsync('linter-settings');
      var settings = Object.assign({}, DEFAULT_SETTINGS, saved || {});
      figma.ui.postMessage({ type: 'settings', settings: settings });
    } catch(e) {
      figma.ui.postMessage({ type: 'settings', settings: DEFAULT_SETTINGS });
    }
  }

  else if (msg.type === 'save_settings') {
    try {
      await figma.clientStorage.setAsync('linter-settings', msg.settings);
    } catch(e) {}
  }

  else if (msg.type === 'resize') {
    figma.ui.resize(480, 600);
  }

  else if (msg.type === 'open_url') {
    var allowed = [
      'https://twitter.com/danielfransix',
      'https://github.com/danielfransix',
      'https://buymeacoffee.com/danielfransix'
    ];
    if (allowed.indexOf(msg.url) !== -1) figma.openExternal(msg.url);
  }

  else if (msg.type === 'close_plugin') {
    figma.closePlugin();
  }
};

// ── Log panel ──────────────────────────────────────────────────────────────
function log(level, message) {
  figma.ui.postMessage({ type: 'log', level: level, message: message, time: formatTime() });
}

function formatTime() {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// ── Document change listener ───────────────────────────────────────────────
// loadAllPagesAsync must be called before registering documentchange in incremental mode
figma.loadAllPagesAsync().then(function() {
  figma.on('documentchange', function() {
    clearTimeout(_rerunDebounce);
    _rerunDebounce = setTimeout(function() {
      figma.ui.postMessage({ type: 'document_changed' });
    }, 300);
  });
});
