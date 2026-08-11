// Binds the session multiplexer to the real OpenCode session primitives.
//
// The SDK v2 session client already knows how to create a session at a
// location with a chosen agent/model and how to interrupt a running one. This
// adapter maps the multiplexer's SessionDriver contract onto those calls so the
// core reuses existing primitives rather than reimplementing session lifecycle.

import type { SessionDriver, SpawnInput } from "./session-manager"

// The minimal slice of the SDK v2 session client this adapter needs. The full
// `OpencodeClient["session"]` from "@opencode-ai/sdk/v2/client" satisfies it;
// narrowing here keeps the core decoupled from generated response unions.
export interface SessionClient {
  create(parameters?: {
    agent?: string
    model?: { id: string; providerID: string; variant?: string }
    location?: { directory?: string }
  }): Promise<{ data?: { id: string; title?: string; agent?: string; directory?: string }; error?: unknown }>
  interrupt(parameters: { sessionID: string }): Promise<{ error?: unknown }>
}

// close() maps to interrupt(): it detaches and stops active execution for the
// session, which is the lifecycle primitive the v2 client exposes. Durable
// archival/deletion is intentionally left to the follow-up UI/CLI work — the
// multiplexer core only guarantees the session stops being tracked and driven.
export function createClientSessionDriver(client: SessionClient): SessionDriver {
  return {
    async create(input: SpawnInput) {
      const result = await client.create({
        agent: input.agent,
        model: input.model,
        location: input.directory ? { directory: input.directory } : undefined,
      })
      if (!result.data?.id) throw new Error("session-manager: session create returned no session id")
      return {
        id: result.data.id,
        title: result.data.title,
        agent: result.data.agent,
        directory: result.data.directory,
      }
    },
    async close(id: string) {
      const result = await client.interrupt({ sessionID: id })
      if (result.error) throw new Error(`session-manager: failed to close session ${id}`)
    },
  }
}
