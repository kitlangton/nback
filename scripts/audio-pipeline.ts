import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { promisify } from "node:util"

import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import type { Letter } from "../src/domain.js"

const execFileAsync = promisify(execFile)
export const apiBaseUrl = "https://api.elevenlabs.io"

export class GenerationError extends Schema.TaggedErrorClass<GenerationError>()("AudioGenerationError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new GenerationError({ operation, message: String(cause) }),
  })

export const runCommand = (command: string, args: ReadonlyArray<string>) =>
  attempt(command, async () => {
    const result = await execFileAsync(command, [...args], { maxBuffer: 10 * 1024 * 1024 })
    return `${result.stdout}\n${result.stderr}`
  })

export const probeDuration = (path: string) =>
  attempt("ffprobe", async () => {
    const result = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      { maxBuffer: 1024 * 1024 },
    )
    const duration = Number(result.stdout.trim())
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid duration for ${path}`)
    return duration
  })

interface Levels {
  readonly mean: number
  readonly peak: number
}

const measureLevels = (path: string) =>
  Effect.gen(function* () {
    const output = yield* runCommand("ffmpeg", ["-i", path, "-af", "volumedetect", "-f", "null", "-"])
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(output)?.[1])
    const peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(output)?.[1])
    if (!Number.isFinite(mean) || !Number.isFinite(peak)) {
      return yield* new GenerationError({ operation: "measureLevels", message: `Could not measure ${path}` })
    }
    return { mean, peak } satisfies Levels
  })

interface SpeechBounds {
  readonly speechStart: number
  readonly speechEnd: number
}

// Sound regions separated by less than this gap are treated as one phoneme.
// The gap must stay wider than the stop closure inside letters like "aitch"
// but narrower than the pause before stray mouth clicks and breath blips.
const mergeGap = 0.08

// Speech boundaries measured on the already-normalized clip so the -60 dB
// threshold means the same thing for quiet and loud renders alike. The
// boundaries come from the longest merged sound region: TTS renders often
// carry an isolated click or breath after the letter, and taking "last sound
// before end of file" as the speech end would keep it.
const detectSpeechBounds = (path: string, total: number) =>
  Effect.gen(function* () {
    const output = yield* runCommand("ffmpeg", ["-i", path, "-af", "silencedetect=n=-60dB:d=0.03", "-f", "null", "-"])
    const starts = [...output.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]))
    const ends = [...output.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]))

    // Complement of the silence intervals: the clip's sound regions.
    const regions: Array<{ start: number; end: number }> = []
    let cursor = 0
    for (let index = 0; index < starts.length; index += 1) {
      const silenceStart = Math.max(0, starts[index]!)
      if (silenceStart > cursor + 0.001) regions.push({ start: cursor, end: silenceStart })
      cursor = ends[index] ?? total
    }
    if (cursor < total - 0.001) regions.push({ start: cursor, end: total })
    if (regions.length === 0) return { speechStart: 0, speechEnd: total } satisfies SpeechBounds

    const merged: Array<{ start: number; end: number }> = [regions[0]!]
    for (const region of regions.slice(1)) {
      const previous = merged.at(-1)!
      if (region.start - previous.end <= mergeGap) previous.end = region.end
      else merged.push({ ...region })
    }

    const longest = merged.reduce((best, region) => (region.end - region.start > best.end - best.start ? region : best))
    return { speechStart: longest.start, speechEnd: longest.end } satisfies SpeechBounds
  })

// Every clip is normalized to the same perceived loudness, then capped below
// the peak ceiling so no letter jumps out of the stimulus stream.
const targetMean = -20
const peakCeiling = -1.5

// The margins keep natural room around the phoneme. Cutting at the detected
// silence edge audibly truncates soft onsets and decay tails.
const onsetMargin = 0.04
const decayMargin = 0.09

/**
 * Normalize, trim with margins, fade, and pad one synthesized clip.
 * Returns the detected speech duration (margins excluded).
 *
 * Order matters: gain is applied before boundary detection so the silence
 * threshold is consistent, and the boundaries keep margins so the fade-out
 * rides near-silence instead of chopping the decay.
 */
export const processClip = (rawPath: string, workPrefix: string, finalPath: string) =>
  Effect.gen(function* () {
    const decodedPath = `${workPrefix}-decoded.wav`
    const normalizedPath = `${workPrefix}-normalized.wav`

    yield* runCommand("ffmpeg", [
      "-y", "-v", "error", "-i", rawPath,
      "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", decodedPath,
    ])

    // Deterministic gain: bring the clip to the shared loudness target while
    // never letting its peak cross the ceiling. loudnorm is unreliable on
    // sub-second clips, which is why earlier sets had uneven volume.
    const levels = yield* measureLevels(decodedPath)
    const gain = Math.min(targetMean - levels.mean, peakCeiling - levels.peak)
    yield* runCommand("ffmpeg", [
      "-y", "-v", "error", "-i", decodedPath,
      "-af", `volume=${gain.toFixed(2)}dB`,
      "-c:a", "pcm_s16le", normalizedPath,
    ])

    const total = yield* probeDuration(normalizedPath)
    const bounds = yield* detectSpeechBounds(normalizedPath, total)
    const cutStart = Math.max(0, bounds.speechStart - onsetMargin)
    const cutEnd = Math.min(total, bounds.speechEnd + decayMargin)
    const length = cutEnd - cutStart
    if (length <= 0.05) {
      return yield* new GenerationError({ operation: "trim", message: `Clip collapsed to ${length.toFixed(2)}s` })
    }

    // The fade-in is a 5 ms declick only: anything longer dulls the attack of
    // plosives such as K and T. The fade-out sits inside the kept margin.
    const fadeIn = 0.005
    const fadeOut = Math.min(0.05, length / 4)
    yield* runCommand("ffmpeg", [
      "-y", "-v", "error", "-i", normalizedPath,
      "-af",
      `atrim=start=${cutStart.toFixed(4)}:end=${cutEnd.toFixed(4)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${(length - fadeOut).toFixed(4)}:d=${fadeOut},adelay=120,apad=pad_dur=0.12`,
      "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", finalPath,
    ])

    return bounds.speechEnd - bounds.speechStart
  })

export interface SynthesisSettings {
  readonly voiceId: string
  readonly modelId: string
  readonly outputFormat: string
  readonly speed: number
  readonly stability: number
  readonly similarityBoost: number
}

const Transcript = Schema.Struct({
  text: Schema.String,
})

const VoiceList = Schema.Struct({
  voices: Schema.Array(
    Schema.Struct({
      voice_id: Schema.String,
      name: Schema.String,
    }),
  ),
})

export interface ApiVoice {
  readonly voiceId: string
  readonly name: string
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/**
 * ElevenLabs client for letter synthesis, transcription, and voice listing.
 *
 * previous_text gives each request the prosody of a steady "The letter X."
 * carrier phrase without being part of the rendered audio, so every clip
 * contains exactly one cleanly articulated letter. There is deliberately no
 * next_text: with trailing context the model would sometimes keep talking
 * past the letter (Q rendered "QR", K rendered a second "kay"), and a bleed
 * fused to the letter cannot be trimmed away afterwards. The utterance ends
 * where the text ends, so there is nothing to follow.
 */
export const makeClient = (apiKey: Redacted.Redacted) =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient
    const client = baseClient.pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("xi-api-key", Redacted.value(apiKey))),
      HttpClient.filterStatusOk,
    )

    const synthesizeLetter = Effect.fn("AudioPipeline.synthesizeLetter")(function* (
      settings: SynthesisSettings,
      letter: Letter,
      seed: number,
    ) {
      const index = alphabet.indexOf(letter)
      const before = [...alphabet.slice(Math.max(0, index - 2), index)].map((entry) => `The letter ${entry}. `).join("")
      const request = yield* HttpClientRequest.post(
        `${apiBaseUrl}/v1/text-to-speech/${settings.voiceId}?output_format=${settings.outputFormat}`,
      ).pipe(
        HttpClientRequest.setHeader("accept", "audio/*"),
        HttpClientRequest.bodyJson({
          text: `${letter}.`,
          model_id: settings.modelId,
          previous_text: `${before}The letter `,
          seed,
          voice_settings: {
            speed: settings.speed,
            stability: settings.stability,
            similarity_boost: settings.similarityBoost,
          },
        }),
      )
      const response = yield* client.execute(request)
      return new Uint8Array(yield* response.arrayBuffer)
    })

    const transcribe = Effect.fn("AudioPipeline.transcribe")(function* (path: string) {
      const bytes = yield* attempt("readFile", () => readFile(path))
      const form = new FormData()
      form.append("model_id", "scribe_v1")
      form.append("language_code", "eng")
      form.append("file", new Blob([bytes]), basename(path))

      return yield* HttpClientRequest.post(`${apiBaseUrl}/v1/speech-to-text`).pipe(
        HttpClientRequest.bodyFormData(form),
        client.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Transcript)),
      )
    })

    const listVoices = Effect.fn("AudioPipeline.listVoices")(function* () {
      const response = yield* client.execute(HttpClientRequest.get(`${apiBaseUrl}/v2/voices?page_size=100`))
      const parsed = yield* HttpClientResponse.schemaBodyJson(VoiceList)(response)
      return parsed.voices.map((voice) => ({ voiceId: voice.voice_id, name: voice.name }) satisfies ApiVoice)
    })

    return { synthesizeLetter, transcribe, listVoices }
  })
