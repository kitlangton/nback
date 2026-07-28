import { describe, expect, test } from "bun:test"

import { makeBlock, nextN, scoreBlock } from "../src/domain.js"

const random = () => 0.42

describe("makeBlock", () => {
  test("creates N warm-ups and twenty scored trials", () => {
    expect(makeBlock(3, random).trials).toHaveLength(23)
  })

  test("creates four single-modality and two dual targets", () => {
    const block = makeBlock(2, random)
    const scored = block.trials.slice(block.n)
    expect(scored.filter((trial) => trial.positionTarget)).toHaveLength(6)
    expect(scored.filter((trial) => trial.soundTarget)).toHaveLength(6)
    expect(scored.filter((trial) => trial.positionTarget && trial.soundTarget)).toHaveLength(2)
  })

  test("prevents accidental N-back matches", () => {
    const block = makeBlock(4, random)
    for (let index = block.n; index < block.trials.length; index += 1) {
      const trial = block.trials[index]!
      const previous = block.trials[index - block.n]!
      expect(trial.letter === previous.letter).toBe(trial.soundTarget)
      expect(trial.position === previous.position).toBe(trial.positionTarget)
    }
  })
})

describe("scoreBlock", () => {
  test("scores perfect target responses", () => {
    const block = makeBlock(2, random)
    const responses = block.trials.map((trial) => ({ sound: trial.soundTarget, position: trial.positionTarget }))
    const score = scoreBlock(block, responses)
    expect(score.accuracy).toBe(1)
    expect(score.sound.hits).toBe(6)
    expect(score.sound.falseAlarms).toBe(0)
    expect(score.sound.dPrime).toBeGreaterThan(2)
  })

  test("does not count warm-up trials", () => {
    const block = makeBlock(2, random)
    const responses = block.trials.map((trial, index) => ({
      sound: index < block.n || trial.soundTarget,
      position: index < block.n || trial.positionTarget,
    }))
    expect(scoreBlock(block, responses).accuracy).toBe(1)
  })

  test("scores always withholding at chance", () => {
    const block = makeBlock(2, random)
    const responses = block.trials.map(() => ({ sound: false, position: false }))
    expect(scoreBlock(block, responses).accuracy).toBe(0.5)
    expect(nextN(2, scoreBlock(block, responses))).toBe(1)
  })
})

describe("nextN", () => {
  const score = (soundAccuracy: number, positionAccuracy: number) => ({
    sound: { accuracy: soundAccuracy },
    position: { accuracy: positionAccuracy },
  })

  test("raises only when both modalities reach 80% balanced accuracy", () => {
    expect(nextN(2, score(0.8, 0.8))).toBe(3)
    expect(nextN(2, score(0.8, 0.79))).toBe(2)
  })

  test("lowers when either modality falls below 65% balanced accuracy", () => {
    expect(nextN(2, score(0.65, 0.65))).toBe(2)
    expect(nextN(2, score(0.65, 0.64))).toBe(1)
  })

  test("stays within supported levels", () => {
    expect(nextN(10, score(1, 1))).toBe(10)
    expect(nextN(1, score(0, 0))).toBe(1)
  })
})
