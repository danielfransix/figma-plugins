// Figma Arrow Manager — plugin backend (Figma Plugin API), plain JS, no build step.
//
// A plugin can never create or clone a native CONNECTOR node ("Cloning CONNECTOR
// nodes is not supported in the current editor"). Instead, the user copy-pastes a
// fresh connector from their styled original (Ctrl+C once, Ctrl+V per new
// connection — Figma preserves the exact styling natively), then selects that
// pasted connector plus the two elements to connect, and this plugin reassigns
// the connector's two ends. It also bulk-manages every connector's visibility,
// color, and stroke weight on the current page.

const TOOL_ID = 'figma-arrow-manager-001';
const RELAUNCH_LABEL = 'Manage arrows';

function formatTime() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function log(level, message) {
  figma.ui.postMessage({ type: 'log', level, message, time: formatTime() });
}

function notify(message, error) {
  figma.notify(message, error ? { error: true } : undefined);
  log(error ? 'error' : 'info', message);
}

function getAllConnectors() {
  return figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] });
}

function sendSelectionStatus() {
  const selection = figma.currentPage.selection;
  const connectors = selection.filter((node) => node.type === 'CONNECTOR');
  const others = selection.filter((node) => node.type !== 'CONNECTOR');
  figma.ui.postMessage({
    type: 'selection-status',
    count: selection.length,
    names: selection.map((node) => node.name),
    connectorCount: connectors.length,
    otherCount: others.length,
    canConnect: selection.length === 3 && connectors.length === 1 && others.length === 2,
  });
}

function sendConnectorState() {
  const connectors = getAllConnectors();
  figma.ui.postMessage({
    type: 'connector-state',
    shown: connectors.length === 0 || connectors.some((connector) => connector.visible),
    count: connectors.length,
  });
}

function findPage(node) {
  let candidate = node;
  while (candidate !== null && candidate.type !== 'PAGE') candidate = candidate.parent;
  return candidate !== null && candidate.type === 'PAGE' ? candidate : null;
}

// Try the node itself first; on failure, climb to node.parent and retry. The only
// real failure mode is "Invalid endpointNodeId" for a node nested inside a
// component instance — climbing always succeeds by the time it reaches the
// instance root. The PAGE/DOCUMENT boundary is our own safety net: the raw API
// accepts a page as an endpoint without error, but that's visually meaningless.
function attachEndpoint(connector, node, property) {
  let candidate = node;
  let climbed = false;
  while (candidate !== null && candidate.type !== 'PAGE' && candidate.type !== 'DOCUMENT') {
    if ('visible' in candidate) {
      try {
        connector[property] = { endpointNodeId: candidate.id, magnet: 'AUTO' };
        return { node: candidate, climbed };
      } catch (e) {
        climbed = true;
      }
    }
    candidate = candidate.parent;
  }
  throw new Error(`Couldn't attach to "${node.name}" or any of its parents.`);
}

async function clearLabel(connector) {
  try {
    if (!connector.text.characters) return;
    const fontName = connector.text.fontName;
    if (fontName !== figma.mixed) await figma.loadFontAsync(fontName);
    connector.text.characters = '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', `Couldn't clear the connector label; it was kept as-is. ${message}`);
  }
}

async function connectSelected() {
  const selection = figma.currentPage.selection;
  const connectors = selection.filter((node) => node.type === 'CONNECTOR');
  const others = selection.filter((node) => node.type !== 'CONNECTOR');
  if (selection.length !== 3 || connectors.length !== 1 || others.length !== 2) {
    notify('Select exactly one pasted connector and two elements to connect.', true);
    return;
  }

  const connector = connectors[0];
  const first = others[0];
  const second = others[1];
  const page = findPage(connector);
  if (page === null || findPage(first) !== page || findPage(second) !== page) {
    notify('All selected items must be on the current page.', true);
    return;
  }

  await clearLabel(connector);
  try {
    const start = attachEndpoint(connector, first, 'connectorStart');
    const end = attachEndpoint(connector, second, 'connectorEnd');
    figma.currentPage.selection = [connector];
    const notes = [];
    if (start.climbed) notes.push(`"${first.name}" attached to "${start.node.name}"`);
    if (end.climbed) notes.push(`"${second.name}" attached to "${end.node.name}"`);
    notify(notes.length > 0 ? `Connected. ${notes.join('; ')}.` : `Connected "${first.name}" to "${second.name}".`);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  }
  sendSelectionStatus();
  sendConnectorState();
}

function setVisibility(show) {
  const connectors = getAllConnectors();
  if (connectors.length === 0) {
    notify('No connectors found on this page.');
    return;
  }
  let changed = 0;
  for (const connector of connectors) {
    if (connector.visible !== show) {
      connector.visible = show;
      changed += 1;
    }
  }
  notify(`${show ? 'Showing' : 'Hiding'} ${connectors.length} connector${connectors.length === 1 ? '' : 's'}${changed < connectors.length ? ` (${changed} changed)` : ''}.`);
  sendConnectorState();
}

function hexToRgb(hex) {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '0D99FF';
  return {
    r: Number.parseInt(clean.slice(0, 2), 16) / 255,
    g: Number.parseInt(clean.slice(2, 4), 16) / 255,
    b: Number.parseInt(clean.slice(4, 6), 16) / 255,
  };
}

function colorsEqual(first, second) {
  return Math.abs(first.r - second.r) < 0.001 &&
    Math.abs(first.g - second.g) < 0.001 &&
    Math.abs(first.b - second.b) < 0.001;
}

function applyStyle(color, weight) {
  const connectors = getAllConnectors();
  if (connectors.length === 0) {
    notify('No connectors found on this page.');
    return;
  }
  const rgb = hexToRgb(color);
  const strokeWeight = Math.max(0.5, Math.min(10, Number.isFinite(weight) ? weight : 2));
  for (const connector of connectors) {
    const currentStroke = connector.strokes[0];
    const currentColor = currentStroke && currentStroke.type === 'SOLID' ? currentStroke.color : null;
    if (currentColor === null || !colorsEqual(currentColor, rgb)) {
      connector.strokes = [{ type: 'SOLID', color: rgb }];
    }
    if (connector.strokeWeight !== strokeWeight) connector.strokeWeight = strokeWeight;
  }
  notify(`Updated ${connectors.length} connector${connectors.length === 1 ? '' : 's'} — ${color}, ${strokeWeight}px.`);
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (hue < 60) { red = chroma; green = x; }
  else if (hue < 120) { red = x; green = chroma; }
  else if (hue < 180) { green = chroma; blue = x; }
  else if (hue < 240) { green = x; blue = chroma; }
  else if (hue < 300) { red = x; blue = chroma; }
  else { red = chroma; blue = x; }
  return { r: red + match, g: green + match, b: blue + match };
}

function randomizeColors() {
  const connectors = getAllConnectors();
  if (connectors.length === 0) {
    notify('No connectors found on this page.');
    return;
  }
  const startHue = Math.random() * 360;
  connectors.forEach((connector, index) => {
    const hue = (startHue + index * 137.508) % 360;
    connector.strokes = [{ type: 'SOLID', color: hslToRgb(hue, 0.7 + (index % 3) * 0.1, 0.45 + (index % 4) * 0.05) }];
  });
  notify(`Randomized colors on ${connectors.length} connector${connectors.length === 1 ? '' : 's'}.`);
}

async function start() {
  await figma.currentPage.loadAsync();
  figma.root.setRelaunchData({ [TOOL_ID]: RELAUNCH_LABEL });
  figma.showUI(__html__, { width: 320, height: 520, title: 'Figma Arrow Manager', themeColors: true });
  sendSelectionStatus();
  sendConnectorState();
  figma.on('selectionchange', () => {
    sendSelectionStatus();
    sendConnectorState();
  });
  figma.ui.onmessage = (message) => {
    if (message.type === 'connect') void connectSelected();
    else if (message.type === 'toggle-visibility') setVisibility(message.show);
    else if (message.type === 'apply-style') applyStyle(message.color, message.weight);
    else if (message.type === 'randomize-colors') randomizeColors();
    else if (message.type === 'resize') figma.ui.resize(320, Math.max(80, Math.min(900, Math.round(message.height))));
  };
}

void start();
