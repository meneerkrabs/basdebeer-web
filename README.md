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
