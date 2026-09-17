// Mosaic Grid Maker — plugin backend (Figma Plugin API), plain JS, no build step.
//
// Arranges the selected layers (or every top-level layer on the page) into a
// masonry-style column grid: optionally resizes them all to a uniform
// width/height (preserving aspect ratio), sorts them, then places each one
// into whichever column is currently shortest. Settings are persisted as
// plugin data on the single selected "target" node so re-running the plugin
// on that node later restores the same settings.

const TOOL_ID = 'mosaic-grid-maker-001';
const DISPLAY_NAME = 'Mosaic Grid Maker';
const ATTACH_KEY = TOOL_ID + ':state';
const SORT_OPTIONS = [
  'As selected',
  'Width (small first)',
  'Width (large first)',
  'Height (small first)',
  'Height (large first)',
  'Area (small first)',
  'Area (large first)',
];
const DEFAULTS = {
  gap: 8,
  columns: 12,
  sortBy: 'As selected',
  uniformSize: true,
  uniformValue: 500,
  uniformDimension: 'Width',
  arrangeAll: true,
};

let latestParams = DEFAULTS;
let isExecuting = false;

function finiteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeParams(input) {
  const value = input || {};
  return {
    gap: Math.max(0, finiteNumber(value.gap, DEFAULTS.gap)),
    columns: Math.max(1, Math.floor(finiteNumber(value.columns, DEFAULTS.columns))),
    sortBy: SORT_OPTIONS.includes(String(value.sortBy)) ? String(value.sortBy) : DEFAULTS.sortBy,
    uniformSize: typeof value.uniformSize === 'boolean' ? value.uniformSize : DEFAULTS.uniformSize,
    uniformValue: clamp(finiteNumber(value.uniformValue, DEFAULTS.uniformValue), 1, 2000),
    uniformDimension: value.uniformDimension === 'Height' ? 'Height' : 'Width',
    arrangeAll: typeof value.arrangeAll === 'boolean' ? value.arrangeAll : DEFAULTS.arrangeAll,
  };
}

function uniqueSceneNodes(nodes) {
  return [...new Set(nodes)].filter((node) => !node.removed);
}

function attachRelaunch(nodes) {
  const unique = uniqueSceneNodes(nodes);
  if (unique.length > 0) {
    for (const node of unique) node.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME });
  } else {
    figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME });
  }
}

function singleSelectedTarget() {
  const selection = figma.currentPage.selection;
  return selection.length === 1 ? selection[0] : null;
}

function readAttachment(node) {
  try {
    const parsed = JSON.parse(node.getPluginData(ATTACH_KEY));
    if (!parsed || parsed.version !== 1) return null;
    return {
      version: 1,
      params: normalizeParams(parsed.params),
      state: parsed.state != null ? parsed.state : null,
    };
  } catch (e) {
    return null;
  }
}

function writeAttachment(node, params, state) {
  node.setPluginData(ATTACH_KEY, JSON.stringify({ version: 1, params, state }));
}

function getArrangeNodes(params) {
  if (params.arrangeAll) {
    return figma.currentPage.children.filter((n) => !n.removed);
  }
  return [...figma.currentPage.selection];
}

function statusArrange(_selection, enabled, params) {
  if (params.arrangeAll) return 'Will arrange all root layers';
  return enabled ? 'Ready to arrange' : 'Select 2+ layers';
}

function evaluateEnabledArrange(selection, params) {
  if (params.arrangeAll) return figma.currentPage.children.length >= 2;
  return selection.length >= 2;
}

function actionTargetArrange() {
  const selection = figma.currentPage.selection;
  if (!evaluateEnabledArrange(selection, latestParams)) return null;
  return selection.length >= 1 ? selection[0] : null;
}

async function actionArrange(params, target) {
  const affectedNodes = target != null ? [target] : [];
  const nodes = getArrangeNodes(params);

  if (nodes.length >= 2) {
    // Apply uniform size if enabled — preserve aspect ratio
    if (params.uniformSize) {
      for (const node of nodes) {
        if ('resize' in node && node.width > 0 && node.height > 0) {
          const aspect = node.width / node.height;
          let w, h;
          if (params.uniformDimension === 'Width') {
            w = params.uniformValue;
            h = w / aspect;
          } else {
            h = params.uniformValue;
            w = h * aspect;
          }
          node.resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
          // Lock aspect ratio in Figma's constraint settings
          if ('constrainProportions' in node) {
            node.constrainProportions = true;
          }
        }
      }
    }

    if (params.sortBy === 'Width (small first)') nodes.sort((a, b) => a.width - b.width);
    else if (params.sortBy === 'Width (large first)') nodes.sort((a, b) => b.width - a.width);
    else if (params.sortBy === 'Height (small first)') nodes.sort((a, b) => a.height - b.height);
    else if (params.sortBy === 'Height (large first)') nodes.sort((a, b) => b.height - a.height);
    else if (params.sortBy === 'Area (small first)') nodes.sort((a, b) => a.width * a.height - b.width * b.height);
    else if (params.sortBy === 'Area (large first)') nodes.sort((a, b) => b.width * b.height - a.width * a.height);

    const gap = params.gap;
    const cols = Math.min(params.columns, nodes.length);
    const startX = nodes[0].x;
    const startY = nodes[0].y;
    const maxWidth = nodes.reduce((max, n) => Math.max(max, n.width), 0);
    const totalWidth = maxWidth * cols + gap * (cols - 1);
    const colWidth = (totalWidth - gap * (cols - 1)) / cols;
    const colHeights = new Array(cols).fill(0);
    const colX = [];
    for (let c = 0; c < cols; c++) {
      colX.push(startX + c * (colWidth + gap));
    }
    for (const node of nodes) {
      let shortest = 0;
      for (let c = 1; c < cols; c++) {
        if (colHeights[c] < colHeights[shortest]) shortest = c;
      }
      node.x = colX[shortest];
      node.y = startY + colHeights[shortest];
      colHeights[shortest] += node.height + gap;
      affectedNodes.push(node);
    }
  }

  return { affectedNodes, state: null };
}

async function runActionArrange(target, notify) {
  isExecuting = true;
  try {
    const result = await actionArrange(latestParams, target);
    if (target != null) writeAttachment(target, latestParams, result.state);
    attachRelaunch(result.affectedNodes);
    pushActionStates();
    if (notify) {
      const created = result.affectedNodes.filter((node) => node !== target);
      if (created.length > 0) {
        if (target == null) figma.currentPage.selection = created;
        figma.viewport.scrollAndZoomIntoView(created);
      }
      figma.notify(DISPLAY_NAME + ' ran');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    figma.notify(message, { error: true });
    throw error;
  } finally {
    isExecuting = false;
  }
}

function pushActionStates() {
  const selection = figma.currentPage.selection;
  const enabledArrange = evaluateEnabledArrange(selection, latestParams);
  figma.ui.postMessage({
    type: 'action-state',
    actions: {
      arrange: { enabled: enabledArrange, label: 'Arrange', status: statusArrange(selection, enabledArrange, latestParams) },
    },
  });
}

function refreshSelection() {
  if (isExecuting) return;
  const target = singleSelectedTarget();
  const attachment = target != null ? readAttachment(target) : null;
  latestParams = attachment ? attachment.params : latestParams;
  figma.ui.postMessage({ type: 'params-change', params: latestParams });
  pushActionStates();
}

async function start() {
  await figma.currentPage.loadAsync();

  const initialTarget = singleSelectedTarget();
  const initialAttachment = initialTarget != null ? readAttachment(initialTarget) : null;
  const initialParams = initialAttachment ? initialAttachment.params : DEFAULTS;
  latestParams = initialParams;

  figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME });
  figma.showUI(__html__, { width: 280, height: 320, themeColors: true });
  figma.ui.postMessage({ type: 'params-change', params: initialParams });
  pushActionStates();
  figma.on('selectionchange', refreshSelection);

  figma.ui.onmessage = (msg) => {
    if (msg.type === 'resize') {
      figma.ui.resize(280, Math.max(120, Math.min(900, Math.round(msg.height))));
      return;
    }
    if (msg.type === 'toggle') {
      latestParams = normalizeParams(Object.assign({}, latestParams, msg.params));
      pushActionStates();
      return;
    }
    if (msg.type === 'action' && msg.id === 'arrange') {
      const params = normalizeParams(msg.params);
      latestParams = params;
      const target = params.arrangeAll ? null : actionTargetArrange();
      void runActionArrange(target, true);
    }
  };
}

void start();
