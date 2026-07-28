#!/usr/bin/env bun

import { render } from "@opentui/solid"

import { App } from "./App.js"

render(() => <App />, {
  targetFps: 30,
  exitOnCtrlC: true,
})
