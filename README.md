# figma-to-protopie

A deterministic, fast replacement for ProtoPie's official "Import from Figma" plugin.

ProtoPie's own Figma plugin streams layers into ProtoPie Studio one item at a time over
whatever private channel connects the plugin sandbox to the desktop app — reported cost is
roughly 30 seconds per frame, worse with images/effects/complex strokes. This project reads a
Figma selection directly through the Figma Plugin API and writes it into ProtoPie Studio through
ProtoPie's own **Studio MCP** server — a local, typed, batchable JSON-RPC write API — in one or a
handful of calls instead of hundreds of small streamed ones.

No AI model is involved anywhere in the data path. Studio MCP is "MCP" in name (Model Context
Protocol), but its wire format is plain JSON-RPC over local HTTP; this project calls it directly
with a deterministic script, the same way it would call any other local API.

See [`docs/feasibility.md`](docs/feasibility.md) for the full investigation: root-cause research
on the existing plugin's slowness, the proven precedent for a Figma-plugin-to-localhost bridge,
and a live-verified map of ProtoPie Studio MCP's actual write surface (pulled directly from a
running Studio instance, not from documentation — ProtoPie hasn't published this anywhere).

**Status: feasibility investigated and confirmed live. Not yet built.**
