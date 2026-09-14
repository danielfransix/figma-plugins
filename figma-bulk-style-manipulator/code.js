// Figma Bulk Style Manipulator — code.js (plugin sandbox)

figma.showUI(__html__, { width: 480, height: 600, title: 'Bulk Style Editor', themeColors: true });

// ─── Serialisers ────────────────────────────────────────────────────────────

function serialiseTextStyle(s) {
  var bv = s.boundVariables || {};
  return {
    id: s.id,
    type: 'TEXT',
    name: s.name,
    description: s.description || '',
    remote: s.remote || false,
    fontFamily: s.fontName.family,
    fontStyle: s.fontName.style,
    fontSize: s.fontSize,
    lineHeight: JSON.parse(JSON.stringify(s.lineHeight)),
    letterSpacing: JSON.parse(JSON.stringify(s.letterSpacing)),
    paragraphSpacing: s.paragraphSpacing,
    paragraphIndent: s.paragraphIndent,
    listSpacing: s.listSpacing,
    textCase: s.textCase,
    textDecoration: s.textDecoration,
    leadingTrim: s.leadingTrim,
    hangingPunctuation: s.hangingPunctuation,
    hangingList: s.hangingList,
    openTypeFeatures: Object.assign({}, s.openTypeFeatures),
    boundVariables: {
      fontFamily: bv.fontFamily ? JSON.parse(JSON.stringify(bv.fontFamily)) : null,
      fontStyle:  bv.fontStyle  ? JSON.parse(JSON.stringify(bv.fontStyle))  : null,
      fontWeight: bv.fontWeight ? JSON.parse(JSON.stringify(bv.fontWeight)) : null,
      fontSize:   bv.fontSize   ? JSON.parse(JSON.stringify(bv.fontSize))   : null
    }
  };
}

function serialisePaint(p) {
  return JSON.parse(JSON.stringify(p));
}

function serialisePaintStyle(s) {
  return {
    id: s.id,
    type: 'PAINT',
    name: s.name,
    description: s.description || '',
    remote: s.remote || false,
    paints: Array.from(s.paints).map(serialisePaint)
  };
}

function serialiseEffect(e) {
  return JSON.parse(JSON.stringify(e));
}

function serialiseEffectStyle(s) {
  return {
    id: s.id,
    type: 'EFFECT',
    name: s.name,
    description: s.description || '',
    remote: s.remote || false,
    effects: Array.from(s.effects).map(serialiseEffect)
  };
}

function serialiseGrid(g) {
  return JSON.parse(JSON.stringify(g));
}

function serialiseGridStyle(s) {
  return {
    id: s.id,
    type: 'GRID',
    name: s.name,
    description: s.description || '',
    remote: s.remote || false,
    layoutGrids: Array.from(s.layoutGrids).map(serialiseGrid)
  };
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function loadAndSend() {
  var textStyles   = await figma.getLocalTextStylesAsync();
  var paintStyles  = await figma.getLocalPaintStylesAsync();
  var effectStyles = await figma.getLocalEffectStylesAsync();
  var gridStyles   = await figma.getLocalGridStylesAsync();

  figma.ui.postMessage({
    type: 'init',
    textStyles:   textStyles.map(serialiseTextStyle),
    paintStyles:  paintStyles.map(serialisePaintStyle),
    effectStyles: effectStyles.map(serialiseEffectStyle),
    gridStyles:   gridStyles.map(serialiseGridStyle)
  });
}

// ─── Apply changes ───────────────────────────────────────────────────────────

async function applyChange(change) {
  var style = figma.getStyleById(change.id);
  if (!style) return;
  var p = change.patches;

  if (change.styleType === 'TEXT') {
    var family = p.fontFamily !== undefined ? p.fontFamily : style.fontName.family;
    var weight = p.fontStyle  !== undefined ? p.fontStyle  : style.fontName.style;
    await figma.loadFontAsync({ family: family, style: weight });

    if (p.fontFamily !== undefined || p.fontStyle !== undefined) {
      style.fontName = { family: family, style: weight };
    }
    if (p.fontSize          !== undefined) style.fontSize          = p.fontSize;
    if (p.lineHeight        !== undefined) style.lineHeight        = p.lineHeight;
    if (p.letterSpacing     !== undefined) style.letterSpacing     = p.letterSpacing;
    if (p.paragraphSpacing  !== undefined) style.paragraphSpacing  = p.paragraphSpacing;
    if (p.paragraphIndent   !== undefined) style.paragraphIndent   = p.paragraphIndent;
    if (p.listSpacing       !== undefined) style.listSpacing       = p.listSpacing;
    if (p.textCase          !== undefined) style.textCase          = p.textCase;
    if (p.textDecoration    !== undefined) style.textDecoration    = p.textDecoration;
    if (p.leadingTrim       !== undefined) style.leadingTrim       = p.leadingTrim;
    if (p.hangingPunctuation !== undefined) style.hangingPunctuation = p.hangingPunctuation;
    if (p.hangingList       !== undefined) style.hangingList       = p.hangingList;
    if (p.openTypeFeatures  !== undefined) {
      style.openTypeFeatures = Object.assign({}, style.openTypeFeatures, p.openTypeFeatures);
    }
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }

  if (change.styleType === 'PAINT') {
    if (p.paints      !== undefined) style.paints      = p.paints;
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }

  if (change.styleType === 'EFFECT') {
    if (p.effects     !== undefined) style.effects     = p.effects;
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }

  if (change.styleType === 'GRID') {
    if (p.layoutGrids !== undefined) style.layoutGrids = p.layoutGrids;
    if (p.name        !== undefined) style.name        = p.name;
    if (p.description !== undefined) style.description = p.description;
  }
}

async function applyChanges(changes) {
  // Pre-load all fonts needed for TEXT changes in one batch
  var fontSet = Object.create(null);
  changes.forEach(function(c) {
    if (c.styleType !== 'TEXT') return;
    var style = figma.getStyleById(c.id);
    if (!style) return;
    var family = c.patches.fontFamily || style.fontName.family;
    var weight = c.patches.fontStyle  || style.fontName.style;
    fontSet[family + ':' + weight] = { family: family, style: weight };
  });
  await Promise.all(Object.values(fontSet).map(function(f) { return figma.loadFontAsync(f); }));

  var errors = [];
  for (var i = 0; i < changes.length; i++) {
    try {
      await applyChange(changes[i]);
    } catch (err) {
      errors.push({ id: changes[i].id, message: err && err.message ? err.message : String(err) });
    }
  }
  return errors;
}

// ─── Delete style ────────────────────────────────────────────────────────────

function deleteStyle(id) {
  var style = figma.getStyleById(id);
  if (style) style.remove();
}

// ─── Available fonts ─────────────────────────────────────────────────────────

async function sendAvailableFonts() {
  var fonts = await figma.listAvailableFontsAsync();
  figma.ui.postMessage({
    type: 'availableFonts',
    fonts: fonts.map(function(f) { return { family: f.fontName.family, style: f.fontName.style }; })
  });
}

// ─── Message handler ─────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'ready') {
    await loadAndSend();
  }

  if (msg.type === 'applyChanges') {
    try {
      var errors = await applyChanges(msg.changes);
      figma.ui.postMessage({ type: 'applyDone', count: msg.changes.length, errors: errors });
      log('info', 'Applied changes to ' + msg.changes.length + ' style(s)' + (errors.length ? ' — ' + errors.length + ' failed' : '') + '.');
      errors.forEach(function(e) { log('error', e.message); });
    } catch (err) {
      var m = err && err.message ? err.message : String(err);
      figma.ui.postMessage({ type: 'applyError', message: m });
      log('error', m);
    }
  }

  if (msg.type === 'deleteStyle') {
    try {
      var style = figma.getStyleById(msg.id);
      var name = style ? style.name : msg.id;
      deleteStyle(msg.id);
      log('info', 'Deleted style "' + name + '".');
    } catch (err) {
      var m2 = err && err.message ? err.message : String(err);
      figma.ui.postMessage({ type: 'applyError', message: m2 });
      log('error', m2);
    }
  }

  if (msg.type === 'getFonts') {
    await sendAvailableFonts();
  }

  if (msg.type === 'resize') {
    figma.ui.resize(480, 600);
  }

  if (msg.type === 'open_url') {
    var allowed = [
      'https://twitter.com/danielfransix',
      'https://buymeacoffee.com/danielfransix'
    ];
    if (allowed.indexOf(msg.url) !== -1) {
      figma.openExternal(msg.url);
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
