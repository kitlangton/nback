import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { Storage } from "../src/services/storage.js"

const withStorage = async <A>(run: (path: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "nback-storage-"))
  try {
    return await run(join(directory, "data.json"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("loads the default daily goal from existing data", () =>
  withStorage(async (path) => {
    await writeFile(path, JSON.stringify({
      version: 1,
      controls: { position: "a", sound: "s" },
      blocks: [],
    }))

    const data = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        return yield* storage.load()
      }).pipe(Effect.provide(Storage.layer(path))),
    )

    expect(data.dailyGoal).toBe(10)
  }))

test("persists and bounds the daily goal", () =>
  withStorage(async (path) => {
    const data = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        yield* storage.saveDailyGoal(40)
        return yield* storage.load()
      }).pipe(Effect.provide(Storage.layer(path))),
    )

    expect(data.dailyGoal).toBe(30)
  }))
