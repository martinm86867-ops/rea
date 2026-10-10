# dsh-rea — REA as a DeepSeek Harness plugin

Mounts [REA](https://github.com/morluto/rea)'s reverse-engineering capability into a
DSH profile: 139 MCP tools for binaries, Electron/JavaScript applications, Android,
firmware, EVM bytecode, browser capture, and process capture.

## Why a gateway instead of a plain MCP row

DSH can mount an MCP server directly with one `@deepseek-ai/dsh-mcp-client` row. For
REA that row is unusable: `tools/list` returns **1,870,560 bytes** of JSON Schemas —
roughly **468,000 tokens** of tool definitions. DSH sends tool schemas on every
request, so mounting the raw catalog would exceed the context window before the model
said anything.

This plugin keeps the catalog in process and registers four routing tools instead:

| Tool | Purpose |
|---|---|
| `rea_status` | Executable, live MCP session, catalog size, REA's own skill/docs paths |
| `rea_search_tools` | Find tools by intent; `names` / `summary` / `schema` detail |
| `rea_tool_schema` | The exact input schema for one named tool |
| `rea_call` | Invoke any of the 139 tools upstream |

Standing cost: **~1.5k tokens** (four small schemas). Full catalog listing:
**~776 tokens** for all 139 names. Capability is unchanged — every upstream tool stays
reachable through `rea_call`, and a miss returns ranked suggestions instead of a
dead end.

A companion runtime skill, `reverse-engineer-with-rea`, teaches the two-step protocol,
a target-to-tool routing table, and evidence discipline. It points at REA's own
bundled methodology, which stays authoritative for the installed version.

## Install

```sh
# 1. REA itself (skipped automatically when `rea` is already present)
npm install --global rea-agents

# 2. The plugin, into a profile
./install.sh                 # defaults to the `web` profile
./install.sh tui             # or name one explicitly
```

`install.sh` runs `dsh plugin --profile <name> add <this directory>`, which links the
package and appends `dsh-rea` to `dsh.profile.bundles`. It then runs the verification
suite.

Manual equivalent:

```sh
dsh plugin --profile web add /path/to/rea/integrations/dsh
```

## Verify

```sh
node verify.mjs          # 32 checks, no harness required
```

`verify.mjs` builds a Cordis-shaped context, applies the plugin, and drives the real
code path — spawn, MCP handshake, catalog build, routing, schema lookup, a live
upstream call, and the skill registration. It exits non-zero on any failure.

Inside a running session, `rea_status` is the fastest health check.

## Configuration

All fields are optional and fall back to environment variables:

| Row config | Environment | Default |
|---|---|---|
| `command` | `REA_DSH_BIN`, `REA_BIN` | `~/.local/bin/rea`, then `PATH` |
| `cwd` | `DSH_REA_CWD` | the host process working directory |
| `maxResultChars` | `REA_DSH_MAX_RESULT_CHARS` | `200000` |
| `callTimeoutMs` | `REA_DSH_CALL_TIMEOUT_MS` | `900000` |

```yaml
- id: rea
  name: dsh-rea
  config:
    command: /opt/rea/bin/rea
    maxResultChars: 400000
```

## Analysis engines

REA reaches some analysis paths through a configured engine. Static JavaScript
analysis, artifact inspection, and evidence workflows need none — verified working
out of the box. Native binary work needs one of:

- **Ghidra** — set `GHIDRA_INSTALL_DIR` to an extracted Ghidra 12.1.x release directory
- **IDA** — set `REA_IDA_MCP_CONFIG` to an upstream IDA MCP registration JSON
- **Hopper** — set `HOPPER_LAUNCHER_PATH` (macOS)
- **ELF via pwntools** — set `REA_PWNTOOLS_PYTHON` to an absolute Python executable
  carrying pwntools 4.15.0, pyelftools 0.33, and Unicorn 2.1.2

Missing engines are reported as structured, actionable errors by the failing tool
call — not crashes. `rea doctor` audits the whole environment.

## Layout

| File | Role |
|---|---|
| `index.js` | Cordis host plugin: registers the four tools and the runtime skill |
| `bridge.mjs` | Dependency-free MCP stdio client for `rea mcp`, with auto-respawn |
| `catalog.mjs` | Catalog index, intent search, schema streaming, result flattening |
| `cordis.patch.yml` | Bundle patch inserting the `rea` row |
| `skills/rea/SKILL.md` | Companion skill body |
| `verify.mjs` | End-to-end verification harness |

The plugin imports only `node:*` builtins and its own files: a linked plugin cannot
resolve the harness's `node_modules`, so it has no platform dependencies to break on
a harness upgrade.

## Uninstall

```sh
dsh plugin --profile web remove dsh-rea
```

The row, the four tools, and the skill disappear together. REA keeps working as an
ordinary CLI and MCP server; nothing else in the harness references this plugin.
