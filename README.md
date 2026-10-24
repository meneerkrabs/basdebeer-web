# Bas de Beer in de browser

Een web-port van de Bas de Beer-boeken van Mindwarp (1996–1999): *Naar Paaseiland*, *Naar Pirateneiland* en *Naar het Noorderlicht*.

De originele programma's waren Delphi-applicaties met een eigen script-engine (`.BSB`-scripts, BMP, WAV, AVI en MIDI). Deze port bouwt die engine en de minispellen na in TypeScript, op een kleine emulatielaag voor de stukken Win32/VCL die de spellen gebruikten (BitBlt met raster-ops, `sndPlaySound`, TTimer, MS Video 1-AVI's).

**Er zitten geen spelbestanden in deze repo.** De speler laadt in de browser zijn eigen ISO of CD-map (bijvoorbeeld de ISO's van [archive.org](https://archive.org/details/bas-de-beer-collectie)). De ISO wordt lokaal bewaard (Origin Private File System) en direct gelezen; er wordt niets geüpload.

## Ontwikkelen

```bash
npm install
npm run dev          # http://localhost:5199
```

Voor snelle ontwikkeling kun je de ISO's ook uitpakken naar `public/data/` (gitignored). Daarna zijn ze beschikbaar zonder ze in de browser te kiezen:

```bash
node tools/extract.mjs ~/Downloads   # map met de ISO's; vereist bsdtar en ffmpeg
```

Losse minispellen testen: `?game=1` (na het kiezen van het boek). Tests:

```bash
node tools/fuzz-rongo.ts 2000              # fuzz de Rongo Rongo-toestandsmachine met de originele range-checks
node tools/test-avi.ts <bestand.avi>       # vergelijk de MS Video 1-decoder met ffmpeg
```

## Structuur

- `src/engine/` — emulatielaag: `surface.ts` (GDI/BitBlt), `vcl.ts` (forms, timers, input, Delphi `Random`), `audio.ts` (`sndPlaySound`, TMediaPlayer), `avi.ts`, `vfs.ts` (ISO9660-lezer), `assets.ts`
- `src/games/<boek>/` — minispellen, geport uit de gedecompileerde `TfrmGn`-forms
- `docs/re/` — reverse-engineering-notities per engine

## Credits: MIDI-weergave

De MIDI-bestanden van de games worden in de browser gesynthetiseerd (lazy geladen bij het eerste `playMidi`):

- [spessasynth_lib](https://github.com/spessasus/spessasynth_lib) 4.3.x (Apache-2.0), AudioWorklet SoundFont-synthesizer.
- SoundFont: [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) 2.0.3 door S. Christian Collins (`src/assets/GeneralUser-GS.sf2`, 32 MB). Eigen licentie: vrij te gebruiken en te herdistribueren, ook in software en commercieel (zie de licentietekst in het SF2-bestand en in de GeneralUser GS-repo).

## Credits: AI-scherp (optionele weergave)

De weergavemodus "AI-scherp" (alleen met WebGPU; anders valt het scherm stilzwijgend terug op "Glad") schaalt het beeld in tegels van 64x64 vier keer op met een klein neuraal netwerk, in een Web Worker. Het wordt pas geladen als je die modus kiest. De spellen zelf draaien ongewijzigd op de originele pixels.

- Model: Real-ESRGAN `realesr-general-x4v3` (SRVGGNetCompact, ~1,2M parameters) door Xintao Wang et al., [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN), **BSD-3-Clause** (Copyright (c) 2021 Xintao Wang). ONNX-fp16-export (2,3 MB, `src/assets/realesr-general-x4v3.fp16.onnx`) van [skillsafe-ai/realesr-general-x4v3](https://huggingface.co/skillsafe-ai/realesr-general-x4v3), gemaakt uit de officiële v0.2.5.0-gewichten; de gewichten blijven BSD-3-Clause.
- Runtime: [onnxruntime-web](https://github.com/microsoft/onnxruntime) 1.30.0 (MIT), WebGPU-provider. Let op: de self-contained `bundle`-build van 1.30 crasht in WebGPU-modus, daarom gebruikt `vite.config.ts` de gewone build en levert `ai.worker.ts` de wasm (~27 MB, alleen geladen in deze modus) en het model als losse assets.
- Debug-opties: `?display=ai`, `?aiin=raw` (ruwe pixels als invoer in plaats van de ontdithered tegel), `?aibatch=`, `?aistable=`.
