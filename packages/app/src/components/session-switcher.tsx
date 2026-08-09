// Visible session switcher for the multiplexer.
//
// Renders a compact strip of the concurrent agent sessions the multiplexer is
// tracking — each showing its title, agent/directory, and live running/idle
// status, with the focused session highlighted. It also registers the switcher
// commands (spawn / next / prev / jump-to-index / close) with keybindings,
// following the app's existing command-registration conventions.
//
// The strip renders nothing while fewer than two sessions exist, so the ordinary
// single-session experience is untouched — no extra chrome, no regression.

import { createMemo, For, Show } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSessionMultiplexer } from "@/context/session-multiplexer"
import {
  buildSwitcherEntries,
  runStateLabelKey,
  shouldRenderSwitcher,
  type SessionRunState,
} from "@/context/session-multiplexer-nav"
import { showToast } from "@/utils/toast"

// Dedicated chords so the switcher coexists with the existing tab shortcuts
// (ctrl+tab, mod+option+arrows, mod+1..9, mod+w) rather than shadowing them.
export const SESSION_SWITCHER_KEYBINDS = {
  new: "mod+shift+m",
  next: "mod+shift+bracketright",
  prev: "mod+shift+bracketleft",
  close: "mod+shift+w",
  jump: (position: number) => `mod+alt+${position}`,
} as const

export function SessionSwitcher(props: { status?: (id: string) => SessionRunState }) {
  const mux = useSessionMultiplexer()
  const command = useCommand()
  const language = useLanguage()

  const statusOf = (id: string): SessionRunState => props.status?.(id) ?? "idle"

  const reportError = (err: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : undefined,
    })

  const run = (fn: () => unknown) => {
    try {
      const result = fn()
      if (result instanceof Promise) result.catch(reportError)
    } catch (err) {
      reportError(err)
    }
  }

  command.register("session-multiplexer", () => {
    const category = language.t("command.category.session")
    const commands: CommandOption[] = [
      {
        id: "session.multiplexer.new",
        title: language.t("command.session.multiplexer.new"),
        category,
        keybind: SESSION_SWITCHER_KEYBINDS.new,
        onSelect: () => run(() => mux.spawn()),
      },
      {
        id: "session.multiplexer.next",
        title: language.t("command.session.multiplexer.next"),
        category,
        keybind: SESSION_SWITCHER_KEYBINDS.next,
        onSelect: () => run(() => mux.focusNext()),
      },
      {
        id: "session.multiplexer.prev",
        title: language.t("command.session.multiplexer.prev"),
        category,
        keybind: SESSION_SWITCHER_KEYBINDS.prev,
        onSelect: () => run(() => mux.focusPrev()),
      },
      {
        id: "session.multiplexer.close",
        title: language.t("command.session.multiplexer.close"),
        category,
        keybind: SESSION_SWITCHER_KEYBINDS.close,
        onSelect: () => run(() => mux.closeFocused()),
      },
    ]
    for (let position = 1; position <= 9; position++) {
      commands.push({
        id: `session.multiplexer.jump.${position}`,
        title: "",
        category: "session",
        keybind: SESSION_SWITCHER_KEYBINDS.jump(position),
        hidden: true,
        onSelect: () => run(() => mux.focusIndex(position)),
      })
    }
    return commands
  })

  const entries = createMemo(() =>
    buildSwitcherEntries({
      sessions: mux.state.sessions,
      focusedID: mux.state.focusedID,
      untitled: language.t("session.multiplexer.untitled"),
      statusOf,
    }),
  )

  return (
    <Show when={shouldRenderSwitcher(mux.state.sessions.length)}>
      <div
        data-slot="session-switcher"
        role="tablist"
        aria-label={language.t("session.multiplexer.title")}
        class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
      >
        <For each={entries()}>
          {(entry) => (
            <div
              data-slot="session-switcher-item"
              data-focused={entry.focused}
              role="tab"
              aria-selected={entry.focused}
              tabindex={0}
              class="group flex min-w-0 max-w-56 flex-shrink cursor-pointer flex-row items-center gap-2 rounded-md border border-transparent px-2 py-1 text-sm text-v2-text-text-muted hover:bg-v2-background-bg-subtle data-[focused=true]:border-v2-border-border-default data-[focused=true]:bg-v2-background-bg-subtle data-[focused=true]:text-v2-text-text-default"
              onClick={() => run(() => mux.focus(entry.id))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  run(() => mux.focus(entry.id))
                }
              }}
            >
              <span
                data-slot="session-switcher-status"
                data-status={entry.status}
                aria-label={language.t(runStateLabelKey(entry.status))}
                class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-muted data-[status=running]:bg-v2-icon-icon-accent"
              />
              <span class="min-w-0 flex-1 truncate">{entry.title}</span>
              <Show when={entry.agent}>
                {(agent) => <span class="shrink-0 text-xs text-v2-text-text-muted">{agent()}</span>}
              </Show>
              <button
                type="button"
                data-slot="session-switcher-close"
                class="shrink-0 rounded p-0.5 text-v2-icon-icon-muted opacity-0 hover:bg-v2-background-bg-element hover:text-v2-icon-icon-default focus:opacity-100 group-hover:opacity-100"
                aria-label={language.t("session.multiplexer.close.aria", { title: entry.title })}
                onClick={(event) => {
                  event.stopPropagation()
                  run(() => mux.close(entry.id))
                }}
              >
                <IconV2 name="xmark-small" />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
