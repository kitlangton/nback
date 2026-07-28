# nback

An adaptive dual n-back trainer built with [OpenTUI](https://github.com/anomalyco/opentui), Effect, and Solid.

```text
BLOCK 4             3-BACK             12 / 23

               ...  ...  ...
               ...  ###  ...
               ...  ...  ...

          [ A ] POSITION    [ S ] SOUND
```

## Run

Requires [Bun](https://bun.sh) and macOS, Linux, or Windows with an audio output device.

```sh
bunx @kitlangton/nback
```

Or run it from source:

```sh
git clone https://github.com/kitlangton/nback.git
cd nback
bun install
bun run start
```

## Interaction

- Each block has `N` warm-up trials and 20 scored trials.
- A position flashes for 500 ms while a spoken letter plays, followed by a 2.5-second response window.
- Press `A` for a position match and `S` for a sound match. Both keys are configurable.
- Responses are one-way and correctness is shown only after the block.
- Blocks raise `N` when both modalities reach 80% balanced accuracy and lower it when either falls below 65%. You can override the next level.
- There is no pause or replay. Escape discards the current partial block.
- Completed blocks are saved locally. There are no accounts, streaks, schedules, or telemetry.

## What the evidence says

Dual n-back reliably improves performance on the trained task and closely related working-memory tasks. Evidence for transfer to fluid intelligence, broad attention, or everyday cognition is weak and inconsistent, especially in preregistered studies with active controls. This project makes no IQ or general cognitive-enhancement claims.

Each block follows the original target composition: six targets per modality, with four unique to each modality and two simultaneous. The training score is the lower balanced accuracy of the two modalities, so a stronger stream cannot hide a weaker one. Balanced accuracy prevents always pressing or always withholding from producing a misleading score. The app also records d-prime, which distinguishes discrimination from response bias.

Useful reviews and studies:

- [Jaeggi et al. (2008), original adaptive dual n-back procedure](https://doi.org/10.1073/pnas.0801268105)
- [Soveri et al. (2017), *Working memory training revisited*](https://doi.org/10.3758/s13423-016-1217-0)
- [Melby-Lervag, Redick, and Hulme (2016), *Working Memory Training Does Not Improve Performance on Measures of Intelligence*](https://doi.org/10.1177/1745691616635612)
- [Syed et al. (2024), second-order meta-analysis](https://doi.org/10.3390/jintelligence12110114)
- [Redick et al. (2013), preregistered active-control trial](https://doi.org/10.1037/a0029082)

## Audio

The bundled consonants are synthesized individually with ElevenLabs' male Eric voice as PCM WAV files with matched loudness and identical onset padding. OpenTUI's native audio engine preloads and plays them locally; gameplay does not make network requests.

Regenerate the complete audio set with:

```sh
ELEVENLABS_API_KEY=... bun run audio:generate
```

Each letter is rendered as its own clip, using ElevenLabs' `previous_text`/`next_text` context so the delivery has the cadence of a steady spelling list without any surrounding words in the audio. The generator trims boundary silence, applies measured gain toward a shared loudness target with a peak ceiling, adds 40 ms fades and identical 120 ms onset and tail padding, and transcribes every candidate clip with ElevenLabs Scribe. Candidates that do not transcribe back to their letter are re-synthesized with a fresh seed, and project assets are replaced only after all eight clips pass. Set `NBACK_VOICE_ID` and `NBACK_VOICE_NAME` to use another ElevenLabs voice.

## Data

History and controls are stored at `$XDG_DATA_HOME/nback-tui/data.json`, or `~/.local/share/nback-tui/data.json` when `XDG_DATA_HOME` is unset.

## License

MIT
