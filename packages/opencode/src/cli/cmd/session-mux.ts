// CLI surface for the session multiplexer.
//
// Exposes the non-UI multiplexer core (packages/app session-manager +
// SessionDriver) as headless, scriptable subcommands: spawn a session, list
// active sessions, switch focus, and close a session. All session lifecycle is
// delegated to the shared primitives — `createClientSessionDriver` for
// create/close and `nextFocusAfterClose` for focus fallback — so nothing here
// re-implements session lifecycle.
//
// A one-shot CLI process cannot hold the core manager's in-memory registry
// across invocations, so that registry (the tracked session ids plus the
// focused one) is persisted per server URL under the opencode state dir.
// Session metadata (title/agent) is never persisted — `list` always reads it
// live from the running server and shows only the tracked sessions that still
// exist there.

import type { Argv } from "yargs"
import { Effect } from "effect"
import path from "path"
import { promises as fs } from "fs"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import {
  createSessionManager,
  nextFocusAfterClose,
  type SessionDriver,
  type SessionModelRef,
  type SessionSummary,
  type SpawnInput,
} from "@opencode-ai/app/context/session-manager"
import { createClientSessionDriver, type SessionClient } from "@opencode-ai/app/context/session-manager-driver"
import { Global } from "@opencode-ai/core/global"
import { ServerAuth } from "@/server/auth"
import { cmd } from "./cmd"
import { effectCmd, CliError } from "../effect-cmd"
import { UI } from "../ui"

type OpencodeClient = ReturnType<typeof createOpencodeClient>

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4096"

// A live session as reported by the server, narrowed to the fields the
// multiplexer surface needs.
export type ActiveSession = {
  id: string
  title: string
  agent?: string
  directory?: string
  createdAt: number
}

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionID: string) {
    super(`No active session with id ${sessionID}`)
    this.name = "SessionNotFoundError"
  }
}

// Precedence: explicit --url, then $OPENCODE_SERVER, then a conventional local
// default. Trailing slashes are stripped so the persisted focus key is stable.
export function resolveServerURL(explicit?: string, env: Record<string, string | undefined> = process.env): string {
  const raw = explicit ?? env.OPENCODE_SERVER ?? DEFAULT_SERVER_URL
  return raw.replace(/\/+$/, "")
}

// Parse a `providerID/modelID` reference. Throws on a malformed value so the
// command fails before touching the network.
export function parseModelRef(value?: string): SessionModelRef | undefined {
  if (value === undefined) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1)
    throw new Error(`Invalid --model "${value}": expected format "providerID/modelID"`)
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

const CONNECTION_ERROR =
  /fetch failed|failed to fetch|unable to connect|network error|connection refused|connection reset|socket|econnrefused|econnreset|enotfound|etimedout|ehostunreach|eai_again/i

export function isConnectionError(error: unknown): boolean {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ""
  const message = error instanceof Error ? `${error.message} ${cause}` : String(error)
  return CONNECTION_ERROR.test(message)
}

export function noServerMessage(url: string): string {
  return (
    `Could not reach an opencode server at ${url}. ` +
    "Start one with `opencode serve` (optionally --port), then pass --url <url> or set OPENCODE_SERVER."
  )
}

// Map any thrown error onto the user-facing CLI message: connection failures
// get the "no server" guidance; everything else surfaces its own message.
export function toCliMessage(error: unknown, url: string): string {
  if (error instanceof SessionNotFoundError) return error.message
  if (isConnectionError(error)) return noServerMessage(url)
  return error instanceof Error ? error.message : String(error)
}

function sessionErrorMessage(action: string, error: unknown): string {
  if (error && typeof error === "object") {
    const obj = error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
    const message =
      (typeof obj.data?.message === "string" && obj.data.message) ||
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.name === "string" && obj.name) ||
      ""
    if (message) return `Failed to ${action} session: ${message}`
  }
  return `Failed to ${action} session`
}

// The persisted multiplexer registry: the ordered set of session ids this CLI
// is managing plus the focused one, keyed by server URL so multiple running
// instances keep independent state. A one-shot CLI process cannot hold the
// core manager's in-memory registry across invocations, so this file is that
// registry made durable — the minimal state (identity + focus) needed for the
// discrete commands to behave like the in-process manager. Session metadata
// (title/agent) is never stored here; it is always read live from the server.
export type MuxServerState = { sessions: string[]; focusedID?: string }
export type MuxState = { servers: Record<string, MuxServerState> }

export function muxStatePath(): string {
  return path.join(Global.Path.state, "session-mux.json")
}

export async function readMuxState(file: string): Promise<MuxState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown
    if (parsed && typeof parsed === "object" && typeof (parsed as MuxState).servers === "object")
      return parsed as MuxState
  } catch {
    // Missing or malformed state resets to empty — a corrupt registry must
    // never wedge the commands.
  }
  return { servers: {} }
}

export async function readServerState(file: string, url: string): Promise<MuxServerState> {
  const state = await readMuxState(file)
  const server = state.servers[url]
  return { sessions: server?.sessions ?? [], focusedID: server?.focusedID }
}

export async function writeServerState(file: string, url: string, server: MuxServerState): Promise<void> {
  const state = await readMuxState(file)
  if (server.sessions.length === 0) delete state.servers[url]
  else state.servers[url] = server
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(state, null, 2))
}

// Adapt the generated SDK v2 session client onto the narrow SessionClient the
// multiplexer's driver consumes. This is the single seam between the CLI and
// the running server; the driver itself is reused unchanged.
export function toSessionClient(client: OpencodeClient, directory?: string): SessionClient {
  return {
    async create(parameters) {
      const result = await client.session.create({
        agent: parameters?.agent,
        model: parameters?.model,
        directory: parameters?.location?.directory ?? directory,
      })
      if (result.error) throw new Error(sessionErrorMessage("create", result.error))
      return {
        data: result.data && {
          id: result.data.id,
          title: result.data.title,
          agent: result.data.agent,
          directory: result.data.directory,
        },
        error: result.error,
      }
    },
    async interrupt(parameters) {
      const result = await client.session.abort({ sessionID: parameters.sessionID, directory })
      return { error: result.error }
    },
  }
}

export async function listActiveSessions(client: OpencodeClient, directory?: string): Promise<ActiveSession[]> {
  const result = await client.session.list({ directory, roots: true })
  if (result.error) throw new Error(sessionErrorMessage("list", result.error))
  return (result.data ?? []).map((session) => ({
    id: session.id,
    title: session.title,
    agent: session.agent,
    directory: session.directory,
    createdAt: session.time.created,
  }))
}

// Resolve the tracked-registry ids against the sessions the server currently
// reports, preserving spawn order and dropping any that no longer exist.
export function selectTracked(serverSessions: ActiveSession[], trackedIDs: string[]): ActiveSession[] {
  const byID = new Map(serverSessions.map((session) => [session.id, session]))
  return trackedIDs.map((id) => byID.get(id)).filter((session): session is ActiveSession => session !== undefined)
}

// Provision a session via the shared manager/driver, then record it in the
// durable registry (and focus it unless spawned in the background).
export async function runSpawn(input: {
  driver: SessionDriver
  spawn: SpawnInput
  focusFile: string
  url: string
}): Promise<SessionSummary> {
  const manager = createSessionManager(input.driver)
  const summary = await manager.spawn(input.spawn)
  const state = await readServerState(input.focusFile, input.url)
  if (!state.sessions.includes(summary.id)) state.sessions.push(summary.id)
  if (input.spawn.focus !== false) state.focusedID = summary.id
  await writeServerState(input.focusFile, input.url, state)
  return summary
}

export async function runSwitch(input: { id: string; focusFile: string; url: string }): Promise<void> {
  const state = await readServerState(input.focusFile, input.url)
  if (!state.sessions.includes(input.id)) throw new SessionNotFoundError(input.id)
  state.focusedID = input.id
  await writeServerState(input.focusFile, input.url, state)
}

// Tear the session down via the shared driver, drop it from the registry, and
// move focus to a survivor (via the core's nextFocusAfterClose) when the closed
// session held focus.
export async function runClose(input: {
  driver: SessionDriver
  id: string
  focusFile: string
  url: string
}): Promise<string | undefined> {
  const state = await readServerState(input.focusFile, input.url)
  if (!state.sessions.includes(input.id)) throw new SessionNotFoundError(input.id)
  await input.driver.close(input.id)
  const survivors: SessionSummary[] = state.sessions.map((id, index) => ({ id, spawnedAt: index }))
  const next = nextFocusAfterClose(survivors, input.id, state.focusedID)
  state.sessions = state.sessions.filter((id) => id !== input.id)
  state.focusedID = next
  await writeServerState(input.focusFile, input.url, state)
  return next
}

export function formatSessionsJSON(sessions: ActiveSession[], focusedID?: string): string {
  return JSON.stringify(
    sessions.map((session) => ({
      id: session.id,
      title: session.title,
      agent: session.agent ?? null,
      directory: session.directory ?? null,
      focused: session.id === focusedID,
    })),
    null,
    2,
  )
}

export function formatSessionsTable(sessions: ActiveSession[], focusedID?: string): string {
  const idWidth = Math.max(2, ...sessions.map((session) => session.id.length))
  const agentWidth = Math.max(5, ...sessions.map((session) => (session.agent ?? "").length))
  const header = `${" ".padEnd(1)}  ${"ID".padEnd(idWidth)}  ${"AGENT".padEnd(agentWidth)}  TITLE`
  const lines = [header, "─".repeat(header.length)]
  for (const session of sessions) {
    const marker = session.id === focusedID ? "*" : " "
    lines.push(
      `${marker}  ${session.id.padEnd(idWidth)}  ${(session.agent ?? "").padEnd(agentWidth)}  ${session.title}`,
    )
  }
  return lines.join("\n")
}

type ServerArgs = {
  url?: string
  directory?: string
  password?: string
  username?: string
}

function withServerOptions<T>(yargs: Argv<T>) {
  return yargs
    .option("url", {
      alias: "u",
      type: "string",
      describe: `URL of a running opencode server (default: $OPENCODE_SERVER or ${DEFAULT_SERVER_URL})`,
    })
    .option("directory", {
      type: "string",
      describe: "project directory on the server",
    })
    .option("password", {
      alias: "p",
      type: "string",
      describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
    })
    .option("username", {
      type: "string",
      describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
    })
}

function makeClient(args: ServerArgs, url: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl: url,
    directory: args.directory,
    headers: ServerAuth.headers({ password: args.password, username: args.username }),
  })
}

export const SessionMuxSpawnCommand = effectCmd({
  command: "spawn",
  describe: "spawn a new agent session on a running server",
  instance: false,
  builder: (yargs) =>
    withServerOptions(yargs)
      .option("agent", { type: "string", describe: "agent to run in the session" })
      .option("model", { type: "string", describe: "model as providerID/modelID" })
      .option("focus", {
        type: "boolean",
        default: true,
        describe: "switch focus to the new session (use --no-focus to spawn in the background)",
      })
      .option("format", { type: "string", choices: ["text", "json"], default: "text" }),
  handler: Effect.fn("Cli.session.mux.spawn")(function* (args) {
    const url = resolveServerURL(args.url)
    const model = yield* Effect.try({
      try: () => parseModelRef(args.model),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    const summary = yield* Effect.tryPromise({
      try: () => {
        const driver = createClientSessionDriver(toSessionClient(makeClient(args, url), args.directory))
        return runSpawn({
          driver,
          spawn: { agent: args.agent, model, directory: args.directory, focus: args.focus },
          focusFile: muxStatePath(),
          url,
        })
      },
      catch: (error) => new CliError({ message: toCliMessage(error, url) }),
    })
    if (args.format === "json") {
      console.log(
        JSON.stringify(
          {
            id: summary.id,
            title: summary.title ?? null,
            agent: summary.agent ?? null,
            directory: summary.directory ?? null,
            focused: args.focus,
          },
          null,
          2,
        ),
      )
      return
    }
    const suffix = summary.agent ? UI.Style.TEXT_DIM + ` (${summary.agent})` + UI.Style.TEXT_NORMAL : ""
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Spawned session ${summary.id}` + UI.Style.TEXT_NORMAL + suffix)
    if (!args.focus)
      UI.println(UI.Style.TEXT_DIM + "(not focused; use `session mux switch` to focus it)" + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionMuxListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list active multiplexed sessions on a running server",
  instance: false,
  builder: (yargs) =>
    withServerOptions(yargs).option("format", { type: "string", choices: ["table", "json"], default: "table" }),
  handler: Effect.fn("Cli.session.mux.list")(function* (args) {
    const url = resolveServerURL(args.url)
    const { sessions, focusedID } = yield* Effect.tryPromise({
      try: async () => {
        const client = makeClient(args, url)
        const state = await readServerState(muxStatePath(), url)
        const sessions = selectTracked(await listActiveSessions(client, args.directory), state.sessions)
        return { sessions, focusedID: state.focusedID }
      },
      catch: (error) => new CliError({ message: toCliMessage(error, url) }),
    })
    if (args.format === "json") {
      console.log(formatSessionsJSON(sessions, focusedID))
      return
    }
    if (sessions.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No active sessions" + UI.Style.TEXT_NORMAL)
      return
    }
    console.log(formatSessionsTable(sessions, focusedID))
  }),
})

export const SessionMuxSwitchCommand = effectCmd({
  command: "switch <sessionID>",
  describe: "switch focus to a multiplexed session by id",
  instance: false,
  builder: (yargs) =>
    withServerOptions(
      yargs.positional("sessionID", { describe: "session id to focus", type: "string", demandOption: true }),
    ),
  handler: Effect.fn("Cli.session.mux.switch")(function* (args) {
    const url = resolveServerURL(args.url)
    yield* Effect.tryPromise({
      try: () => runSwitch({ id: args.sessionID, focusFile: muxStatePath(), url }),
      catch: (error) => new CliError({ message: toCliMessage(error, url) }),
    })
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Focus switched to ${args.sessionID}` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionMuxCloseCommand = effectCmd({
  command: "close <sessionID>",
  describe: "close a multiplexed session by id",
  instance: false,
  builder: (yargs) =>
    withServerOptions(
      yargs.positional("sessionID", { describe: "session id to close", type: "string", demandOption: true }),
    ),
  handler: Effect.fn("Cli.session.mux.close")(function* (args) {
    const url = resolveServerURL(args.url)
    const next = yield* Effect.tryPromise({
      try: () => {
        const driver = createClientSessionDriver(toSessionClient(makeClient(args, url), args.directory))
        return runClose({ driver, id: args.sessionID, focusFile: muxStatePath(), url })
      },
      catch: (error) => new CliError({ message: toCliMessage(error, url) }),
    })
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Closed session ${args.sessionID}` + UI.Style.TEXT_NORMAL)
    if (next) UI.println(UI.Style.TEXT_DIM + `Focus moved to ${next}` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionMuxCommand = cmd({
  command: "mux",
  describe: "multiplex concurrent agent sessions on a running server",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionMuxSpawnCommand)
      .command(SessionMuxListCommand)
      .command(SessionMuxSwitchCommand)
      .command(SessionMuxCloseCommand)
      .demandCommand(),
  async handler() {},
})
