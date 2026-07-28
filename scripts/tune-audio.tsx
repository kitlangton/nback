#!/usr/bin/env bun

/**
 * Interactive tuner for the letter audio set.
 *
 * Navigate letters and settings, re-roll individual letters with fresh seeds,
 * audition candidates by ear, and install the takes you like into audio/.
 *
 * Run with: 2password run --env "ELEVENLABS_API_KEY=op://Personal/ElevenLabs API Key/credential" -- bun run audio:tune
 */

import { execFile } from "node:child_process"
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { TextAttributes } from "@opentui/core"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { Effect, ManagedRuntime, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { LETTERS, type Letter } from "../src/domain.js"
import { makeClient, probeDuration, processClip, type ApiVoice, type SynthesisSettings } from "./audio-pipeline.js"

const colors = {
  background: "#1a1b26",
  panel: "#24283b",
  text: "#c0caf5",
  muted: "#a9b1d6",
  faint: "#565f89",
  accent: "#9ece6a",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  coral: "#f7768e",
}

const audioDirectory = fileURLToPath(new URL("../audio/", import.meta.url))
const installedPath = (letter: Letter) => join(audioDirectory, `${letter.toLowerCase()}.wav`)

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
type Api = Effect.Effect.Success<ReturnType<typeof makeClient>>

interface Candidate {
  readonly path: string
  readonly speech: number
  readonly seed: number
}

interface LetterState {
  readonly installed: number | undefined
  readonly candidate: Candidate | undefined
  readonly busy: boolean
}

const initialLetterState: LetterState = { installed: undefined, candidate: undefined, busy: false }

type Row = { readonly kind: "letter"; readonly letter: Letter } | { readonly kind: "voice" | "speed" | "stability" }

const rows: ReadonlyArray<Row> = [
  ...LETTERS.map((letter) => ({ kind: "letter", letter }) as const),
  { kind: "voice" },
  { kind: "speed" },
  { kind: "stability" },
]

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

function Tuner() {
  const renderer = useRenderer()
  const [states, setStates] = createSignal<ReadonlyMap<Letter, LetterState>>(
    new Map(LETTERS.map((letter) => [letter, initialLetterState])),
  )
  const [selected, setSelected] = createSignal(0)
  const [status, setStatus] = createSignal("loading...")
  const [voices, setVoices] = createSignal<ReadonlyArray<ApiVoice>>([])
  const [voiceIndex, setVoiceIndex] = createSignal(0)
  const [speed, setSpeed] = createSignal(1.0)
  const [stability, setStability] = createSignal(0.5)

  let api: Api | null = null
  let workDirectory = ""

  const currentVoice = () => voices()[voiceIndex()]
  const letterState = (letter: Letter) => states().get(letter) ?? initialLetterState
  const updateLetter = (letter: Letter, update: Partial<LetterState>) =>
    setStates((current) => new Map(current).set(letter, { ...letterState(letter), ...update }))

  const settings = (): SynthesisSettings => ({
    voiceId: currentVoice()?.voiceId ?? "C7KFSYTllManKOBX99re",
    modelId: "eleven_multilingual_v2",
    outputFormat: "mp3_44100_128",
    speed: speed(),
    stability: stability(),
    similarityBoost: 0.75,
  })

  onMount(() => {
    void (async () => {
      const key = process.env.ELEVENLABS_API_KEY ?? process.env.XI_API_KEY
      if (!key) {
        setStatus("ELEVENLABS_API_KEY is not set — run through 2password")
        return
      }
      workDirectory = await mkdtemp(join(tmpdir(), "nback-tune-"))
      try {
        api = await runtime.runPromise(makeClient(Redacted.make(key)))
        const list = await runtime.runPromise(api.listVoices())
        setVoices(list)
        const severus = list.findIndex((voice) => voice.voiceId === "C7KFSYTllManKOBX99re")
        if (severus >= 0) setVoiceIndex(severus)
        setStatus("")
      } catch (error) {
        setStatus(`Could not reach ElevenLabs: ${String(error)}`)
      }
      for (const letter of LETTERS) {
        runtime.runPromise(probeDuration(installedPath(letter))).then(
          (duration) => updateLetter(letter, { installed: duration }),
          () => undefined,
        )
      }
    })()
  })

  onCleanup(() => {
    if (workDirectory) void rm(workDirectory, { recursive: true, force: true })
    void runtime.dispose()
  })

  const play = (letter: Letter) => {
    const candidate = letterState(letter).candidate
    const path = candidate?.path ?? installedPath(letter)
    execFile("afplay", [path], (error) => {
      if (error) setStatus(`Playback failed: ${String(error)}`)
    })
  }

  const reroll = (letter: Letter) => {
    if (!api || letterState(letter).busy) return
    const seed = Math.floor(Math.random() * 100000) + 1
    const current = settings()
    updateLetter(letter, { busy: true })
    setStatus(`Synthesizing ${letter} (seed ${seed})...`)
    const rawPath = join(workDirectory, `${letter.toLowerCase()}-${seed}.audio`)
    const finalPath = join(workDirectory, `${letter.toLowerCase()}-${seed}.wav`)
    runtime
      .runPromise(
        Effect.gen(function* () {
          const synthesized = yield* api!.synthesizeLetter(current, letter, seed)
          yield* Effect.tryPromise(() => writeFile(rawPath, synthesized))
          return yield* processClip(rawPath, join(workDirectory, `${letter.toLowerCase()}-${seed}`), finalPath)
        }),
      )
      .then(
        (speech) => {
          updateLetter(letter, { busy: false, candidate: { path: finalPath, speech, seed } })
          setStatus(`${letter}: candidate ready (${speech.toFixed(2)}s) — space to replay, enter to keep`)
          execFile("afplay", [finalPath], () => undefined)
        },
        (error) => {
          updateLetter(letter, { busy: false })
          setStatus(`${letter}: synthesis failed: ${String(error)}`)
        },
      )
  }

  const accept = (letter: Letter) => {
    const candidate = letterState(letter).candidate
    if (!candidate) return
    void copyFile(candidate.path, installedPath(letter)).then(
      () => {
        runtime.runPromise(probeDuration(installedPath(letter))).then(
          (duration) => updateLetter(letter, { installed: duration, candidate: undefined }),
          () => updateLetter(letter, { candidate: undefined }),
        )
        setStatus(`${letter}: installed candidate (seed ${candidate.seed})`)
      },
      (error) => setStatus(`${letter}: install failed: ${String(error)}`),
    )
  }

  const discard = (letter: Letter) => {
    if (!letterState(letter).candidate) return
    updateLetter(letter, { candidate: undefined })
    setStatus(`${letter}: candidate discarded`)
  }

  const adjust = (row: Row, direction: 1 | -1) => {
    if (row.kind === "voice") {
      if (voices().length === 0) return
      setVoiceIndex((current) => (current + direction + voices().length) % voices().length)
    } else if (row.kind === "speed") {
      setSpeed((current) => clamp(Math.round((current + direction * 0.05) * 100) / 100, 0.7, 1.2))
    } else if (row.kind === "stability") {
      setStability((current) => clamp(Math.round((current + direction * 0.1) * 100) / 100, 0, 1))
    }
  }

  useKeyboard((key) => {
    if (key.eventType === "release" || key.repeated) return
    const name = key.name.toLowerCase()
    const row = rows[selected()]!

    if (name === "q" || name === "escape") {
      void renderer.destroy()
      return
    }
    if (name === "up") setSelected((current) => (current + rows.length - 1) % rows.length)
    else if (name === "down") setSelected((current) => (current + 1) % rows.length)
    else if (name === "left") adjust(row, -1)
    else if (name === "right") adjust(row, 1)
    else if (row.kind === "letter") {
      if (name === "space" || name === "p") play(row.letter)
      else if (name === "r") reroll(row.letter)
      else if (name === "return" || name === "enter") accept(row.letter)
      else if (name === "x") discard(row.letter)
    }
    if (name === "g") for (const letter of LETTERS) reroll(letter)
  })

  const envHint = () =>
    `NBACK_VOICE_ID=${currentVoice()?.voiceId ?? "?"} NBACK_VOICE_SPEED=${speed()} NBACK_VOICE_STABILITY=${stability()}`

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={colors.background} paddingTop={1} paddingLeft={3} paddingRight={3}>
      <box flexDirection="row" height={2}>
        <text fg={colors.accent} attributes={TextAttributes.BOLD}>NBACK</text>
        <text fg={colors.muted}> · audio tuner</text>
        <box flexGrow={1} />
        <text fg={colors.faint}>{voices().length > 0 ? `${voices().length} voices` : ""}</text>
      </box>

      <box flexDirection="column">
        <text fg={colors.faint}>{"  letter".padEnd(12) + "installed".padStart(11) + "candidate".padStart(24)}</text>
        <For each={rows}>
          {(row, index) => {
            const isSelected = () => selected() === index()
            if (row.kind === "letter") {
              const state = () => letterState(row.letter)
              return (
                <box height={1} backgroundColor={isSelected() ? colors.panel : undefined}>
                  <text>
                    <span style={{ fg: isSelected() ? colors.accent : colors.faint }}>{isSelected() ? "▸ " : "  "}</span>
                    <span style={{ fg: colors.text, bold: true }}>{row.letter.padEnd(10)}</span>
                    <span style={{ fg: colors.muted }}>
                      {(state().installed !== undefined ? `${state().installed!.toFixed(2)}s` : "—").padStart(11)}
                    </span>
                    <span style={{ fg: state().busy ? colors.cyan : state().candidate ? colors.accent : colors.faint }}>
                      {(state().busy
                        ? "generating..."
                        : state().candidate
                          ? `${state().candidate!.speech.toFixed(2)}s · seed ${state().candidate!.seed}`
                          : "—"
                      ).padStart(24)}
                    </span>
                  </text>
                </box>
              )
            }
            const label = row.kind
            const value = () =>
              row.kind === "voice"
                ? (currentVoice()?.name ?? "loading...")
                : row.kind === "speed"
                  ? speed().toFixed(2)
                  : stability().toFixed(2)
            return (
              <box height={1} marginTop={row.kind === "voice" ? 1 : 0} backgroundColor={isSelected() ? colors.panel : undefined}>
                <text>
                  <span style={{ fg: isSelected() ? colors.accent : colors.faint }}>{isSelected() ? "▸ " : "  "}</span>
                  <span style={{ fg: colors.muted }}>{label.padEnd(10)}</span>
                  <span style={{ fg: colors.blue }}>{`◂ ${value()} ▸`}</span>
                </text>
              </box>
            )
          }}
        </For>
      </box>

      <box marginTop={1} flexDirection="column">
        <text>
          <span style={{ fg: colors.blue, bold: true }}>space</span><span style={{ fg: colors.muted }}> play  </span>
          <span style={{ fg: colors.blue, bold: true }}>r</span><span style={{ fg: colors.muted }}> reroll  </span>
          <span style={{ fg: colors.blue, bold: true }}>g</span><span style={{ fg: colors.muted }}> reroll all  </span>
          <span style={{ fg: colors.blue, bold: true }}>enter</span><span style={{ fg: colors.muted }}> keep  </span>
          <span style={{ fg: colors.blue, bold: true }}>x</span><span style={{ fg: colors.muted }}> discard  </span>
          <span style={{ fg: colors.blue, bold: true }}>←→</span><span style={{ fg: colors.muted }}> adjust  </span>
          <span style={{ fg: colors.blue, bold: true }}>q</span><span style={{ fg: colors.muted }}> quit</span>
        </text>
        <Show when={status().length > 0}>
          <text fg={colors.cyan}>{status()}</text>
        </Show>
        <text fg={colors.faint}>{envHint()}</text>
      </box>
    </box>
  )
}

render(() => <Tuner />, {
  targetFps: 30,
  exitOnCtrlC: true,
})
