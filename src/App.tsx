import { TextAttributes, type KeyEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions, useTimeline } from "@opentui/solid"
import { Effect, Fiber, type Fiber as EffectFiber } from "effect"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { LETTERS, makeBlock, nextN, scoreBlock, type Block, type BlockScore, type Letter, type Response } from "./domain.js"
import { AppRuntime } from "./runtime.js"
import { Storage } from "./services/storage.js"

const colors = {
  background: "#1a1b26",
  panel: "#24283b",
  panelBright: "#292e42",
  text: "#c0caf5",
  muted: "#a9b1d6",
  faint: "#565f89",
  accent: "#9ece6a",
  accentDark: "#283b36",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  coral: "#f7768e",
  grid: "#24283b",
  gridActive: "#7aa2f7",
}

type Screen = "loading" | "home" | "tutorial" | "playing" | "summary" | "history" | "controls" | "goal" | "error"
type ControlName = keyof Storage.Controls

interface PlayingState {
  readonly block: Block
  readonly blockNumber: number
  readonly trialIndex: number
  readonly positionVisible: boolean
  readonly responses: ReadonlyArray<Response>
}

interface SummaryState {
  readonly n: number
  readonly score: BlockScore
  readonly recommendedN: number
  readonly blockNumber: number
}

const percent = (value: number): string => `${Math.round(value * 100)}%`
const accuracyColor = (value: number): string => value >= 0.8 ? colors.accent : value < 0.65 ? colors.coral : colors.blue

const mixColor = (from: string, to: string, amount: number): string => {
  const start = parseInt(from.slice(1), 16)
  const end = parseInt(to.slice(1), 16)
  const channel = (shift: number) => {
    const a = (start >> shift) & 255
    const b = (end >> shift) & 255
    return Math.round(a + (b - a) * amount)
  }
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, "0")}`
}
const dPrime = (value: number): string => value.toFixed(2)
const controlLabel = (value: string): string => value.length === 1 ? value.toUpperCase() : value
const clampN = (value: number): number => Math.max(1, Math.min(10, value))
const clampDailyGoal = (value: number): number => Math.max(1, Math.min(30, value))

const blocksToday = (blocks: ReadonlyArray<Storage.BlockRecord>): number => {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return blocks.filter((block) => block.timestamp >= start.getTime() && block.timestamp < end.getTime()).length
}

const formatDate = (timestamp: number): string => {
  const date = new Date(timestamp)
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })}`
}

const actionKey = (key: KeyEvent): string => key.name.toLowerCase()

export function App() {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [screen, setScreen] = createSignal<Screen>("loading")
  const [data, setData] = createSignal<Storage.AppData>({
    version: 1,
    controls: { position: "a", sound: "s" },
    blocks: [],
    dailyGoal: Storage.defaultDailyGoal,
  })
  const [n, setN] = createSignal(2)
  const [playing, setPlaying] = createSignal<PlayingState | null>(null)
  const [summary, setSummary] = createSignal<SummaryState | null>(null)
  const [status, setStatus] = createSignal("")
  const [selectedControl, setSelectedControl] = createSignal<ControlName>("position")
  const [listeningFor, setListeningFor] = createSignal<ControlName | null>(null)
  const [sampleIndex, setSampleIndex] = createSignal(0)
  const [goalDraft, setGoalDraft] = createSignal(Storage.defaultDailyGoal)
  let blockFiber: EffectFiber.Fiber<void, unknown> | null = null

  const blocks = createMemo(() => data().blocks)
  const lastBlock = createMemo(() => blocks().at(-1))

  const refreshData = () => {
    AppRuntime.runtime.runPromise(AppRuntime.loadData).then(
      (loaded) => {
        setData(loaded)
        const last = loaded.blocks.at(-1)
        setN(last ? nextN(last.n, last) : 2)
        setScreen(loaded.tutorialCompletedAt === undefined && loaded.blocks.length === 0 ? "tutorial" : "home")
      },
      (error) => {
        setStatus(String(error))
        setScreen("error")
      },
    )
  }

  onMount(refreshData)

  onCleanup(() => {
    if (blockFiber) AppRuntime.runtime.runFork(Fiber.interrupt(blockFiber))
    void AppRuntime.runtime.dispose()
  })

  const finishBlock = () =>
    Effect.gen(function* () {
      const state = playing()
      if (!state) return
      const score = scoreBlock(state.block, state.responses)
      const recommendedN = nextN(state.block.n, score)
      yield* AppRuntime.recordBlock(state.block.n, score).pipe(
        Effect.catch((error) => Effect.sync(() => setStatus(`Block completed, but history could not be saved: ${String(error)}`))),
      )
      setSummary({ n: state.block.n, score, recommendedN, blockNumber: state.blockNumber })
      setN(recommendedN)
      setPlaying(null)
      setScreen("summary")
      blockFiber = null
      refreshDataAfterSave()
    })

  const refreshDataAfterSave = () => {
    AppRuntime.runtime.runPromise(AppRuntime.loadData).then(setData, () => undefined)
  }

  const startBlock = () => {
    const block = makeBlock(n())
    const blockNumber = blocks().length + 1
    setStatus("")
    setSummary(null)
    setPlaying({
      block,
      blockNumber,
      trialIndex: 0,
      positionVisible: false,
      responses: block.trials.map(() => ({ sound: false, position: false })),
    })
    setScreen("playing")

    blockFiber = AppRuntime.runtime.runFork(
      AppRuntime.runBlock(block, {
        showTrial: (trialIndex) => setPlaying((state) => state && { ...state, trialIndex, positionVisible: true }),
        hidePosition: () => setPlaying((state) => state && { ...state, positionVisible: false }),
      }).pipe(
        Effect.andThen(finishBlock()),
        Effect.catch((error) =>
          Effect.sync(() => {
            setPlaying(null)
            setStatus(`Block stopped: ${String(error)}`)
            setScreen("home")
            blockFiber = null
          }),
        ),
      ),
    )
  }

  const stopBlock = () => {
    const fiber = blockFiber
    blockFiber = null
    setPlaying(null)
    setStatus("Partial block discarded. Difficulty was not changed.")
    setScreen("home")
    if (fiber) AppRuntime.runtime.runFork(Fiber.interrupt(fiber))
  }

  const registerResponse = (modality: ControlName) => {
    setPlaying((state) => {
      if (!state) return state
      const current = state.responses[state.trialIndex]!
      if (current[modality]) return state
      const responses = [...state.responses]
      responses[state.trialIndex] = { ...current, [modality]: true }
      return { ...state, responses }
    })
  }

  const finishTutorial = () => {
    setStatus("")
    setScreen("home")
    if (data().tutorialCompletedAt !== undefined) return
    setData((current) => ({ ...current, tutorialCompletedAt: Date.now() }))
    AppRuntime.runtime.runFork(AppRuntime.markTutorialComplete.pipe(Effect.ignore))
  }

  const playSample = () => {
    const letter = LETTERS[sampleIndex() % LETTERS.length]!
    setSampleIndex((value) => value + 1)
    setStatus(`Audio sample: ${letter}`)
    AppRuntime.runtime.runFork(
      AppRuntime.playLetter(letter).pipe(
        Effect.catch((error) => Effect.sync(() => setStatus(`Audio unavailable: ${String(error)}`))),
      ),
    )
  }

  const saveControl = (control: ControlName, key: string) => {
    const other: ControlName = control === "position" ? "sound" : "position"
    if (key === data().controls[other]) {
      setStatus(`${controlLabel(key)} is already assigned to ${other}`)
      return
    }
    const controls = { ...data().controls, [control]: key }
    setData((current) => ({ ...current, controls }))
    setListeningFor(null)
    setStatus(`${control} match is now ${controlLabel(key)}`)
    AppRuntime.runtime.runFork(
      AppRuntime.saveControls(controls).pipe(
        Effect.catch((error) => Effect.sync(() => setStatus(`Controls could not be saved: ${String(error)}`))),
      ),
    )
  }

  const openGoal = () => {
    setGoalDraft(data().dailyGoal)
    setStatus("")
    setScreen("goal")
  }

  const saveDailyGoal = () => {
    const dailyGoal = goalDraft()
    setData((current) => ({ ...current, dailyGoal }))
    setStatus("")
    setScreen("home")
    AppRuntime.runtime.runFork(
      AppRuntime.saveDailyGoal(dailyGoal).pipe(
        Effect.catch((error) => Effect.sync(() => setStatus(`Daily goal could not be saved: ${String(error)}`))),
      ),
    )
  }

  useKeyboard((key) => {
    if (key.eventType === "release" || key.repeated) return
    const name = actionKey(key)
    const activeScreen = screen()

    if (activeScreen === "playing") {
      if (name === "escape") stopBlock()
      else if (name === data().controls.position) registerResponse("position")
      else if (name === data().controls.sound) registerResponse("sound")
      return
    }

    if (activeScreen === "controls") {
      const listening = listeningFor()
      if (listening) {
        if (name === "escape") setListeningFor(null)
        else saveControl(listening, name)
        return
      }
      if (name === "escape" || name === "q") {
        setStatus("")
        setScreen("home")
      }
      else if (name === "up" || name === "down") {
        setSelectedControl((value) => value === "position" ? "sound" : "position")
      } else if (name === "return" || name === "enter") {
        setListeningFor(selectedControl())
      }
      return
    }

    if (activeScreen === "history") {
      if (name === "escape" || name === "q" || name === "h") setScreen("home")
      return
    }

    if (activeScreen === "goal") {
      if (name === "escape" || name === "g") setScreen("home")
      else if (name === "up" || name === "right") setGoalDraft((value) => clampDailyGoal(value + 1))
      else if (name === "down" || name === "left") setGoalDraft((value) => clampDailyGoal(value - 1))
      else if (name === "return" || name === "enter") saveDailyGoal()
      return
    }

    if (activeScreen === "home") {
      if (name === "return" || name === "enter") startBlock()
      else if (name === "up") setN((value) => clampN(value + 1))
      else if (name === "down") setN((value) => clampN(value - 1))
      else if (name === "t") setScreen("tutorial")
      else if (name === "h") setScreen("history")
      else if (name === "c") setScreen("controls")
      else if (name === "g") openGoal()
      else if (name === "v") playSample()
      else if (name === "q") void renderer.destroy()
      return
    }

    if (activeScreen === "summary") {
      if (name === "return" || name === "enter") startBlock()
      else if (name === "up") setN((value) => clampN(value + 1))
      else if (name === "down") setN((value) => clampN(value - 1))
      else if (name === "h") setScreen("history")
      else if (name === "q" || name === "escape") setScreen("home")
      return
    }

    if (activeScreen === "error" && name === "q") void renderer.destroy()
  })

  const currentTrial = createMemo(() => {
    const state = playing()
    return state?.block.trials[state.trialIndex]
  })

  const currentResponse = createMemo(() => {
    const state = playing()
    return state?.responses[state.trialIndex]
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={colors.background}>
      <Show when={screen() === "loading"}>
        <box width="100%" height="100%" justifyContent="center" alignItems="center">
          <text fg={colors.faint}>loading…</text>
        </box>
      </Show>

      <Show when={screen() === "error"}>
        <box width="100%" height="100%" justifyContent="center" alignItems="center">
          <box width={Math.min(70, dimensions().width - 4)} flexDirection="column" gap={1}>
            <text fg={colors.coral} attributes={TextAttributes.BOLD}>NBACK COULD NOT START</text>
            <text fg={colors.text} wrapMode="word">{status()}</text>
            <CommandBar align="flex-start" commands={[{ key: "q", label: "quit" }]} />
          </box>
        </box>
      </Show>

      <Show when={screen() === "home"}>
        <Home
          n={n()}
          blocks={blocks()}
          lastBlock={lastBlock()}
          controls={data().controls}
          dailyGoal={data().dailyGoal}
          status={status()}
        />
      </Show>

      <Show when={screen() === "tutorial"}>
        <Tutorial controls={data().controls} onExit={finishTutorial} />
      </Show>

      <Show when={screen() === "playing" && playing()}>
        <Playing state={playing()!} trial={currentTrial()!} response={currentResponse()!} controls={data().controls} />
      </Show>

      <Show when={screen() === "summary" && summary()}>
        <Summary summary={summary()!} nextLevel={n()} status={status()} />
      </Show>

      <Show when={screen() === "history"}>
        <History blocks={blocks()} />
      </Show>

      <Show when={screen() === "controls"}>
        <Controls
          controls={data().controls}
          selected={selectedControl()}
          listening={listeningFor()}
          status={status()}
        />
      </Show>

      <Show when={screen() === "goal"}>
        <Goal dailyGoal={goalDraft()} completed={blocksToday(blocks())} />
      </Show>
    </box>
  )
}

function Header(props: { readonly right?: string }) {
  return (
    <box height={2} flexShrink={0} paddingLeft={3} paddingRight={3} paddingTop={1} flexDirection="row">
      <text fg={colors.accent} attributes={TextAttributes.BOLD} flexShrink={0}>NBACK</text>
      <box flexGrow={1} />
      <Show when={props.right !== undefined}><text fg={colors.faint} flexShrink={0}>{props.right}</text></Show>
    </box>
  )
}

function Keycap(props: { readonly keyName: string; readonly label: string }) {
  return (
    <box flexDirection="row">
      <box width={3} height={1} justifyContent="center" backgroundColor={colors.panelBright}>
        <text fg={colors.blue} attributes={TextAttributes.BOLD}>{controlLabel(props.keyName)}</text>
      </box>
      <text fg={colors.muted}> {props.label}</text>
    </box>
  )
}

function DailyGoalProgress(props: { readonly completed: number; readonly goal: number }) {
  const segments = 54
  const filled = () => Math.min(segments, Math.round((props.completed / props.goal) * segments))
  const complete = () => props.completed >= props.goal
  const remaining = () => Math.max(0, props.goal - props.completed)
  return (
    <box width={54} flexDirection="column">
      <box width="100%" flexDirection="row">
        <text fg={colors.faint} attributes={TextAttributes.BOLD}>TODAY</text>
        <box width={3} />
        <text fg={complete() ? colors.accent : colors.text} attributes={TextAttributes.BOLD}>
          {props.completed} / {props.goal} blocks
        </text>
        <box flexGrow={1} />
        <text fg={complete() ? colors.accent : colors.faint}>
          {complete() ? "complete" : `${remaining()} to go`}
        </text>
      </box>
      <box width="100%" marginTop={1} flexDirection="row">
        <text fg={complete() ? colors.accent : colors.blue}>{"━".repeat(filled())}</text>
        <text fg={colors.panelBright}>{"━".repeat(segments - filled())}</text>
      </box>
    </box>
  )
}

function HomeDetails(props: {
  readonly blocks: ReadonlyArray<Storage.BlockRecord>
  readonly lastBlock: Storage.BlockRecord | undefined
  readonly controls: Storage.Controls
  readonly dailyGoal: number
  readonly average: number
}) {
  return (
    <box width={58} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column" backgroundColor={colors.panel}>
      <DailyGoalProgress completed={blocksToday(props.blocks)} goal={props.dailyGoal} />
      <box marginTop={1} flexDirection="column">
        <Show
          when={props.lastBlock}
          fallback={
            <box flexDirection="row">
              <box width={9}><text fg={colors.faint}>LAST</text></box>
              <text fg={colors.muted}>no completed blocks</text>
            </box>
          }
        >
          {(last) => (
            <>
              <box flexDirection="row">
                <box width={9}><text fg={colors.faint}>LAST</text></box>
                <text fg={colors.blue} attributes={TextAttributes.BOLD}>{`${last().n}-back`.padEnd(12)}</text>
                <text fg={accuracyColor(last().accuracy)} attributes={TextAttributes.BOLD}>{percent(last().accuracy).padEnd(9)}</text>
                <text fg={colors.muted}>d' <span style={{ fg: colors.text }}>{dPrime((last().position.dPrime + last().sound.dPrime) / 2)}</span></text>
              </box>
              <box flexDirection="row">
                <box width={9}><text fg={colors.faint}>AVERAGE</text></box>
                <text fg={colors.text} attributes={TextAttributes.BOLD}>{percent(props.average)}</text>
                <text fg={colors.faint}> across {props.blocks.length} {props.blocks.length === 1 ? "block" : "blocks"}</text>
              </box>
            </>
          )}
        </Show>
        <box marginTop={1} flexDirection="row">
          <box width={9}><text fg={colors.faint}>KEYS</text></box>
          <Keycap keyName={props.controls.position} label="position" />
          <box width={3} />
          <Keycap keyName={props.controls.sound} label="sound" />
        </box>
      </box>
    </box>
  )
}

function Home(props: {
  readonly n: number
  readonly blocks: ReadonlyArray<Storage.BlockRecord>
  readonly lastBlock: Storage.BlockRecord | undefined
  readonly controls: Storage.Controls
  readonly dailyGoal: number
  readonly status: string
}) {
  const average = () => props.blocks.length === 0
    ? 0
    : props.blocks.reduce((total, block) => total + block.accuracy, 0) / props.blocks.length

  // Flash the hero brighter whenever the level changes, then ease back down.
  const [flash, setFlash] = createSignal(0)
  const timeline = useTimeline({ duration: 600, autoplay: false })
  let initialRender = true
  createEffect(() => {
    void props.n
    if (initialRender) {
      initialRender = false
      return
    }
    timeline.restart()
    timeline.once({ progress: 0 }, {
      progress: 1,
      duration: 600,
      ease: "linear",
      onUpdate: (animation) => {
        const progress = animation.targets[0].progress
        setFlash((1 + 7 * progress) * Math.exp(-7 * progress))
      },
      onComplete: () => setFlash(0),
    })
  })
  const heroColor = () => mixColor(colors.accent, "#eaffc9", flash())

  return (
    <>
      <Header right={`${props.blocks.length} ${props.blocks.length === 1 ? "block" : "blocks"}`} />
      <box width="100%" flexGrow={1} minHeight={0} justifyContent="center" alignItems="center">
        <box flexDirection="column" alignItems="center" gap={1}>
          <box flexDirection="row">
            <ascii_font
              text={`${props.n}`}
              font="block"
              color={[heroColor(), colors.background]}
              backgroundColor={colors.background}
            />
            <ascii_font
              text="-BACK"
              font="block"
              color={[colors.accent, colors.background]}
              backgroundColor={colors.background}
            />
          </box>
          <box marginTop={1}>
            <HomeDetails
              blocks={props.blocks}
              lastBlock={props.lastBlock}
              controls={props.controls}
              dailyGoal={props.dailyGoal}
              average={average()}
            />
          </box>
          <box marginTop={1} flexDirection="column" alignItems="center">
            <CommandBar
              commands={[
                { key: "enter", label: "start" },
                { key: "↑↓", label: "level" },
                { key: "t", label: "tutorial" },
              ]}
            />
            <CommandBar
              commands={[
                { key: "h", label: "history" },
                { key: "g", label: "goal" },
                { key: "c", label: "controls" },
                { key: "q", label: "quit" },
              ]}
            />
            <Show when={props.status.length > 0}>
              <text fg={colors.cyan}>{props.status}</text>
            </Show>
          </box>
        </box>
      </box>
    </>
  )
}

function Goal(props: { readonly dailyGoal: number; readonly completed: number }) {
  return (
    <>
      <Header right="daily goal" />
      <box width="100%" flexGrow={1} minHeight={0} justifyContent="center" alignItems="center">
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={colors.accent} attributes={TextAttributes.BOLD}>DAILY PRACTICE</text>
          <ascii_font
            text={`${props.dailyGoal}`}
            font="block"
            color={[colors.accent, colors.background]}
            backgroundColor={colors.background}
          />
          <text fg={colors.muted}>blocks per day</text>
          <box marginTop={1}><DailyGoalProgress completed={props.completed} goal={props.dailyGoal} /></box>
          <text fg={colors.faint}>A focused session is usually 8–12 blocks.</text>
          <box marginTop={1}>
            <CommandBar commands={[
              { key: "↑↓", label: "adjust" },
              { key: "enter", label: "save" },
              { key: "esc", label: "cancel" },
            ]} />
          </box>
        </box>
      </box>
    </>
  )
}

function Playing(props: {
  readonly state: PlayingState
  readonly trial: Block["trials"][number]
  readonly response: Response
  readonly controls: Storage.Controls
}) {
  return (
    <>
      <Header right={`block ${props.state.blockNumber} · ${props.state.block.n}-back · ${props.state.trialIndex + 1}/${props.state.block.trials.length}`} />
      <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <Grid active={props.state.positionVisible ? props.trial.position : null} />
        <box marginTop={1} gap={1} flexDirection="row">
          <ResponseBadge keyName={props.controls.position} label="position" active={props.response.position} />
          <ResponseBadge keyName={props.controls.sound} label="sound" active={props.response.sound} />
        </box>
        <box marginTop={1}>
          <text fg={colors.faint}>esc discard</text>
        </box>
      </box>
    </>
  )
}

function Grid(props: { readonly active: number | null; readonly letter?: string }) {
  const [highlightedPosition, setHighlightedPosition] = createSignal<number | null>(null)
  const [flashOpacity, setFlashOpacity] = createSignal(0)
  const timeline = useTimeline({ duration: 600, autoplay: false })

  createEffect(() => {
    const active = props.active
    if (active !== null) {
      // A running fade-out would keep overwriting the fresh flash.
      timeline.pause()
      setHighlightedPosition(active)
      setFlashOpacity(1)
      return
    }
    if (highlightedPosition() === null) return

    timeline.restart()
    timeline.once({ progress: 0 }, {
      progress: 1,
      duration: 600,
      ease: "linear",
      onUpdate: (animation) => {
        const progress = animation.targets[0].progress
        setFlashOpacity((1 + 7 * progress) * Math.exp(-7 * progress))
      },
      onComplete: () => {
        setFlashOpacity(0)
        setHighlightedPosition(null)
      },
    })
  })

  return (
    <box flexDirection="column" gap={1}>
      <For each={[0, 1, 2]}>
        {(row) => (
          <box gap={2} flexDirection="row">
            <For each={[0, 1, 2]}>
              {(column) => {
                const position = row * 3 + column
                return (
                  <box
                    width={7}
                    height={3}
                    backgroundColor={colors.grid}
                    justifyContent="center"
                    alignItems="center"
                  >
                    <box
                      position="absolute"
                      top={0}
                      left={0}
                      width="100%"
                      height="100%"
                      backgroundColor={colors.gridActive}
                      opacity={highlightedPosition() === position ? flashOpacity() : 0}
                    />
                    <text
                      zIndex={1}
                      attributes={highlightedPosition() === position && props.letter ? TextAttributes.BOLD : undefined}
                      fg={highlightedPosition() === position ? colors.background : colors.faint}
                    >
                      {highlightedPosition() === position && props.letter !== undefined
                        ? props.letter
                        : position === 4
                          ? "+"
                          : " "}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

function ResponseBadge(props: {
  readonly keyName: string
  readonly label: string
  readonly active: boolean
  readonly error?: boolean
}) {
  const fg = (activeColor: string) => props.error ? colors.coral : props.active ? activeColor : undefined
  return (
    <box
      width={12}
      height={1}
      justifyContent="center"
      alignItems="center"
      backgroundColor={props.active ? colors.accentDark : colors.panel}
    >
      <text>
        <span style={{ fg: fg(colors.accent) ?? colors.blue, bold: true }}>{controlLabel(props.keyName)}</span>
        <span style={{ fg: fg(colors.accent) ?? colors.muted }}> {props.label}</span>
      </text>
    </box>
  )
}

interface TutorialTrial {
  readonly position: number
  readonly letter: Letter
  readonly expectPosition: boolean
  readonly expectSound: boolean
  readonly hint: (positionKey: string, soundKey: string) => string
}

// A fixed 1-back sequence so the first match lands on trial two and every
// concept appears exactly once before the unassisted trials at the end.
const oneBackTrials: ReadonlyArray<TutorialTrial> = [
  {
    position: 1,
    letter: "C",
    expectPosition: false,
    expectSound: false,
    hint: () => "A square lights up and a letter plays. Remember both — every trial is compared to the one before it.",
  },
  {
    position: 1,
    letter: "H",
    expectPosition: true,
    expectSound: false,
    hint: (positionKey) => `Same square as the previous trial. That is a position match — press ${positionKey}.`,
  },
  {
    position: 7,
    letter: "H",
    expectPosition: false,
    expectSound: true,
    hint: (_, soundKey) => `New square, but the same letter H. That is a sound match — press ${soundKey}.`,
  },
  {
    position: 2,
    letter: "K",
    expectPosition: false,
    expectSound: false,
    hint: () => "New square and new letter — nothing matches. When in doubt, press nothing.",
  },
  {
    position: 2,
    letter: "K",
    expectPosition: true,
    expectSound: true,
    hint: (positionKey, soundKey) => `Same square and same letter. Press both ${positionKey} and ${soundKey}.`,
  },
  {
    position: 6,
    letter: "T",
    expectPosition: false,
    expectSound: false,
    hint: () => "Your turn — respond if something matches the previous trial.",
  },
  {
    position: 6,
    letter: "R",
    expectPosition: true,
    expectSound: false,
    hint: () => "Your turn — respond if something matches the previous trial.",
  },
  {
    position: 3,
    letter: "R",
    expectPosition: false,
    expectSound: true,
    hint: () => "Your turn — respond if something matches the previous trial.",
  },
]

// A fixed 2-back sequence: two history-building trials, then one example of
// each match kind against the trial from two steps ago.
const twoBackTrials: ReadonlyArray<TutorialTrial> = [
  {
    position: 1,
    letter: "C",
    expectPosition: false,
    expectSound: false,
    hint: () => "2-back compares with the trial from TWO steps ago, so the first two trials just build history.",
  },
  {
    position: 5,
    letter: "R",
    expectPosition: false,
    expectSound: false,
    hint: () => "Still building. The next trial will be compared with the first one.",
  },
  {
    position: 1,
    letter: "T",
    expectPosition: true,
    expectSound: false,
    hint: (positionKey) => `Same square as two trials ago — not the previous one. Press ${positionKey}.`,
  },
  {
    position: 8,
    letter: "R",
    expectPosition: false,
    expectSound: true,
    hint: (_, soundKey) => `Same letter as two trials ago. Press ${soundKey}.`,
  },
  {
    position: 1,
    letter: "T",
    expectPosition: true,
    expectSound: true,
    hint: (positionKey, soundKey) => `Both streams match two back. Press ${positionKey} and ${soundKey}.`,
  },
]

interface InfoStep {
  readonly kind: "info"
  readonly demo?: "position" | "audio" | "both"
  readonly hint: (positionKey: string, soundKey: string) => string
}

interface TrialStep {
  readonly kind: "trial"
  readonly n: number
  readonly trials: ReadonlyArray<TutorialTrial>
  readonly index: number
}

interface FinishStep {
  readonly kind: "finish"
}

type TutorialStep = InfoStep | TrialStep | FinishStep

const tutorialSteps: ReadonlyArray<TutorialStep> = [
  { kind: "info", hint: () => "This is dual n-back — dual because you track two streams at once." },
  { kind: "info", demo: "position", hint: () => "Stream one is visual: a square flashes on the grid, one trial every three seconds." },
  { kind: "info", demo: "audio", hint: () => "Stream two is audio: a letter is spoken aloud, on the same three-second rhythm." },
  {
    kind: "info",
    demo: "both",
    hint: (positionKey, soundKey) =>
      `Both streams fire together, one trial every three seconds. ${positionKey} answers position, ${soundKey} answers sound.`,
  },
  { kind: "info", hint: () => "Warm-up: 1-back. Does the current trial match the one right before it?" },
  ...oneBackTrials.map((_, index) => ({ kind: "trial", n: 1, trials: oneBackTrials, index }) as const),
  { kind: "info", hint: () => "Now 2-back — compare each trial with the one from TWO trials ago. Real blocks start here." },
  ...twoBackTrials.map((_, index) => ({ kind: "trial", n: 2, trials: twoBackTrials, index }) as const),
  { kind: "finish" },
]

function MiniTrial(props: {
  readonly position: number
  readonly letter: string
  readonly positionMatch: boolean
  readonly soundMatch: boolean
  readonly current: boolean
  readonly opacity: number
}) {
  return (
    <box flexDirection="column" alignItems="center" opacity={props.opacity}>
      <For each={[0, 1, 2]}>
        {(row) => (
          <box flexDirection="row">
            <For each={[0, 1, 2]}>
              {(column) => {
                const index = row * 3 + column
                return (
                  <box
                    width={2}
                    height={1}
                    backgroundColor={index === props.position
                      ? props.positionMatch ? colors.accent : colors.gridActive
                      : colors.panelBright}
                  />
                )
              }}
            </For>
          </box>
        )}
      </For>
      <text
        fg={props.soundMatch ? colors.accent : props.current ? colors.text : colors.faint}
        attributes={props.current || props.soundMatch ? TextAttributes.BOLD : undefined}
      >
        {props.letter}
      </text>
    </box>
  )
}

function Tutorial(props: { readonly controls: Storage.Controls; readonly onExit: () => void }) {
  const [stepIndex, setStepIndex] = createSignal(0)
  const [pressed, setPressed] = createSignal<Response>({ position: false, sound: false })
  const [wrong, setWrong] = createSignal<ControlName | null>(null)
  const [demoPosition, setDemoPosition] = createSignal<number | null>(1)
  const [demoLetter, setDemoLetter] = createSignal<Letter>("C")
  const [demoLetterOpacity, setDemoLetterOpacity] = createSignal(1)
  const demoLayout = () => {
    const current = step()
    return current.kind === "info" ? current.demo ?? null : null
  }
  let advanceTimer: ReturnType<typeof setTimeout> | null = null
  let wrongTimer: ReturnType<typeof setTimeout> | null = null
  let previousIndex = -1

  const step = () => tutorialSteps[stepIndex()]!
  const positionKey = () => controlLabel(props.controls.position)
  const soundKey = () => controlLabel(props.controls.sound)

  const playLetter = (letter: Letter) => {
    AppRuntime.runtime.runFork(AppRuntime.playLetter(letter).pipe(Effect.ignore))
  }
  const replay = () => {
    const current = step()
    if (current.kind === "trial") playLetter(current.trials[current.index]!.letter)
    else if (current.kind === "info" && current.demo !== undefined && current.demo !== "position") playLetter(demoLetter())
  }

  // Sliding history: the current trial is pinned to the screen center and
  // older trials march out to the left. Match pointers are drawn only on the
  // current trial, with a bridge back to the n-back trial it matches.
  const dimensions = useTerminalDimensions()
  const centerColumn = () => Math.floor(dimensions().width / 2)
  const timelineItems = () => {
    const current = step()
    if (current.kind !== "trial") return []
    const base = Math.max(0, current.index - 4)
    return current.trials.slice(base, current.index + 1).map((item, offset) => {
      const absolute = base + offset
      const isCurrent = absolute === current.index
      return {
        item,
        distance: current.index - absolute,
        current: isCurrent,
        positionMatch: isCurrent && item.expectPosition,
        soundMatch: isCurrent && item.expectSound,
      }
    })
  }
  const currentEntry = () => timelineItems().at(-1)

  // On advance the history block starts one slot to the right (where the old
  // current trial sat, under the new one) and settles left with a damped
  // spring: fast out, a one-cell overshoot, then rest. The trial leaving the
  // window fades out as it slides.
  const [slideRaw, setSlideRaw] = createSignal(0)
  const [settled, setSettled] = createSignal(true)
  const slideTimeline = useTimeline({ duration: 500, autoplay: false })
  const slideColumns = () => Math.round(slideRaw())
  const startSlide = () => {
    setSettled(false)
    setSlideRaw(8)
    slideTimeline.restart()
    slideTimeline.once({ progress: 0 }, {
      progress: 1,
      duration: 500,
      ease: "linear",
      onUpdate: (animation) => {
        const progress = animation.targets[0].progress
        setSlideRaw(8 * Math.exp(-3.5 * progress) * Math.cos(4 * progress))
      },
      onComplete: () => {
        setSlideRaw(0)
        setSettled(true)
      },
    })
  }

  const itemOpacity = (entry: { readonly distance: number; readonly current: boolean }) => {
    const current = step()
    if (current.kind !== "trial") return 1
    if (entry.current) return 1
    if (entry.distance === 4) return 0.55 * Math.max(0, Math.min(1, slideRaw() / 8))
    const active = currentEntry()
    if (entry.distance === current.n && active !== undefined && (active.positionMatch || active.soundMatch)) return 1
    return 0.55
  }

  const bridge = (open: string, close: string) => {
    const current = step()
    const width = current.kind === "trial" ? current.n * 8 : 8
    return `${open}${"─".repeat(width - 1)}${close}`
  }
  const bridgeLeft = () => {
    const current = step()
    return centerColumn() - 1 - (current.kind === "trial" ? current.n * 8 : 8)
  }

  const goTo = (next: number) => {
    if (next < 0 || next >= tutorialSteps.length) return
    if (advanceTimer) {
      clearTimeout(advanceTimer)
      advanceTimer = null
    }
    setStepIndex(next)
  }

  // Match trials demand their answer: forward navigation stays locked until
  // the expected keys are pressed, so the lesson cannot be skimmed past.
  const locked = () => {
    const current = step()
    if (current.kind !== "trial") return false
    const item = current.trials[current.index]!
    const state = pressed()
    return (item.expectPosition && !state.position) || (item.expectSound && !state.sound)
  }

  // Entering a step resets responses, plays its letter, and animates the
  // timeline only when moving forward through consecutive trials.
  createEffect(() => {
    const index = stepIndex()
    const current = tutorialSteps[index]!
    const movedForward = index === previousIndex + 1
    previousIndex = index
    setPressed({ position: false, sound: false })
    setWrong(null)
    if (current.kind === "trial") {
      playLetter(current.trials[current.index]!.letter)
      const previous = tutorialSteps[index - 1]
      if (movedForward && previous?.kind === "trial" && current.index > 0) startSlide()
      else {
        setSlideRaw(0)
        setSettled(true)
      }
    }
  })

  // Demos run at the real trial cadence: one stimulus every three seconds.
  // The demo square stays visible briefly and then fades out, exactly like a
  // real trial, so the rhythm and the flash both read correctly.
  const letterFadeTimeline = useTimeline({ duration: 600, autoplay: false })
  const fadeLetter = () => {
    letterFadeTimeline.restart()
    letterFadeTimeline.once({ progress: 0 }, {
      progress: 1,
      duration: 600,
      ease: "linear",
      onUpdate: (animation) => {
        const progress = animation.targets[0].progress
        setDemoLetterOpacity((1 + 7 * progress) * Math.exp(-7 * progress))
      },
      onComplete: () => setDemoLetterOpacity(0),
    })
  }

  createEffect(() => {
    const layout = demoLayout()
    if (layout === null) return
    // The center cell is the fixation cross and never flashes in real blocks.
    const tour = [2, 6, 1, 8, 3, 5, 0, 7]
    let at = 0
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    let letterTimer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      if (layout !== "audio") {
        setDemoPosition(tour[at % tour.length]!)
        hideTimer = setTimeout(() => setDemoPosition(null), 600)
      }
      if (layout !== "position") {
        const letter = LETTERS[at % LETTERS.length]!
        setDemoLetter(letter)
        setDemoLetterOpacity(1)
        playLetter(letter)
        letterTimer = setTimeout(fadeLetter, 600)
      }
      at += 1
    }
    if (layout === "audio") setDemoPosition(null)
    tick()
    const timer = setInterval(tick, 3000)
    onCleanup(() => {
      clearInterval(timer)
      if (hideTimer) clearTimeout(hideTimer)
      if (letterTimer) clearTimeout(letterTimer)
    })
  })

  // The demo grid sits centered for the visual stream, then glides left to
  // make room for the letter when the audio stream is introduced.
  const [gridX, setGridX] = createSignal<number | null>(null)
  let gridXCurrent: number | null = null
  const applyGridX = (value: number) => {
    gridXCurrent = value
    setGridX(value)
  }
  const gridTimeline = useTimeline({ duration: 400, autoplay: false })
  createEffect(() => {
    const layout = demoLayout()
    if (layout === null) {
      gridXCurrent = null
      setGridX(null)
      return
    }
    const target = layout === "position" ? centerColumn() - 12 : centerColumn() - 24
    const from = gridXCurrent
    if (from === null || from === target) {
      applyGridX(target)
      return
    }
    gridTimeline.restart()
    gridTimeline.once({ progress: 0 }, {
      progress: 1,
      duration: 400,
      ease: "linear",
      onUpdate: (animation) => {
        const progress = animation.targets[0].progress
        const eased = 1 - (1 - progress) ** 3
        applyGridX(from + (target - from) * eased)
      },
      onComplete: () => applyGridX(target),
    })
  })

  onCleanup(() => {
    if (advanceTimer) clearTimeout(advanceTimer)
    if (wrongTimer) clearTimeout(wrongTimer)
  })

  const press = (modality: ControlName) => {
    const current = step()
    if (current.kind !== "trial") return
    const item = current.trials[current.index]!
    const expected = modality === "position" ? item.expectPosition : item.expectSound
    if (!expected) {
      setWrong(modality)
      if (wrongTimer) clearTimeout(wrongTimer)
      wrongTimer = setTimeout(() => setWrong(null), 700)
      return
    }
    const next = { ...pressed(), [modality]: true }
    setPressed(next)
    const complete = (!item.expectPosition || next.position) && (!item.expectSound || next.sound)
    if (complete && !advanceTimer) advanceTimer = setTimeout(() => goTo(stepIndex() + 1), 550)
  }

  useKeyboard((key) => {
    if (key.eventType === "release" || key.repeated) return
    const name = actionKey(key)
    const current = step()
    if (current.kind === "finish") {
      if (name === "return" || name === "enter" || name === "space" || name === "q" || name === "escape") props.onExit()
      else if (name === "left") goTo(stepIndex() - 1)
      return
    }
    if (name === "escape") props.onExit()
    else if (name === "left") goTo(stepIndex() - 1)
    else if (name === "right" || name === "space") {
      if (!locked()) goTo(stepIndex() + 1)
    }
    else if (name === "r") replay()
    else if (name === props.controls.position) press("position")
    else if (name === props.controls.sound) press("sound")
  })

  const hintText = () => {
    const current = step()
    if (current.kind === "trial") {
      return wrong() !== null
        ? `No ${wrong()} match on this trial.`
        : current.trials[current.index]!.hint(positionKey(), soundKey())
    }
    if (current.kind === "info") return current.hint(positionKey(), soundKey())
    return ""
  }

  const headerRight = () => {
    const current = step()
    const counter = `${stepIndex() + 1}/${tutorialSteps.length}`
    if (current.kind === "trial") return `tutorial · ${current.n}-back · ${counter}`
    return `tutorial · ${counter}`
  }

  return (
    <>
      <Header right={headerRight()} />
      <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <Show
          when={step().kind !== "finish"}
          fallback={
            <box flexDirection="column" alignItems="center" gap={1} width={58}>
              <text fg={colors.accent} attributes={TextAttributes.BOLD}>THAT IS DUAL N-BACK</text>
              <text fg={colors.muted} wrapMode="word">
                Real blocks run one trial every three seconds with no hints. The level adapts to your accuracy, starting at 2-back.
              </text>
              <CommandBar commands={[{ key: "enter", label: "finish" }, { key: "←", label: "back" }]} />
            </box>
          }
        >
          <box width={52} height={3} justifyContent="center" alignItems="center" flexDirection="column">
            <text fg={colors.cyan} wrapMode="word">{hintText()}</text>
          </box>
          <box height={19} width="100%" marginTop={1} flexDirection="column" alignItems="center">
            <Show when={step().kind === "trial"}>
              <box height={6} width="100%">
                <For each={timelineItems()}>
                  {(entry) => (
                    <box
                      position="absolute"
                      top={1}
                      left={centerColumn() - 3 - entry.distance * 8 + (entry.current ? 0 : slideColumns())}
                    >
                      <MiniTrial
                        position={entry.item.position}
                        letter={entry.item.letter}
                        positionMatch={entry.positionMatch}
                        soundMatch={entry.soundMatch}
                        current={entry.current}
                        opacity={itemOpacity(entry)}
                      />
                    </box>
                  )}
                </For>
                <Show when={settled() && currentEntry()?.positionMatch}>
                  <box position="absolute" top={0} left={bridgeLeft()}>
                    <text fg={colors.accent}>{bridge("╭", "╮")}</text>
                  </box>
                </Show>
                <Show when={settled() && currentEntry()?.soundMatch}>
                  <box position="absolute" top={5} left={bridgeLeft()}>
                    <text fg={colors.accent}>{bridge("╰", "╯")}</text>
                  </box>
                </Show>
              </box>
              <box marginTop={1} flexDirection="column" alignItems="center">
                <Show when={step().kind === "trial"}>
                  {(() => {
                    const current = step() as TrialStep
                    const item = current.trials[current.index]!
                    return <Grid active={item.position} />
                  })()}
                </Show>
              </box>
            </Show>
            <Show when={step().kind === "info"}>
              <box flexGrow={1} width="100%" justifyContent="center" flexDirection="column">
                <Show when={demoLayout() !== null}>
                  <box height={11} width="100%">
                    <box
                      position="absolute"
                      top={0}
                      left={Math.round(gridX() ?? centerColumn() - 12)}
                      opacity={demoLayout() === "audio" ? 0.35 : 1}
                    >
                      <Grid active={demoPosition()} />
                    </box>
                    <Show when={demoLayout() !== "position"}>
                      <box position="absolute" top={2} left={centerColumn() + 9} opacity={demoLetterOpacity()}>
                        <ascii_font
                          text={demoLetter()}
                          font="block"
                          color={[colors.cyan, colors.background]}
                          backgroundColor={colors.background}
                        />
                      </box>
                    </Show>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
          <box height={1} marginTop={1} gap={1} flexDirection="row">
            <Show when={step().kind === "trial"}>
              <ResponseBadge
                keyName={props.controls.position}
                label="position"
                active={pressed().position}
                error={wrong() === "position"}
              />
              <ResponseBadge
                keyName={props.controls.sound}
                label="sound"
                active={pressed().sound}
                error={wrong() === "sound"}
              />
            </Show>
          </box>
          <box marginTop={2}>
            <CommandBar
              commands={[
                { key: "←", label: "back" },
                { key: "space", label: "next", dimmed: locked() },
                { key: "r", label: "replay" },
                { key: "esc", label: "skip" },
              ]}
            />
          </box>
        </Show>
      </box>
    </>
  )
}

function Summary(props: { readonly summary: SummaryState; readonly nextLevel: number; readonly status: string }) {
  const changed = () => props.nextLevel === props.summary.n ? "unchanged" : props.nextLevel > props.summary.n ? "up" : "down"
  const levelColor = () => changed() === "up" ? colors.accent : changed() === "down" ? colors.coral : colors.blue
  const changeLabel = () => changed() === "up" ? "LEVEL UP" : changed() === "down" ? "LEVEL DOWN" : "LEVEL HELD"
  const scoreColor = () => {
    const accuracy = props.summary.score.accuracy
    return accuracy >= 0.8 ? colors.accent : accuracy < 0.65 ? colors.coral : colors.blue
  }
  const rows = (): ReadonlyArray<readonly [string, string, string]> => {
    const p = props.summary.score.position
    const s = props.summary.score.sound
    return [
      ["accuracy", percent(p.accuracy), percent(s.accuracy)],
      ["hits", `${p.hits}/${p.hits + p.misses}`, `${s.hits}/${s.hits + s.misses}`],
      ["false alarms", `${p.falseAlarms}`, `${s.falseAlarms}`],
      ["correct rejects", `${p.correctRejections}`, `${s.correctRejections}`],
      ["d'", dPrime(p.dPrime), dPrime(s.dPrime)],
    ]
  }
  return (
    <>
      <Header right={`block ${props.summary.blockNumber} · ${props.summary.n}-back`} />
      <box width="100%" flexGrow={1} minHeight={0} justifyContent="center" alignItems="center">
        <box flexDirection="column" alignItems="center" gap={1}>
          <text fg={levelColor()} attributes={TextAttributes.BOLD}>{changeLabel()}</text>
          <ascii_font
            text={`${props.nextLevel}-BACK`}
            font="block"
            color={[levelColor(), colors.background]}
            backgroundColor={colors.background}
          />
          <text>
            <Show when={changed() !== "unchanged"} fallback={
              <span style={{ fg: levelColor(), bold: true }}>{props.nextLevel}-back held</span>
            }>
              <span style={{ fg: colors.faint }}>{props.summary.n}-back</span>
              <span style={{ fg: levelColor(), bold: true }}>  →  {props.nextLevel}-back</span>
            </Show>
            <span style={{ fg: colors.faint }}>  ·  block accuracy </span>
            <span style={{ fg: scoreColor(), bold: true }}>{percent(props.summary.score.accuracy)}</span>
          </text>
          <box flexDirection="column" marginTop={1}>
            <text>
              <span style={{ fg: colors.faint }}>{"".padEnd(16)}</span>
              <span style={{ fg: colors.faint }}>{"position".padStart(10)}</span>
              <span style={{ fg: colors.faint }}>{"sound".padStart(8)}</span>
            </text>
            <For each={rows()}>
              {([label, position, sound]) => (
                <text>
                  <span style={{ fg: colors.faint }}>{label.padEnd(16)}</span>
                  <span style={{ fg: colors.text }}>{position.padStart(10)}</span>
                  <span style={{ fg: colors.text }}>{sound.padStart(8)}</span>
                </text>
              )}
            </For>
          </box>
          <box marginTop={1} flexDirection="column" alignItems="center">
            <CommandBar
              commands={[
                { key: "enter", label: `continue at ${props.nextLevel}-back` },
                { key: "↑↓", label: "override" },
                { key: "h", label: "history" },
                { key: "q", label: "home" },
              ]}
            />
            <Show when={props.status.length > 0}><text fg={colors.coral}>{props.status}</text></Show>
          </box>
        </box>
      </box>
    </>
  )
}

function CommandBar(props: {
  readonly commands: ReadonlyArray<{ readonly key: string; readonly label: string; readonly dimmed?: boolean }>
  readonly align?: "flex-start" | "center"
}) {
  return (
    <box justifyContent={props.align ?? "center"}>
      <text>
        <For each={props.commands}>
          {(command, index) => (
            <>
              <span style={{ fg: command.dimmed ? colors.faint : colors.blue, bold: !command.dimmed }}>{command.key}</span>
              <span style={{ fg: command.dimmed ? colors.faint : colors.muted }}> {command.label}{index() < props.commands.length - 1 ? "  " : ""}</span>
            </>
          )}
        </For>
      </text>
    </box>
  )
}

function History(props: { readonly blocks: ReadonlyArray<Storage.BlockRecord> }) {
  const recent = () => [...props.blocks].reverse().slice(0, 12)
  return (
    <>
      <Header right="history" />
      <box width="100%" flexGrow={1} minHeight={0} justifyContent="center" alignItems="center">
        <box flexDirection="column" alignItems="center" gap={1}>
          <box flexDirection="column">
            <box paddingLeft={1} paddingRight={1}>
              <text fg={colors.faint}>
                {"date".padEnd(18) + "level".padStart(7) + "accuracy".padStart(11) + "pos d'".padStart(9) + "snd d'".padStart(9)}
              </text>
            </box>
            <Show when={recent().length > 0} fallback={<box paddingLeft={1}><text fg={colors.muted}>no blocks yet</text></box>}>
              <For each={recent()}>
                {(block, index) => (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={index() % 2 === 0 ? colors.panel : colors.background}
                  >
                    <text>
                      <span style={{ fg: colors.muted }}>{formatDate(block.timestamp).padEnd(18)}</span>
                      <span style={{ fg: colors.blue }}>{`${block.n}-back`.padStart(7)}</span>
                      <span style={{ fg: colors.text }}>{percent(block.accuracy).padStart(11)}</span>
                      <span style={{ fg: colors.text }}>{dPrime(block.position.dPrime).padStart(9)}</span>
                      <span style={{ fg: colors.text }}>{dPrime(block.sound.dPrime).padStart(9)}</span>
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </box>
          <CommandBar commands={[{ key: "esc", label: "back" }]} />
        </box>
      </box>
    </>
  )
}

function Controls(props: {
  readonly controls: Storage.Controls
  readonly selected: ControlName
  readonly listening: ControlName | null
  readonly status: string
}) {
  return (
    <>
      <Header right="controls" />
      <box width="100%" flexGrow={1} minHeight={0} justifyContent="center" alignItems="center">
        <box width={44} flexDirection="column" gap={1} alignItems="center">
          <box width="100%" flexDirection="column">
            <ControlRow
              name="position"
              value={props.controls.position}
              selected={props.selected === "position"}
              listening={props.listening === "position"}
            />
            <ControlRow
              name="sound"
              value={props.controls.sound}
              selected={props.selected === "sound"}
              listening={props.listening === "sound"}
            />
          </box>
          <Show
            when={props.listening !== null}
            fallback={
              <CommandBar
                commands={[
                  { key: "↑↓", label: "select" },
                  { key: "enter", label: "rebind" },
                  { key: "esc", label: "back" },
                ]}
              />
            }
          >
            <text fg={colors.accent}>press the new {props.listening} key · esc cancels</text>
          </Show>
          <Show when={props.status.length > 0}><text fg={colors.cyan}>{props.status}</text></Show>
        </box>
      </box>
    </>
  )
}

function ControlRow(props: {
  readonly name: ControlName
  readonly value: string
  readonly selected: boolean
  readonly listening: boolean
}) {
  return (
    <box
      height={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      alignItems="center"
      backgroundColor={props.selected ? colors.panel : undefined}
    >
      <text fg={props.selected ? colors.text : colors.muted}>
        {props.selected ? "▸ " : "  "}{props.name} match
      </text>
      <box flexGrow={1} />
      <text
        fg={props.listening ? colors.cyan : colors.blue}
        attributes={props.listening ? undefined : TextAttributes.BOLD}
      >
        {props.listening ? "press a key…" : controlLabel(props.value)}
      </text>
    </box>
  )
}
