# Incomplete large-scene previews in the tested Studio build

Observed on Windows with ProtoPie Studio 10.5.0,
`c6e3e3596a-dirty@2026-10-06T04:22:26.030Z`, on October 18, 2026.

## Reproduction and evidence

Create an unsaved scratch Pie and import one 1440 by 1024 container with 1,000
32 by 24 rectangles, arranged in 36 columns. The importer uses native layer arrays,
at most 250 layer items per request. All six write requests are acknowledged.

Six sequential `inspect_layout`, `query_interactions`, and `capture_preview` reads
return identical layer trees and interaction arrays. However, the six 1228 by 873
RGB previews show different incomplete portions of the grid. Compared with the
first preview, the later previews have 116,317; 138,376; 258,936; 129,493; and
349,452 channel samples differing by more than two levels. The maximum difference
is 255. This is missing content, not ordinary antialiasing noise.

The ignored local `stress-view-*.json` files retain the exact layout and PNG
responses. Test content is removed afterward. No successful stress timing is
reported for these failed runs.

## Likely cause and safe behavior

Inspection of this installed build shows that the thumbnail renderer pauses its
engine after `onFirstFrame` and two animation frames, once its resource-loading
condition is satisfied. The engine enables progressive rendering by default.
This suggests that the thumbnail can pause before all large-scene content is
painted. This explanation is an inference from the installed code and returned
images, not a confirmed upstream diagnosis.

The exposed `capture_preview` schema offers no wait or render-completion option.
Repeated captures start new thumbnail jobs; merely delaying the next request does
not wait within the current render. The importer does not modify Studio binaries,
inject content into the Pie to delay rendering, or weaken its conflict checks.

The importer reports the unstable baseline and prevents later source updates from
overwriting that unverified scope. Already acknowledged layers remain linked.
Unchanged imports send no writes. A Studio fix or a supported complete authored-model
read is needed to remove this limitation safely. Smaller scenes can pass the same
checks, as demonstrated by the native integration suite and real Figma QA fixture.

## Handling in version 0.3.0

The importer now reports an inconsistent baseline as verification pending, with per-capture
structure hashes and preview-pixel differences in the diagnostic. It saves bounded original
post-write candidates so a later matching capture can establish the second observation without
rebuilding the screen. The Retry verification only action reads the saved target, without Figma
exports or Studio mutations. A new capture must match an original candidate; arbitrary stable
new images are not adopted over potentially edited content. Older failed imports with no saved
candidates remain protected and receive an explicit missing-baseline explanation. The native
preview defect remains unresolved; these changes improve diagnosis and safe recovery.
