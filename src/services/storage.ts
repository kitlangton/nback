import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { Context, Effect, Layer, Schema } from "effect"

const Controls = Schema.Struct({
  position: Schema.String,
  sound: Schema.String,
})
export interface Controls extends Schema.Schema.Type<typeof Controls> {}

const ModalityRecord = Schema.Struct({
  hits: Schema.Number,
  misses: Schema.Number,
  falseAlarms: Schema.Number,
  correctRejections: Schema.Number,
  accuracy: Schema.Number,
  dPrime: Schema.Number,
})

export const BlockRecord = Schema.Struct({
  timestamp: Schema.Number,
  n: Schema.Number,
  accuracy: Schema.Number,
  position: ModalityRecord,
  sound: ModalityRecord,
})
export interface BlockRecord extends Schema.Schema.Type<typeof BlockRecord> {}

const AppData = Schema.Struct({
  version: Schema.Literal(1),
  controls: Controls,
  blocks: Schema.Array(BlockRecord),
  tutorialCompletedAt: Schema.optionalKey(Schema.Number),
})
export interface AppData extends Schema.Schema.Type<typeof AppData> {}

const defaults: AppData = { version: 1, controls: { position: "a", sound: "s" }, blocks: [] }

const normalizeBlock = (block: BlockRecord): BlockRecord => ({
  ...block,
  accuracy: Math.min(block.position.accuracy, block.sound.accuracy),
})

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("Storage.StorageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly load: () => Effect.Effect<AppData, StorageError>
  readonly addBlock: (block: BlockRecord) => Effect.Effect<void, StorageError>
  readonly saveControls: (controls: Controls) => Effect.Effect<void, StorageError>
  readonly setTutorialCompleted: (timestamp: number) => Effect.Effect<void, StorageError>
}

export class Service extends Context.Service<Service, Interface>()("nback/Storage") {}

export const layer = (path: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const read = Effect.fn("Storage.read")(function* () {
        const text = yield* Effect.tryPromise({
          try: () => readFile(path, "utf8"),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) => {
            if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
              return Effect.succeed(JSON.stringify(defaults))
            }
            return new StorageError({ operation: "read", message: String(cause) })
          }),
        )
        const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AppData))(text).pipe(
          Effect.mapError((cause) => new StorageError({ operation: "decode", message: String(cause) })),
        )
        return { ...data, blocks: data.blocks.map(normalizeBlock) }
      })

      const write = Effect.fn("Storage.write")(function* (data: AppData) {
        const text = yield* Schema.encodeEffect(Schema.fromJsonString(AppData))(data).pipe(
          Effect.mapError((cause) => new StorageError({ operation: "encode", message: String(cause) })),
        )
        const temporary = `${path}.tmp`
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            await writeFile(temporary, text, "utf8")
            await rename(temporary, path)
          },
          catch: (cause) => new StorageError({ operation: "write", message: String(cause) }),
        })
      })

      const load = Effect.fn("Storage.load")(read)
      const addBlock = Effect.fn("Storage.addBlock")(function* (block: BlockRecord) {
        const data = yield* read()
        yield* write({ ...data, blocks: [...data.blocks, block] })
      })
      const saveControls = Effect.fn("Storage.saveControls")(function* (controls: Controls) {
        const data = yield* read()
        yield* write({ ...data, controls })
      })
      const setTutorialCompleted = Effect.fn("Storage.setTutorialCompleted")(function* (timestamp: number) {
        const data = yield* read()
        yield* write({ ...data, tutorialCompletedAt: timestamp })
      })

      return Service.of({ load, addBlock, saveControls, setTutorialCompleted })
    }),
  )

export * as Storage from "./storage.js"
