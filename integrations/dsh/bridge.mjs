/**
 * Minimal, dependency-free MCP stdio client for `rea mcp`.
 *
 * Why hand-rolled instead of `@modelcontextprotocol/client`: a linked DSH plugin
 * cannot reliably resolve the platform's node_modules, and one less abstraction
 * is one less thing that can break on a harness upgrade. The wire protocol over
 * stdio is newline-delimited JSON-RPC 2.0 — small enough to own outright.
 *
 * Lifecycle: the child is started lazily on first use and respawned
 * automatically after a crash, so a missing or broken `rea` install degrades to
 * a clear tool error instead of failing DSH boot.
 *
 * @module rea-bridge
 */

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** MCP revision this client advertises; rea 6.3.0 answers 2025-11-25. */
export const PROTOCOL_VERSION = '2025-11-25'

/** Received-stderr ring buffer size kept for diagnostics. */
const STDERR_LIMIT = 8_192

/**
 * Locate the `rea` executable.
 *
 * Order matters: an explicit override wins, then the user's own install
 * directory (rea's installer writes there on Linux), then PATH. The fallback
 * keeps the bare name so `spawn` produces its own ENOENT message.
 *
 * @param options - Environment and home overrides, injectable for tests.
 * @returns Command, argument prefix, and which rule matched.
 */
export function locateRea(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  const isExecutable = (path) => {
    if (!exists(path)) return false
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  }

  for (const key of ['REA_DSH_BIN', 'REA_BIN']) {
    const explicit = env[key]
    if (typeof explicit === 'string' && explicit.length > 0) {
      return { command: explicit, args: [], source: `env:${key}`, found: isExecutable(explicit) || isAbsolute(explicit) }
    }
  }

  const localBin = join(home, '.local', 'bin', 'rea')
  if (isExecutable(localBin)) return { command: localBin, args: [], source: 'local-bin', found: true }

  const pathEntries = String(env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0)
  for (const entry of pathEntries) {
    const candidate = join(entry, 'rea')
    if (isExecutable(candidate)) return { command: candidate, args: [], source: 'path', found: true }
  }

  return { command: 'rea', args: [], source: 'fallback', found: false }
}

/**
 * One `rea mcp` child process and its JSON-RPC session.
 *
 * Requests are matched by id; server notifications are ignored except for
 * logging. A dead child is detected on exit, on spawn error, and on every
 * request, so the next call transparently restarts the session.
 */
export class ReaMcpClient {
  #config
  #child
  #session
  #buffer = ''
  #pending = new Map()
  #nextId = 1
  #starting
  #stderr = ''
  #disposed = false
  #log

  /**
   * @param options - Binary location, spawn parameters, and timeouts.
   */
  constructor(options = {}) {
    const located = options.located ?? locateRea(options)
    this.#config = {
      located,
      serverArgs: options.serverArgs ?? ['mcp'],
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      initializeTimeoutMs: options.initializeTimeoutMs ?? 30_000,
      listTimeoutMs: options.listTimeoutMs ?? 30_000,
      callTimeoutMs: options.callTimeoutMs ?? 900_000,
    }
    this.#log = options.logger ?? (() => {})
    this.info = { found: located.found, command: located.command, source: located.source, startedPid: undefined }
  }

  /** Whether a live initialized session currently exists. */
  get connected() {
    return this.#child !== undefined
  }

  /**
   * Start and initialize the session if it is not already running.
   * @returns The live session's `initialize` result.
   */
  async ensure() {
    if (this.#disposed) throw new Error('rea bridge disposed')
    if (this.#child !== undefined) return this.#session
    this.#starting ??= this.#start().finally(() => { this.#starting = undefined })
    return await this.#starting
  }

  async #start() {
    const { located, serverArgs, cwd, env } = this.#config
    let child
    try {
      child = spawn(located.command, [...located.args, ...serverArgs], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (cause) {
      throw new Error(`cannot start '${located.command} ${serverArgs.join(' ')}': ${String(cause)}`)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { this.#ingest(chunk) })
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT)
    })

    const failure = new Promise((_, reject) => {
      child.once('error', (error) => {
        this.#teardown(child)
        reject(new Error(
          `cannot run '${located.command}' (${located.source}): ${error.message}. `
          + 'Install REA with: npm install --global rea-agents  — or point REA_DSH_BIN at the rea executable.',
        ))
      })
      child.once('exit', (code, signal) => {
        const detail = this.#stderr.trim().slice(0, 600)
        this.#teardown(child)
        reject(new Error(
          `'rea mcp' exited before initialization (code=${String(code)}, signal=${String(signal)})`
          + (detail.length > 0 ? `: ${detail}` : ''),
        ))
      })
    })

    this.#child = child
    this.info.startedPid = child.pid

    const initialized = await Promise.race([
      this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-rea', version: '1.0.0' },
      }, { timeoutMs: this.#config.initializeTimeoutMs }),
      failure,
    ])

    this.#session = initialized
    this.notify('notifications/initialized', {})
    this.#log(`rea mcp initialized: ${initialized?.serverInfo?.name ?? 'rea'}@${initialized?.serverInfo?.version ?? '?'}`)
    return initialized
  }

  /** Drop one child and fail its in-flight requests. */
  #teardown(child) {
    if (this.#child !== child) return
    this.#child = undefined
    this.info.startedPid = undefined
    const error = new Error('rea mcp connection closed')
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }

  /** Parse newline-delimited JSON-RPC frames out of one stdout chunk. */
  #ingest(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.#log(`rea mcp: unparseable stdout frame ignored (${line.length} bytes)`)
        continue
      }
      if (message.id === undefined || message.id === null) continue
      const entry = this.#pending.get(message.id)
      if (entry === undefined) continue
      this.#pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) {
        entry.reject(new Error(
          `${entry.method}: ${message.error.message ?? 'MCP error'}${message.error.code === undefined ? '' : ` (code ${message.error.code})`}`,
        ))
      } else {
        entry.resolve(message.result)
      }
    }
    if (this.#buffer.length > 8_000_000) this.#buffer = ''
  }

  /**
   * Send one request and await its result.
   * @param method - MCP method name.
   * @param params - Method parameters.
   * @param options - Optional timeout and cancellation.
   * @returns The JSON-RPC `result`.
   */
  async request(method, params, options = {}) {
    const child = this.#child
    if (child === undefined) throw new Error(`rea mcp is not running (${method})`)
    const id = this.#nextId++
    const timeoutMs = options.timeoutMs ?? this.#config.initializeTimeoutMs
    const signal = options.signal

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()

      const onAbort = () => {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error(`${method} aborted`))
      }
      if (signal !== undefined) {
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#pending.set(id, {
        method,
        timer,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error === undefined || error === null) return
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`${method} could not be written to rea mcp: ${error.message}`))
      })
    })
  }

  /** Send one notification (no reply is awaited). */
  notify(method, params) {
    this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /**
   * Fetch the server's tool catalog.
   * @param options - Cancellation.
   * @returns Array of MCP tool definitions.
   */
  async listTools(options = {}) {
    await this.ensure()
    const result = await this.request('tools/list', {}, {
      timeoutMs: this.#config.listTimeoutMs,
      signal: options.signal,
    })
    return result?.tools ?? []
  }

  /**
   * Invoke one upstream tool.
   * @param name - Raw MCP tool name.
   * @param args - Tool arguments.
   * @param options - Cancellation.
   * @returns The MCP `tools/call` result.
   */
  async callTool(name, args, options = {}) {
    await this.ensure()
    return await this.request('tools/call', { name, arguments: args }, {
      timeoutMs: this.#config.callTimeoutMs,
      signal: options.signal,
    })
  }

  /** Captured stderr tail, for diagnostics. */
  get stderrTail() {
    return this.#stderr
  }

  /** Terminate the child and fail everything in flight. */
  dispose() {
    this.#disposed = true
    const child = this.#child
    if (child === undefined) return
    this.#teardown(child)
    child.stdin.end()
    child.kill('SIGTERM')
    const escalate = setTimeout(() => { child.kill('SIGKILL') }, 2_000)
    escalate.unref?.()
  }
}
