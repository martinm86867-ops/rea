/**
 * Compact index over REA's MCP tool catalog.
 *
 * REA 6.3.0 publishes 139 tools whose full JSON Schemas total ~1.87 MB
 * (~468k tokens). Registering that surface directly would consume more context
 * than any session has, so the plugin keeps the catalog in memory, exposes only
 * four routing tools, and streams individual schemas on demand.
 *
 * @module rea-catalog
 */

/** First-sentence summary length cap; keeps a full-catalog listing affordable. */
const SUMMARY_LIMIT = 180

/** Default number of search hits. */
export const DEFAULT_SEARCH_LIMIT = 12

/**
 * Hard cap on search hits. Sized so a `names`-detail call can list the entire
 * 139-tool catalog in one shot while staying far below the cost of one schema.
 */
export const MAX_SEARCH_LIMIT = 200

/**
 * Reduce a long tool description to its first sentence.
 * @param description - Raw upstream description.
 * @returns A single-line summary.
 */
export function summarize(description) {
  const flat = String(description ?? '').replaceAll(/\s+/g, ' ').trim()
  if (flat.length <= SUMMARY_LIMIT) return flat
  const stop = flat.slice(0, SUMMARY_LIMIT)
  const sentenceEnd = stop.search(/[.;]\s/)
  if (sentenceEnd > 40) return stop.slice(0, sentenceEnd + 1)
  const lastSpace = stop.lastIndexOf(' ')
  return `${stop.slice(0, lastSpace > 40 ? lastSpace : SUMMARY_LIMIT)}…`
}

/** Parameter names declared by one JSON Schema, split by requirement. */
function parameterNames(schema) {
  const properties = schema?.properties
  if (properties === null || typeof properties !== 'object') return { required: [], optional: [] }
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const names = Object.keys(properties)
  return {
    required: names.filter((name) => required.has(name)),
    optional: names.filter((name) => !required.has(name)),
  }
}

/**
 * Build the searchable catalog.
 * @param tools - Raw MCP tool definitions from `tools/list`.
 * @returns Catalog with ordered entries and a name lookup.
 */
export function buildCatalog(tools) {
  const entries = []
  const byName = new Map()
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string') continue
    const { required, optional } = parameterNames(tool.inputSchema)
    const entry = {
      name: tool.name,
      summary: summarize(tool.description),
      description: String(tool.description ?? ''),
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      required,
      optional,
      haystack: `${tool.name} ${tool.description ?? ''}`.toLowerCase(),
    }
    entries.push(entry)
    byName.set(entry.name, entry)
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { entries, byName, size: entries.length }
}

/**
 * Score one entry against the query tokens; higher is better, 0 means no match.
 *
 * Tokens are additive rather than conjunctive: a natural-language query like
 * "decompile function" must still rank `batch_decompile`, whose name carries only
 * one of the two words. Coverage then scales the total so an entry matching every
 * token outranks one matching a single strong token.
 */
function score(entry, tokens, rawQuery) {
  if (entry.name === rawQuery) return 10_000
  let total = 0
  let matched = 0
  for (const token of tokens) {
    let tokenScore = 0
    if (entry.name === token) tokenScore = 400
    else if (entry.name.startsWith(token)) tokenScore = 220
    else if (entry.name.includes(token)) tokenScore = 140
    else if (entry.haystack.includes(token)) tokenScore = 45
    if (tokenScore > 0) matched += 1
    total += tokenScore
  }
  if (matched === 0) return 0
  const coverage = matched / tokens.length
  // Prefer specific, short names and tools with fewer required parameters.
  return total * (0.4 + 0.6 * coverage) + Math.max(0, 40 - entry.name.length) - entry.required.length * 2
}

/**
 * Last-resort matcher for truncated or misspelled tool names.
 *
 * An agent that half-remembers a name ("batch_decompil") should still get a
 * usable suggestion list instead of a dead end, so the longest query token is
 * matched as a name prefix down to four characters.
 */
function prefixFallback(entries, tokens) {
  const longest = [...tokens].sort((left, right) => right.length - left.length)[0] ?? ''
  if (longest.length < 5) return []
  for (let length = longest.length - 1; length >= 4; length -= 1) {
    const prefix = longest.slice(0, length)
    const hits = entries.filter((entry) => entry.name.includes(prefix))
    if (hits.length > 0) return hits
  }
  return []
}

/**
 * Rank catalog entries for a natural-language or snake_case query.
 * @param catalog - Catalog from {@link buildCatalog}.
 * @param query - Search text; empty returns the head of the catalog.
 * @param limit - Maximum hits.
 * @returns Matching entries in rank order.
 */
export function searchCatalog(catalog, query, limit = DEFAULT_SEARCH_LIMIT) {
  const capped = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_SEARCH_LIMIT))
  const rawQuery = String(query ?? '').trim().toLowerCase()
  if (rawQuery.length === 0) return catalog.entries.slice(0, capped)

  const tokens = rawQuery.split(/[^a-z0-9]+/).filter((token) => token.length > 1)
  if (tokens.length === 0) return catalog.entries.slice(0, capped)

  const scored = []
  for (const entry of catalog.entries) {
    const value = score(entry, tokens, rawQuery)
    if (value > 0) scored.push({ entry, value })
  }
  if (scored.length === 0) return prefixFallback(catalog.entries, tokens).slice(0, capped)

  scored.sort((left, right) => right.value - left.value || (left.entry.name < right.entry.name ? -1 : 1))
  return scored.slice(0, capped).map((hit) => hit.entry)
}

/**
 * Render one catalog entry.
 * @param entry - Catalog entry.
 * @param detail - `names` for the name alone, `summary` for name + summary,
 *   `schema` for the full input schema.
 * @returns Markdown-ish text block.
 */
export function describeEntry(entry, detail = 'summary') {
  if (detail === 'names') return entry.name
  const signature = entry.required.length > 0 ? ` (requires: ${entry.required.join(', ')})` : ''
  if (detail === 'schema') {
    return [
      `### ${entry.name}${signature}`,
      '',
      entry.summary,
      '',
      '```json',
      JSON.stringify(entry.inputSchema, null, 2),
      '```',
    ].join('\n')
  }
  const optional = entry.optional.length > 0 ? ` [optional: ${entry.optional.slice(0, 8).join(', ')}]` : ''
  return `- **${entry.name}**${signature}: ${entry.summary}${optional}`
}

/**
 * Flatten one MCP `tools/call` result into model-facing text.
 *
 * Text blocks pass through; structured content is appended as JSON because REA
 * returns canonical values there. Truncation is explicit so a clipped result is
 * never mistaken for a complete one.
 *
 * @param result - Raw MCP call result.
 * @param maxChars - Output cap.
 * @returns Text plus the upstream error flag.
 */
export function flattenCallResult(result, maxChars) {
  const parts = []
  const blocks = Array.isArray(result?.content) ? result.content : []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image ${block.mimeType ?? 'image'} omitted — DSH attachments are not bridged by this plugin]`)
    else if (block.type === 'resource') parts.push(`[resource ${block.resource?.uri ?? ''}]`)
    else parts.push(JSON.stringify(block))
  }
  if (result?.structuredContent !== undefined) {
    parts.push(`\n--- structuredContent ---\n${JSON.stringify(result.structuredContent, null, 2)}`)
  }
  if (parts.length === 0) parts.push(result === undefined ? '(no result)' : JSON.stringify(result).slice(0, 2_000))

  let text = parts.join('\n')
  if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
    const omitted = text.length - maxChars
    text = `${text.slice(0, maxChars)}\n\n[truncated: ${omitted} more characters omitted by the dsh-rea bridge]`
  }
  return { text, isError: result?.isError === true }
}
