# Proxied Server Consolidation -- Design Memo

**Question:** how should cortex handle the proxied MCP servers it ships with
and the ones users bring, so "5-minute install" is realistic for new adopters?

## Current topology

From `mcp-servers.yaml`:

| Server | Runtime | Location | Install cost |
|--------|---------|----------|--------------|
| github | Node/TS | `servers/github/` (in-tree) | built from source at install |
| commands | Node/TS | `servers/commands/` (in-tree) | built from source at install |
| inspector | Node/TS | `servers/inspector/` (in-tree) | built from source at install |
| playwright | Node/TS | `npx -y @playwright/mcp@latest` | npm cache fetch on first run |
| brave-search | Node/TS | `npx -y @brave/brave-search-mcp-server` | npm cache fetch on first run |

Three vendored, two npx-lazy. All Node. The install story is close to
"clone + build + run," but there are soft edges.

## Why this matters

Distribution is cortex's actual constraint. The engineering is done; the
question is whether a stranger can go from `git clone` to `enter_state` in
five minutes. The install story compounds: every friction point drops some
percentage of potential users at the threshold.

Specific risks:

1. **`npx ... @latest` is a time bomb.** Playwright MCP and brave-search
   pin to the latest tag. An upstream breaking change reaches every user
   simultaneously, and the first symptom is a cortex that won't start.
2. **Bring-your-own servers.** Users adding a Python MCP server (atlassian,
   jira, etc.), or any non-Node runtime, have to set up that runtime
   themselves. cortex doesn't help.
3. **No doctor.** When something fails at startup, the error is the failing
   subprocess's error. No "your $X is missing, run $Y" nudge.

## Three options for tighter distribution

### Option A -- Full fold-in

Vendor any proxied server's full source into `servers/<name>/`. Drop npx
entirely. Polyglot deps get their runtime absorbed into the cortex build.

**Pros**
- Single-command install: clone + bootstrap.
- Pinned versions automatically; no drift.
- Version history lives with cortex.

**Cons**
- Monorepo turns polyglot -- CI, build, linting complexity grows.
- Upstream servers evolve; cherry-picking patches is ongoing work.
- For servers that are real projects with their own release cadence, the
  maintenance cost is meaningful even when "you don't touch it".

**When it fits:** cortex stops caring about upstream for a given server and
becomes the authoritative fork -- only worth it if there are cortex-specific
patches that can't go upstream.

### Option B -- Git submodules for foreign-runtime deps

Keep vendored Node servers in-tree. For any non-Node MCP a user wants to
proxy, point at it via a submodule pinned at a specific commit. Bootstrap
script runs `git submodule update --init` plus whatever runtime install
(`uv sync`, `pip install`, etc.) the submodule needs.

**Pros**
- Pinned commit -- reproducible installs.
- Upstream tracking is one `git submodule update --remote` away.
- Repo size stays small (submodules are references).
- Polyglot concern localizes to `vendor/`.

**Cons**
- Submodules are a known developer pitfall (detached HEAD, clone depth,
  forgetting `--recursive`).
- Bootstrap still needs to detect and install the foreign runtime.

**When it fits:** cortex wants the install story of "clone + bootstrap"
without owning the release cadence of every proxied server.

### Option C -- Vendor-pin with a lockfile

Leave server wiring where it is. Extend `mcp-servers.yaml` (or add a
sibling lockfile) that pins exact versions / commits for every proxied
server, whether npx'd, vendored, or cloned. A bootstrap script reads the
lockfile and does the right install for each entry.

**Pros**
- No repo-structure change.
- Version-pinning is explicit and reviewable.
- Works across heterogeneous install methods.
- Per-server upgrade path -- no coupling between cortex release and server
  release.

**Cons**
- Another config surface.
- For npx, the pin is already half-solved by writing `@0.4.2` instead of
  `@latest`.
- Doesn't reduce moving parts, just makes them explicit.

**When it fits:** cortex values clarity and upgrade flexibility over install
simplicity.

## Recommendation

**Short term:**
- Pin the npx-installed servers to specific versions in `mcp-servers.yaml`.
  `@latest` is the single most preventable breakage vector.
- Add `scripts/bootstrap.sh` that builds the vendored Node servers and
  exits cleanly with a checklist for anything else the user has configured.
- Ship a `cortex doctor` subcommand that checks: Node version, vendored-
  server build artifacts present, npx-cached versions match the pin,
  foreign runtimes installed for any user-added servers. Good errors beat
  good docs.

**Medium term:**
- Option B for any foreign-runtime server the community ends up adopting.
  Pin a known-good commit; maintenance patches live on a branch of the
  submodule.
- The install story becomes: `git clone --recursive cortex && ./scripts/bootstrap.sh`.

**Not recommending Option A** because fork-maintenance cost is real and
the distribution wins are mostly achievable through bootstrap + pinning.

## Distribution-facing blockers

Current blockers to "5-minute install":

1. No version pinning on npx servers -- "works on my laptop" drift.
2. No doctor means startup failures surface as raw subprocess errors.
3. No bootstrap script means new users figure out the build order from
   README rather than `./scripts/bootstrap.sh`.
4. BYO-MCP-server story is undocumented -- users with, say, a Python
   atlassian MCP need to know how to slot it in.

All four are solvable without restructuring the monorepo.

## Open questions

- When would Option A actually be right? Only when cortex has meaningful
  patches in the vendored server that can't go upstream. Otherwise the
  maintenance burden is a net negative.
- Should `cortex doctor` be a native CLI subcommand, a cortex MCP tool,
  or both? A CLI for setup sanity, an MCP tool for in-session debugging
  of the proxy layer.
