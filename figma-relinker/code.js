// Figma Relinker — Plugin Main Thread

figma.showUI(__html__, { width: 460, height: 300, title: 'Figma Relinker', themeColors: true });

// ─── Cancellation flag ────────────────────────────────────────────────────────

let _cancelled = false;

// ─── Constants ────────────────────────────────────────────────────────────────

const IMPORT_BATCH = 15;

// ─── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'resize') {
    figma.ui.resize(460, Math.min(msg.height, 600));
    return;
  }
  if (msg.type === 'close_plugin') {
    figma.closePlugin();
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
  if (msg.type === 'cancel') {
    _cancelled = true;
    return;
  }

  var id = msg.id;
  var command = msg.command;
  var params = msg.params || {};

  try {
    var result = await handleCommand(command, params);
    figma.ui.postMessage({ id: id, result: result });
    logCommandResult(command, result);
  } catch (err) {
    figma.ui.postMessage({ id: id, error: err.message });
    log('error', err.message);
  }
};

// ─── Log panel ────────────────────────────────────────────────────────────────

function log(level, message) {
  figma.ui.postMessage({ type: 'log', level: level, message: message, time: formatTime() });
}

function formatTime() {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function logCommandResult(command, result) {
  if (command === 'scan_and_fetch') {
    if (result.cancelled) { log('info', 'Scan cancelled.'); return; }
    log('info', 'Scan found ' + result.groups.length + ' broken group(s), ' + result.sets.length + ' library set(s) available.');
  } else if (command === 'apply_relinks') {
    if (result.cancelled) { log('info', 'Relink cancelled.'); return; }
    log('info', 'Relinked ' + result.ok + ' ok, ' + result.partial + ' partial, ' + result.failed + ' failed.');
  } else if (command === 'select_nodes_on_page') {
    log('info', 'Selected ' + result.selected + ' node(s) on page.');
  }
}

// ─── Command router ───────────────────────────────────────────────────────────

async function handleCommand(command, params) {
  switch (command) {
    case 'scan_and_fetch':
      return scanAndFetch(params.scope || 'page');
    case 'apply_relinks':
      return applyRelinks(params.matches || []);
    case 'select_nodes_on_page':
      return selectNodesOnPage(params.pageId, params.nodeIds || []);
    default:
      throw new Error('Unknown command: ' + command);
  }
}

// ─── scan_and_fetch ───────────────────────────────────────────────────────────

async function scanAndFetch(scope) {
  _cancelled = false;

  // Run scan first — if nothing is broken, skip the expensive library fetch entirely
  var scanResult = await scanBrokenInstances(scope);

  if (scanResult.cancelled) {
    return { cancelled: true, groups: [], sets: [], localComps: [] };
  }

  if (scanResult.groups.length === 0) {
    return { groups: [], sets: [], localComps: [] };
  }

  var libResult = await fetchLibraryComponentSets();

  return {
    groups:     scanResult.groups,
    sets:       libResult.sets,
    localComps: libResult.localComps,
  };
}

// ─── Scan broken instances (non-blocking stack walk) ─────────────────────────

function getRoots(scope) {
  if (scope === 'selection') {
    var sel = figma.currentPage.selection;
    return sel.length > 0 ? sel : [figma.currentPage];
  }
  if (scope === 'all') return figma.root.children;
  return [figma.currentPage];
}

async function scanBrokenInstances(scope) {
  var roots  = getRoots(scope);
  var groups = new Map();

  for (var r = 0; r < roots.length; r++) {
    var root     = roots[r];
    var pageNode = (scope === 'all') ? root : figma.currentPage;
    var pageId   = String(pageNode.id);
    var pageName = String(pageNode.name);
    var stack    = [root];
    var count    = 0;

    figma.ui.postMessage({ type: 'scan_progress', scanned: 0, found: 0 });

    while (stack.length > 0) {
      if (_cancelled) {
        return { cancelled: true, groups: Array.from(groups.values()) };
      }

      var node = stack.pop();
      count++;

      if (count % 500 === 0) {
        figma.ui.postMessage({ type: 'scan_progress', scanned: count, found: groups.size });
        await new Promise(function(resolve) { setTimeout(resolve, 0); });
      }

      if (node.type === 'INSTANCE' && node.mainComponent === null) {
        var name = String(node.name);
        if (!groups.has(name)) {
          groups.set(name, {
            name:                name,
            instanceIds:         [],
            instancesByPage:     {},
            componentProperties: serializeComponentProperties(node.componentProperties),
            pageIds:             [],
            pageNames:           [],
          });
        }
        var g = groups.get(name);
        g.instanceIds.push(String(node.id));
        if (!g.instancesByPage[pageId]) g.instancesByPage[pageId] = [];
        g.instancesByPage[pageId].push(String(node.id));
        if (g.pageIds.indexOf(pageId) === -1) {
          g.pageIds.push(pageId);
          g.pageNames.push(pageName);
        }
      }

      if (node.children) {
        for (var i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]);
        }
      }
    }
  }

  return { groups: Array.from(groups.values()) };
}

// Figma's componentProperties is a proxy object and cannot cross the postMessage
// boundary directly — deepFreezeObject in the plugin sandbox will abort if we try.
// Manually extract only the plain-value fields we actually need.
function serializeComponentProperties(props) {
  if (!props) return null;
  var out = {};
  try {
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = props[k];
      var type = String(v.type || '');
      var val  = v.value;
      // INSTANCE_SWAP value is { type, key } — also a proxy, flatten it
      if (val !== null && typeof val === 'object') {
        val = { type: String(val.type || ''), key: String(val.key || '') };
      }
      out[k] = { type: type, value: val };
    }
  } catch (e) {
    return null;
  }
  return out;
}

// ─── Fetch library component sets ─────────────────────────────────────────────

var LIBRARY_FETCH_TIMEOUT = 10000; // 10s — getAvailableLibraryComponentSetsAsync can hang on bad connections

async function fetchLibraryComponentSets() {
  var sets = [];

  try {
    var raw = await Promise.race([
      figma.teamLibrary.getAvailableLibraryComponentSetsAsync(),
      new Promise(function(_, reject) {
        setTimeout(function() { reject(new Error('Library fetch timed out — check your connection')); }, LIBRARY_FETCH_TIMEOUT);
      }),
    ]);
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      sets.push({ key: String(s.key), name: String(s.name), libraryName: String(s.libraryName || '') });
    }
  } catch (e) {
    console.warn('[Relinker] teamLibrary unavailable:', e.message);
    figma.ui.postMessage({ type: 'lib_fetch_error', message: e.message });
    log('error', 'Library fetch failed: ' + e.message);
  }

  var localComps = [];
  var pages = figma.root.children;
  for (var p = 0; p < pages.length; p++) {
    var children = pages[p].children;
    for (var c = 0; c < children.length; c++) {
      collectLocalComponents(children[c], localComps);
    }
  }

  return { sets: sets, localComps: localComps };
}

function collectLocalComponents(node, out) {
  if (node.type === 'COMPONENT') {
    var parent = node.parent;
    out.push({
      id:      String(node.id),
      name:    String(node.name),
      setName: (parent && parent.type === 'COMPONENT_SET') ? String(parent.name) : null,
    });
  }
  if (node.children) {
    for (var i = 0; i < node.children.length; i++) {
      collectLocalComponents(node.children[i], out);
    }
  }
}

// ─── Apply relinks ────────────────────────────────────────────────────────────

async function applyRelinks(matches) {
  _cancelled = false;
  var results = { ok: 0, partial: 0, failed: 0, failedGroups: [] };

  // Phase 1: deduplicated parallel import of all needed sets
  var keySet = new Set();
  for (var mi = 0; mi < matches.length; mi++) {
    var m = matches[mi];
    if (m.enabled && m.targetSetKey) keySet.add(m.targetSetKey);
  }
  var uniqueSetKeys = Array.from(keySet);
  var keyToSet = {};

  for (var i = 0; i < uniqueSetKeys.length; i += IMPORT_BATCH) {
    if (_cancelled) return Object.assign({}, results, { cancelled: true });
    var batch = uniqueSetKeys.slice(i, i + IMPORT_BATCH);
    await Promise.all(batch.map(async function(key) {
      try {
        keyToSet[key] = await figma.importComponentSetByKeyAsync(key);
      } catch (e) {
        keyToSet[key] = null;
      }
    }));
    figma.ui.postMessage({
      type: 'apply_progress',
      phase: 'importing',
      done: Math.min(i + IMPORT_BATCH, uniqueSetKeys.length),
      total: uniqueSetKeys.length,
    });
  }

  // If there were no sets to import, jump the UI progress bar to 50% so the
  // relinking phase fills the second half rather than the whole bar
  if (uniqueSetKeys.length === 0) {
    figma.ui.postMessage({ type: 'apply_progress', phase: 'importing', done: 0, total: 0 });
  }

  // Phase 2: apply swaps
  var total = 0;
  for (var mi2 = 0; mi2 < matches.length; mi2++) {
    if (matches[mi2].enabled) total += matches[mi2].instanceIds.length;
  }
  var processed = 0;

  for (var mi3 = 0; mi3 < matches.length; mi3++) {
    var match = matches[mi3];
    if (!match.enabled) continue;
    if (_cancelled) return Object.assign({}, results, { cancelled: true });

    for (var ii = 0; ii < match.instanceIds.length; ii++) {
      var instanceId = match.instanceIds[ii];
      var node = figma.getNodeById(instanceId);

      if (!node || node.type !== 'INSTANCE') {
        results.failed++;
        processed++;
        continue;
      }

      try {
        var targetComponent = null;

        if (match.targetSetKey) {
          var set = keyToSet[match.targetSetKey];
          if (!set) throw new Error('Set import failed');
          var found = findVariantInSet(set, match.componentProperties);
          targetComponent = found;
        } else if (match.targetLocalId) {
          var localNode = figma.getNodeById(match.targetLocalId);
          if (!localNode) throw new Error('Local component not found');
          targetComponent = { node: localNode, isDefault: false };
        }

        if (!targetComponent || !targetComponent.node) throw new Error('No target component');

        node.swapComponent(targetComponent.node);
        // Count after the swap succeeds so a thrown swapComponent doesn't double-count
        if (targetComponent.isDefault) {
          results.partial++;
        } else {
          results.ok++;
        }

      } catch (e) {
        results.failed++;
        var alreadyLogged = false;
        for (var fg = 0; fg < results.failedGroups.length; fg++) {
          if (results.failedGroups[fg].name === match.instanceName) { alreadyLogged = true; break; }
        }
        if (!alreadyLogged) {
          results.failedGroups.push({ name: match.instanceName, error: e.message });
        }
      }

      processed++;
      if (processed % 5 === 0) {
        figma.ui.postMessage({ type: 'apply_progress', phase: 'relinking', done: processed, total: total });
        await new Promise(function(resolve) { setTimeout(resolve, 0); });
      }
    }
  }

  return results;
}

// ─── Variant resolution ───────────────────────────────────────────────────────

function findVariantInSet(set, componentProperties) {
  if (!set.children || set.children.length === 0) {
    return { node: set, isDefault: true };
  }
  if (!componentProperties || Object.keys(componentProperties).length === 0) {
    return { node: set.defaultVariant || set.children[0], isDefault: true };
  }

  var wantedPairs = [];
  var keys = Object.keys(componentProperties);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = componentProperties[k];
    if (v && v.type === 'VARIANT') {
      // Figma appends "#XXXX" disambiguation suffixes to property keys internally
      // (e.g. "State#1234") but variant component names use the bare key ("State=Default")
      var cleanKey = k.replace(/#\d+$/, '');
      wantedPairs.push(cleanKey + '=' + v.value);
    }
  }

  // No variant axes — nothing to match on, fall back to default
  if (wantedPairs.length === 0) {
    return { node: set.defaultVariant || set.children[0], isDefault: true };
  }

  var exactMatch = null;
  for (var c = 0; c < set.children.length; c++) {
    var child = set.children[c];
    if (child.type !== 'COMPONENT') continue;
    var allMatch = true;
    for (var p = 0; p < wantedPairs.length; p++) {
      if (child.name.indexOf(wantedPairs[p]) === -1) { allMatch = false; break; }
    }
    if (allMatch) { exactMatch = child; break; }
  }

  if (exactMatch) return { node: exactMatch, isDefault: false };
  return { node: set.defaultVariant || set.children[0], isDefault: true };
}

// ─── Cross-page node selection ────────────────────────────────────────────────

async function selectNodesOnPage(pageId, nodeIds) {
  var page = null;
  var pages = figma.root.children;
  for (var i = 0; i < pages.length; i++) {
    if (pages[i].id === pageId) { page = pages[i]; break; }
  }
  if (!page) throw new Error('Page not found: ' + pageId);

  figma.currentPage = page;

  var nodes = [];
  for (var j = 0; j < nodeIds.length; j++) {
    var n = figma.getNodeById(nodeIds[j]);
    if (n) nodes.push(n);
  }

  figma.currentPage.selection = nodes;
  if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);

  return { ok: true, pageId: pageId, selected: nodes.length };
}

// ─── Matching engine (runs in code.js, called from UI via message) ────────────
// The UI sends scan results + library data back via apply_relinks;
// matching itself runs in the UI thread for responsiveness.
// These utilities are exported for completeness if needed server-side.

function normalizeName(name) {
  return name
    .replace(/\s*\/\s*/g, '/')
    .replace(/_/g, '/')
    .toLowerCase()
    .trim();
}

function stripVariantSuffix(name) {
  var parts = name.split('/');
  var VARIANT_WORDS = /^(default|primary|secondary|sm|md|lg|true|false|on|off|light|dark|\d+)$/i;
  if (parts.length > 1 && VARIANT_WORDS.test(parts[parts.length - 1].trim())) {
    return parts.slice(0, -1).join('/');
  }
  return name;
}

function buildTokenIndex(sets) {
  var index = new Map();
  for (var i = 0; i < sets.length; i++) {
    var s = sets[i];
    var tokens = s.name.toLowerCase().split(/[\/\s_-]+/);
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      if (!index.has(tok)) index.set(tok, new Set());
      index.get(tok).add(s);
    }
  }
  return index;
}

function bestFuzzyMatch(name, sets, tokenIndex) {
  var tokens = name.toLowerCase().split(/[\/\s_-]+/);
  var candidates = new Map();
  for (var t = 0; t < tokens.length; t++) {
    var matches = tokenIndex.get(tokens[t]);
    if (!matches) continue;
    matches.forEach(function(s) {
      candidates.set(s, (candidates.get(s) || 0) + 1);
    });
  }
  var best = null, bestScore = 0;
  candidates.forEach(function(overlap, s) {
    var compTokens = s.name.toLowerCase().split(/[\/\s_-]+/);
    var score = overlap / Math.max(tokens.length, compTokens.length);
    if (score > bestScore && score >= 0.6) { bestScore = score; best = s; }
  });
  return best;
}
