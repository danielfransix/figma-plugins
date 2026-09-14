figma.showUI(__html__, { width: 360, height: 480, title: "Figma Connector", themeColors: true });

// No "master" state needed anymore: a real plugin cannot create or clone a CONNECTOR
// node ("Cloning CONNECTOR nodes is not supported in the current editor" — confirmed
// against the actual installed plugin). Instead, the user copy-pastes a fresh connector
// from their styled original (Ctrl+C once, Ctrl+V per new connection — Figma preserves
// the exact styling natively), then selects that pasted connector plus the two elements
// to connect, and this plugin reassigns the connector's two ends.

figma.on('selectionchange', () => {
  sendSelectionStatus();
  sendConnectorState();
});
sendSelectionStatus();
sendConnectorState();

figma.ui.onmessage = (msg) => {
  if (msg.type === 'connect') return handleConnect();
  if (msg.type === 'toggle-visibility') return handleToggleVisibility(msg.show);
  if (msg.type === 'apply-style') return handleApplyStyle(msg.color, msg.weight);
  if (msg.type === 'randomize-colors') return handleRandomizeColors();
  if (msg.type === 'resize') {
    const h = Math.max(280, Math.min(700, msg.height));
    figma.ui.resize(360, h);
    return;
  }
};

function log(level, message) {
  figma.ui.postMessage({ type: 'log', level, message, time: formatTime() });
}

function formatTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sendSelectionStatus() {
  const sel = figma.currentPage.selection;
  const connectors = sel.filter((n) => n.type === 'CONNECTOR');
  const others = sel.filter((n) => n.type !== 'CONNECTOR');
  figma.ui.postMessage({
    type: 'selection-status',
    count: sel.length,
    names: sel.map((n) => n.name),
    connectorCount: connectors.length,
    otherCount: others.length,
    canConnect: sel.length === 3 && connectors.length === 1 && others.length === 2,
  });
}

async function handleConnect() {
  const sel = figma.currentPage.selection;
  const connectors = sel.filter((n) => n.type === 'CONNECTOR');
  const others = sel.filter((n) => n.type !== 'CONNECTOR');

  if (sel.length !== 3 || connectors.length !== 1 || others.length !== 2) {
    const msg = 'Select exactly 3 items: one pasted connector and the two elements to connect.';
    figma.notify(msg, { error: true });
    log('error', msg);
    return;
  }

  const connector = connectors[0];
  const [a, b] = others;

  // The API doesn't enforce same-page itself, so the plugin validates this.
  const connectorPage = findPage(connector);
  if (findPage(a) !== connectorPage || findPage(b) !== connectorPage) {
    const msg = 'All selected items must be on the current page.';
    figma.notify(msg, { error: true });
    log('error', msg);
    return;
  }

  await clearLabel(connector); // pasted copies may carry over the original's label text

  let startInfo, endInfo;
  try {
    startInfo = attachEndpoint(connector, a, 'connectorStart');
    endInfo = attachEndpoint(connector, b, 'connectorEnd');
  } catch (e) {
    figma.notify(e.message, { error: true });
    log('error', e.message);
    return;
  }

  figma.currentPage.selection = [connector]; // one click away from a manual arrow-flip if needed

  const climbNotes = [];
  if (startInfo.climbed) climbNotes.push(`"${a.name}" → attached to "${startInfo.node.name}"`);
  if (endInfo.climbed) climbNotes.push(`"${b.name}" → attached to "${endInfo.node.name}"`);
  const msg = climbNotes.length ? `Connected (${climbNotes.join('; ')})` : `Connected "${a.name}" to "${b.name}".`;
  figma.notify(msg);
  log('info', msg);
}

function findPage(node) {
  let p = node;
  while (p && p.type !== 'PAGE') p = p.parent;
  return p;
}

// Try the node itself first; on failure, climb to node.parent and retry.
// The only real failure mode is "Invalid endpointNodeId" for a node nested inside a
// component instance — climbing always succeeds by the time it reaches the instance
// root (attaching to an INSTANCE directly works fine). The PAGE/DOCUMENT boundary is
// our own safety net: the raw API accepts a page as an endpoint without error, but
// that's visually meaningless, so we stop and fail before ever trying it.
function attachEndpoint(connector, node, propName) {
  let candidate = node;
  let climbed = false;
  while (candidate && candidate.type !== 'PAGE' && candidate.type !== 'DOCUMENT') {
    try {
      connector[propName] = { endpointNodeId: candidate.id, magnet: 'AUTO' };
      return { node: candidate, climbed };
    } catch (e) {
      candidate = candidate.parent;
      climbed = true;
    }
  }
  throw new Error(`Couldn't attach to "${node.name}" or any of its parents.`);
}

async function clearLabel(connector) {
  try {
    const label = connector.text.characters;
    if (!label) return; // already empty — no font load needed
    await figma.loadFontAsync(connector.text.fontName);
    connector.text.characters = '';
  } catch (e) {
    log('error', `Couldn't clear connector label (kept as-is): ${e.message}`);
  }
}

// ── Manage Connectors: visibility / color / weight (ported from the "Toggle
// connectors" plugin brief) — operates on every CONNECTOR on the current page.

function getAllConnectors() {
  return figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] });
}

function sendConnectorState() {
  const connectors = getAllConnectors();
  const shown = connectors.length === 0 || connectors.some((c) => c.visible);
  figma.ui.postMessage({ type: 'connector-state', shown, count: connectors.length });
}

function handleToggleVisibility(show) {
  const connectors = getAllConnectors();
  if (connectors.length === 0) {
    figma.notify('No connectors found on this page.');
    log('info', 'No connectors found on this page.');
    return;
  }
  let changed = 0;
  for (const c of connectors) {
    if (c.visible !== show) {
      c.visible = show;
      changed++;
    }
  }
  const msg = `${show ? 'Showing' : 'Hiding'} ${connectors.length} connector${connectors.length === 1 ? '' : 's'}${changed < connectors.length ? ` (${changed} changed)` : ''}.`;
  figma.notify(msg);
  log('info', msg);
}

function handleApplyStyle(hex, weight) {
  const connectors = getAllConnectors();
  if (connectors.length === 0) {
    figma.notify('No connectors found on this page.');
    log('info', 'No connectors found on this page.');
    return;
  }
  const rgb = hexToRgb(hex || '#0D99FF');
  const paint = { type: 'SOLID', color: rgb };
  const clampedWeight = Math.min(10, Math.max(0.5, weight || 2));

  for (const c of connectors) {
    const currentStroke = c.strokes && c.strokes[0];
    const currentColor = currentStroke && currentStroke.type === 'SOLID' ? currentStroke.color : null;
    if (!currentColor || !colorsEqual(currentColor, rgb)) c.strokes = [paint];
    if (c.strokeWeight !== clampedWeight) c.strokeWeight = clampedWeight;
  }
  const msg = `Updated ${connectors.length} connector${connectors.length === 1 ? '' : 's'} — color ${hex}, weight ${clampedWeight}.`;
  figma.notify(msg);
  log('info', msg);
}

function handleRandomizeColors() {
  const connectors = getAllConnectors();
  if (connectors.length === 0) {
    figma.notify('No connectors found on this page.');
    log('info', 'No connectors found on this page.');
    return;
  }
  const colors = generateDistinctColors(connectors.length);
  for (let i = 0; i < connectors.length; i++) {
    connectors[i].strokes = [{ type: 'SOLID', color: colors[i] }];
  }
  const msg = `Randomized colors on ${connectors.length} connector${connectors.length === 1 ? '' : 's'}.`;
  figma.notify(msg);
  log('info', msg);
}

// Convert HSL (h: 0-360, s: 0-1, l: 0-1) to Figma RGB (0-1)
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return { r: r + m, g: g + m, b: b + m };
}

// Generate N maximally distinct colors by evenly spacing hues (golden angle).
// Lightness stays mid-range so colors read on both light and dark surfaces.
function generateDistinctColors(count) {
  const colors = [];
  const goldenAngle = 137.508;
  const startHue = Math.random() * 360; // random start so each run looks different
  for (let i = 0; i < count; i++) {
    const hue = (startHue + i * goldenAngle) % 360;
    const saturation = 0.7 + (i % 3) * 0.1;
    const lightness = 0.45 + (i % 4) * 0.05;
    colors.push(hslToRgb(hue, saturation, lightness));
  }
  return colors;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

function colorsEqual(a, b) {
  return Math.abs(a.r - b.r) < 0.001 && Math.abs(a.g - b.g) < 0.001 && Math.abs(a.b - b.b) < 0.001;
}
