figma.showUI(__html__, { width: 390, height: 600, title: 'Component Collector', themeColors: true });

figma.ui.onmessage = async function(msg) {
  if (msg.type === 'resize') {
    figma.ui.resize(390, 600);
    return;
  }
  if (msg.type === 'run') {
    try {
      await runCollect(msg.widthFilter);
    } catch (err) {
      var errMsg = err.message || 'An unexpected error occurred.';
      figma.ui.postMessage({ type: 'error', message: errMsg });
      log('error', errMsg);
    }
    return;
  }
  if (msg.type === 'ui_ready') {
    figma.ui.postMessage({ type: 'debug_info', messageChannelSupported: _messageChannelSupported });
    return;
  }
  if (msg.type === 'visibility') {
    _uiHidden = !!msg.hidden;
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

var COLLECTION_PAGE_NAME = '[component-collector]';
var CONTAINER_NAME = 'Components';

var _widthFilter = { enabled: false, min: 0, max: null };

var _lastYieldTime = Date.now();
var _yieldCounter = 0;
var _messageChannelSupported = (typeof MessageChannel !== 'undefined');
var _uiHidden = false;

// While the window/tab is hidden, throttled setTimeout stalls cost hundreds to
// tens of thousands of ms each (confirmed via testing), but the actual work
// between yields runs at normal speed regardless of visibility. So the only
// lever we have is yielding far less often while hidden, since nothing is
// visibly rendering that needs to stay responsive anyway.
var YIELD_THRESHOLD_VISIBLE_MS = 150;
var YIELD_THRESHOLD_HIDDEN_MS = 5000;

function passesWidthFilter(node) {
  if (!_widthFilter.enabled) return true;
  if (node.width < _widthFilter.min) return false;
  if (_widthFilter.max !== null && node.width > _widthFilter.max) return false;
  return true;
}

// setTimeout(fn, 0) gets throttled hard by Chromium/Electron once the tab/window
// loses focus (clamped to ~1s, then further). MessageChannel postMessage isn't
// classified as a timer, so it's typically exempt from that throttling.
// Fall back to setTimeout if MessageChannel isn't available in this sandbox.
function scheduleYield(resolve) {
  if (_messageChannelSupported) {
    try {
      var channel = new MessageChannel();
      channel.port1.onmessage = function() {
        channel.port1.onmessage = null;
        resolve();
      };
      channel.port2.postMessage(null);
      return;
    } catch (e) {
      _messageChannelSupported = false;
    }
  }
  setTimeout(resolve, 0);
}

async function yieldIfNeeded() {
  if (++_yieldCounter % 100 !== 0) return;
  var workMs = Date.now() - _lastYieldTime;
  var threshold = _uiHidden ? YIELD_THRESHOLD_HIDDEN_MS : YIELD_THRESHOLD_VISIBLE_MS;
  if (workMs > threshold) {
    var yieldStart = Date.now();
    await new Promise(scheduleYield);
    var yieldDuration = Date.now() - yieldStart;
    if (yieldDuration > 100) {
      console.log('[component-collector] work ' + workMs + 'ms -> yield ' + yieldDuration + 'ms (hidden=' + _uiHidden + ', messageChannel=' + _messageChannelSupported + ')');
      figma.ui.postMessage({
        type: 'debug_yield',
        duration: yieldDuration,
        workMs: workMs,
        hidden: _uiHidden,
        messageChannelSupported: _messageChannelSupported,
      });
    }
    _lastYieldTime = Date.now();
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runCollect(widthFilter) {
  _widthFilter = widthFilter || { enabled: false, min: 0, max: null };
  _yieldCounter = 0;
  _lastYieldTime = Date.now();

  // Snapshot pages before creating the collection page so we never scan it
  var allPages = figma.root.children.slice();

  // ── Find or create the collection page ────────────────────────────────────
  var collectionPage = null;
  for (var i = 0; i < allPages.length; i++) {
    if (allPages[i].name === COLLECTION_PAGE_NAME) {
      collectionPage = allPages[i];
      break;
    }
  }
  if (!collectionPage) {
    collectionPage = figma.createPage();
    collectionPage.name = COLLECTION_PAGE_NAME;
  }

  try { await collectionPage.loadAsync(); } catch (e) {}

  // ── Find or create the auto-layout container ──────────────────────────────
  var container = null;
  var cpChildren = collectionPage.children;
  for (var i = 0; i < cpChildren.length; i++) {
    if (cpChildren[i].type === 'FRAME' && cpChildren[i].name === CONTAINER_NAME) {
      container = cpChildren[i];
      break;
    }
  }
  if (!container) {
    container = figma.createFrame();
    container.name = CONTAINER_NAME;
    container.layoutMode = 'VERTICAL';
    container.primaryAxisSizingMode = 'AUTO';
    container.counterAxisSizingMode = 'AUTO';
    container.itemSpacing = 80;
    container.paddingTop = 80;
    container.paddingBottom = 80;
    container.paddingLeft = 80;
    container.paddingRight = 80;
    container.fills = [];
    container.x = 100;
    container.y = 100;
    collectionPage.appendChild(container);
  }

  // ── Scan and collect, page by page ────────────────────────────────────────
  var totalCollected = 0;
  var totalReplaced  = 0;
  var totalSkipped   = 0;
  var seen = new Set();
  var pageTotal = allPages.length;

  for (var pi = 0; pi < allPages.length; pi++) {
    var page = allPages[pi];
    if (page.id === collectionPage.id) continue;

    try { await page.loadAsync(); } catch (e) {}

    figma.ui.postMessage({
      type: 'progress',
      page: page.name,
      pageIndex: pi + 1,
      pageTotal: pageTotal,
      found: totalCollected,
    });

    // ── DFS scan: find all local COMPONENT and COMPONENT_SET nodes ───────────
    var pageItems = [];
    var stack = [];
    var pageChildren = page.children;
    for (var ci = 0; ci < pageChildren.length; ci++) {
      stack.push(pageChildren[ci]);
    }

    while (stack.length > 0) {
      await yieldIfNeeded();
      var node = stack.pop();
      if (!node || node.removed) continue;

      if (node.type === 'COMPONENT_SET') {
        if (!node.remote && !seen.has(node.id) && passesWidthFilter(node)) {
          seen.add(node.id);
          var pType = node.parent ? node.parent.type : 'PAGE';
          pageItems.push({
            node: node,
            needsReplacement: (pType !== 'PAGE' && pType !== 'SECTION'),
          });
        }
        continue; // never descend into a COMPONENT_SET
      }

      if (node.type === 'COMPONENT') {
        // Variants are handled via their parent COMPONENT_SET — skip them here
        if (node.parent && node.parent.type === 'COMPONENT_SET') continue;

        if (!node.remote && !seen.has(node.id) && passesWidthFilter(node)) {
          seen.add(node.id);
          var pType = node.parent ? node.parent.type : 'PAGE';
          pageItems.push({
            node: node,
            needsReplacement: (pType !== 'PAGE' && pType !== 'SECTION'),
          });
        }
        continue; // never descend into a COMPONENT
      }

      if ('children' in node) {
        var nodeChildren = node.children;
        for (var ci = 0; ci < nodeChildren.length; ci++) {
          stack.push(nodeChildren[ci]);
        }
      }
    }

    // ── Process this page's items: replace in place, then move ───────────────
    for (var ii = 0; ii < pageItems.length; ii++) {
      await yieldIfNeeded();
      var item = pageItems[ii];
      var target = item.node;

      try {
        if (target.removed) { totalSkipped++; continue; }

        if (item.needsReplacement) {
          var parent = target.parent;
          var targetIndex = -1;
          for (var k = 0; k < parent.children.length; k++) {
            if (parent.children[k].id === target.id) { targetIndex = k; break; }
          }
          var savedX = target.x;
          var savedY = target.y;

          var instance = null;
          if (target.type === 'COMPONENT') {
            instance = target.createInstance();
          } else if (target.type === 'COMPONENT_SET' && target.children && target.children.length > 0) {
            // Instantiate the first variant as a stand-in
            var firstVariant = target.children[0];
            if (firstVariant && firstVariant.type === 'COMPONENT') {
              instance = firstVariant.createInstance();
            }
          }

          if (instance) {
            if (targetIndex >= 0) {
              parent.insertChild(targetIndex, instance);
            } else {
              parent.appendChild(instance);
            }
            instance.x = savedX;
            instance.y = savedY;
            totalReplaced++;
          }
        }

        // Move the master into the auto-layout container
        container.appendChild(target);

        // Keep the component at its natural dimensions inside the auto-layout frame
        try {
          if ('layoutSizingHorizontal' in target) target.layoutSizingHorizontal = 'FIXED';
          if ('layoutSizingVertical'   in target) target.layoutSizingVertical   = 'FIXED';
        } catch (e) {}

        totalCollected++;
      } catch (e) {
        totalSkipped++;
      }
    }

    // Post updated count after finishing this page
    figma.ui.postMessage({
      type: 'progress',
      page: page.name,
      pageIndex: pi + 1,
      pageTotal: pageTotal,
      found: totalCollected,
    });
  }

  // ── Notify and wrap up ────────────────────────────────────────────────────
  if (totalCollected === 0) {
    figma.ui.postMessage({
      type: 'done',
      collected: 0,
      replaced: 0,
      skipped: totalSkipped,
    });
    return;
  }

  var notifyParts = [totalCollected + ' component' + (totalCollected !== 1 ? 's' : '') + ' collected'];
  if (totalReplaced > 0) {
    notifyParts.push(totalReplaced + ' replaced with instance' + (totalReplaced !== 1 ? 's' : ''));
  }
  figma.notify('Component Collector · ' + notifyParts.join(' · '));
  log('info', notifyParts.join(', ') + (totalSkipped > 0 ? ', ' + totalSkipped + ' skipped' : '') + '.');

  figma.ui.postMessage({
    type: 'done',
    collected: totalCollected,
    replaced: totalReplaced,
    skipped: totalSkipped,
  });
}

// ── Log panel ────────────────────────────────────────────────────────────────

function log(level, message) {
  figma.ui.postMessage({ type: 'log', level: level, message: message, time: formatTime() });
}

function formatTime() {
  var d = new Date();
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
