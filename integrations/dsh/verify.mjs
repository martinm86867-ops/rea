#!/usr/bin/env node
/**
 * End-to-end verification for the dsh-rea plugin, without a running harness.
 *
 * Builds a minimal Cordis-shaped context, applies the plugin, then invokes the
 * registered tools exactly as the tool registry would. This exercises the real
 * code path: bridge spawn, MCP handshake, catalog build, routing, and the
 * companion skill registration.
 *
 * Usage: node verify.mjs [--verbose]
 */

import { buildCatalog, flattenCallResult, searchCatalog } from './catalog.mjs'

const verbose = process.argv.includes('--verbose')
const checks = []
let failures = 0

function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  checks.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail.length > 0 ? ` — ${detail}` : ''}`)
  if (verbose || !ok) console.log(`${ok ? '✓' : '✗'} ${label}${detail.length > 0 ? `: ${detail}` : ''}`)
}

/** Minimal Cordis-shaped context capturing every registration. */
function fakeContext() {
  const state = { tools: new Map(), skills: [], effects: [] }
  const noop = () => {}
  const ctx = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
    },
    effect(callback) {
      const disposer = callback()
      state.effects.push(disposer)
      return noop
    },
    inject(services, callback) {
      if (services.includes('skills')) {
        callback({ skills: { register(skill) { state.skills.push(skill); return noop } } })
      }
      return noop
    },
  }
  return { ctx, state }
}

/** Validate the shape the tool registry requires of a registered tool. */
function structuralProblems(definition) {
  const problems = []
  if (typeof definition.name !== 'string' || definition.name.length === 0) problems.push('name')
  if (typeof definition.description !== 'string' || definition.description.length === 0) problems.push('description')
  if (definition.parameters === null || typeof definition.parameters !== 'object') problems.push('parameters')
  if (definition.parameters?.type !== 'object') problems.push('parameters.type=object')
  if (definition.output === null || typeof definition.output !== 'object') problems.push('output')
  if (definition.output?.schema === null || typeof definition.output?.schema !== 'object') problems.push('output.schema')
  if (typeof definition.output?.render !== 'function') problems.push('output.render')
  if (typeof definition.execute !== 'function') problems.push('execute')
  return problems
}

async function main() {
  console.log('dsh-rea verification\n')

  const { apply } = await import('./index.js')
  const { ctx, state } = fakeContext()
  apply(ctx)

  const expectedTools = ['rea_status', 'rea_search_tools', 'rea_tool_schema', 'rea_call']
  check('registers exactly four tools', state.tools.size === expectedTools.length, `got ${state.tools.size}: ${[...state.tools.keys()].join(', ')}`)
  for (const toolName of expectedTools) {
    const definition = state.tools.get(toolName)
    check(`tool ${toolName} registered`, definition !== undefined)
    if (definition === undefined) continue
    const problems = structuralProblems(definition)
    check(`tool ${toolName} structure`, problems.length === 0, problems.join(', '))
  }

  check('registers the companion skill', state.skills.length === 1, `got ${state.skills.length}`)
  const skill = state.skills[0]
  if (skill !== undefined) {
    check('skill name is kebab-case', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name), skill.name)
    check('skill has a description', typeof skill.description === 'string' && skill.description.length > 0)
    check('skill body is non-trivial', typeof skill.content === 'string' && skill.content.length > 500, `${skill.content?.length ?? 0} chars`)
    check('skill documents the two-step protocol', skill.content?.includes('rea_search_tools') === true)
  }

  // Live path: status -> catalog -> search -> schema -> call.
  const status = state.tools.get('rea_status')
  const statusResult = await status.execute({}, {})
  const statusText = statusResult?.text ?? ''
  const available = statusText.includes('REA is available')
  check('rea_status reaches the server', available, statusText.split('\n').slice(0, 4).join(' | '))
  if (!available) {
    console.log('\nLive checks skipped: REA is not reachable.\n')
    report()
    return
  }

  const toolCount = Number(/tools: (\d+)/.exec(statusText)?.[1] ?? 0)
  check('catalog reports 139 tools', toolCount === 139, `reported ${toolCount}`)
  check('rea_status renders text', status.output.render({}, statusResult)[0]?.type === 'text')

  const search = state.tools.get('rea_search_tools')

  const namesOnly = await search.execute({ detail: 'names', limit: 200 }, {})
  const nameLines = namesOnly.text.split('\n').filter((line) => /^[a-z0-9_]+$/.test(line.trim()))
  check('names-only listing returns full catalog', nameLines.length === 139, `${nameLines.length} names, ${namesOnly.text.length} chars`)
  check('names-only listing is context-cheap', namesOnly.text.length < 12_000, `${namesOnly.text.length} chars ≈ ${Math.round(namesOnly.text.length / 4)} tokens`)

  const hits = await search.execute({ query: 'decompile function', detail: 'summary', limit: 8 }, {})
  const ranked = hits.text.split('\n').filter((line) => line.startsWith('- **'))
  check('intent search returns hits', ranked.length > 0, `${ranked.length} hits`)
  check('intent search ranks a decompiler first', /batch_decompile|procedure_pseudo_code|analyze_function/.test(ranked[0] ?? ''),
    (ranked[0] ?? '').slice(0, 70))

  const schemaTool = state.tools.get('rea_tool_schema')
  const schema = await schemaTool.execute({ name: 'binary_session' }, {})
  check('schema lookup returns JSON schema', schema.text.includes('"type"') && schema.text.includes('```json'))
  check('schema lookup states required args', schema.text.includes('Required arguments:'))

  let unknownRejected = false
  try {
    await schemaTool.execute({ name: 'batch_decompil' }, {})
  } catch (error) {
    unknownRejected = /unknown REA tool/.test(error.message) && /Closest matches/.test(error.message)
    check('misspelled tool name suggests matches', unknownRejected, error.message.slice(0, 120))
  }
  check('unknown tool name is rejected', unknownRejected)

  const call = state.tools.get('rea_call')
  const callResult = await call.execute({ name: 'binary_session', arguments: {} }, {})
  check('rea_call executes upstream tool', typeof callResult.text === 'string' && callResult.text.length > 0,
    `${callResult.text.length} chars`)
  check('rea_call returns content', callResult.text.includes('session') || callResult.text.includes('binary') || callResult.text.length > 40,
    callResult.text.slice(0, 110).replaceAll('\n', ' '))

  // Catalog helpers, in isolation.
  const built = buildCatalog([
    { name: 'alpha_tool', description: 'Does alpha things. More text.', inputSchema: { type: 'object', properties: { a: {}, b: {} }, required: ['a'] } },
    { name: 'beta_tool', description: 'Does beta things.', inputSchema: { type: 'object', properties: {} } },
  ])
  check('catalog indexes by name', built.byName.get('alpha_tool')?.required[0] === 'a')
  check('catalog search is ranked', searchCatalog(built, 'alpha')[0]?.name === 'alpha_tool')
  check('catalog search misses cleanly', searchCatalog(built, 'zzz').length === 0)
  check('catalog search tolerates a missing token', searchCatalog(built, 'alpha nonexistentword')[0]?.name === 'alpha_tool')
  const flat = flattenCallResult({ content: [{ type: 'text', text: 'x'.repeat(50) }] }, 10)
  check('result truncation is explicit', flat.text.includes('[truncated:'))

  // Release the spawned `rea mcp` child so this process can exit.
  for (const dispose of state.effects) if (typeof dispose === 'function') dispose()
  report()
}

function report() {
  console.log('')
  for (const line of checks) if (line.startsWith('FAIL')) console.log(line)
  console.log(`${checks.length - failures}/${checks.length} checks passed`)
  if (failures > 0) {
    console.log(`\nVERIFICATION FAILED (${failures} failing)`)
    process.exit(1)
  }
  console.log('\nVERIFICATION PASSED')
  process.exit(0)
}

await main()
