export const LETTERS = ["C", "H", "K", "L", "Q", "R", "S", "T"] as const
export type Letter = (typeof LETTERS)[number]

export const POSITIONS = [0, 1, 2, 3, 5, 6, 7, 8] as const
export type Position = (typeof POSITIONS)[number]

export interface Trial {
  readonly letter: Letter
  readonly position: Position
  readonly soundTarget: boolean
  readonly positionTarget: boolean
}

export interface Response {
  readonly sound: boolean
  readonly position: boolean
}

export interface ModalityScore {
  readonly hits: number
  readonly misses: number
  readonly falseAlarms: number
  readonly correctRejections: number
  readonly accuracy: number
  readonly dPrime: number
}

export interface BlockScore {
  readonly sound: ModalityScore
  readonly position: ModalityScore
  readonly accuracy: number
}

export interface Block {
  readonly n: number
  readonly trials: ReadonlyArray<Trial>
}

const SCORED_TRIALS = 20
const DUAL_TARGETS = 2
const SINGLE_MODALITY_TARGETS = 4

const randomIndex = (length: number, random: () => number): number => Math.floor(random() * length)

const shuffled = <A>(values: ReadonlyArray<A>, random: () => number): Array<A> => {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = randomIndex(index + 1, random)
    const value = result[index]
    result[index] = result[other]!
    result[other] = value!
  }
  return result
}

const nonMatching = <A>(values: ReadonlyArray<A>, excluded: A, random: () => number): A => {
  const candidates = values.filter((value) => value !== excluded)
  return candidates[randomIndex(candidates.length, random)]!
}

export const makeBlock = (n: number, random: () => number = Math.random): Block => {
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new RangeError("N must be an integer from 1 to 10")

  const targetOrder = shuffled(Array.from({ length: SCORED_TRIALS }, (_, index) => n + index), random)
  const dualTargets = targetOrder.slice(0, DUAL_TARGETS)
  const soundTargets = new Set([
    ...dualTargets,
    ...targetOrder.slice(DUAL_TARGETS, DUAL_TARGETS + SINGLE_MODALITY_TARGETS),
  ])
  const positionTargets = new Set([
    ...dualTargets,
    ...targetOrder.slice(
      DUAL_TARGETS + SINGLE_MODALITY_TARGETS,
      DUAL_TARGETS + 2 * SINGLE_MODALITY_TARGETS,
    ),
  ])
  const trials: Array<Trial> = []

  for (let index = 0; index < n + SCORED_TRIALS; index += 1) {
    const soundTarget = soundTargets.has(index)
    const positionTarget = positionTargets.has(index)
    const previous = trials[index - n]

    const letter = previous
      ? soundTarget
        ? previous.letter
        : nonMatching(LETTERS, previous.letter, random)
      : LETTERS[randomIndex(LETTERS.length, random)]!

    const position = previous
      ? positionTarget
        ? previous.position
        : nonMatching(POSITIONS, previous.position, random)
      : POSITIONS[randomIndex(POSITIONS.length, random)]!

    trials.push({ letter, position, soundTarget, positionTarget })
  }

  return { n, trials }
}

const inverseNormal = (probability: number): number => {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924]
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857]
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878]
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]
  const low = 0.02425
  const high = 1 - low

  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (probability <= high) {
    const q = probability - 0.5
    const r = q * q
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  }
  const q = Math.sqrt(-2 * Math.log(1 - probability))
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
}

const scoreModality = (
  trials: ReadonlyArray<Trial>,
  responses: ReadonlyArray<Response>,
  target: (trial: Trial) => boolean,
  response: (value: Response) => boolean,
): ModalityScore => {
  let hits = 0
  let misses = 0
  let falseAlarms = 0
  let correctRejections = 0

  for (let index = 0; index < trials.length; index += 1) {
    const isTarget = target(trials[index]!)
    const didRespond = response(responses[index] ?? { sound: false, position: false })
    if (isTarget && didRespond) hits += 1
    else if (isTarget) misses += 1
    else if (didRespond) falseAlarms += 1
    else correctRejections += 1
  }

  const targetCount = hits + misses
  const nonTargetCount = falseAlarms + correctRejections
  const hitRate = (hits + 0.5) / (targetCount + 1)
  const falseAlarmRate = (falseAlarms + 0.5) / (nonTargetCount + 1)

  return {
    hits,
    misses,
    falseAlarms,
    correctRejections,
    accuracy: (hits / targetCount + correctRejections / nonTargetCount) / 2,
    dPrime: inverseNormal(hitRate) - inverseNormal(falseAlarmRate),
  }
}

export const scoreBlock = (block: Block, responses: ReadonlyArray<Response>): BlockScore => {
  const scoredTrials = block.trials.slice(block.n)
  const scoredResponses = responses.slice(block.n)
  const sound = scoreModality(scoredTrials, scoredResponses, (trial) => trial.soundTarget, (value) => value.sound)
  const position = scoreModality(
    scoredTrials,
    scoredResponses,
    (trial) => trial.positionTarget,
    (value) => value.position,
  )
  return { sound, position, accuracy: Math.min(sound.accuracy, position.accuracy) }
}

type AdaptationScore = {
  readonly sound: Pick<ModalityScore, "accuracy">
  readonly position: Pick<ModalityScore, "accuracy">
}

export const nextN = (n: number, score: AdaptationScore): number => {
  const weakerAccuracy = Math.min(score.sound.accuracy, score.position.accuracy)
  if (weakerAccuracy >= 0.8) return Math.min(10, n + 1)
  if (weakerAccuracy < 0.65) return Math.max(1, n - 1)
  return n
}
