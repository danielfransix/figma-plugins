# Studio connection permissions

Investigated on October 18, 2026 against the installed ProtoPie Studio 10.5.0 build, its live
`tools/list` schema, and the installed application bundle. The findings about internal switches
and grant lifetime below are version-specific, not promises from ProtoPie's public documentation.

## Normal operation: remember the approved connection

ProtoPie's [official setup guide](https://www.protopie.io/learn/docs/mcp-studio-mcp-setup)
requires approving the initial connection in Studio. The live `connect_studio` schema has no
arguments and says that it displays the native approval dialog. A constant client name does not
create lasting trust. The earlier implementation called it whenever the plugin opened and lost
its returned grant when the panel closed, unnecessarily producing repeated prompts.

The plugin now stores the returned connection ID and its approved Pie context in
[`figma.clientStorage`](https://developers.figma.com/docs/plugins/api/figma-clientStorage/),
not document plugin data. These permissions stay on that user's device and are not included in
shared Figma files or sent to other users. Reopening the plugin validates the cached grant through
read-only calls. A context check prevents a tab switch from silently changing the import target.

In this Studio build, `McpConnectionGrantStore` has a 1,800,000 ms idle lifetime. Protected calls
refresh its last-use time. A restart, disabling MCP, or 30 minutes without a protected call
invalidates the grant. There is no background keepalive to keep an idle grant alive indefinitely.
When needed, the plugin requests a new approval once. Network failures and target mismatches
are surfaced instead of generating repeated approval requests.

## Disconnect and switch tabs

Use **Disconnect** beside the connection status to stop this plugin and forget its saved
grant on this device. The plugin waits for an active write batch and its link checkpoint to
finish, then releases the editing session before forgetting the connection. A pending connection
attempt is cancelled, and a late approval response cannot restore the disconnected state.
Figma must acknowledge saving the disconnected setting before the panel reports success.
If saving fails, the panel stays disconnected locally and offers a retry.

Reopening the plugin after Disconnect leaves it disconnected. Click **Connect** to approve
a new connection. Imported scenes and source links are retained, so reconnecting to the same
Pie can continue updating the existing import. Closing the panel without Disconnect retains
the normal cached-grant behavior.

To target another Pie, focus its tab in Studio and use **Import settings → Connect to current
ProtoPie tab**. **Reconnect** revalidates the existing pinned target instead of following tab focus.

The tested Studio exposes no `disconnect` or grant-revocation tool. This button forgets the
grant held by this plugin; it cannot revoke copies of that grant inside Studio or disconnect
other MCP clients. Studio's normal expiration and server controls still govern those grants.

## Saved and renamed Pie names

The connection label is separate from the import target: changing its display name does not
retarget the grant or change source links. Reconnect refreshes the validated context's session
metadata. A real `.pie` filename is preferred to a stale tab title; temporary Cloud cache paths
are not shown as filenames.

In the inspected Studio build, MCP tab names come from the main-process context's initial
`displayName`. Cloud renames can update the visible tab without refreshing that value, and
`studio_session_init` attaches the same main-process identity. Disconnecting the plugin cannot
refresh Studio's cached title. If Studio supplies only a placeholder such as Untitled, the panel
shows Connected to ProtoPie and says "ProtoPie hasn't provided this Cloud tab's name" for
recognized Cloud cache paths. For an unknown or unsaved context it says "ProtoPie hasn't provided
this tab's name." A placeholder session response never replaces a usable listed name or saved
file path. These messages do not claim to refresh Cloud names that Studio has not exposed.

Reopening the Pie recreates Studio's context metadata, but is not recommended solely to refresh
this label while continuing a linked Cloud import. This build also generates a new temporary path
for each Cloud opening; neither that path nor the context ID is a persistent Cloud document ID.
The importer cannot infer across those identities that it is the same Cloud Pie. Keep the Pie open
to retain its current import links. Display-name refreshes within the same context preserve links.

Downloaded diagnostics include the reported context ID, tab name, and path for troubleshooting,
but exclude the approval grant.

## Optional automatic approval

The installed bundle defines `PROTOPIE_MCP_AUTO_APPROVE`. Its approval handler returns immediately
when that environment variable is `1`, `true`, `auto`, or `yes`. It also permits MCP requests while
the Labs toggle is off; leave the toggle enabled for predictable normal operation.

This is an undocumented process environment switch, not an exposed plugin-specific trust setting.
It accepts **all local Studio MCP clients**, including future ones, for that app process. It does
not remove plan requirements or Pie editing rules. Other versions may remove or change it.

For Windows:

1. Save open Pies and quit ProtoPie completely.
2. Double-click `scripts/Start-ProtoPieAutoApprove.cmd`.
3. Keep the panel helper running via `Start-Plugin.cmd`, then open the plugin in Figma.

The launcher sets the variable for the new Studio process only and restores its own environment.
It does not edit Studio binaries, registry values, or persistent user environment settings. It
refuses to relaunch an already-running Studio. To return to manual approval, quit that Studio
process and open ProtoPie normally. The PowerShell entry point accepts `-ProtoPiePath` for a
non-default installation and `-Check` to check its executable path without launching anything.

The launcher's path check has passed on this machine. Studio has not been restarted with this
setting during this investigation, so automatic approval has been verified in the installed code,
not through a fresh live app launch.

## Sharing the plugin

Each recipient gets their own local grant and approves their initial connection. The plugin can
reuse it while Studio considers it valid. An owner cannot grant Studio access on a recipient's
computer by distributing a Figma plugin. Recipients who want automatic approval must opt into
the launcher on their own machine; the plugin does not enable that setting for them.

Packaged platform builds include the Node runtime, helper, launchers, and installation guide.
Recipients do not need npm or the build toolchain. Source checkouts and node-required packages
need Node.js 20+. Windows and macOS launchers are supplied; the macOS app run and Community
publishing remain release gates. Compatibility checks run before writing, and live coverage is
currently limited to the tested Studio build.

## Why the local panel helper is necessary

Figma documents that its plugin iframes have a null origin and are subject to
[CORS restrictions](https://developers.figma.com/docs/plugins/making-network-requests/).
Read-only probes against this Studio returned HTTP 403 for `Origin: null` and
`Origin: https://www.figma.com`, but HTTP 200 with the appropriate CORS header for a localhost
origin. Automatic approval does not change those origin restrictions.

The helper binds to `127.0.0.1:9983` and is loaded as `http://localhost:9983` because Figma rejects
numeric IP literals in its manifest domain list. Figma documents the [localhost pattern](https://developers.figma.com/docs/plugins/manifest/). It serves only the panel HTML, its script, and a health check.
It does not proxy arbitrary URLs or expose write endpoints. The bootstrap iframe passes messages
only between its Figma parent and its own localhost panel. The hosted panel calls Studio directly.
This avoids changing Studio's CORS policy and keeps all design traffic on the same computer.

Offline checks, read-only HTTP probes, and a headless browser run of the real opaque-iframe bridge
pass. The compiled reader has also read a real Figma QA file through the Figma connector. These
checks do not establish desktop plugin installation, its exact CSP behavior, or clientStorage
persistence in Figma desktop; that final app run is still a release gate.
