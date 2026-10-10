/**
 * DSH plugin: REA reverse-engineering tools, with a context-safe gateway.
 *
 * REA's MCP server publishes 139 tools whose full JSON Schemas total ~1.87 MB
 * (~468k tokens). Mounting that catalog into the model's tool list would exceed
 * the context window on its own, so this plugin holds the catalog in process and
 * registers four routing tools instead:
 *
 *   rea_status        — installation, session, and catalog health
 *   rea_search_tools  — find tools by intent; stream one schema on demand
 *   rea_tool_schema   — the exact input schema for one named tool
 *   rea_call          — invoke any of the 139 tools upstream
 *
 * Full upstream capability, ~1.5k tokens of standing surface. The companion
 * runtime skill teaches the two-step protocol and points at REA's own bundled
 * methodology, which stays authoritative for the installed version.
 *
 * Dependency-free by design: linked plugins cannot resolve the harness's
 * node_modules, so this module imports `node:*` builtins and its own files only.
 *
 * @module dsh-rea
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAnalysisEnv, locateRea, ReaMcpClient } from './bridge.mjs'
import { buildCatalog, describeEntry, DEFAULT_SEARCH_LIMIT, flattenCallResult, searchCatalog } from './catalog.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-rea'

/** The tool registry must exist before this plugin registers anything. */
export const inject = ['tools']

/** Default cap on one flattened tool result, in characters. */
const DEFAULT_MAX_RESULT_CHARS = 200_000

/** Skill registered for the two-step gateway protocol. */
const SKILL_NAME = 'reverse-engineer-with-rea'

/** Read one packed skill body, relative to this module. */
function readSkillBody() {
  const url = new URL('./skills/rea/SKILL.md', import.meta.url)
  const path = fileURLToPath(url)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/**
 * Locate REA's own documentation inside its installed package.
 *
 * The installed `skills/` and `docs/` are version-matched to the running
 * binary, so the plugin defers methodology to them instead of shipping a
 * second, drifting copy.
 *
 * @param located - Result of {@link locateRea}.
 * @returns Discovered package root, skill path, and docs path when present.
 */
function discoverReaDocs(located) {
  const empty = { packageRoot: undefined, skillPath: undefined, readmePath: undefined }
  let start
  try {
    start = realpathSync(located.command)
  } catch {
    return empty
  }
  let dir = dirname(start)
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest?.name === 'rea-agents') {
          const skillPath = join(dir, 'skills', 'reverse-engineer-anything', 'SKILL.md')
          const readmePath = join(dir, 'README.md')
          return {
            packageRoot: dir,
            skillPath: existsSync(skillPath) ? skillPath : undefined,
            readmePath: existsSync(readmePath) ? readmePath : undefined,
          }
        }
      } catch {
        // A malformed neighbour manifest is not this plugin's failure.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return empty
}

/** Build a plain ToolDefinition returning uniform `{ text }` content. */
function textTool({ toolName, description, parameters, run }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Model-facing result text.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      return { text: await run(args ?? {}, exec) }
    },
  }
}

/**
 * Register the REA gateway tools and its companion skill.
 * @param ctx - Context providing the tool registry and, optionally, the skill registry.
 * @param config - Optional row config overrides.
 */
export function apply(ctx, config) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const env = process.env
  const located = options.command !== undefined
    ? { command: String(options.command), args: [], source: 'config', found: true }
    : locateRea({ env })
  const maxResultChars = Number(options.maxResultChars ?? env.REA_DSH_MAX_RESULT_CHARS ?? DEFAULT_MAX_RESULT_CHARS)
  const callTimeoutMs = Number(options.callTimeoutMs ?? env.REA_DSH_CALL_TIMEOUT_MS ?? 900_000)

  const docs = discoverReaDocs(located)

  // Inject a discovered analysis engine and JDK, so the operator never has to
  // export GHIDRA_INSTALL_DIR or JAVA_HOME before starting the harness.
  const analysis = options.analysis === false ? {} : discoverAnalysisEnv({ env })
  const childEnv = { ...env, ...analysis, ...(options.env !== null && typeof options.env === 'object' ? options.env : {}) }

  const client = new ReaMcpClient({
    located,
    env: childEnv,
    cwd: typeof options.cwd === 'string' ? options.cwd : (env.DSH_REA_CWD ?? process.cwd()),
    callTimeoutMs: Number.isFinite(callTimeoutMs) ? callTimeoutMs : 900_000,
    logger: (message) => { ctx.logger?.info?.(`dsh-rea: ${message}`) },
  })

  ctx.effect(() => () => { client.dispose() })

  /** Cached catalog plus the generation it was built for. */
  let catalog
  let catalogPromise

  /** Load (and memoize) the upstream catalog, refreshing it once after a reconnect. */
  const loadCatalog = async (refresh, signal) => {
    if (refresh) {
      catalog = undefined
      catalogPromise = undefined
    }
    catalogPromise ??= (async () => {
      const tools = await client.listTools({ signal })
      const built = buildCatalog(tools)
      catalog = built
      return built
    })().catch((error) => {
      catalogPromise = undefined
      throw error
    })
    return await catalogPromise
  }

  /** Report a bridge failure as an actionable message. */
  const unreachable = (error) => new Error(
    `REA is not reachable (${error.message}). `
    + `Bridge target: ${located.command} (${located.source}). `
    + 'Install or repair REA with: npm install --global rea-agents',
  )

  ctx.tools.register(textTool({
    toolName: 'rea_status',
    description: 'Report REA availability: executable, MCP session, catalog size, and upstream skill/docs paths. Call this first when a reverse-engineering task may need REA, or when a REA tool call fails.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, exec) {
      const lines = []
      try {
        const session = await client.ensure()
        const built = await loadCatalog(false, exec?.signal)
        lines.push('REA is available.')
        lines.push(`- executable: ${located.command} (${located.source})`)
        lines.push(`- server: ${session?.serverInfo?.name ?? 'rea'} ${session?.serverInfo?.version ?? ''}`.trim())
        lines.push(`- protocol: ${session?.protocolVersion ?? 'unknown'}`)
        lines.push(`- tools: ${built.size}`)
        lines.push(`- pid: ${client.info.startedPid ?? 'unknown'}`)
      } catch (error) {
        lines.push('REA is NOT available.')
        lines.push(`- reason: ${error.message}`)
        lines.push(`- bridge target: ${located.command} (${located.source})`)
        lines.push('- install: npm install --global rea-agents')
      }
      const engine = analysis.GHIDRA_INSTALL_DIR ?? '(none discovered — native analysis unavailable)'
      lines.push(`- native engine: ${engine}`)
      if (analysis.JAVA_HOME !== undefined) lines.push(`- jdk: ${analysis.JAVA_HOME}`)
      if (docs.packageRoot !== undefined) {
        lines.push(`- package root: ${docs.packageRoot}`)
        if (docs.skillPath !== undefined) lines.push(`- workflow skill: ${docs.skillPath}`)
        if (docs.readmePath !== undefined) lines.push(`- readme: ${docs.readmePath}`)
      }
      lines.push('')
      lines.push('Using REA: rea_search_tools to find a tool, rea_tool_schema for its exact input, then rea_call to run it.')
      return lines.join('\n')
    },
  }))

  ctx.tools.register(textTool({
    toolName: 'rea_search_tools',
    description: 'Search REA\'s tool catalog by intent and return matching tool names with one-line summaries. Use detail "schema" to stream the input schema of one tool. Call with no query to list the catalog (use detail "names" for the cheapest full listing).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Intent or tool name fragment, e.g. "decompile function", "javascript bundle", "compare versions". Omit to list the catalog.' },
        detail: { type: 'string', enum: ['names', 'summary', 'schema'], description: 'Response detail. "names" is cheapest, "summary" adds descriptions, "schema" returns full JSON Schemas.' },
        limit: { type: 'integer', description: `Maximum matches (default ${DEFAULT_SEARCH_LIMIT}, max 200).` },
        refresh: { type: 'boolean', description: 'Re-read the catalog from REA instead of the cached copy.' },
      },
    },
    async run(args, exec) {
      let built
      try {
        built = await loadCatalog(args.refresh === true, exec?.signal)
      } catch (error) {
        throw unreachable(error)
      }
      const detail = ['names', 'summary', 'schema'].includes(args.detail) ? args.detail : 'summary'
      const matches = searchCatalog(built, args.query ?? '', args.limit ?? DEFAULT_SEARCH_LIMIT)
      const header = args.query === undefined || String(args.query).trim() === ''
        ? `REA tool catalog (${built.size} tools total; showing ${matches.length}).`
        : `REA tools matching "${String(args.query).trim()}" (${matches.length} of ${built.size}).`
      const blocks = matches.map((entry) => describeEntry(entry, detail))
      const footer = detail === 'names'
        ? '\nCall rea_search_tools with a query and detail "summary" for descriptions, or rea_tool_schema for one tool\'s exact input.'
        : '\nNext: rea_tool_schema { name } for the exact input, then rea_call { name, arguments }.'
      return `${header}\n\n${blocks.join(detail === 'schema' ? '\n\n' : '\n')}\n${footer}`
    },
  }))

  ctx.tools.register(textTool({
    toolName: 'rea_tool_schema',
    description: 'Return the exact JSON input schema for one REA tool, so its arguments can be constructed correctly before calling rea_call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Exact REA tool name, e.g. "binary_session".' },
      },
    },
    async run(args, exec) {
      const requested = String(args.name ?? '').trim()
      if (requested.length === 0) throw new Error('rea_tool_schema requires a tool name')
      let built
      try {
        built = await loadCatalog(false, exec?.signal)
      } catch (error) {
        throw unreachable(error)
      }
      const entry = built.byName.get(requested)
      if (entry === undefined) {
        const suggestions = searchCatalog(built, requested, 6).map((hit) => hit.name)
        throw new Error(
          `unknown REA tool "${requested}".`
          + (suggestions.length > 0 ? ` Closest matches: ${suggestions.join(', ')}.` : '')
          + ' Call rea_search_tools to browse the catalog.',
        )
      }
      const required = entry.required.length > 0 ? entry.required.join(', ') : '(none)'
      return `${describeEntry(entry, 'schema')}\n\nRequired arguments: ${required}`
    },
  }))

  ctx.tools.register(textTool({
    toolName: 'rea_call',
    description: 'Invoke any REA tool by exact name with JSON arguments. This is the execution path for REA\'s full reverse-engineering toolset: binaries, JavaScript/Electron applications, Android, firmware, EVM bytecode, browser and process capture. Call rea_tool_schema first to get the exact argument shape.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Exact REA tool name, e.g. "binary_session".' },
        arguments: { type: 'object', description: 'Arguments object matching the tool\'s input schema.', additionalProperties: true },
        maxChars: { type: 'integer', description: `Output cap in characters (default ${DEFAULT_MAX_RESULT_CHARS}).` },
      },
    },
    async run(args, exec) {
      const requested = String(args.name ?? '').trim()
      if (requested.length === 0) throw new Error('rea_call requires a tool name')
      let built
      try {
        built = await loadCatalog(false, exec?.signal)
      } catch (error) {
        throw unreachable(error)
      }
      if (!built.byName.has(requested)) {
        const suggestions = searchCatalog(built, requested, 6).map((hit) => hit.name)
        throw new Error(
          `unknown REA tool "${requested}".`
          + (suggestions.length > 0 ? ` Closest matches: ${suggestions.join(', ')}.` : '')
          + ' Use rea_search_tools, then rea_call with an exact name.',
        )
      }
      const toolArguments = args.arguments !== null && typeof args.arguments === 'object' ? args.arguments : {}
      const cap = Number.isFinite(args.maxChars) ? Number(args.maxChars) : maxResultChars
      let result
      try {
        result = await client.callTool(requested, toolArguments, { signal: exec?.signal })
      } catch (error) {
        throw new Error(`REA tool "${requested}" failed: ${error.message}`)
      }
      const flattened = flattenCallResult(result, cap)
      const prefix = flattened.isError ? `REA tool "${requested}" reported an error.\n\n` : ''
      return `${prefix}${flattened.text}`
    },
  }))

  // The skill registry is optional: the tools stay useful without it.
  ctx.inject(['skills'], (skillCtx) => {
    const body = readSkillBody()
    if (body.length === 0) {
      ctx.logger?.warn?.('dsh-rea: companion skill body missing; tools are registered without it')
      return
    }
    const methodology = docs.skillPath !== undefined
      ? `\n\n## Full REA methodology\n\nREA ships its own, version-matched workflow instructions. Read them with the read tool before a substantial investigation:\n\n\`${docs.skillPath}\`\n`
      : ''
    const content = body.replaceAll('{{METHODOLOGY}}', methodology)
    skillCtx.skills.register({
      name: SKILL_NAME,
      description: 'Reverse engineer binaries, Electron/JavaScript applications, Android, firmware, or EVM bytecode with REA through the dsh-rea gateway tools.',
      whenToUse: 'Use when a claim depends on a shipped artifact rather than available source: decompilation, runtime capture, or version comparison. Skip for ordinary source-repository reading.',
      source: 'runtime',
      provider: name,
      metadata: { version: '1' },
      content,
    })
  })
}
