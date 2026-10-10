---
name: reverse-engineer-with-rea
description: Reverse engineer binaries, Electron/JavaScript applications, Android, firmware, or EVM bytecode with REA through the dsh-rea gateway tools.
whenToUse: Use when a claim depends on a shipped artifact rather than available source: decompilation, runtime capture, or version comparison. Skip for ordinary source-repository reading.
---

# REA through the dsh-rea gateway

REA is installed and reachable through four tools. It is **not** mounted as a flat
tool list: REA publishes 139 tools whose full schemas total roughly 1.87 MB, so the
gateway holds that catalog in process and streams what you ask for.

## The two-step protocol

1. `rea_search_tools { query, detail }` — find candidate tools. `detail: "summary"`
   gives one-line descriptions; `detail: "names"` is cheapest and can list the whole
   catalog in one call.
2. `rea_tool_schema { name }` — get the **exact** input schema for the tool you chose.
   Do not guess argument names.
3. `rea_call { name, arguments }` — run it.

`rea_status` reports installation health, the live session, catalog size, and the
path to REA's own bundled methodology.

Never invent a tool name. If `rea_call` reports an unknown tool, it returns the
closest matches — use them. Repeated guessed calls are the main way this workflow
wastes context.

## Cost discipline

- Pull the catalog once with `detail: "names"`; it is a few thousand characters and
  covers all 139 tools.
- Fetch schemas only for the tool you are about to call.
- Prefer one broad REA call over many narrow ones: `analyze_javascript_application`,
  `binary_overview`, and `trace_application_feature` return far more per token than
  primitive getters.
- Long REA results are truncated by the bridge at 200,000 characters with an explicit
  marker. Raise `maxChars` on `rea_call` only when the truncation marker tells you to.

## Routing by target

| Target | Start with |
|---|---|
| Native binary (PE/Mach-O/ELF) | `binary_session`, then `binary_overview`, `list_procedures`, `batch_decompile`, `analyze_function` |
| Decompilation at scale | `batch_decompile` (bulk), `procedure_pseudo_code` (one function), `get_call_graph`, `trace_call_path` |
| Cross-references and symbols | `xrefs`, `find_xrefs_to_name`, `search_procedures`, `search_strings`, `list_names` |
| Apple / macOS application | `inspect_macho`, `inspect_signature`, `inspect_plist`, `get_objc_classes`, `analyze_swift_types`, `project_apple_application_graph` |
| Managed (.NET) code | `inspect_managed_artifact`, `inspect_managed_members`, `inspect_managed_native_boundaries`, `project_managed_application_graph` |
| Android package | `inspect_android_package`, `search_android_classes`, `inspect_android_method`, `project_android_application_graph` |
| Electron / JavaScript application | `analyze_javascript_application`, `list_electron_targets`, `capture_electron_scenario`, `reconcile_javascript_runtime` |
| Web bundle / site | `analyze_web_bundle`, `recover_javascript_sources`, `trace_web_module_imports`, `observe_web_execution` |
| Live browser behaviour | `list_browser_targets`, `capture_browser_scenario`, `inspect_web_network_capture`, `capture_web_screenshot` |
| Running process | `capture_process_scenario`, `compare_process_captures`, `inspect_recorded_crash` |
| Firmware | `inspect_firmware_regions`, `extract_firmware` |
| EVM bytecode | `inspect_evm_interface` |
| Version-to-version change | `compare_application_versions`, `compare_artifacts`, `compare_functions`, `find_changed_behavior` |
| Evidence and reconstruction | `export_evidence_bundle`, `list_unknowns`, `build_reconstruction_obligation_ledger`, `verify_reconstruction` |

## Evidence rules

REA's value is that it grounds claims in observed artifacts instead of plausible
prose. Preserve that:

- Report what the tool observed, and name the tool that observed it.
- Distinguish static evidence (decompiled structure) from runtime evidence (captured
  behaviour). They disagree more often than intuition suggests; when they do, say so
  rather than picking one.
- Native analysis needs Hopper, Ghidra, or IDA configured. Static JavaScript analysis
  needs no analysis engine. If a provider is missing, `rea_status` or the failing
  call says so — report that instead of speculating about the binary.
- Track unresolved questions with `record_unknown` / `list_unknowns` so open gaps
  survive across steps instead of being silently smoothed over.

{{METHODOLOGY}}
