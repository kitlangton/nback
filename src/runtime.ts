import { homedir } from "node:os"
import { join } from "node:path"

import { Clock, Effect, Layer, ManagedRuntime } from "effect"

import type { Block, BlockScore } from "./domain.js"
import { NBackAudio } from "./services/audio.js"
import { Storage } from "./services/storage.js"

const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
const storageLayer = Storage.layer(join(dataRoot, "nback-tui", "data.json"))
const appLayer = Layer.merge(NBackAudio.layer, storageLayer)

export const runtime = ManagedRuntime.make(appLayer)

export const loadData = Effect.gen(function* () {
  const storage = yield* Storage.Service
  return yield* storage.load()
})

export const saveControls = (controls: Storage.Controls) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    yield* storage.saveControls(controls)
  })

export const saveDailyGoal = (dailyGoal: number) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    yield* storage.saveDailyGoal(dailyGoal)
  })

export const playLetter = (letter: Parameters<NBackAudio.Interface["play"]>[0]) =>
  Effect.gen(function* () {
    const audio = yield* NBackAudio.Service
    yield* audio.play(letter)
  })

export interface BlockEvents {
  readonly showTrial: (index: number) => void
  readonly hidePosition: () => void
}

export const runBlock = (block: Block, events: BlockEvents) =>
  Effect.gen(function* () {
    const audio = yield* NBackAudio.Service
    yield* Effect.forEach(
      block.trials,
      (trial, index) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => events.showTrial(index))
          yield* audio.play(trial.letter)
          yield* Effect.sleep("500 millis")
          yield* Effect.sync(events.hidePosition)
          yield* Effect.sleep("2500 millis")
        }),
      { discard: true },
    )
  })

export const markTutorialComplete = Effect.gen(function* () {
  const storage = yield* Storage.Service
  const timestamp = yield* Clock.currentTimeMillis
  yield* storage.setTutorialCompleted(timestamp)
})

export const recordBlock = (n: number, score: BlockScore) =>
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const timestamp = yield* Clock.currentTimeMillis
    yield* storage.addBlock({ timestamp, n, ...score })
  })

export * as AppRuntime from "./runtime.js"
