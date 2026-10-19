# Release checklist

## Implemented and locally checked

- Native shape and editable text reading; SVG fallback only for non-text artwork with visible notes.
- Sections, multiple frames, entire pages, all pages in a file, and selection-scoped updates.
- Stable layer IDs for property updates; conservative visual and interaction conflict checks.
- Component dependency ordering, master creation and updates, and per-instance text overrides.
- Native Smart Animate navigation, basic prototype triggers, URL links, and imported variables.
- UTF-8 byte limits, native array batching, cross-batch references, partial acknowledgements,
  cancellation, uncertain-write protection, resource deduplication, and chunked link storage.
- Localhost panel transport, cached grants, explicit target switching, persistent Disconnect, and optional auto-approval.
- Build, offline/browser tests, live Studio test harness, benchmark CLI, license, packaged artifacts,
  checksums, Windows/macOS launchers, and CI configuration.

## Required before a public Community release

- Resolve the [incomplete large-scene preview issue](studio-preview-issue.md) in the tested Studio
  build before claiming reliable updates for that workload. The importer currently fails closed.

- Register the actual numeric plugin ID in the publishing owner's Figma account.
- Run the packaged plugin inside Figma desktop against a real file, including first connection,
  source reading, link persistence, closing/reopening the plugin, and importing again.
- Compare the same real file against the official importer. Preserve both durations, source file
  revision, device settings, image mix, Studio build, and Figma version. Synthetic fixture timings
  establish neither a real-file speedup nor visual equivalence.
- Check the portable macOS package on macOS. CI does not replace actual Studio/Figma app testing.
- Restart Studio through each optional auto-approve launcher and verify its behavior live.
- Supply Community listing assets and complete the publishing review. Publishing is a separate,
  externally visible action; these local files are a reviewable development candidate.

## Explicit limitations

- Text is never exported to SVG or a bitmap, including through ancestor flattening. Single-line
  mixed styling uses native text runs. Multi-line mixed styling currently uses the first run's
  style with an explicit note; all text and wrapping remain editable. Unsupported text decoration,
  gradient paint and small-caps typography are simplified with explicit notes. Incomplete text
  metadata stops the read rather than producing text artwork. Complex containers containing text
  retain native children and report unsupported container appearance. Non-text artwork can use SVG.
- Advanced Figma conditional actions, mode-switching, overlays, interactive variant changes,
  media actions, and unsupported gestures are reported, not silently approximated.
- Native reusable instance overrides cover compatible text content. Instances with other overrides,
  different resolved geometry, or incompatible children import as resolved editable layers instead
  of retaining master sharing. Complex artwork may still use SVG fallback.
- Live auto layout and Match canvas size are on by default. Live layout can differ between Figma
  and Studio; turn it off to retain resolved geometry. The production sidebar/table still needs a
  live retry after the recent text and layout fixes.
- Variable values are imported; ongoing paint/property bindings and per-node mode switching are
  not preserved as live ProtoPie bindings. A source re-import refreshes resolved appearance.
- One global Pie device size applies to every scene. Mixed-size source frames keep their bounds
  within a common canvas.
- Scope-level conflict checking favors preserving manual changes; it can reject a safe change
  elsewhere in a manually edited scene. Conflicting scopes are never force-overwritten implicitly.
- Visual checks normalize PNG pixels and tolerate minute antialiasing noise. They cannot guarantee
  detection of invisible property changes or very small color differences. Structure and interaction
  checks remain exact.
- Studio's undocumented MCP surface is checked on connection and exercised against the tested
  build. These checks cannot promise compatibility with every future internal API change.
- Repeated-structure meta-ops are optional; native array batching is preferred because it preserves
  a separate acknowledgement and source link for each node.
