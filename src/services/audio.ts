import { fileURLToPath } from "node:url"

import { Audio, type AudioSound } from "@opentui/core"
import { Context, Effect, Layer, Schema } from "effect"

import { LETTERS, type Letter } from "../domain.js"

export interface Interface {
  readonly play: (letter: Letter) => Effect.Effect<void, PlaybackError>
}

export class Service extends Context.Service<Service, Interface>()("nback/Audio") {}

export class InitializationError extends Schema.TaggedErrorClass<InitializationError>()(
  "Audio.InitializationError",
  { message: Schema.String },
) {}

export class PlaybackError extends Schema.TaggedErrorClass<PlaybackError>()("Audio.PlaybackError", {
  letter: Schema.String,
}) {}

interface Resource {
  readonly service: Interface
  readonly dispose: () => void
}

const acquire = Effect.gen(function* () {
  const audio = yield* Effect.try({
    try: () => Audio.create({ autoStart: false }),
    catch: (cause) => new InitializationError({ message: String(cause) }),
  })

  if (!audio.start()) {
    audio.dispose()
    return yield* new InitializationError({ message: "No audio output device is available" })
  }

  const entries = yield* Effect.forEach(LETTERS, (letter) =>
    Effect.tryPromise({
      try: () => audio.loadSoundFile(fileURLToPath(new URL(`../../audio/${letter.toLowerCase()}.wav`, import.meta.url))),
      catch: (cause) => new InitializationError({ message: `Could not load ${letter}: ${String(cause)}` }),
    }).pipe(Effect.map((sound) => [letter, sound] as const)),
  )

  const sounds = new Map<Letter, AudioSound>()
  for (const [letter, sound] of entries) {
    if (sound === null) {
      audio.dispose()
      return yield* new InitializationError({ message: `Could not decode the ${letter} sound` })
    }
    sounds.set(letter, sound)
  }

  const play = Effect.fn("Audio.play")(function* (letter: Letter) {
    const sound = sounds.get(letter)
    if (!sound || audio.play(sound, { volume: 1, loop: false }) === null) {
      return yield* new PlaybackError({ letter })
    }
  })

  return {
    service: Service.of({ play }),
    dispose: () => audio.dispose(),
  } satisfies Resource
})

export const layer = Layer.effect(
  Service,
  Effect.acquireRelease(acquire, (resource) => Effect.sync(resource.dispose)).pipe(Effect.map((resource) => resource.service)),
)

export * as NBackAudio from "./audio.js"
