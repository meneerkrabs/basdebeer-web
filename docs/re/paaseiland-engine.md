# Bas de Beer naar Paaseiland: engine spec (PAASBAAS.EXE story book)

Reverse-engineered from `basdebeer-extract/paaseiland/BASWIN/PAASBAAS.EXE` (Delphi 2, Win32). The
Ghidra output, capstone disassembly and DFM text are in `basdebeer-tools/decomp/PAASBAAS.*`. This spec
is written for a faithful TypeScript/browser reimplementation. Addresses are PAASBAAS.EXE VAs.
`+0x...` offsets are `TfrmMain` instance fields. They are given so every claim can be re-checked.
**[?]** marks an uncertainty.

Colours in the binary are Win32 COLORREF (`0x00BBGGRR`). Every colour below is given as CSS `#RRGGBB`.
Rectangles are `(left, top, right, bottom)`. "PtInRect" means the Win32 semantics (right and bottom
exclusive). "Inclusive" means the engine's own helper `FUN_0042a6b0`, where all four edges count.

This engine differs a lot from the Pirateneiland one (`pirateneiland-engine.md`). The command names
overlap, but the argument lists, layout, timing and interaction are different. Don't share code
paths blindly.

---------------------------------------------------------------------------------------------------

## 0. Quick reference

| Thing | Value | Source |
|---|---|---|
| Book window `frmMain` | 640x480, `bsNone`, colour black, `poScreenCenter`, caption "Bas de Beer naar Paaseiland" | `FormCreate_43fc48`, `entry` |
| Buffers | front buffer `+0x1c8` (640x480, painted by `FormPaint_4402ec` at 0,0) and back buffer `+0x1cc` (640x480, "clean" scene without text, bee or tip-hive) | `43fc48`, `4402ec` |
| Screen bands (normal page) | header 0..80 (`HEADER.BMP`), picture 80..400 (`Ixxx.BMP` 640x320), menu bar 400..480 (`MENU.BMP`) | `FUN_0043f554` |
| Script timer | `ScriptTimer`, interval **10 ms**, reset to 10 before every script line. Real Win95 granularity is about 55 ms. | DFM, `ScriptTimerTimer_43dd50` |
| One script line per tick | yes. Blocking commands switch to a wait state. | `43dd50` case 1 |
| Script coords | x as is, **y + 80** (relative to the picture band), for every scene including full-screen ones | `FUN_00441574`, `FUN_00442364` |
| Text font | **Arial, bold, `Font.Height = 17`** (cell height 17 px, about 15 px em) | `FUN_004426f8` (`0x443030`, `0x443038`) |
| Text area on screen | (100,7)-(604,72): 504x65, 3 visible lines, **line pitch 21 px** | `FUN_0044308c` |
| Text colours | `INIT_TEXTBOX a~b~` maps to 16-colour palette indices. In the data, `4` (navy `#000080`) is the normal colour and `9` (red `#FF0000`) or `10` (lime `#00FF00`) is the highlight. | `FUN_0043d638` |
| Persistence | registry `HKCU\Software\Mindwarp\Bas de beer\Naar Paaseiland\` section `BerenBoek`, value `Boekenlegger` = scene number | `FormClose_443ac4`, `FormCreate_43cb88` |
| Paths | `<exe dir>\IMAGES\` (BMP and AVI), `\SOUNDS\` (WAV), `\SCRIPTS\` (`NNN.BSB`). `HELPBOEK.TXT` is in the CD root. | `FUN_0042a770`, `FormActivate_43d300` |
| Script encoding | every byte +1. Decode as byte-1. Lines are CRLF. Text is cp1252. | `FUN_0043f554` |

---------------------------------------------------------------------------------------------------

## 1. Program flow

### 1.1 Start-up (`entry @0x4440c8`, `FUN_0042a770`, `FormCreate_43fc48`)

1. Unit init `FUN_0042a770` builds the paths from the exe directory: `IMAGES\`, `SOUNDS\`, `SCRIPTS\`.
   Debug switch: if `ParamStr(1) = '/D'`, the data paths come from `Copy(ParamStr(2), 4, ...)` and the
   start scene from `Copy(ParamStr(3), 4, ...)` (ScriptTimer state 0). Ignore this in the web port.
2. Forms are created in this order: `frmMain` (main form), `frmBackGround`, `frmStartup`, `frmHelp`.
   `TfrmEnding` exists in the DFM but is **never instantiated**. The credits use a runtime class
   `TAftitelScherm` instead (section 9.4).
3. `frmMain.FormCreate`:
   - `sndPlaySound(nil, SND_MEMORY)` checks that a sound card exists. If it fails, the game shows
     "Er is geen geluidskaart aangetroffen. Bas de Beer kan niet opstarten" and terminates.
   - It sets Width 640, Height 480, `poScreenCenter` and Color black, and creates the bitmaps:
     `HEADER.BMP` (`+0x1b8`, 640x80), `MENU.BMP` (`+0x1bc`, 819x80), `PIJLEN.BMP` (`+0x1c0`, 40x50),
     the main picture (`+0x1c4`), the front buffer (`+0x1c8`) and the back buffer (`+0x1cc`).
   - Built-in animation slots 1..3 (the bee, section 6.6): `BijUit` = `PBA001.BMP`, 14 frames,
     100 ms, rect (9,19)-(76,74). `BijIn` = `PBA002.BMP`, 16 frames, 100 ms, rect (0,33)-(82,79),
     **never used**. `Bij` = `PBS001.BMP`, 8 frames, 100 ms, rect (0,0)-(32,56), used as the flying-bee
     sprite sheet.
   - Sounds: `MNU000..MNU004.WAV` are the menu hover voices (async). `PB001.WAV` is about 51 ms of
     silence, played synchronously with `SND_NOSTOP` (a "wait until the sound is finished" probe).
     `PB002.WAV` is the bee buzz (async and looping).
   - It sets `scene(+0x20b) = 0` and `state(+0x694) = 0`. The ScriptTimer (enabled in the DFM) starts
     ticking.
4. `frmBackGround` (`FormCreate_42ab18`) covers the whole screen (Screen.Width x Screen.Height),
   centred, black and disabled. It is shown behind the book (section 9.1).
5. ScriptTimer state 0: anim count `+0x2148 = 3` (slots 1..3 are the bee), then `LoadScene(0)`.

### 1.2 Scene sequence

- Scene **0** (`000.BSB`): the 640x480 title picture with no header or menu. "Welcome" voice, a
  600 ms DELAY (in effect 1200 ms, see 3.5), then "Bas". `{END}`. Clicking Bas runs the effect and
  `{AUTO_NEXT}`.
- Leaving scene 0 (ScriptTimer state 8): if the current scene is 0, the bookmark logic runs
  (1.3) and then the next scene loads.
- Scene **1**: movie `PBM001.AVI` (`{MOVIE}` scene). Scene **2**: the first story page, which doubles
  as the interactive tutorial (the "voorbeeld" from the help text). Its `Midtext`, `Baspointer`,
  `Bzzzpointer` and `Menu1..5` animations explain the features. This is a normal script, not a
  separate demo mode, and it plays every time page 2 is shown.
- Scenes 3..30 are story pages, movie pages (4 = `PBM002.AVI`) and game pages (7, 13, 17, 22, 24).
  Scene **31** is the end picture (640x480). Any click there closes the program (1.4).

### 1.3 Bookmark ("boekenlegger")

- **Write**: only in `frmMain.FormClose` (`0x443ac4`). It stores `Boekenlegger := currentScene(+0x20c)`
  through `TRegIniFile('Software\Mindwarp\Bas de beer\Naar Paaseiland\')`, section `BerenBoek`.
  In the web port, use localStorage.
- **Read**: in `frmStartup.FormCreate` (`0x43cb88`): `b = ReadInteger(..., 'Boekenlegger', 0)`, then
  `b = MAP[b]` with the byte table at `0x445800`:

  | saved | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | resume | 0 | 2 | 2 | 3 | 3 | 5 | 6 | 6 | 8 | 9 | 10 | 11 | 12 | 12 | 14 | 15 | 16 | 16 | 18 | 19 | 20 | 21 | 21 | 23 | 23 | 25 | 26 | 27 | 28 | 29 | 0 | 0 |

  Movie and game scenes map to the page before them. 30 and 31 map to 0, which means "no bookmark".
- When scene 0 is left (state 8): if the mapped bookmark is 0, the next scene is 1 and no question is
  asked. Otherwise `frmStartup.ShowModal` (9.2) runs. ModalResult 2 ("Opnieuw Beginnen") gives scene 1.
  Anything else ("Verder gaan") gives the mapped bookmark scene. `frmStartup` is then freed.
  Quirk: a second visit to scene 0 in the same session would reuse the freed form. That can't happen
  with the shipped data, because nothing goes back to scene 0.

### 1.4 Quitting

Paths into `frmMain.Close`: JA in the EINDE dialog (6.4), a click on scene 31, `{THE_END}`, or a game
that returns result 2. `FormClose_443ac4` then does this:
`state = 2`, stop `sndPlaySound`, stop the movie if one is playing, free an active game form whose
result is still 0, write the bookmark, hide `frmMain`, create and show `TAftitelScherm` (credits, 9.4),
pump messages until it is closed, then `Application.Terminate`.

---------------------------------------------------------------------------------------------------

## 2. Screen layout (640x480 client)

### 2.1 Normal page (`displayMode +0x1f4 = 0`; scenes other than 0, 31 and `{MOVIE}`)

`LoadScene` (`FUN_0043f554`) builds the back buffer like this:
1. Fill it black with `Rectangle(0,0,640,480)`.
2. Draw `HEADER.BMP` at (0,0). This is the beehive on the left (about x 0..80) and the parchment
   scroll on the right, where the text goes.
3. Copy `MENU.BMP` (0,0)-(640,80) to (0,400)-(640,480).
4. Draw the menu-button states with `FUN_0043fa3c(1,1,0)` (section 6.3; the scene<2 branch can't
   happen).
5. Copy the whole back buffer to the front buffer.
`ACTIVATE_MAINIMAGE` later draws the 640x320 picture at **(0,80)**.

| Element | Rect | Notes |
|---|---|---|
| Header | (0,0)-(640,80) | `HEADER.BMP` |
| Bee hive hit area | (16,19)-(71,77) PtInRect | active only when a tip exists (`+0x1eac != 0`) |
| Bee hive animation `BijUit` | (9,19)-(76,74), frames 67x55 | `PBA001.BMP`, 15 frames in the strip, 1..14 used |
| Text window | (100,7)-(604,72) | 504x65, shows source rows `(top-1)*21+1 .. +66` of the text bitmap |
| Scroll up arrow | drawn at (604,10)-(625,35), hit at the same rect (PtInRect) | only if `lineCount > 3` (section 5.4) |
| Scroll down arrow | drawn at (604,44)-(625,69) | same |
| Picture | (0,80)-(640,400) | main image 640x320. Clickareas only respond inside this band. |
| Menu bar | (0,400)-(640,480) | `MENU.BMP` |

### 2.2 Menu bar (`MENU.BMP` 819x80, hit rects at `0x4457a0`, inclusive)

From left to right: EINDE (egg), HERHALEN, TERUGBLADEREN, OMSLAAN (rabbits that show an egg when the
option is available), HELP (egg). The table follows the help text order and the hover-sound order.

| # | Option | Hit rect (inclusive) | Graphic dest | "Available" source in MENU.BMP | Flag | Hover sound |
|---|---|---|---|---|---|---|
| 0 | EINDE | (35,403)-(112,475) | always in base image | - | always | MNU000.WAV |
| 1 | HERHALEN | (135,401)-(209,478) | (136,400)-(206,480) | (640,0)-(710,80), else (136,0)-(206,80) | `+0x1f1` | MNU001.WAV |
| 2 | TERUGBLADEREN | (240,415)-(302,478) | (242,400)-(301,480) | (710,0)-(769,80), else (242,0)-(301,80) | `+0x1f2` | MNU002.WAV |
| 3 | OMSLAAN | (339,404)-(405,478) | (338,400)-(388,480) | (769,0)-(819,80), else (338,0)-(388,80) | `+0x1f3` | MNU003.WAV |
| 4 | HELP | (552,402)-(625,478) | always in base image | - | always | MNU004.WAV |

The whole bar is (0,400)-(640,480). `FUN_0043fa3c(a,b,c)` draws buttons 1, 2 and 3 into the back
buffer, copies (136,400)-(388,480) to the front buffer and invalidates it. It stores `a` in `+0x1f1` and
`b` in `+0x1f2`. `c` (OMSLAAN) is drawn only: the "allowed" flag is `+0x1f3`, managed separately
(section 6.2).

### 2.3 Other display modes (`+0x1f4`)

| Value | When | Effect |
|---|---|---|
| 0 | normal page | header and menu; picture at (0,80); menu, hive, text and scroll active |
| 1 | `{MOVIE}` is line 0 of the script | back buffer black; picture at (0,0) (640x480); `frmBackGround` black; no menu; skip rect active (7.2) |
| 2 | set by `PLAY_GAME` | game in progress; menu clicks go to the game (7.1) |
| 3 | scenes 0 and 31 (not a movie) | back buffer black; picture at (0,0) (640x480); no header or menu |

When the *previous* mode was not 0, `LoadScene` first calls `FUN_00443ea4`. That recreates the
bitmaps and paints the form black. Visually this is only a black flash.

### 2.4 Fonts and colours

- Story text: Arial bold, `Height = 17` (GDI cell height, so `TextHeight('W') = 17`). For a canvas
  approximation use `bold 15px Arial` (Arial ascent+descent = 1.117 em, so the em is about 15.2 px),
  baseline at about y+14 from the word's top. No anti-aliasing in the original. Word widths come from
  GDI `TextWidth`. Browser metrics can differ by a pixel or so per word and that can change line breaks.
  **Recommendation:** ship a per-word width table measured from GDI, or accept small differences.
- Palette for `INIT_TEXTBOX` (`FUN_0043d638`, string "0".."15"; anything else gives black):
  `0 #000000, 1 #800000, 2 #008000, 3 #808000, 4 #000080, 5 #800080, 6 #008080, 7 #808080,
  8 #C0C0C0, 9 #FF0000, 10 #00FF00, 11 #FFFF00, 12 #0000FF, 13 #FF00FF, 14 #00FFFF, 15 #FFFFFF`.
- Startup form: Times New Roman bold, `Height = 27`, black, transparent background.

---------------------------------------------------------------------------------------------------

## 3. Script format and interpreter

### 3.1 Loading (`LoadScene` = `FUN_0043f554(scene)`)

```
LoadScene(n):
  Cursor := crHourGlass
  currentScene(+0x20c) := n
  raw := TStringList.LoadFromFile(SCRIPTS + Format('%.3d', n) + '.BSB')
  delete every line whose length is 0          // before decoding; lines of spaces stay
  for i, line in raw:                           // indices are after the deletion
    line := map(line, c -> c - 1)               // per byte
    if Copy(line,1,7) = '{LABEL}':
      labelCount++                              // 1-based, at most 40
      labels[labelCount] := { name: ShortString20(Copy(line, 8, len-8)), line: i }
                                                // drops '{LABEL}' and the last char (the '~')
    script.Add(line)
  lineIdx(+0x690) := 0; nextClicks(+0x20d) := 0
  if displayMode != 0: FUN_00443ea4()           // recreate buffers, form black
  if script[0] starts with '{MOVIE}':
     displayMode := 1; back := black; frmBackGround.Black()
  else:
     back := black; displayMode := 3
     if n != 0 and n != 31: displayMode := 0; draw header and menu; FUN_0043fa3c(1,1,0)   // (2.1)
     frmBackGround.ShowWallpaper()
  front := copy of back
  canTurn(+0x1f3) := 1
  Repaint
  state := 1
```

Important: line numbers (for labels and the interpreter) count only **non-empty** lines. The decoded
`.TXT` files in `public/data` still contain the blank lines, so drop them first.

### 3.2 Argument extraction (`FUN_0044125c(self, n)`), which must be reproduced exactly

`pos(x, s)` is Delphi `Pos` (1-based, 0 if not found). The engine stores positions in a **byte**, so a
`~` at position 256 or later is treated as missing. Real lines are short.

```
Arg(n):                                   // operates on script[lineIdx]
  line := script[lineIdx]
  if n = 1:
     start := (line[1] = '{') ? pos('}', line) + 1 : 1
     return Copy(line, start, pos('~', line) - start)   // the first '~' in the whole line; none gives ''
  s := line
  repeat n-1 times: s := Copy(s, pos('~', s) + 1, MaxInt) // field 1 still contains "{CMD}"
  if pos('~', s) > 0: return Copy(s, 1, pos('~', s) - 1)
  if s = '': return ''
  // continuation over several lines (no shipped script relies on this [?]):
  acc := s; lineIdx++
  while pos('~', script[lineIdx]) = 0: acc := acc + ' ' + script[lineIdx]; lineIdx++
  return acc + ' ' + Copy(script[lineIdx], 1, len-1)     // drops the last char
```

Lists that span several lines (`INIT_READER`, `INIT_CLICKWORD`) are read with this convention: when
`Arg(k)` returns '', set `lineIdx++, k := 1` and read again. After the command, `lineIdx` points at the
last data line. The main loop then increments it.

### 3.3 Interpreter state machine (`ScriptTimerTimer_43dd50`, one call per timer tick)

Fields: `state +0x694`, `mode +0x698` (the state to return to after a blocking operation),
`savedMode +0x69c`.

| state | Meaning | Tick behaviour |
|---|---|---|
| 0 | boot | `state=2`, scene 0 (or the debug scene), `animCount=3`, `LoadScene` |
| 1 | run script | execute one line (3.4) |
| 2 | busy / no-op | nothing (used as a guard while a handler runs) |
| 3 | idle, waiting for the user | nothing (mouse handlers act) |
| 4 | leave page | `exiting(+0x1f5)=1`. If `onExit(+0x1f6)` is empty, `state=8`. Otherwise jump to label `onExit` (`lineIdx = label.line`, `state=1`). A missing label leaves state 2 forever. |
| 5 | animation playing | draw frame `cur` (see `ACTIVATE_ANIMATION` in section 4). Step `cur` toward `to`. When it passes `to`: `state=mode` (and `Interval=50` if `mode=10`), else stay 5. |
| 6 | reader playing | see 5.4 |
| 7 | DELAY | `delayCount--`. At 0, `state=mode`, else stay 7 (the count is always 1). |
| 8 | load next scene | `Cleanup()` (3.6). If `currentScene=31`, close. Otherwise, if `currentScene=0`, bookmark logic (1.3). Then `LoadScene(nextScene +0x20b)`. |
| 9 | wait for effect sound | `if Play(PB001, sync and NOSTOP) succeeded: state=mode` else stay 9. This succeeds only once nothing else plays through `sndPlaySound`. |
| 10 | bee tip flight | draw the bee at path point `cur` (6.6), `cur++`, wrap to `loopStart` after `loopEnd`. Stays 10 until the user clicks it. |
| 11 (0xb) | movie playing | if `mpMovie.Mode = mpPlaying`, stay. Otherwise `Close`, invalidate (0,0,640,480), `state=mode`. |
| 14 (0xe) | game running | poll the game form's result byte (7.1) |
| 24 (0x18) | EINDE sign rising | 6.4 |
| 25 (0x19) | EINDE sign lowering | 6.4 |
| 26 (0x1a) | EINDE sign up, waiting for JA/NEE | nothing |

### 3.4 Executing one line (state 1)

```
case 1:
  state := 2; ScriptTimer.Interval := 10; mode := 1
  line := script[lineIdx]
  cmd := the command whose text equals Copy(line, 1, Length(cmd))   // prefix compare, case-sensitive
  switch cmd:
    '{END}':       if exiting: state := 8
                   else: state := 3; mode := 3; Cursor := crDefault
                   return                                            // no line advance
    '{THE_END}':   state := 2; Cleanup(); frmMain.Close(); return
    '{AUTO_NEXT}': state := 4; return
    other known commands: execute (section 4). Blocking ones set state to 5/6/7/9/11/14.
    unknown lines (including {LABEL}, {MOVIE}, {BLACKOUT}, {END_TEXT}, text lines): no-op
  if lineIdx = script.Count - 1: state := 3     // end of file without {END}; cursor stays an hourglass (hang)
  else: lineIdx++; if state = 2: state := 1
```

Notes:
- Falling through: a `{LABEL}` line is a no-op. A label without `{END}` simply runs on into the next
  label. `003.BSB` label `Kok` does this.
- The commands `{INIT_LARGEBOX}`, `{INIT_MENU}`, `{ACTIVATE_MENU}`, `{SETMOUSETYPE}` and `{BLACKOUT}`
  do nothing in this exe. Only the first four are even compared; `{BLACKOUT}` is simply unknown.

### 3.5 Timing model (needed to keep the pacing faithful)

`TTimer.SetInterval` (`0x426714`) restarts the Windows timer only when the value changes. Every
state-1 tick sets the interval to 10.

- Ordinary (non-blocking) line: 1 tick (10 ms nominal; about 55 ms on Win95/98, about 10-16 ms on NT).
- `ACTIVATE_ANIMATION` with frames f..t (n = |t-f|+1) and delay d: the interval becomes d. Frame f is
  drawn at +d, ..., frame t at +n·d. The state returns to `mode`, and the next line runs at
  **+(n+1)·d**. So each frame stays visible for d ms, including the last.
- `DELAY ms`: the next line runs at **+2·ms** (state 7 decrements on the first tick at +ms and only
  returns; the following tick at +2·ms runs the next line).
- Reader: polled every 100 ms. After the voice stops, the next line runs about 100 ms later.
- `ACTIVATE_EFFECT`: polled every 10 ms until the effect WAV is finished, then about 51 ms of
  synchronous silence (`PB001.WAV`), then the next line.

A browser port can run a 10 ms tick loop (or a 16 ms rAF loop) with these rules. Reproducing the 55 ms
granularity of Win95 is optional. It mainly slows down the long runs of non-blocking lines.

### 3.6 `Cleanup()` (`FUN_00441fc0`, before every scene change and on `THE_END`)

Clears `exiting(+0x1f5)`, the tip (`+0x1eac=0`) and `onExit`. Frees animation slots 4..animCount
(`animCount=3`), all effects, all clickareas, and the two text bitmaps. Labels, words and reader data
are overwritten by the next scene.

---------------------------------------------------------------------------------------------------

## 4. Commands

`Arg(k)` is defined in 3.2. "y+80" means the engine adds 80 to every y from the script.

### `{NEXT_SCENE}n~`
`nextScene(+0x20b) := StrToInt(Arg1)`. Used by AUTO_NEXT and OMSLAAN.

### `{INIT_MAINIMAGE}file.BMP~`
Load `IMAGES\file` into the main-picture bitmap (`+0x1c4`). Nothing is drawn.

### `{ACTIVATE_MAINIMAGE}`
`back.Draw(0, displayMode=0 ? 80 : 0, mainImage)`, then `front := back` (the whole 640x480), then
Repaint. This **wipes the text, bee and anything else drawn only to the front buffer**, which is why
scripts call `ACTIVATE_TEXTBOX` after it.

### `{INIT_TEXTBOX}textColour~highlightColour~` followed by paragraph lines and then `{END_TEXT}`
Sets `mode := 2` and runs `FUN_004426f8` (5.1). Synchronous: one tick. Colours use the 16-colour
table in 2.4. Every line up to the next line starting with `{END_TEXT}` is one paragraph. At the end
`state = 1`.

### `{ACTIVATE_TEXTBOX}` and `{TEXT_TOP}`
Both call `DrawWord(1, normal, blit=true)` (`FUN_0044308c(1,0,1)`). This scrolls the view to line 1 and
blits the text window (5.2). `TEXT_TOP` is used at the end of the intro script to reset the scroll
after reading.

### `{INIT_READER}file.WAV~count~` followed by `start,end~` pairs (ms) on the next lines (`FUN_004436b8`)
`readerWav(+0x33f4) := SOUNDS\file`, `wordCount(+0x33d4) := count` (this **overwrites** the text's
word count). For i = 1..count: `word[i].startMs, word[i].endMs := pair i`. The pairs are read with the
multi-line convention, starting at field 3 of the command line. Times are positions in the WAV.

### `{ACTIVATE_READER}from~to~`
`PlayReader(from, to)` (`FUN_00443558`), blocking (state 6). See 5.4.

### `{INIT_CLICKWORD}n~` followed by n triples `w~from~to~` on the next lines (`FUN_00443400`)
For each triple: `word[w].clickFrom := from; word[w].clickTo := to`. Clicking word w later plays the
reader from word `from` to word `to` (a phrase). By default (set in INIT_TEXTBOX) every word plays
only itself. Triples never span lines (data reality; the reader would also misparse that).

### `{INIT_ANIMATION}name~strip.BMP~frames~delay~x1~y1~x2~y2~sound.WAV~` (`FUN_00441574`)
`animCount++` (slot 4..16; slots 1..3 are the bee). Slot record (`+0x1ea0 + 40·i`): name, bitmap
`IMAGES\strip`, frames (informational only, never used for bounds), delay in ms, dest rect
`(x1, y1+80, x2, y2+80)`, sound `SOUNDS\sound.WAV` if non-empty (async).
Strip layout: **frames side by side horizontally**. Frame width = `x2-x1`, frame k (1-based) is at
x = (k-1)·w, full bitmap height. Every shipped strip is exactly `frames·w` wide and `y2-y1` high, so
there is no stretching. **No transparency**: frames are opaque rectangles blitted with SRCCOPY.

### `{ACTIVATE_ANIMATION}name~from~to~sound~` (`FUN_004420f4`)
Find the slot by name (case-sensitive; the last match wins; slots 1..16 are searched, so the bee slots
are reachable too). If none is found, a message box shows "Deze animatie bestaat niet" and the line is
skipped. Otherwise `cur := from`, `playSound := (Arg4 = '1')`, `Interval := delay`, cursor hourglass
(unless `mode=10`), `state := 5`.
Each state-5 tick (`FUN_0043d87c`) does this:
```
src := (cur-1)*w, 0, cur*w, bmp.Height;  dst := slot.rect
if mode != 10: back.CopyRect(dst, bmp, src)        // the bee hive (mode 10) goes to front only
front.CopyRect(dst, bmp, src); invalidate dst
if playSound: sndPlaySound(slot.wav, ASYNC); playSound := false   // only on the first drawn frame
if from > to: cur--; done := cur < to   else: cur++; done := cur > to
```
Reverse playback (from > to) is used a lot. `from = to` repeated N times works as an N·2·delay hold.

### `{INIT_CLICKAREA}name~x1~y1~x2~y2~label~TRUE|FALSE~` (`FUN_00442364`)
`clickCount(+0x2504)++` (at most about 20). Record (`+0x2168 + 44·i`): name (AnsiString),
rect `(x1, y1+80, x2, y2+80)`, label (ShortString20), `enabled := (Arg7 = 'TRUE')`. Several areas can
point to the same label (`Nose1`, `Nose2` give `Nose`). The name and the label are different things:
`ENABLE/DISABLE/INIT_TIPAREA` use the name, a click runs the label.

### `{ENABLE_CLICKAREA}name~` and `{DISABLE_CLICKAREA}name~`
Set or clear `enabled` on **every** clickarea whose name equals Arg1.

### `{NEXT_CLICKS}n~`
`nextClicks(+0x20d) := n; canTurn(+0x1f3) := 0`. After n successful effect clicks the OMSLAAN egg
appears (6.2).

### `{ONEXIT}label~`
`onExit(+0x1f6) := ShortString20(Arg1)`. This label runs when the page is left by **OMSLAAN, TERUG or
AUTO_NEXT** (state 4). Its `{END}` then loads `nextScene`, because `exiting=1`.

### `{AUTO_NEXT}`
`state := 4` (leave page, running ONEXIT first if set).

### `{INIT_TIPAREA}clickareaName~` (`FUN_00441930`)
Sets `mode := 1` and computes the Bzzz bee flight path to that clickarea (6.6). It sets
`tipRect(+0x1eb4) := area.rect` and `tipIdx(+0x1ec4) := area index`, and makes the hive clickable
(`loopEnd +0x1eac != 0`). If no area has that name (`019.BSB` names `Bzzz1`, which doesn't exist),
nothing changes and the previous tip stays active.

### `{DELAY}ms~`
`delayCount := 1; Interval := ms; state := 7`. In effect this waits 2·ms (3.5).

### `{INIT_EFFECT}name~file.WAV~` (`FUN_004424ec`)
`effectCount(+0x2508)++`. Record (`+0x24f0 + 28·i`): name (ShortString20) and the sound
`SOUNDS\file` (async).

### `{ACTIVATE_EFFECT}name~` (`FUN_00442614`)
If found: `sndPlaySound(file, ASYNC)`, cursor hourglass, `state := 9` (wait until the sound has
finished). If not found: no-op.

### `{PLAY_GAME}n~` (`FUN_00443860`)
See 7.1.

### `{PLAY_MOVIE}file.AVI~` (`FUN_0044177c`)
See 7.2.

### `{THE_END}`
`Cleanup()` and `frmMain.Close` (credits, then quit). Not used in the data.

### `{LABEL}name~`, `{MOVIE}`, `{END_TEXT}`, `{BLACKOUT}`, `{INIT_LARGEBOX}`, `{INIT_MENU}`, `{ACTIVATE_MENU}`, `{SETMOUSETYPE}`
No-ops at execution time. `{LABEL}` matters only at load time and `{MOVIE}` only as line 0 at load
time. `{END_TEXT}` is consumed by INIT_TEXTBOX.

---------------------------------------------------------------------------------------------------

## 5. Text box, reader and click-words

### 5.1 Layout (`FUN_004426f8`, INIT_TEXTBOX)

Word records (`+0x272c + 40·w`, w = 1..80): `text, rect(l,t,r,b), startMs, endMs, clickFrom,
clickTo, line`. Coordinates are in **text-bitmap space** (504 wide, origin at the top-left of the
bitmap).

```
clear words 1..80; lineCount(bl) := 1; lineFirst[1] := 1; w := 1
word[1].rect.topLeft := (5, 5)           // margins: left 5, top 5, right limit 499
H := TextHeight('W') = 17
for each paragraph p:
  s := p
  while pos(' ', s) > 0:
     k := pos(' ', s)
     word[w].text := Copy(s, 1, k)       // INCLUDES the trailing space; a double space gives the word " "
     place(w, pitch = 21)
     word[w+1].rect := (word[w].r, word[w].t, word[w].r, word[w].t)   // next word continues on the same line
     s := Copy(s, k+1, MaxInt); w++
  if s != '':                            // last word of the paragraph (no trailing space)
     word[w].text := s; place(w, pitch = 20)   // quirk: 20, not 21
     w++
  word[w].rect := (5, word[w-1].t + 21, 0, 0)  // the paragraph break always starts a new line
  lineCount++; lineFirst[lineCount] := w
place(w, pitch):
  W := TextWidth(word[w].text)
  rect := (l, t, l+W, t+H)
  if rect.r > 499: lineCount++; lineFirst[lineCount] := w; rect := (5, t+pitch, 5+W, t+pitch+H)
  word[w].line := lineCount; word[w].clickFrom := word[w].clickTo := w
wordCount := w-1
lineCount (+0x2188) ends up as (real lines + 1), because of the final paragraph break
textBottom := word[wordCount].t + 21;  bitmapH := max(64, textBottom)   // (< 65 gives 64)
```

The word split above reproduces the reader counts exactly. `003` has a double space and its reader
lists 59 words including the blank one. In `009` the double space makes 44 words against 43 reader
entries, so word 44 never gets highlighted. Keep this behaviour.

Two 504 x bitmapH bitmaps are then created:
- `+0x218c` colour text: filled black, Arial bold 17, `Brush.Style = bsClear`.
- `+0x2190` mask: filled white (pen `psClear`), the same font, colour black. **[?]** With a null pen
  the GDI `Rectangle` fill leaves the last column and row unfilled. If the new DDB starts out black,
  that gives a 1-px black line at screen x=603 (and possibly at the bottom when bitmapH is 64). This
  is cosmetic; ignore it.

Every word is then rendered once with `DrawWord(w, normal, blit=false)`, which draws it into both
bitmaps. `topLine(+0x33fc) := 1`.

### 5.2 `DrawWord(w, highlight, blit)` (`FUN_0044308c`)

```
colourText.Font.Color := highlight ? hiColour(+0x2740 rec0) : textColour(+0x273c rec0)
colourText.TextOut(word[w].l, word[w].t, word[w].text)          // transparent (bsClear)
if not blit: mask.TextOut(word[w].l, word[w].t, word[w].text)   // black on white; init only
else:
  while word[w].t > (topLine-1)*21 + 65: topLine++               // auto-scroll so the word is visible
  while (topLine-1)*21 > word[w].t: topLine--
  srcY := (topLine-1)*21
  front.CopyRect((100,7,604,72), HEADER.BMP, (100,7,604,72))     // restore the parchment
  front: SRCAND  mask       (0, srcY+1, 504, srcY+66) -> (100,7,604,72)
  front: SRCPAINT colourText(0, srcY+1, 504, srcY+66) -> (100,7,604,72)
  if lineCount > 3:                                              // arrows, always drawn the same
     front: SRCAND PIJLEN(0,25,20,50), then SRCPAINT PIJLEN(0,0,20,25)   -> (604,10,625,35)  up
     front: SRCAND PIJLEN(20,25,40,50), then SRCPAINT PIJLEN(20,0,40,25) -> (604,44,625,69)  down
     invalidate (100,7,625,72)   // the dest is 21 wide against a 20-wide source: a 1-px horizontal stretch
  else invalidate (100,7,604,72)
```
In a browser, keep the text in a 504-wide offscreen canvas with an alpha background, and composite it
over a copy of the header. That is equivalent to the AND/OR pair. Text exists **only in the front
buffer**. Anything that restores from the back buffer (an ACTIVATE_MAINIMAGE, or the bee flying over
the text window) erases it until the next DrawWord blit.

`PIJLEN.BMP` (40x50): the top half holds the yellow arrows on black (up at x 0..20, down at x 20..40),
the bottom half holds their black-on-white masks.

### 5.3 Scrolling (`FormMouseDown_4404a0`, state 3, displayMode 0)

- Up, (604,10)-(625,35): if `lineCount > 3` and `topLine > 1`: `topLine--`, then
  `DrawWord(lineFirst[topLine], normal, blit)`.
- Down, (604,44)-(625,69): if `lineCount > 3` and `lineCount - topLine > 3`: `topLine++`, then the
  same redraw.
- `btnScrollUpClick/DownClick` (`0x443a80`, `0x443a28`) contain the same logic but no buttons exist
  in the DFM, so they are dead code.
- While the reader runs, the text auto-scrolls one line at a time to keep the spoken word visible
  (the DrawWord loop above).

### 5.4 Reader playback (`PlayReader` = `FUN_00443558(from, to)`; state 6 in `43dd50`)

```
PlayReader(from, to):              // from = 0 means "read Arg1 and Arg2" (ACTIVATE_READER)
  state := 2; first := from; last(+0x33ec) := to; cur(+0x33f0) := from
  ScriptMedia: Close; TimeFormat := ms; FileName := readerWav; Open
               StartPos := word[from].startMs; EndPos := word[to].endMs; Play   // MCI, separate from sndPlaySound
  DrawWord(from, highlight, blit)
  Interval := 100; state := 6
state 6, every 100 ms:
  if ScriptMedia.Mode = mpStopped:
     DrawWord(last, normal, blit)
     if repeatFlag(+0x1ec5): DrawWord(1, normal, blit); repeatFlag := 0   // HERHALEN goes back to the top
     state := mode
  else if ScriptMedia.Position > word[cur].endMs:
     DrawWord(cur, normal, blit)
     if cur < last: cur++; DrawWord(cur, highlight, blit)
     // at most ONE word advance per 100 ms tick, so short words lag behind (faithful)
```
Exactly one word is highlighted at a time, in the highlight colour. Nothing else changes (no
underline, no box).

### 5.5 Clicking words (state 3, displayMode 0, `FormMouseDown_4404a0`)

```
if PtInRect((100,7,604,72), p):
  row := 1
  if PtInRect((100,7,604,28), p): row := 1
  if PtInRect((100,29,604,50), p): row := 2
  if PtInRect((100,51,604,71), p): row := 3        // y = 28, 50 or 71 falls back to row 1
  L := row + topLine - 1;  w := lineFirst[L]
  loop: if word[w].line != L: return               // no word hit
        off := (topLine-1)*21
        if PtInRect((word[w].l+100, word[w].t+7-off, word[w].r+100, word[w].b+7-off), p): break
        w++
  PlayReader(word[w].clickFrom, word[w].clickTo)   // mode stays 3, so the book returns to idle afterwards
```
A word click doesn't count toward NEXT_CLICKS. The trailing space belongs to the word's hit box.

---------------------------------------------------------------------------------------------------

## 6. Interaction

### 6.1 Cursor

`frmMain.Cursor` is `crHourGlass` (-11, the standard Windows wait cursor) from `LoadScene`, and again
from every `ACTIVATE_ANIMATION` (except in bee mode 10) and `ACTIVATE_EFFECT`. It goes back to
`crDefault` at `{END}` (idle), after `PLAY_MOVIE` has started and at `PLAY_GAME`. The reader doesn't
touch it. **`FormMouseDown` ignores every click while the cursor is the hourglass** (this includes
EINDE). The help text says "dan verdwijnt je muis". In this exe the mouse becomes the hourglass rather
than disappearing. For the web port use `cursor: wait` (or `none` if you prefer the help text) and
apply the same input gate. There are no custom cursor resources.

### 6.2 Effect clicks, NEXT_CLICKS and page turning

Clickareas only work in state 3 (idle, cursor not an hourglass, left button), for a point in
(0,80)-(640,400):
```
for each clickarea i (1..clickCount), if PtInRect(area[i].rect, p):
  for each label j (1..labelCount), if labels[j].name = area[i].label and area[i].enabled:
     if not canTurn: nextClicks--; if nextClicks = 0: FUN_0043fa3c(+0x1f1, +0x1f2, 1); canTurn := 1  // the OMSLAAN egg appears
     lineIdx := labels[j].line; state := 1
// no break: overlapping enabled areas all count, and the last one wins the jump
```
- Every successful click counts, including repeated clicks on the same area and the bee-tip click
  (6.6). Disabled areas count nothing.
- **OMSLAAN** (next page) needs `canTurn = 1`, state 3 and `nextClicks = 0`. Then `state := 4`: run
  ONEXIT, then load `nextScene`. `canTurn` is 1 right after LoadScene and NEXT_CLICKS sets it to 0.
  Every story page has NEXT_CLICKS (values 2..5, and 50 on one page, which in practice disables
  turning). Pages without it (title, movies, games, end) never reach state 3 with the menu active
  anyway.
- **TERUGBLADEREN**: state 3 required. `nextScene := currentScene - 1; state := 4`. ONEXIT runs on going
  back too. Page 2 goes back to scene 1, which replays the intro movie.
- **AUTO_NEXT** in a script: `state := 4`.

### 6.3 Menu (`FormMouseMove_440314`, `FormMouseDown_4404a0`)

Hover (only when `state = 3` and `displayMode = 0`): `hover(+0x1f0)` tracks the item under the mouse.
Entering an item plays its `MNU00n.WAV` (async), but only if the item is "available": HERHALEN needs
`+0x1f1`, TERUG needs `+0x1f2`, OMSLAAN needs `canTurn`. EINDE and HELP are always available. When the
mouse is anywhere else (including outside the bar) and `hover != -1`:
`sndPlaySound(nil)`, which **stops any sndPlaySound sound** (including a bee buzz or effect), and
`hover := -1`.

Click (left button, in the bar, `displayMode` 0 or 2), checked in order. Before acting, an item stops
its own hover voice if it is the hovered one.
- EINDE: allowed in any state. In game mode it calls the game's quit routine, otherwise the JA/NEE
  sign (6.4).
- HERHALEN (if `+0x1f1`; needs state 3 or game mode): in game mode the game's "repeat" routine.
  Otherwise `PlayReader(1, wordCount)` and `repeatFlag := 1`.
- TERUGBLADEREN (if `+0x1f2`, state 3): see 6.2.
- OMSLAAN (if `canTurn`, state 3): see 6.2.
- HELP (state 3 or game mode): `frmHelp.ShowModal` (9.3).

After the menu, the same click is also tested against the bee and the state-3 targets (it can't hit
them, because they're outside the bar).

### 6.4 EINDE: the JA/NEE sign (`FUN_00440f04`, `FUN_00443cb0`, `FUN_00443e10`, states 0x18-0x1a)

```
savedMode := mode; mode := state; state := 2
if mode = 5 or 9: sndPlaySound(nil)            // cut the anim/effect sound
if mode = 6: ScriptMedia.Pause/Stop            // reader
load YN1.BMP (196x179, sign on black) and YN1M.BMP (mask)
save front (220,221)-(416,400) into a 196x179 bitmap
step := 1; voice := 1; Interval := 100; state := 0x18
draw(step): front(220,221,416,400) := saved
            dst := (220, 400-12*step, 416, 400); src := (0, 0, 196, 12*step)
            front SRCAND YN1M src->dst, then SRCPAINT YN1 src->dst; blit the region straight to the window
0x18 (every 100 ms): draw(step); step++; if step = 15: ScriptMedia plays SOUNDS\yn001.wav; state := 0x1a
                     // the sign rises out of the menu bar; the top 168 of its 179 rows are visible
0x1a: click X in 255..304 and Y in 255..290 (exclusive) is JA: answer := 1
      click X in 324..385 and Y in 258..291 is NEE: answer := 0
      on either: ScriptMedia.Close; state := 0x19
0x19 (every 100 ms): step--; draw(step); at step 0: free the bitmaps, then
      JA:  frmMain.Close (1.4)
      NEE: if mode = 6: PlayReader(cur, last) (resumes from the current word); mode := savedMode
           else: state := mode; mode := savedMode     // e.g. animation (5), DELAY (7) or bee (10) resume
```
EINDE is the only click that works outside state 3, but the hourglass gate (6.1) still blocks it while
the script runs.

### 6.5 Mouse-down order (`FormMouseDown_4404a0`, complete)

1. If `Cursor = crHourGlass`: ignore.
2. If `currentScene = 31`: `state := 4` (any button, anywhere). Return.
3. If state is 0x18/0x19/0x1a: in 0x1a only, the JA/NEE test. Return.
4. Else if `displayMode = 1` (movie): if the point is in (477,390)-(605,470) (the arrow drawn in
   `I001.BMP`/`I004.BMP`) and the movie is playing: Stop and Close it (state 0xb then continues the
   script). Return.
5. Else, left button only:
   a. the menu (6.3);
   b. if `state = 10`, `cur >= loopStart` (the bee is circling) and the point is in `tipRect`
      (PtInRect): bee click (6.6);
   c. if `state = 3`: the hive (6.6), then scroll arrows (5.3, displayMode 0), then clickareas (6.2),
      then text words (5.5, displayMode 0). These are all independent tests in this order.

### 6.6 Bzzz the bee (tip system)

**Hive click** (state 3, `loopEnd(+0x1eac) != 0`, PtInRect (16,19)-(71,77)):
`mode := 10`; `ACTIVATE_ANIMATION('BijUit', 1, 14, nosound)` (front buffer only, 14 x 100 ms);
`PB002.WAV` async and looping (the buzz). When it finishes: `state := 10`, `Interval := 50`.

**Path** (`FUN_00441930`, computed by INIT_TIPAREA; the point table is at `+0x6a0 + 12·i` =
`{frame:u16, x, y}`):
```
tx := area.l + (area.r-area.l) div 2 - 20;  ty := area.t + (area.b-area.t) div 2 - 35   // area includes the +80
if tx = 0: abort (nothing changes)
n := 0
for i in 0..15: P[n++] := { frame: (i+1) and 3, x: 24+2i, y: 40+3i }     // leaving the hive, down-right
x0, y0 := P[15] = (54, 85); dx := tx-x0; dy := ty-y0
step := (51 <= dx < 641 as unsigned) ? 0.04 : 0.05                       // negative dx gives 0.05
t := 3.14
while t > 1.57:                                                            // quarter-ellipse arc to (tx,ty)
   x := Round(tx + dx*cos t); y := Round(y0 + dy*sin t); t := t - step     // Round = round half to even
   P[n] := { frame: n and 3, x, y }; n++
loopStart(+0x1eae) := n
cx := P[n-1].x; cy := P[n-1].y + 22                                        // circle radius 22 below the arc end
t := 4.71; while t < 6.28: P[n] := {n and 3, Round(cx+22cos t), Round(cy+22sin t)}; n++; t += 0.1
t := 0;    while t < 4.71: same; n++; t += 0.1
loopEnd(+0x1eac) := n-1;  cur(+0x1eb0) := 0
```
(The constants are Delphi Real48 values 0.05, 0.04, 3.14 and 4.71, and extended 1.57, 6.28, 4.71 and
0.1. The arc has 40 points at step 0.04 and 32 at 0.05. The circle has 64 points, so 3.2 s per lap.)

**Flight** (state 10 every 50 ms, `FUN_0043dac8`):
```
p := P[cur]; prev := cur > 0 ? P[cur-1] : empty
front.CopyRect(prev 32x28 rect, back, same)                     // erase the previous position from the back buffer
front SRCAND PBS001(frame*32, 28, frame*32+32, 56) -> (p.x, p.y, p.x+32, p.y+28)   // mask = bottom half
front SRCPAINT PBS001(frame*32, 0, frame*32+32, 28) -> same                       // sprite = top half
invalidate union; cur++; if cur > loopEnd: cur := loopStart
```
Only frames 0..3 of `PBS001.BMP` (256x56, 8 frames of 32) are used. Quirk: on the wrap, the "previous"
rect is `P[loopStart-1]`, not `P[loopEnd]`, and the two are about 2 px apart, so a sliver can stay
behind. Restoring from the back buffer also erases the hive's `BijUit` end frame (drawn front-only) as
the bee leaves, and any text the bee crosses.

**Bee click** (state 10, `cur >= loopStart`, PtInRect(tipRect = the target clickarea's rect)):
```
state := 2; restore P[cur-1] from back to front; sndPlaySound(nil)   // the buzz stops
mode := 3; cur := 1
for each label j with name = area[tipIdx].label and area[tipIdx].enabled: (NEXT_CLICKS accounting as in 6.2); jump; state := 1
// if no label matches or the area is disabled, state stays 2 and the book hangs (faithful, avoid it)
```
While the bee flies, only the bee click and the menu respond (state is not 3). Scripts normally end
every label with `{INIT_TIPAREA}next~`, which chains the tips. The hive stays clickable as long as
`loopEnd != 0`. Cleanup resets it on scene change.

### 6.7 Sound channels (needed for faithful overlap and cut-off behaviour)

- **Channel A, `sndPlaySound`** (one voice; a new async sound stops the previous one): animation
  sounds, effects, menu hover voices, the bee buzz (looping), `PB001` (silence probe), the startup
  `S001.WAV`. `sndPlaySound(nil)` stops it on: leaving the menu, menu clicks, the bee click, EINDE
  during an animation or effect, FormClose.
- **Channel B, `ScriptMedia` TMediaPlayer (MCI)**: the reader voice `V###.WAV` with StartPos/EndPos
  in ms, and the `yn001.wav` EINDE question. It plays independently of channel A.
- **Channel C, `mpMovie`**: AVI with its own audio.
- **Credits**: a separate TMediaPlayer with `AT001.WAV`.
- WAVs of 200 KiB or less (`0x32000`) are preloaded into memory, larger ones play from file. There is no
  audible difference.

---------------------------------------------------------------------------------------------------

## 7. PLAY_GAME and PLAY_MOVIE

### 7.1 `{PLAY_GAME}n~` (`FUN_00443860`; state 0xe in `43dd50`)

```
gameNo(+0x3418) := n; state := 2
Application.CreateForm(TfrmGn)            // G1 0x433cbc, G2 0x435280, G3 0x436c60, G4 0x438948, G5 0x43ad1c
if n in {1,2}: pump messages while game.result = 3      // the game preloads on its own timer
game.Show                                  // NON-modal
state := 0xe; displayMode := 2; Cursor := crDefault; FUN_0043fa3c(1,0,0)   // only the HERHALEN egg
```
- Game form: 640x320, `bsNone`, `poScreenCenter`. Because the book (640x480) is also screen-centred,
  the game sits exactly over the picture band **(0,80)-(640,400)**. The header (with the INIT_TEXTBOX
  instructions) and the menu bar stay visible and live. Game scenes have a textbox but no reader, and
  the band behind the game is black.
- Menu during a game: EINDE calls the game's own JA/NEE (drawn inside the game form at
  (420,141)-(616,320) in G1). HERHALEN calls the game's repeat routine (`FUN_00434e8c`,
  `FUN_004367a8`, `FUN_00438544`, `FUN_0043a87c`, `FUN_0043c064`). HELP works. TERUG and OMSLAAN are
  off.
- Result byte: G1 `+0x2e4`, G2 `+0x2f0`, G3 `+0x664`, G4 `+0x2720`, G5 `+0x4fc`. 0 = running,
  1 = solved, 2 = quit (the game's FormClose sets 2 if it is still 0), 3 = loading (G1/G2).
  State 0xe polls it every tick. 1: free the game, `state := mode` (1), and the script continues with
  the `{AUTO_NEXT}` that always follows. 2: free the game, `frmMain.Close` (credits, then quit).
- `displayMode` stays 2 until the next LoadScene.
- Games are 1 Rongo Rongo (scene 7), 2 the egg sorting machine (13), 3 the memory trainer (17),
  5 the harmonica (22) and 4 football (24). The order in the data is `1,2,3,5,4`.

### 7.2 `{PLAY_MOVIE}file.AVI~` (`FUN_0044177c`; state 0xb)

- AVI from `IMAGES\`. `PBM001.AVI` and `PBM002.AVI` are both 180x132 at 15 fps (66 666 µs/frame),
  3166 and 2285 frames (about 211 s and 152 s).
- `mpMovie.Display := frmMain`, `DisplayRect := (left, top, 0, 0)` (right and bottom 0 mean native
  size). For `PBM001.AVI` the top-left is **(230,175)** (centred in the open book in `I001.BMP`); for
  any other file it is **(240,255)** (`PBM002` over `I004.BMP`). So the movie occupies
  (230,175)-(410,307) or (240,255)-(420,387) in the 640x480 client.
- Order: Close, FileName, Open, set Display and DisplayRect, Repaint, Play. If there is no error, pump
  messages until the mode is `mpPlaying`, then cursor default and `state := 0xb`. If there is an error,
  show "Het filmpje kan niet worden afgespeeld, controleer uw systeem. Bas de Beer gaat nu verder." and
  set `state := 0xb`.
- Skip: a click in (477,390)-(605,470) while it plays (6.5 step 4).
- When it ends: Close, invalidate everything, `state := mode`, then the next line (`{AUTO_NEXT}`, or in
  scene 4 a DELAY and an effect).
- Movie scenes: `{MOVIE}` is line 0, `displayMode = 1`, the picture is drawn at (0,0) as 640x480, the
  background form goes black, and there is no menu or header. `{BLACKOUT}` lines are no-ops.

---------------------------------------------------------------------------------------------------

## 8. Interpreter pseudo-code (main loop, consolidated)

```
onTimer():                                   // ScriptTimer, interval as set (10 by default)
  switch state:
    0:  state=2; scene=0 (or the /D debug scene); animCount=3; LoadScene(scene)
    1:  ExecLine()                           // 3.4
    4:  state=2; exiting=1
        if onExit=='': state=8 else { j=findLabel(onExit); if j { lineIdx=labels[j].line; state=1 } }
    5:  state=2; DrawAnimFrame(slot)
        if from>to { cur--; if cur<to { done } } else { cur++; if cur>to { done } }
        done: { if mode==10 Interval=50; state=mode } else state=5
    6:  state=2; ReaderTick()                // 5.4
    7:  state=2; if --delayCount==0 state=mode else state=7
    8:  state=2; Cleanup()
        if currentScene==31: frmMain.Close(); break
        if currentScene==0: nextScene = Bookmark()   // 1.3
        LoadScene(nextScene)
    9:  state=2; state = (sndPlaySound(PB001, SYNC|NOSTOP) ? mode : 9)
    10: state=2; DrawBee(cur); cur++; if cur>loopEnd cur=loopStart; state=10
    11: state=2; if mpMovie.Mode==Playing state=11 else { mpMovie.Close(); InvalidateAll(); state=mode }
    14: state=2; r=game.result; if r==0 or r==3 { state=14 } elif r==1 { free(game); state=mode } else { free(game); frmMain.Close() }
    24: state=2; DrawSign(step); step++; if step==15 { playYN(); state=26 } else state=24
    25: state=2; step--; DrawSign(step); if step==0 { FinishSign() } else state=25
    26: state=26
    2, 3: nothing
```

---------------------------------------------------------------------------------------------------

## 9. Other forms

### 9.1 `TfrmBackGround` (`FormCreate_42ab18`, `FormPaint_42ab78`, `FUN_0042aca8`, `FUN_0042acd4`)

Full-screen, centred, colour black, disabled, behind the book. Mode "black" (the initial mode and
movie scenes): `Rectangle(0,0,W,H)` in black. Mode "wallpaper" (every other scene): `B001.BMP` (800x600)
drawn at `(W/2-400, H/2-300)`, then a black pen (width 2) `Rectangle(W/2-321, H/2-241, W/2+322,
H/2+242)`, which is a frame just outside the book window. For the web port: a page background with
B001 centred behind the 640x480 stage plus a 2-px black border, or plain black in movie scenes.
`B002.BMP`, `MNUXX*.WAV` and `CLK*.WAV` are unused.

### 9.2 `TfrmStartup` ("Hier was je gebleven", `0x43cb88`..`0x43d048`)

640x480, `bsNone`, `poScreenCenter`, ShowModal. Its 640x480 buffer holds `HEADER.BMP` at (0,0), the
text "Hier was je gebleven......" at (165,25) (Times New Roman bold, Height 27, black, transparent),
`I<bookmark %.3d>.BMP` at (0,80), and `MENU2.BMP` (0,0)-(640,80) at (0,400). `S001.WAV` plays async on
show. Click (PtInRect): (0,400)-(320,480), "Verder gaan", gives ModalResult 1 (resume);
(321,400)-(640,480), "Opnieuw Beginnen", gives ModalResult 2 (restart). Clicks elsewhere do nothing.
OnClose stops the sound.

### 9.3 `TfrmHelp` (`FormCreate_43d1a0`, `FormActivate_43d300`)

400x250, `bsNone`, `poScreenCenter`, modal. `H001.BMP` (400x250) is the background. The memo is at
(5,20), 390x200, read-only with a vertical scrollbar, default MS Sans Serif 8 pt, and is loaded on
activate with `HELPBOEK.TXT` (cp1252) from the CD root (`IMAGES` path minus 14 chars). The OK button
is at (150,225), 100x20, caption "OK", `ModalResult = mrOk`, default.

### 9.4 Credits `TAftitelScherm` (`FUN_0043c6e0` ctor, `FUN_0043c9e0` show, timer `0x43c508`, close `0x43c6ac`)

A runtime form: 640x480, `bsNone`, black, `poScreenCenter`, with a 640x480 TImage. `AT001.WAV` (22 kHz
8-bit, about 212 s) plays through its own TMediaPlayer. The timer runs every 50 ms:
```
if music not playing: Close
if pos = 0: image.Draw(0,0, AT001.BMP); pos := 150          // first tick
tmp(0,80,320,380)  := AT003.BMP (0, pos, 320, pos+300)        // 320x2656 credits strip
tmp SRCAND  AT002.BMP (160,80,480,380)                        // 1-bit mask (white = credits window)
tmp SRCPAINT AT001.BMP (160,80,480,380)
image (160,80,480,380) := tmp (0,80,320,380)
pos += 3; if pos > AT003.Height-300: pos := AT003.Height-300  // stops at the end (about 37 s), music continues
```
So the credits scroll up at 60 px/s in a 320x300 window, shaped by the mask, inside the `AT001`
picture. A click on the image stops the timer and closes the form. On close: timer off, music closed,
done flag set, and then the main code terminates the application.

---------------------------------------------------------------------------------------------------

## 10. Quirks, open questions, implementation advice

- **Two buffers matter.** Text, the bee, the hive animation in mode 10, and the EINDE sign live only in
  the front buffer. Animations in normal mode go to both. Restores copy back to front. Several visible
  behaviours depend on this, such as text being erased by ACTIVATE_MAINIMAGE or by the bee. Emulate
  two canvases.
- DELAY waits 2xN ms. An animation takes (frames+1) x delay. Each other line takes one 10 ms tick
  (about 55 ms on Win95). **[?]** Which "real" speed should the port target? Suggestion: keep the
  10 ms tick. The authors tuned the pacing on Win95, but the extra tick costs only show up in long
  runs of instant lines.
- The reader highlights at most one word per 100 ms.
- Last-word line pitch 20 instead of 21 (5.1). Double spaces create blank "words".
- The hang cases are faithful but best avoided: a bee click on a disabled area or one without a label,
  a missing ONEXIT label, a script without `{END}`.
- **[?]** The black 1-px artefacts from the mask's unfilled edge (5.1) and from source rows beyond the
  64-px text bitmap for texts of one or two lines. Unverified on real hardware. Recommend not
  emulating them.
- **[?]** `FUN_00428af0` on the movie and the reader is Stop or Pause. The behaviour is the same
  either way, because the player is closed afterwards.
- **[?]** The palette: the BMPs are 8-bit, each with its own palette. In a 256-colour display mode the
  original would show palette flashes. Render in true colour.
- Hit tests mix inclusive (menu, `FUN_0042a6b0`) and Win32 PtInRect (everything else). The menu hit
  rects do not equal the drawn button rects.
- Script coordinates always get +80 on y, even on the full-screen title and end pictures (checked:
  the title "Bas" area (499,116)-(587,192) lands on Bas at y 196..272).
- Names (labels, animations, effects, clickareas) are case-sensitive. Labels and effect names are
  truncated to 20 chars.
- Capacities: 40 labels, about 20 clickareas, 20 effects, 16 animation slots (13 for scripts;
  `002.BSB` uses all 13), 80 words, about 512 bee path points.

---------------------------------------------------------------------------------------------------

## Appendix A. `TfrmMain` field map (for re-checking)

| Offset | Meaning |
|---|---|
| +0x1ac / +0x1b0 / +0x1b4 | ScriptTimer / ScriptMedia (reader and YN voice) / mpMovie |
| +0x1b8 / +0x1bc / +0x1c0 | HEADER.BMP / MENU.BMP / PIJLEN.BMP |
| +0x1c4 / +0x1c8 / +0x1cc | main picture / front buffer / back buffer |
| +0x1d0..+0x1e0 | MNU000..MNU004 sound objects |
| +0x1e4 / +0x1e8 | PB001 (silent probe) / PB002 (buzz) |
| +0x1ec | script TStringList |
| +0x1f0 | menu hover index (0xFF = none) |
| +0x1f1 / +0x1f2 / +0x1f3 | HERHALEN available / TERUG available / canTurn (OMSLAAN) |
| +0x1f4 | displayMode (0 page, 1 movie, 2 game, 3 full-screen picture) |
| +0x1f5 | exiting (set by state 4) |
| +0x1f6 | ONEXIT label (ShortString[20]) |
| +0x20b / +0x20c / +0x20d | nextScene / currentScene / nextClicks |
| +0x210 + 28i | label i: ShortString[20] name, +0x18 line index |
| +0x68c / +0x690 / +0x694 / +0x698 / +0x69c | labelCount / lineIdx / state / mode / savedMode |
| +0x6a0 + 12i | bee path point i: u16 frame, i32 x, i32 y |
| +0x1ea0 + 40i | animation slot i (1..16): name, bitmap, frames, delay, rect, sound, playFlag(+0x24) |
| +0x1eac / +0x1eae / +0x1eb0 (u16) | bee loopEnd / loopStart / cur |
| +0x1eb4 / +0x1ec4 / +0x1ec5 | tip rect / tip clickarea index / HERHALEN repeat flag |
| +0x2148..+0x2158 | animCount / cur frame / from / to / current slot |
| +0x215f + L (byte) | first word of text line L |
| +0x2168 + 44i | clickarea i: name, rect(+4), label ShortString[20](+0x14), enabled(+0x29) |
| +0x2188 (byte) | lineCount (real lines + 1) |
| +0x218c / +0x2190 | colour-text bitmap / mask bitmap |
| +0x24f0 + 28i | effect i: ShortString[20] name, +0x18 sound |
| +0x2504 / +0x2508 | clickCount / effectCount |
| +0x272c + 40w | word w: text, rect, startMs(+0x14), endMs(+0x18), clickFrom(+0x1c), clickTo(+0x20), line(+0x24) |
| +0x273c / +0x2740 | text colour / highlight colour (inside word slot 0) |
| +0x33d4 | wordCount (INIT_TEXTBOX, then overwritten by INIT_READER) |
| +0x33e8 / +0x33ec / +0x33f0 / +0x33f4 | reader from / to / cur / wav path |
| +0x33f8 / +0x33fc | DELAY counter / topLine |
| +0x3404..+0x3418 | YN1 / YN1M / saved background / sign step / answer / voice / gameNo |
