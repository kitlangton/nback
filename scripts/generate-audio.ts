#!/usr/bin/env bun

import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { Config, Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import { LETTERS, type Letter } from "../src/domain.js"
import { attempt, GenerationError, makeClient, processClip } from "./audio-pipeline.js"

const normalizedToken = (text: string): string => text.toUpperCase().replace(/[^A-Z]/g, "")

const spokenLetterAliases: Record<Letter, ReadonlySet<string>> = {
  C: new Set(["C", "SEE", "SEA"]),
  H: new Set(["H", "AITCH", "EACH"]),
  K: new Set(["K", "KAY"]),
  L: new Set(["L", "ELL", "ELLE"]),
  Q: new Set(["Q", "CUE", "QUEUE"]),
  R: new Set(["R", "ARE"]),
  S: new Set(["S", "ESS"]),
  T: new Set(["T", "TEA", "TEE"]),
}

const configuration = Config.all({
  apiKey: Config.redacted("ELEVENLABS_API_KEY").pipe(Config.orElse(() => Config.redacted("XI_API_KEY"))),
  modelId: Config.string("NBACK_VOICE_MODEL").pipe(Config.withDefault("eleven_multilingual_v2")),
  outputFormat: Config.string("NBACK_VOICE_FORMAT").pipe(Config.withDefault("mp3_44100_128")),
  outputDirectory: Config.string("NBACK_AUDIO_OUTPUT").pipe(Config.withDefault(resolve("audio"))),
  seed: Config.int("NBACK_VOICE_SEED").pipe(Config.withDefault(7)),
  speed: Config.number("NBACK_VOICE_SPEED").pipe(Config.withDefault(1.0)),
  stability: Config.number("NBACK_VOICE_STABILITY").pipe(Config.withDefault(0.5)),
  similarityBoost: Config.number("NBACK_VOICE_SIMILARITY").pipe(Config.withDefault(0.75)),
  voiceId: Config.string("NBACK_VOICE_ID").pipe(Config.withDefault("C7KFSYTllManKOBX99re")),
  voiceName: Config.string("NBACK_VOICE_NAME").pipe(Config.withDefault("Severus Burbea")),
})

const program = Effect.gen(function* () {
  const config = yield* configuration
  const api = yield* makeClient(config.apiKey)
  const settings = {
    voiceId: config.voiceId,
    modelId: config.modelId,
    outputFormat: config.outputFormat,
    speed: config.speed,
    stability: config.stability,
    similarityBoost: config.similarityBoost,
  }

  // Synthesis is stochastic even with a fixed seed: a render can bleed
  // context letters, add a breathy tail, come out truncated, or drawl. Each
  // candidate clip must land inside the duration window and transcribe back
  // to its letter; rejected candidates are re-synthesized with a fresh seed.
  const synthesisAttempts = 6
  const transcriptionAttempts = 2
  const minSpeechDuration = 0.28
  const maxSpeechDuration = 0.9
  const generateLetter = Effect.fn("AudioGenerator.generateLetter")(function* (
    temporaryDirectory: string,
    letter: Letter,
  ) {
    const rawPath = join(temporaryDirectory, `${letter.toLowerCase()}-raw.audio`)
    const workPrefix = join(temporaryDirectory, letter.toLowerCase())
    const finalPath = join(temporaryDirectory, `${letter.toLowerCase()}.wav`)
    const rejected: Array<string> = []

    for (let attemptIndex = 0; attemptIndex < synthesisAttempts; attemptIndex += 1) {
      const seed = config.seed + attemptIndex * 101
      const synthesized = yield* api.synthesizeLetter(settings, letter, seed).pipe(
        Effect.mapError((cause) => new GenerationError({ operation: `synthesize.${letter}`, message: String(cause) })),
      )
      yield* attempt("writeFile", () => writeFile(rawPath, synthesized))
      const duration = yield* processClip(rawPath, workPrefix, finalPath)

      if (duration < minSpeechDuration || duration > maxSpeechDuration) {
        rejected.push(`${duration.toFixed(2)}s`)
        yield* Effect.log(`${letter}: rejected ${duration.toFixed(2)}s candidate (seed ${seed}), re-synthesizing...`)
        continue
      }

      let mismatch: string | undefined
      for (let transcription = 0; transcription < transcriptionAttempts; transcription += 1) {
        const result = yield* api.transcribe(finalPath).pipe(
          Effect.mapError((cause) => new GenerationError({ operation: `verify.${letter}`, message: String(cause) })),
        )
        if (spokenLetterAliases[letter].has(normalizedToken(result.text))) {
          yield* Effect.log(`${letter} -> ${result.text.trim()} (${duration.toFixed(2)}s, seed ${seed})`)
          return finalPath
        }
        mismatch = result.text
        rejected.push(result.text)
      }
      yield* Effect.log(`${letter}: rejected candidate transcribed ${JSON.stringify(mismatch)} (seed ${seed}), re-synthesizing...`)
    }

    return yield* new GenerationError({
      operation: `verify.${letter}`,
      message: `No candidate for ${letter} passed verification: ${JSON.stringify(rejected)}`,
    })
  })

  const temporaryDirectory = yield* attempt("mkdtemp", () => mkdtemp(join(tmpdir(), "nback-audio-")))
  yield* Effect.addFinalizer(() => attempt("cleanup", () => rm(temporaryDirectory, { recursive: true, force: true })).pipe(Effect.ignore))

  yield* Effect.log(`Synthesizing ${LETTERS.length} letters with ${config.voiceName} (${config.modelId})...`)
  const generated = yield* Effect.forEach(
    LETTERS,
    (letter) => generateLetter(temporaryDirectory, letter),
    { concurrency: 4 },
  )

  yield* attempt("mkdir", () => mkdir(config.outputDirectory, { recursive: true }))
  yield* Effect.forEach(generated, (path) =>
    attempt("install", () => rename(path, join(config.outputDirectory, basename(path)))),
  )
  yield* Effect.log(`Installed verified audio in ${config.outputDirectory}`)
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))

Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
