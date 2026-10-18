# Validation evidence

Local validation on October 18, 2026 used Windows, Node.js 24.21.0, and ProtoPie Studio 10.5.0,
build `c6e3e3596a-dirty@2026-10-06T04:22:26.030Z`. This is the tested compatibility target.

## Automated checks

The current revision passed **132 offline/browser checks**. The importer revision preceding the
Disconnect UI passed **10 live Studio checks**, including transitive shared-master conflict
protection and explicit scene routing for global variables. Disconnect is covered by the nested
headless-browser and sandbox tests; its final manual Figma desktop check remains pending.
TypeScript checks, final builds, formatting, and dependency audit also pass. The extracted Windows
package's included runtime, asset checksums, and localhost helper have been smoke-tested.

The offline suite covers the real reader, scoped updates, source identity, manual-edit conflicts,
failed deletions, partial acknowledgements, cross-batch dependencies, UTF-8 payload limits,
resource reuse, uncertain-write persistence, cancellation, reaction retry, local grant reuse,
target pinning, chunked storage, and explicit multi-page loading. Disconnect coverage includes
reopening without automatic connection, ignoring late approval responses, ordered settings saves,
failed-storage retry, and finishing/persisting an active batch before disconnecting. A headless Chromium test uses
the real opaque bootstrap behind nested host frames and the localhost panel with simulated
Studio/Figma endpoints. The host replies directly from an ancestor above the immediate parent,
matching the frame topology that previously dropped settings replies in desktop Figma.

Reader regressions cover empty vector/text artwork, visible instances with hidden masters,
zero-height stroked lines, and export failures retaining the layer identity and export reason.
The sandbox and browser tests verify that early export failures reach the downloadable diagnostic,
clear stale results, and send no Studio writes. The failing production selection still needs a
manual retry in desktop Figma; the supplied original diagnostic contained no design or report.

Connection checks prefer matching session metadata over stale context-list titles and use saved
.pie filenames while rejecting temporary cloud cache names. Browser coverage verifies renamed
labels, an explicit unavailable-name state, reconnects, grant-free diagnostics, and zero-write
re-import after a display-name change. The installed Studio main-process bundle uses its initial
context display name for MCP tab metadata; the visible Cloud title can differ after a rename.
The available diagnostic grant had expired during this investigation, so the renamed production
Pie has not been rechecked live. A placeholder session response no longer discards a usable
listed name or saved path. When neither response provides a name, the panel states that ProtoPie
has not provided this tab's name, explicitly identifying Cloud cache contexts. This is an honest
unavailable-name message, not automatic Cloud rename support.

The live suite exercises native master creation, instance text, nested text overrides, clearing
overrides, unchanged imports with zero writes, master updates preserving IDs, selected-child
updates, manual-edit protection, and cleanup. It also imports the real Figma reader snapshot.
Run live files sequentially because they share one approved Studio context.

## Single-line text clipping

Version 0.3.1 adds **Clip truncated text**, enabled by default. Reader tests cover Fill-width
clipping viewports, editable Auto Width content, fixed-height and legacy truncation, alignment,
opacity and rotation, Live auto layout on/off, and unchanged paragraphs and multi-line limits.
Re-import tests toggle clipping both ways without extra scenes or stale wrappers, retain zero-write
unchanged imports, and resolve component text overrides to the inner text layer. Shared master
updates retain their existing explicit permission setting. Sandbox and nested browser checks
verify the default, forwarding both toggle states, and disabling the control during imports.
Final rendering of this workaround in desktop Studio still needs a user import.

The [P&E Team QA file](https://www.figma.com/design/zd0jTRSy9d8qOxJtLroGvG) contains two linked
screens, native shapes and text, auto-layout, a reusable component with different instance labels,
original PNG data, vectors, and variables. The compiled reader ran against these real Figma
objects through the connector. Its snapshot is retained in `test/fixtures/figma-source.json`.
Studio's returned native layers, Smart Animate responses, and screenshots are checked separately.
The connector cannot verify Figma desktop plugin installation or clientStorage persistence.

## Variable collisions and recovery guidance

Normal imports do not automatically create a duplicate for an unlinked variable-name collision.
They pause before start_editing, canvas resizing, or any native mutation, and request a per-variable
choice: Use existing, Create separate variable, or Skip. Without a choice callback, the importer
returns a structured collision report and makes zero writes. The existing-variable option requires
matching data types, preserves the current value, and records a non-owned binding whose values
and types are never overwritten by later imports. Incompatible or deleted reused bindings stay
protected. Skip omits that variable and its actions for the current attempt. Cancel sends no writes.

The UI requires a decision for every collision, keeps the duration timer running, and handles Stop
and Disconnect while waiting. Variable metadata is refreshed after the decision and reused IDs,
names, and types are revalidated before writes. Import as new explicitly creates independent
suffixed variables without this prompt. Owned updates retain stable IDs and assigned names, and
reaction hashes include the actual binding. Older index records remain readable.

Tests cover normal collisions with no choice, explicit creation, non-owned reuse and subsequent
source/target changes, skip, cancellation, incompatible types, stale decisions, fresh copies,
manual changes, deleted bindings, source renames, and older records. Browser checks verify that
waiting and cancellation write nothing, that explicit create and reuse work, and that later imports
preserve reused values. Scene/component recovery actions remain separate from variable-only
conflicts. Native production verification is pending; these checks make no live Studio writes.

## Import duration timer

The panel shows a fixed elapsed timer above its footer, using monotonic elapsed time from the
Import click rather than counting interval callbacks. It includes connection approval, source
reading, native writes, validation, link persistence, and editing-session release. The display
refreshes four times per second and renders minutes and seconds, with hours when needed. Completion,
conflicts, connection/read/import errors, and cancellation freeze the final duration. Stop or
Disconnect during an active native batch keeps counting until that batch and cleanup return.
A native timeout ends the plugin attempt; it does not guarantee Studio has stopped applying it.

The final elapsed milliseconds and outcome remain available in diagnostics, including failures
before a report exists. The existing headless browser regression checks counting during a held
connection request, frozen successful duration, blocked updates, connection/read failures, live
write diagnostics, and waiting for a pending batch before freezing cancellation time. Native
production timing remains a manual check.

## Optional component creation

Create components starts on. When off, the reader bypasses source-master resolution and walks the
visible children of instances and component definitions, including nested instances. It emits no
component definitions or instance references. Unsupported artwork can still use the existing image
fallback. The UI forwards the option through the sandbox and disables shared-master updates while
it is off. Existing masters are not deleted. Reader/importer regressions cover editable nested
content, no master lookups or component writes when off, zero-write unchanged imports, and switching
back on with the same master and scene IDs. Browser and sandbox checks exercise the actual option
relay. The behavior has not yet been verified manually on the production selection.

## Deleted or interrupted import recovery

A reported retry made zero write calls and showed missing component targets and an interrupted
scene marker. These are protections for previously linked content, not a fresh creation attempt.
Conflict reports now offer an explicit Import as new action beside the warning. The UI captures
that choice before connecting and uses an empty import index even if an older sandbox replies
with saved links. The existing sandbox also bypasses the target, previous-target, and legacy
indexes for fresh imports. No previous scene or component is deleted by this action.

Metrics and diagnostics identify New import versus Update. The fresh option is consumed when the
source design is accepted, so later retries use the new links instead of creating duplicate copies.
Tests cover an interrupted scene, a deleted component master, clean new IDs, preserved existing
content, a zero-write subsequent update, and bypassing unreadable old indexes. The production
selection still requires manual verification; these checks use simulated Studio/Figma endpoints.

## Production layout regression

A production import screenshot showed a displaced sidebar, rearranged table, and incorrect instance
content, with a reported duration of about two minutes. Its completed diagnostic has not yet been
provided; the only downloaded diagnostic available during this investigation was empty.

The reader supports resolved positions, fixed sizing, and fixed text boxes when Live auto layout
is off. The plugin's Live auto layout and Match canvas size controls now start on by default,
per the requested settings; either can be turned off for an import. It resolves
unsupported instance overrides and size/structure/style differences before importing a master,
using the visible instance's editable children instead. Compatible native instances remain shared;
text overrides match source IDs rather than child positions. Tests cover sidebar/table coordinates,
resolved override content, resized instances, and retained compatible master reuse.

The new report includes Figma read duration, connection duration, per-tool Studio call counts and
durations, and link checkpoint duration. Per-import metrics exclude earlier imports. Fresh component
root discovery now requests only the root tree and omits an unnecessary interaction read. Existing
visual baseline protections remain enabled. No production timing improvement or visual equivalence
has yet been demonstrated for this revision; the prior native QA results do not validate this change.

## Performance candidate: hierarchy dispatch and checkpoints

A production screen continued applying native writes after ten minutes. Further development and
builds were isolated from the registered plugin while that import was running. After the user
stopped and deleted those imports, these changes were promoted to the main project. This revision has
not yet been tested against that production selection in Studio.

The previous coalescer combined only unreferenced leaf nodes under the same parent. Containers
used as parents still required individual native layer operations. The candidate plans creation
breadth first, waits for parent acknowledgements, and combines independent layers from multiple
acknowledged parents into native arrays. Each source node retains an individual result and native
ID. Failed parents block their descendants without blocking successful siblings. Ambiguous,
malformed, or incomplete results stop the scope without automatic retry.

| Local fixture                                                                       | Previous path | Candidate path |
| ----------------------------------------------------------------------------------- | ------------: | -------------: |
| 1,361 nested table layers: native layer operations                                  |         1,361 |              8 |
| Same fixture: write requests                                                        |             7 |              9 |
| 20 journal checkpoints on a 1,400-node index: plugin data writes, including cleanup |         1,180 |             60 |

These are deterministic work counts from local fixtures, not elapsed-time measurements in Studio.
Dependency acknowledgements increase the HTTP request count while substantially reducing native
operation dispatch. The table regression also checks parent IDs, zero-write unchanged re-import,
and preserved native IDs on a text update. Existing 250-item and 8 MiB bounds remain in effect.

Storage now reuses immutable content-addressed chunks, commits the manifest last, and cleans old
chunks only after commit. Legacy generation-based indexes migrate without losing links. Interrupted
checkpoint and visual-blob writes retain the previous committed state. This avoids rewriting the
entire large index for each small recovery marker; it does not eliminate index serialization.

The footer's Save diagnostics action works during an import. Its snapshot includes the current
stage, elapsed import time, completed tool timings, pending Studio requests and their elapsed time,
and the selected design when reading has finished. It contains no approval grant. A pending call
can only be observed from the plugin instance that owns it.

Requests have bounded deadlines: 180 seconds for native connection approval, 90 seconds per
compose request, and 20 seconds for other calls. A compose timeout means the write outcome is
uncertain; Studio may continue applying it. The importer does not resend the batch and retains its
recovery marker. Stop and Disconnect still wait for the current acknowledged batch. No deadline
or new candidate build can cancel an already running older native write.

Headless visual checks cover both themes, 320- and 400-pixel panel widths, select chevron alignment,
settings action reachability, and the persistent diagnostics footer. Production fidelity, including
the reported logo mismatch, remains unverified. Existing visual-conflict protection is retained.

## Production diagnostic optimization

The production diagnostic saved on October 18 contains 2,462 native layers, including 2,009
containers and 1,636 live auto-layout containers, not just the roughly 850 visible top-level items.
At 383 seconds elapsed it recorded 53 completed compose calls taking 195 seconds. It did not
contain a final report, so the remaining time cannot be assigned to one cause. The installed
Studio renderer processes native batch-add items sequentially with layer-add and property-edit
commands; fewer HTTP requests do not turn that into one bulk document insertion.

The new path uploads each scope's missing resources before layer creation, using acknowledged
resource IDs in its layer arrays. Failed or malformed resource acknowledgements prevent layer
replacement. The durable uncertainty marker now covers an entire batch sequence rather than
being removed and rewritten between every request. Each acknowledged batch still saves its IDs
before the next request. Checkpoint failures, timeouts, and ambiguous responses retain protection;
cancellation between known acknowledgements clears ordinary uncertainty safely.

For scopes with at least 250 desired layers, newly created auto-layout containers start with
layout disabled and fixed sizing. Once the hierarchy exists, their original layout properties
are applied from descendants to ancestors in bounded arrays. Existing layers are not temporarily
disabled during updates. Source insertion order is retained. Incomplete layout restoration leaves
an explicit recovery marker and cannot become an ordinary update baseline. This adds a final edit
for each deferred container to avoid repeated reflow while its hierarchy is being constructed;
its net elapsed-time benefit still needs native measurement.

| Replay of the same production diagnostic |    Previous |  Optimized |
| ---------------------------------------- | ----------: | ---------: |
| Write requests                           |         102 |         30 |
| Native layer-create array operations     |          99 |         19 |
| Acknowledged checkpoints                 |         203 |         36 |
| Cumulative serialized checkpoint bytes   | 232,478,018 | 47,340,469 |
| Plugin data writes, including cleanup    |       1,157 |        606 |
| Imported native layers                   |       2,462 |      2,462 |

These are deterministic counts using simulated Studio acknowledgements and the actual storage
implementation. Re-reading the stored index retained all links, and final native properties matched
the source properties in the simulation. They are not measured elapsed-time improvements or proof
of production visual fidelity. The replay uses the existing diagnostic asset bytes unchanged.

The largest asset in that diagnostic was a 1.54 MB SVG displaying a 38-pixel image while embedding
a 2,320-pixel JPEG. Oversized SVG exports containing raster images now attempt a PNG at up to
2x display size, capped at 4,096 pixels on the longest side, and use it only if smaller. Ordinary
vector artwork remains SVG. If PNG export is unavailable, valid SVG artwork is retained. Tests
cover the scale bound, vector preservation, and export fallback; actual production asset savings
require a fresh read in Figma. Live diagnostics now also include Figma read time, acknowledged
checkpoint count, and cumulative checkpoint time, even before a final report exists.

Production timing, logo fidelity, and a comparison with the official importer remain manual checks.
The new build has not written into the user's production Pie during this validation.

## Grouped artwork placement and fractional SVG viewports

A read-only inspection of the actual logo found two nested groups, both reporting x=20 and
approximately y=20.05179 in Figma. Figma's x/y and relativeTransform skip group and boolean
ancestors and remain relative to the containing frame; native ProtoPie containers have immediate
parent coordinates. Copying those values to both groups placed the logo at x=40 and y=40.10358.
The reader now uses inverse(parent absolute transform) multiplied by the child's absolute transform
when retaining those ancestors, correcting both local translation and local rotation. The nested
group becomes (0, 0), so the original offset is applied once. Ordinary frame children retain their
existing coordinates. See the [Figma coordinate-space documentation](https://developers.figma.com/docs/plugins/api/properties/nodes-relativetransform/).

The captured individual glyph exports also had integer SVG viewports, such as 3 by 13, around
fractional rendered artwork approximately 2.0587 by 12.3913. Fitting that padded SVG into the smaller
native image box shrank the glyph. For the recognized whole-pixel rounding case, the reader now
trims transparent right/bottom export padding by matching the SVG viewport to the fractional render
bounds. It preserves paths, native layer bounds, intentional viewBox offsets/scales, and the separate
artwork layers. This normalization is limited to axis-aligned
parents; no new claim is made for arbitrary transformed SVG ancestry.

The regression fixture records the real logo's nested geometry and vector exports, plus a whole-logo
SVG reference. Reader/importer tests check all ten vector positions through acknowledged native IDs,
both live-layout settings, rotated groups, ordinary frames, and shared component masters. A headless
Chromium comparison checks the converted logo's visible bounds against the whole-logo Figma export
to within one physical pixel at 2x scale, with a 5% coverage tolerance for separately composited SVG
edges. The observed converted bounds match the reference exactly. This validates the conversion and
browser rendering; native Studio rendering of the rebuilt plugin remains a manual retry. The user's
production Pie was not modified during these checks. The earlier failed import's duration is not
explained or fixed by this placement correction alone.

## Version 0.3.0: three-run diagnosis and incremental checkpoints

The second production run created its frame with 30 acknowledged writes in 270.465 seconds, then
could not reproduce a visual baseline. Studio writes accounted for 151.896 seconds, Figma link saves
82.514 seconds, source reading 14.907 seconds, and verification reads 16.378 seconds. The third run
was an update blocked before any write because the prior import had no trusted baseline. Its
53.802 seconds included 39.112 seconds reading Figma and 6.828 seconds saving unchanged links.
The old message incorrectly implied an actual target edit when no baseline existed.

Version 0.3.0 sends record-level checkpoint patches over the UI/sandbox bridge. Nodes, reactions,
assets, variables and scope metadata are compared with their last acknowledged encodings. Unchanged
checkpoints are omitted. Each patch is appended as immutable chunks and the journal manifest commits
last. Per-run session IDs and increasing sequence numbers reject stale or out-of-order messages.
An acknowledged patch is durable before the next Studio write. Compaction restores the regular index only when a journal reaches 128 patches or 768 chunk references;
small imports avoid a full rewrite. Interrupted compaction leaves the journal readable. Old indexes remain readable,
and active journals fail closed in older clients rather than silently exposing stale links. Explicit
fresh imports can atomically replace a corrupt old index. Normal variable collision choices and
non-owned variable protections are unchanged.

Live layout remains on by default. Only new containers with at least 16 descendants including their
root are deferred in scopes of 250+ layers. Small wrappers retain normal live layout while building;
large subtrees activate bottom-up. This avoids 1,533 extra layout edits on the supplied selection.
Source exports overlap up to four tasks when component creation is off; shared raster reads are
deduplicated and source child order is preserved. Failed reads drain their export tasks before
returning, and no partial design is sent to Studio.

| Replay of the supplied 2,462-layer design      |       Prior build |   Version 0.3.0 |
| ---------------------------------------------- | ----------------: | --------------: |
| Write requests                                 |                30 |              24 |
| Deferred layout restoration edits              |             1,636 |             103 |
| Changed checkpoint messages, before compaction | 36 full snapshots |      26 patches |
| Serialized checkpoint payload                  |  47,340,469 bytes | 2,408,692 bytes |

The new path checks journal bounds at completion and avoids full compaction for this fixture. These are simulated work counts using the
actual persistence code, not a native elapsed-time measurement. Re-reading and compacting the index
preserved all 2,462 IDs and the simulated final layer properties matched the source. Actual savings
on the next native run remain unmeasured.

An unstable visual baseline is now a visible verification-pending result, distinct from a layer-write
failure or proven manual edit. Strict visual comparison remains unchanged. Up to four bounded
post-write capture candidates are retained. A later read can establish a trusted baseline only by
reproducing one of those original captures; two unrelated new captures are never adopted over
possibly edited content. Old unverified imports without candidates remain protected. Retry
verification only reads the saved target and skips source exports, editing locks, and Studio writes.
Reports record per-capture structural hashes and distinguish structural/interaction, dimension and
preview-pixel differences. Diagnostics include version, checkpoint protocol and transmitted bytes.

The installed Studio preview limitation is not repaired by this plugin. Verification can remain
pending, and the manual-update safeguard is retained. The 24 Figma CHANGE_TO checkbox variant
actions are still unsupported; repeated notes now show their occurrence counts. SVG fallback and
empty placeholder notes remain informational. These limitations are not represented as successful
interaction translation. The logo geometry and SVG viewport corrections from the preceding revision
are retained. No live writes to the user's production Pie were made while validating this revision.

## Performance observations

The same synthetic 1,000-rectangle fixture was imported into an unsaved scratch Pie. These are
single observations during development, without statistical repetition or control of Studio's
undo history, caches, or machine load. They measure the importer and Studio calls, excluding the
Figma read and link persistence. They are not comparisons against the official importer.

| Strategy                            | Batch setting |    Import | Unchanged import | Write requests |
| ----------------------------------- | ------------: | --------: | ---------------: | -------------: |
| Individually named layer operations |            50 |  79.203 s |          0.515 s |             22 |
| Individually named layer operations |           100 | 135.747 s |          0.690 s |             12 |
| Individually named layer operations |           250 | 267.370 s |          1.266 s |              6 |
| Native layer arrays                 |           100 |  55.266 s |          0.519 s |              2 |
| Native layer arrays                 |           250 |  46.372 s |          0.414 s |              2 |
| Native layer arrays                 |         1,000 |  42.300 s |          0.522 s |              2 |

The increasing timings for individually named operations show why fewer HTTP requests alone do
not establish better performance. Native layer arrays reduce Studio's per-operation dispatch work.
The final default caps each request at 250 layer items and 8 MiB, with acknowledgement and link
persistence between chunks. This improves interruption handling and bounds the work in one request;
the earlier array measurements above packed several arrays into one request.

The latest large-frame stress run failed its visual baseline check even with decoded-pixel
comparison and a two-level color tolerance. This is an unresolved release blocker: the importer
refuses to trust a changing baseline. The diagnostic run found identical layer trees but incomplete preview images; see the
[reproduction and diagnosis](studio-preview-issue.md). Failed runs are excluded from the timing table.

The small real QA snapshot has also imported successfully, with zero-write unchanged re-import.
Its timings are available in the local ignored `real-figma-live-report.json` output. They do not
establish performance on a representative production file.

To measure a real selection, download the panel's diagnostic snapshot, then run:

```sh
npm run benchmark -- --design snapshot.json --batches 100,250 --output result.json
```

Focus an unsaved Untitled scratch Pie first. The CLI requests its own Studio approval unless given
a private local grant through `--connection`. Benchmark-created scenes, masters, and variables are
removed afterward. A measured official baseline can be supplied with `--official-ms`; it must use
the same source, settings, and timing boundary. Interrupted or overlapping runs must be discarded.
Studio's MCP resource API has no delete action, so uploaded media remains in the scratch Pie's
resource catalog after its test layers are removed.

## Remaining external checks

The full desktop plugin run, real production-file comparison with the official importer, macOS app
run, fresh-process automatic approval, and Community publishing are listed in the
[release checklist](release-checklist.md). None is implied by passing builds or connector tests.
