# Bas de Beer naar Pirateneiland: engine spec (BBOEK32 story book and friends)

Reverse-engineered from the Win32 Delphi binaries in `basdebeer-extract/pirateneiland/BASWIN/`
(Ghidra output and disassembly in `basdebeer-tools/decomp/`). The spec is meant for a faithful
TypeScript/browser reimplementation. Addresses are BBOEK32.EXE VAs unless stated otherwise.
Instance-field offsets (`+0x1c4` and so on) are TMainForm fields and are given so that claims can be
re-checked. **[?]** marks an uncertainty.

Delphi colour constants are BGR in the binary. Every colour below is given as CSS `#RRGGBB`.

---------------------------------------------------------------------------------------------------

## 0. Quick reference

| Thing | Value | Source |
|---|---|---|
| Book window | 640x480, borderless, black, screen-centred | `FormCreate_437c94` |
| Back-buffer | 640x480 bitmap `+0x1c0`, blitted to `MainImage` (alClient TImage) | `437c94`, `439164` case 2 |
| Script tick | `ScriptTimer`, initial interval **70 ms** (DFM); interval changes at runtime (see 3.4) | DFM, `428218` calls |
| Mouse/cursor/worm tick | `MouseTimer`, interval **10 ms** nominal (Win9x real rate is about 55 ms) | DFM |
| Font | **Arial, 12 pt (16 px at 96 dpi), bold** | `437e98`/`437ea0`, `43a32c`/`43a334` |
| Line pitch | **18 px** fixed | `436f9c` |
| Text shadow | black, offset (+2,+2) | `437550` |
| Scripts | `SCRIPTS\NNN.BSB`, every byte +1 (decode: byte-1), CRLF lines | `437904` |
| Paths | `IMAGES\` (BMP and AVI), `SOUNDS\` (WAV and MID), `SCRIPTS\`, relative to the exe dir | `FUN_00429308` |
| Persistence | `BASWIN.INI` (TIniFile, Windows dir): `[Boekenlegger] Pagina`, `[Games] Game1..6`, `[Movies] Movie2/3` | `429308`, `429084`, `4291a0`, `4290fc` |

---------------------------------------------------------------------------------------------------

## 1. Program flow

CD flow: `AUTORUN.INF` starts `Autorun.exe`, a 596x305 menu with 4 buttons: Berenboek (BBOEK32), PrintStudio (BPRINT32), BerenSpellen (BSPEL32) and BerenBios (BBIOS32). BCD32 is an unused audio-CD player. Details are in section 9. This section covers the book.

### 1.1 BBOEK32 start-up (`entry @43ba04`, `FUN_00429308`, `FormCreate_437c94`)

1. `Application.Title = "BereBoek"`. Paths are derived from the exe directory: `IMAGES\`, `SOUNDS\`,
   `SCRIPTS\`. **The bookmark is read once at start-up**: `bookmark = INI[Boekenlegger].Pagina` (default 0)
   goes into global `DAT_0043d674`. Later bookmark writes do **not** update this in-memory copy.
2. Forms are created in this order: `MainForm` (TMainForm), `Form2` (an unused edit-box dialog),
   `Form1` (full-screen black backdrop, see 1.3) and `PrintBuzzy` ("Bezig met printen" with a Cancel button).
3. MainForm: borderless, 640x480, colour black, centred; MainImage is alClient at 640x480. The 5 menu
   hover sounds `SOUNDS\MNU001.WAV .. MNU005.WAV` are preloaded into memory (`func 435060`, stored at
   `+0x2068+n*8`). The back-buffer font is set to Arial 12 bold with a clear brush. The cursor sprite is
   `msMouse1.BMP`. The mouse-anim counter `+0x658 = 5`. **Script state `+0x1c4 = 0x14` (20)** and ScriptTimer is enabled.
4. State 20 (first script tick, `439164` case 0x14) runs the **intro movie** (see 6.2, movie 1 =
   `BB001.AVI` over `BM001.BMP`). It sets the flag `+0x23bc := 1`, meaning "this is the intro".
5. State 21 waits for the movie form to close. Then `Form1` redraws its border frame (`42d01c`) and,
   because the intro flag is set, `nextScene := 0` and state goes to 5, which loads `000.BSB`.

There is no command-line handling. The book always starts with intro movie 1 and then scene 000.
Scene 000 (the ship deck) has a `FIND_LEGGER` behind the cook (`KOKKIE` click area): it jumps to
the bookmarked page if `Pagina != 0`.

### 1.2 Quitting

* Menu button 2 (see 5.5) opens the JA/NEE sign. **JA** sets state 7: `MainForm.Close`.
* `{THE_END}` (last page 069, after movie 3): disables MouseTimer, cleans up the page and calls `MainForm.Close`.
* `FormClose_437ea8`: `sndPlaySound(nil)`, both timers off, frees the bitmaps, then runs the **outro/credits screen**
  (`FUN_0042c688`/`42c974`/timer `42c4cc`) modally:
  * A new borderless black 640x480 form is shown with `AT001.bmp` (640x480 frame artwork) at (0,0), and `SOUNDS\AT001.WAV` is played via MCI.
  * Every **50 ms**: composite `AT003.bmp` (320x2656 credits strip), source rect `(0, pos, 320, pos+300)`, then
    SRCAND `AT002.bmp` (mask) and SRCPAINT `AT001.bmp` (both source rect (160,80)-(480,380)). Blit the result to
    screen rect **(160,80)-(480,380)**. `pos` starts at **150**, goes up by **3 px/tick** and is clamped to `2656-300`.
  * It ends when AT001.WAV stops playing (MCI mode is not "playing"), or on a click anywhere (`42c670`).
    Then the application terminates.
* There are no keyboard handlers in BBOEK32 (no Esc). Alt+F4 also goes through FormClose and so shows the credits.

### 1.3 Backdrop `Form1` (TForm1, `FormCreate_42d400`, `FUN_0042d01c`)

A full-screen black window behind the 640x480 book. `42d01c` draws a decorative frame with
`IMAGES\bord<n>s.BMP` (n=1..7) when the screen width is not 1024 ('s' = small = 800x600 layout):

| n | dest rect (800x600 screen) | bitmap size |
|---|---|---|
| 1 | (0,0)-(80,60) top-left | 80x60 |
| 2 | (80,0)-(720,60) top | 640x60 |
| 3 | (720,0)-(800,60) top-right | 80x60 |
| 4 | (0,60)-(80,540) left, **and** (720,60)-(800,540) right | 80x480 |
| 5 | (0,540)-(80,600) bottom-left | 80x60 |
| 6 | (80,540)-(720,600) bottom | 640x60 |
| 7 | (720,540)-(800,600) bottom-right | 80x60 |

For a 1024-wide screen ('l') the same layout is offset by (112,84) (rects 0x70..0x390), using `bord<n>l.BMP`.
**Those 'l' files are not on the CD**, so on a 1024 screen they fail [?]. The frame is cleared to black when a
movie starts (`42cfd8`) and redrawn after a movie (`42d01c`). Web suggestion: an 800x600 stage with the 640x480
book at (80,60) inside the BORD frame, or the bare 640x480 view.

---------------------------------------------------------------------------------------------------

## 2. TMainForm screen layout

* One 640x480 client area. Everything is drawn into the back-buffer `+0x1c0`, and dirty rects are copied
  (SRCCOPY) to `MainImage.Picture.Bitmap`. The back-buffer is the "page"; animations, the text box,
  the menu, the worm and the JA/NEE sign are all painted **into** it, so they overwrite each other.
* The page background is a 640x480 BMP (`I0xx.BMP`) loaded by `ACTIVATE_MAINIMAGE`.
* The text box (section 5.1) is a stippled translucent coloured rectangle with a 1 px black border and
  white (or yellow) Arial 12 bold text with a black shadow.
* The icon menu (section 5.5) is 1 to 5 icons of 50x50 from `MENU2.BMP` in a horizontal or vertical strip,
  at a script-given position.
* The software cursor (section 5.7) is a 32x32 animated sprite drawn directly on the screen image.
* No caption, no Windows buttons, no scrollbars.

---------------------------------------------------------------------------------------------------

## 3. Script format and interpreter

### 3.1 File format and loading (`FUN_00437904`)

* The file name is the scene number as 3 digits plus `.BSB` (`"00"+n` if n<10, `"0"+n` if n<100, else `n`).
  The scene number is kept as a **byte** (`+0x638` current, `+0x63c` next).
* Loaded into a TStringList, **empty lines are deleted**, and every byte of every line is decoded as `c-1`.
* For each line starting with `{LABEL}`: `labels[k] = { name: copy(line, 8, len-8) (drops "{LABEL}" and the last char,
  normally "~"), truncated to 20 chars; line: index }`. **Label lines remain in the line list** and execute as no-ops.
* Resets on load: animation count, click-area count, effect count, label count, line pointer = 0,
  LARGEBOX values = 0. `MENU2.BMP` is (re)loaded and state goes to 2.
  **Not** reset on load: the menu buttons (count/rects), the text-box words and reader times, and the
  reader/MediaPlayer. So a page without `INIT_MENU` keeps the previous page's (invisible) menu hot-spots. Most of
  those pages auto-advance.
* Before loading, `FUN_0043b8bc` frees the page's animation bitmaps and MENU2, and resets the worm completely.

### 3.2 Argument extraction (`FUN_0043765c(self, n)`), which needs exact reproduction

The current line is `L = lines[ip]`.

* **n = 1**: if `L[1]=='{'` then `start = pos('}')+1`, else `start = 1`. Return `copy(L, start, pos('~') - start)`.
  The length is computed as a byte, so with no `~` on the line, the length wraps (about 248) and the rest of
  the line is returned (for example `{DELAY}1500` without `~` gives "1500").
* **n > 1**: `s = L` (including the `{CMD}` prefix). Repeat n-1 times: `s = s after the first '~'`. Then:
  * if `s` contains `~`: return `copy(s, 1, pos('~')-1)`;
  * else if `s == ''`: return `''` (end of fields on this line);
  * else (**multi-line argument**): `acc = s`; `ip++`. While `lines[ip]` contains no `~`: `acc += ' ' + lines[ip]`; `ip++`.
    Finally `acc += ' ' + copy(lines[ip], 1, len-1)`, which drops the last char and so assumes the closing `~`
    is the last char. Return `acc`. **ip now points at the last text line**, and the interpreter continues
    after it. Only the text argument of `INIT_TEXTBOX` uses this.
* Line continuation for `INIT_READER` works differently (see 4.x INIT_READER).

### 3.3 Command dispatch

Dispatch is by **case-sensitive prefix**: `copy(L, 1, length("{CMD}")) == "{CMD}"`. Unknown lines (including
`{LABEL}..` lines, text-continuation lines and **`{ACTIVATE_ANIMATIONT}`**, a typo in the scripts) do
nothing. Trailing text after the command is irrelevant (for example `{END} ` and `{FIND_LEGGER} `).

### 3.4 Interpreter loop (`ScriptTimerTimer_439164`)

**One script line is executed per ScriptTimer tick.** The timer interval is global and is changed by
commands. It persists across commands and across pages:

| Set by | Interval |
|---|---|
| initial (DFM) | 70 ms |
| `ACTIVATE_ANIMATION` | that animation's delay (arg 5 of `INIT_ANIMATION`) |
| `ACTIVATE_READER`, menu "read again", clicking a word | 40 ms |
| opening the JA/NEE sign | 100 ms |

`DELAY ms` is converted to **ticks = ms div currentInterval** (integer division). Worm idle time is
converted the same way (see 5.6).

State byte `+0x1c4` (`st`) and return state `+0x1c5` (`ret`):

```
onScriptTick():                         // every ScriptTimer.interval ms
  switch st:
  case 0:  idle (nothing)
  case 2:  RUN_LINE
  case 3:  waiting for user input (only mouse handlers act)
  case 4:  READER: st=0
           if media.mode == stopped: unhighlight(word[readTo]); setCursor(1); st = ret
           else: if media.position > word[cur].endMs:
                     unhighlight(cur); if cur < readTo: cur++; highlight(cur)
                 st = 4
  case 5:  LOAD_SCENE: cleanupPage(); curScene = nextScene; loadScript(nextScene); st = 2
  case 6:  ANIM: st=0; drawFrame(anim, frame)           // see 4 ACTIVATE_ANIMATION
           if from<=to: frame++; if frame>to: st=ret; else st=6
           else:        frame--; if frame<to: st=ret; else st=6
  case 7:  QUIT: cleanupPage(); MainForm.Close()
  case 8:  DELAY: st=0; delayTicks--; st = (delayTicks==0) ? ret : 8
           // delayTicks==0 at start would underflow and hang (no script triggers this)
  case 9:  EFFECT: st = (media.mode==stopped) ? ret : 9
  case 11: SIGN_UP:  n++; drawSign(n); if n==15: play yn001/yn002.wav; st=13 else st=11
  case 12: SIGN_DOWN: n--; drawSign(n); if n==0: finishSign() else st=12
  case 13: SIGN_WAIT (clicks handled in MouseDown)
  case 20: INTRO movie start (1.1)          case 21: wait for movie end (6.2)
  case 22: wait for minigame end (6.1)

RUN_LINE:
  st = 0; ret = 2
  L = lines[ip]
  if L startsWith "{END}":  st = 3; ret = 3
  ... dispatch all other commands (section 4); each may set st (blocking) ...
  if L startsWith "{THE_END}": st=0; MouseTimer.off; cleanupPage(); MainForm.Close(); return
  if L startsWith "{AUTO_NEXT}": curScene=nextScene; st=5; return     // no ip++ needed
  if L startsWith "{FIND_LEGGER}" and bookmarkAtStartup != 0:
        nextScene = bookmarkAtStartup; st = 5; return
  if ip == lastLineIndex: st = 3                                  // end of file acts as {END}
  ip++
  if st == 0: st = 2                                              // non-blocking: next line next tick
```

All command checks run in sequence on the same line. Because they are prefix-exclusive, at most one matches.

Blocking commands set `st` to 4/6/8/9/21/22 and come back to `ret` (2 = continue with the next line, or 3 if
the line was `{END}`). There is no call stack: a `{LABEL}` block runs until its `{END}`, which goes back to state 3.

**Jumping** (`MainImageMouseDown_43a5d4`, only in state 3): `ip = labels[k].line; st = 2`. The `{LABEL}` line itself
is then executed as a no-op tick.

---------------------------------------------------------------------------------------------------

## 4. Commands

Notation: `a1~a2~...`. Numbers are parsed with StrToInt. Colour names are upper-cased first.

### `{NEXT_SCENE}nnn~`
`nextScene = int(a1)` (`+0x63c`). It does not jump. It is used by the menu's "next page" button and by
`{AUTO_NEXT}`. It can appear inside labels to create branches (016 gives 080, 017 gives 081, 049 gives 053, 059 gives 060).

### `{INIT_MAINIMAGE}file.BMP~`
Stores the file name (`+0x640`). Nothing is drawn yet. The same file is used by "print".

### `{ACTIVATE_MAINIMAGE}`
Replaces the back-buffer with `IMAGES\<file>` (it is a fresh bitmap, so the menu, text box and worm disappear from the buffer),
sets the font to Arial 12 bold with a clear brush, and blits the whole buffer to the screen. It is instant, with no transition.
It is used inside labels to clear the old text box before showing a new one (004 `ToMot`). Note that the menu is
then gone visually, but its hot-spots stay active.

### `{INIT_LARGEBOX}x~y~w~`
Alternative text-box x, y and width (`+0x65c/660/66c`). `INIT_TEXTBOX` uses these **only if the back-buffer font
height is -20 px**, which is the "large fonts" (120 dpi) Windows setting (`436f9c`: `font.Height == -0x14`). At
96 dpi the font is -16 px and LARGEBOX is ignored. **Web: ignore LARGEBOX.**

### `{INIT_TEXTBOX}x~y~w~textColor~hiliteColor~bgColor~LOW|MEDIUM|HIGH~text...~`
(`FUN_00436f9c`) Clears 80 word slots (text, rect, reader times, click ranges). Then:
* `box.left=x, box.top=y, box.right=x+w` (or the LARGEBOX values, see above).
* `textColor` and `hiliteColor` are names from BLACK MAROON GREEN OLIVE NAVY PURPLE TEAL GRAY SILVER RED LIME YELLOW BLUE
  FUCHSIA AQUA WHITE, giving Delphi colours `#000000 #800000 #008000 #808000 #000080 #800080 #008080 #808080
  #C0C0C0 #FF0000 #00FF00 #FFFF00 #0000FF #FF00FF #00FFFF #FFFFFF` (`435194`).
* `bgColor` is the same list as an **index 1..16** (`435414`). It selects the colour row in `PATTERN.BMP`.
* style: `LOW` = 0, `MEDIUM` = 1, anything else (scripts use `High`) = 2.
* The text may span several lines (3.2) and is joined with single spaces.
* **Word layout** (pixel-exact). The canvas font is Arial bold 16 px.
  ```
  right = box.right - 5; cx = box.left + 5; cy = box.top + 5; i = 1
  while text contains ' ':
      w = copy(text, 1, pos(' '))          // the word INCLUDING its trailing space
      tw = TextWidth(w); th = TextHeight("W")
      r = (cx, cy, cx+tw, cy+th)
      if r.right > right:                   // wrap (includes the trailing space)
          r = (box.left+5, cy+18, box.left+5+tw, cy+18+th)
      word[i] = { text: w, rect: r, clickFrom: i, clickTo: i }
      cx = r.right; cy = r.top; i++
      text = text after the first ' '
  if text != '': last word, laid out the same way (no trailing space)
  wordCount = i (or i-1 if the text ended in a space) [?]
  box.bottom = word[wordCount].rect.bottom + 5
  ```
  Double spaces produce a 1-char " " word. `th` is about 18 for Arial Bold -16 [?]. The line pitch is always 18.

### `{ACTIVATE_TEXTBOX}`
(`FUN_004374c0`, `FUN_00429528`)
1. Background: tile `PATTERN.BMP` (80x340, tiles of 20x20) over the box rect, anchored at box top-left and
   clipped at the right and bottom edges. Per tile: SRCAND with the **mask tile** `(style*20, 0, 20x20)`, then SRCPAINT with
   the **colour tile** `(style*20, bgIndex*20, 20x20)`. Mask density: LOW 25 %, MEDIUM 37.5 %, HIGH 50 % of the pixels
   take the colour, and the rest keep the picture (a "screen-door" translucency). Use the BMP pixels as they are:
   its palette has e.g. MAROON as #BF0000, not #800000.
2. A black 1 px rectangle outline over the box (pen black, brush clear) [? pen style assumed solid].
3. Draw every word unhighlighted (see 5.2) and blit the box to the screen.

### `{INIT_READER}file.wav~count~s1,e1~s2,e2~...~`
(`FUN_004364b4`) `readerWav = SOUNDS\file`. `wordCount := count` (it **overrides** the layout count). Then `count`
pairs `start,end` in **milliseconds** are read into `word[k].startMs/endMs`. Pairs continue on following lines.
When field j on the current line is empty (the line ended with `~`), `ip++` and parsing continues with field 1
of the next line. Must come after `INIT_TEXTBOX`, which clears the times. Scene 065 contains the template
line `{INIT_READER}bestand~aantal woorden~...` and `TEKST`: StrToInt raises an error there. 065 is an unused
placeholder page that nothing links to.

### `{ACTIVATE_READER}from~to~`
(`FUN_00436608`) `readFrom = from, readTo = to, cur = from`. MediaPlayer: Close, set FileName to readerWav, Open,
`StartPos = word[from].startMs`, `EndPos = word[to].endMs`, Play. Cursor becomes type 2 (mouth). Highlight `word[cur]`.
**Interval 40 ms.** State 4 (blocking, see 3.4). Typical scripts call it with 1..N directly after the text box.

### `{INIT_CLICKWORD}w~from~to~w~from~to~...~`
(`FUN_00436718`) Triples: clicking word `w` reads words `from..to` (for example a multi-word name read as one).
Default for every word is `from = to = w`. The list ends at the first empty field.

### `{INIT_MENU}x~y~horiz~b1~b2~b3~b4~b5~[colour~style~]`
(`FUN_004368e8`) `horiz == "1"` gives a horizontal strip (dx=50), otherwise a vertical one (dy=50). `bN == "1"` enables button N.
Optional args 9/10 (`YELLOW~LOW` in 004) are parsed into `+0x1fec/+0x1ff0` and **never used**. The code
also reads arg 7 instead of 10 for the style. Ignore them.

### `{ACTIVATE_MENU}`
(`FUN_00436b20`) Enabled buttons are packed in order (disabled ones leave no gap). Button i (1-based among the
enabled) has rect `(x+(i-1)dx, y+(i-1)dy, +50, +50)` and id = its original number 1..5. Drawn from `MENU2.BMP`
(250x100): SRCAND the mask `((id-1)*50, 50, 50x50)`, then SRCPAINT the image `((id-1)*50, 0, 50x50)`.
The menu bounding rect is `(x-2, y, x+(n-1)dx+54, y+(n-1)dy+50)`, used for the hover test and the blit.
`menuCount = n`. Icons: 1 = read again (bear/parrot head), 2 = stop (figure), 3 = next page (arrow),
4 = bookmark (book), 5 = print (printer). Behaviour is in 5.5.

### `{CLICK_AREA}x1~y1~x2~y2~LABEL~`
(`FUN_00436d78`) Appends a rect and label name (truncated to 20). The hit test is **inclusive** on all edges. Areas are
only active in state 3.

### `{LABEL}NAME~`
A jump target. It is a no-op when executed.

### `{END}`
State 3 (wait for clicks) with return state 3.

### `{INIT_ANIMATION}name~strip.BMP~frames~TRUE|FALSE~delayMs~x1~y1~x2~y2~sound.wav~`
(`FUN_00435f50`) Appends `{name, bitmap, frames, delay, rect(x1,y1,x2,y2), wav}`. **Arg 4 (TRUE/FALSE) is
never read.** There is no transparency. Frames are blitted opaque.
Strip layout: frames side by side horizontally. `frameW = x2-x1`, and the strip is `frames*frameW` wide and
`(y2-y1)` high (for example A00201: 7x290 = 2030 x 380).

### `{ACTIVATE_ANIMATION}name~from~to~sound~`
(`FUN_004360d8`) Looks up the name (exact, case-sensitive). If it is missing, a "Deze animatie bestaat niet" message box appears.
`frame = from`. If `sound == "1"`: MediaPlayer Close, FileName = `SOUNDS\<wav>`, Open, and play on the first frame.
Sets **interval = delay** and state 6.
Frame draw (`FUN_00438f4c`): `src = ((f-1)*frameW, 0, f*frameW, bitmapHeight)` goes to `dest = rect` (SRCCOPY, no
stretch in practice) into the back-buffer, then the rect is blitted to the screen. On the first drawn frame,
if the sound flag is set, `media.Play()` runs and the flag clears. `from > to` plays backwards. Every frame (including the last) is shown for one interval.
The first frame appears one interval after the command. The next script line runs one interval after the last frame.
The sound plays through the **same MCI player** as the reader and effects, so it cuts them off.

### `{INIT_EFFECT}name~file~`
(`FUN_004362c4`) Up to N entries: name (20 chars) and file (12 chars).

### `{ACTIVATE_EFFECT}name~`
(`FUN_00436398`) If `media.FileName != SOUNDS\file`: Close, set it and Open. Then **Play** (AutoRewind restarts a
finished file). State 9: **blocks until the sound ends**. `.MID` effects (e.g. EFCT002B.MID) also go through MCI
(sequencer). Web: pre-render MIDI to audio or use a soft-synth.

### `{DELAY}ms~`
`delayTicks = ms div interval`. State 8.

### `{SETMOUSETYPE}n~`
Cursor sprite: 1 = `msMouse1.BMP` (arrow), 2 = `msMouth1.BMP` (mouth, used while reading), 3 = `mstv1.BMP` (bear
head, "busy"). Purely visual: input blocking depends only on the state.

### `{AUTO_NEXT}`
`curScene = nextScene; st = 5`. The next page loads on the next tick.

### `{FIND_LEGGER}`
If the bookmark read at start-up is not 0: `nextScene = bookmark`, go to the page (state 5). Otherwise continue.

### `{INIT_URM}clicks~seconds~wavClick~wavIdle~enterDir~x~y~exitDir~`
(`FUN_00435668`) The worm "Urm" helper (5.6).
`clicks` = number of "missed" clicks before the worm appears (`+0x1fac`, live counter `+0x14b0`).
`idleTicks = seconds*1000 div ScriptTimer.interval` (`+0x1fb0`, live `+0x14b4`), but it **counts down per MouseTimer
tick** (see 5.6). `wavClick` is the speech when triggered by clicks and `wavIdle` the speech when triggered by idling.
`enterDir` 1 = from the left, 2 = from the right, 3 = drop from the top, 4 = appear in place. `(x,y)` is the
target top-left of the 100x100 sprite. `exitDir` 1..4 (all scripts use 1). Examples: `1~999~...` appears on the first missed click.
`20~4~...` appears after 20 missed clicks or about 4 s idle (see 5.6).

### `{ACTIVATE_URM}`
(`FUN_004357b4`) Snapshot of the current back-buffer (640x480, used to erase the worm). Loads `UA.bmp`
(4800x100, 48 frames of 100x100) and `UAM.bmp` (mask). Arms the worm: not done, active.

### `{PLAY_GAME}NAME~failScene~`, `{PLAY_MOVIE}n~`
See section 6.

### `{THE_END}`
Quits the book (credits, 1.2).

### `{ACTIVATE_ANIMATIONT}...`
Not a command (a typo in 035.BSB line 50). It is ignored, so that frame step simply does not happen.

---------------------------------------------------------------------------------------------------

## 5. Interaction details

### 5.1 Text box
See `INIT_TEXTBOX` and `ACTIVATE_TEXTBOX`. Box geometry: `(x, y) - (x+w, bottomOfLastLine+5)`. The click test for words first
checks the box rect (inclusive), then each word rect with `x1 <= X <= x2-1` and `y1 <= Y <= y2-2`.

### 5.2 Word drawing and highlighting (`FUN_00437550`)
Brush clear. `TextOut(x+2, y+2, word)` in black (shadow), then `TextOut(x, y, word)` in `hiliteColor` if highlighted,
else `textColor`. The rect `(x, y, x+TextWidth+2, y+TextHeight+2)` is blitted to the screen. The original draws on
top of the old pixels without restoring the box background. Because the glyph shapes are identical (no
anti-aliasing in 1997), this looks clean. **Web: re-render the box region (pattern and all words) instead, to
avoid anti-aliasing fringes.**

### 5.3 Reading by clicking a word (`43a5d4`)
Allowed when `st == 3`, or when `st == 4 && ret == 3` (a user-started reading is being interrupted).
For word `w`: if reading, unhighlight the current word. `readFrom = word[w].clickFrom`, `readTo = word[w].clickTo`.
If `media.FileName != readerWav`: Close and Open readerWav. `StartPos = start[readFrom]`, `EndPos = end[readTo]`,
`cur = readFrom`, Play, highlight `cur`. State 4 with return state 3. (The interval is **not** set to 40 here.
It keeps its current value, normally 40 from the initial reading [?].)
If no reader times exist (a text re-initialised in a label without `INIT_READER`, as in 004 `ToMot`), start = end = 0,
so the play stops immediately.

### 5.4 Click handling order (`MainImageMouseDown_43a5d4`)
```
if st in {11,12,13}: only the sign buttons (5.5) are handled
elif wormBlocksInput (+0x14a4): ignore
else:
  hit = false
  if st == 3:
     for each menu button containing (X,Y) (PtInRect, right/bottom exclusive):
         sndPlaySound(nil); hit = true; do button action
     for each CLICK_AREA containing (X,Y) inclusive, for each label with the same name:
         hit = true; ip = label.line; st = 2            // the last match wins
  if (st == 3) or (st == 4 and ret == 3): word hit test (5.3) -> hit = true
  worm click counter (5.6)
```
Clicks in every other state (animations, delays, effects, the initial reading) are ignored.

### 5.5 Menu and JA/NEE sign
Hover (`MainImageMouseMove_43b620`, only in st 3 and while the worm is not walking): when the pointer is inside the menu
bounding rect and over button id != lastHover, `sndPlaySound(MNU00<id>.WAV, ASYNC|MEMORY)` and set lastHover = id.
Leaving the bounding rect stops the sound (`sndPlaySound(nil)`) and resets lastHover. This is a separate
audio channel that does not interfere with MCI.

Button actions:
1. **Read again**: only if `readTo > 1`: read words `1..wordCount` (as ACTIVATE_READER, interval 40, cursor 2,
   state 4, return state = the current one (3)). (`FUN_00436824`)
2. **Stop**: open the sign in mode 1.
3. **Next page**: `st = 5` (loads `nextScene`).
4. **Bookmark**: write `INI[Boekenlegger].Pagina = curScene` (`FUN_00429084`). No visual feedback.
5. **Print**: open the sign in mode 2.

Sign (JA/NEE, `YN1.BMP` 196x179 with mask `YN1M.BMP`), at screen rect **(220,301)-(416,480)**:
* Open: `ret = st`, snapshot of the back-buffer region, interval **100 ms**, `n = 0`, state 11.
* Each tick (`FUN_0043b6f8`): restore the snapshot, then draw the top `n*12` rows of the sign (mask SRCAND, then image SRCPAINT)
  at `(220, 480-n*12)-(416, 480)`. The sign **rises out of the bottom edge**. Then blit the region.
* At n == 15: play `SOUNDS\yn001.wav` (mode 1, quit question) or `yn002.wav` (mode 2, print question), state 13.
* Clicks in state 13: **JA** `255<=X<=304, 335<=Y<=370` and **NEE** `324<=X<=385, 338<=Y<=371`
  (strict inequalities in code: `0xfe<X<0x131`, `0x14e<Y<0x173`, `0x143<X<0x182`, `0x151<Y<0x174`). Stop the media, state 12.
* State 12 counts n down to 0 (the sign sinks), then: NEE goes back to `ret`. JA in mode 1 sets state 7 (quit). JA in mode 2 prints
  `IMAGES\<INIT_MAINIMAGE file>` scaled to the printable page width (height = width*480/640) via the
  PrintBuzzy dialog (`FUN_00435df4`), then goes back to `ret`. Web: `window.print()` of the page image.

### 5.6 The worm "Urm" (`FUN_00437f28` path builder, `FUN_0043ae74` draw, `MouseTimerTimer_43b1a8`)
Triggers, while the worm is armed and not yet done on this page:
* **Missed clicks**: every click with `hit == false` decrements the click counter. At 0, the worm enters with speech
  `wavClick`. Any hit **resets both counters** to their INIT_URM values.
* **Idle**: in MouseTimer, while `st == 3`, the idle counter decrements once per MouseTimer tick. At 0, the worm enters with
  `wavIdle`, and **all clicks are ignored** (`+0x14a4`) until it leaves.
  The real duration is `idleTicks x MouseTimer period`. On Win9x the period is about 55 ms, so e.g. `8 s` with interval 70
  gives 114 ticks, about 6.3 s. On NT (about 15.6 ms) it is about 1.8 s. **[?] recommend 55 ms** (the target platform was Win95).

Steps. A path is a list of `{frame 1..48, rect 100x100, flip}`. One step is drawn **per MouseTimer tick**. A
per-step delay field (10/100) is stored but **never used**. Per step: restore the previous rect from the
ACTIVATE_URM snapshot into the back-buffer and to the screen, then draw the frame into the back-buffer with
`UAM.bmp` SRCAND and then `UA.bmp` SRCPAINT. Source is `((f-1)*100, 0, f*100, 100)`, or mirrored (source x-flipped) when
flip = 1. Blit to the screen.

Phases (`T=(x,y)` from INIT_URM, `R` = current rect):
* **Enter 1 (left)**: f31 at (-100,y). Then f31 with x+=20 per step while `x <= T.x-150`.
  Then cycles of {f32..f36 in place, then f35,f34,f33,f32,f31 each x+=8} until `x > T.x`. Then f29..f24 in place.
* **Enter 2 (right)**: mirrored. Start (640,y), x-=20 while `x >= T.x+150`, cycles with -8 until `x < T.x`, then f29..f24 flipped.
* **Enter 3 (top)**: f37 at (T.x,-100). y+=20 while `y <= 216`. Cycles {f38..f42, f41..f37} each y+=4 until `y > 379`
  (ignores T.y). Then f43..f48.
* **Enter 4**: f19 at T, then f20..f24.
* After entering: play the speech wav through MCI. Then **idle** repeatedly while MCI is playing: `base = random(4)*6`,
  steps `f(base+1)`, then `f(base+1) .. f(base+3+random(3))` in place, unflipped.
* When the speech has ended, **exit 1**: f25, f26..f30 in place. Cycles as enter-1 with +8 until `x >= R0.x+150`. Then f31 with x+=20
  until `x > 640`. (Exit 2 mirrors to the left: f26, f27..29, -8, then -20 until `x < -100`. Exit 3 repeats the
  top-drop. Exit 4 is f19..f24. These are unused.)
* Then the worm is done for this page (`+0x14a2`), and input is unblocked.
Menu hover sounds are suppressed while the worm walks (`+0x148c == 10`).

### 5.7 Cursor (`MouseTimerTimer_43b1a8`, `FUN_0043ad28`)
Every MouseTimer tick: read the pointer and draw a 32x32 sprite at `(px-13, py-9)`, composited from the back-buffer
plus a sprite (SRCAND mask row `y=32..64`, SRCPAINT image row `y=0..32`). Sprite sheets are 64x64: frame A at x 0..32,
frame B at x 32..64. It alternates A/B every 5 ticks. The old position is restored from the back-buffer. No
code hides the Windows cursor and the binary has no custom cursor resources [?]. **Web: use `cursor: none` and draw
the sprite** (its arrow tip sits at (13,9), which matches the system hotspot).

### 5.8 Bookmark (legger)
Write: menu 4 writes `Pagina = curScene`. Read: once at start-up. Used only by `FIND_LEGGER` (page 000, clicking the
cook). Web: localStorage `basdebeer.pirateneiland.Pagina`, snapshotted at boot.

---------------------------------------------------------------------------------------------------

## 6. PLAY_GAME and PLAY_MOVIE

### 6.1 `{PLAY_GAME}NAME~failScene~` (`FUN_0043591c`, state 22 in `439164`)
`NAME` (upper-cased) selects one of the BBOEK32-internal forms. **BSPEL32 is not involved.** In this dialect there is no
numeric form: arg 1 is always a name.

| NAME | Form | n | INI key written at start |
|---|---|---|---|
| MOTTENSPEL | TfrmG1 | 1 | `[Games] Game1=1` |
| KISTENSPEL | TfrmG2 | 2 | Game2 |
| ROEISPEL | TfrmG3 | 3 | Game3 |
| KOKOSSPEL | TfrmG4 | 4 | Game4 |
| MEMORYSPEL | TfrmG5 | 5 | Game5 |
| GROTSPEL | TfrmG6 | 6 | Game6 |

Sequence: `failScene` goes to `+0x664`. Write the INI key. `Application.CreateForm(TfrmGn)`. Pump messages until the
form's status byte becomes non-zero (the form has initialised). `form.Show` (non-modal, but the book is
effectively frozen). Clear the book back-buffer and screen to **black**. Set state 22. Every script tick checks the
status: `1` = still playing. When it is not 1: if it is not 2, then `nextScene = failScene` (100, "Helaas, het is niet
gelukt. Bas is in het ziekenhuis terecht gekomen."). Then `form.Close`, `Free`, and `st = ret`, so the script
continues with the next line (`{AUTO_NEXT}` in five scripts, and `{DELAY}1500` then more in 068). So **2 = success**. All six games write only 2 (won) or 3 (lost, or closed early), as confirmed in section 7. An unknown NAME only blacks the screen and the script continues.

### 6.2 `{PLAY_MOVIE}n~` and the intro (`FUN_00435cbc`, `FUN_0042caf0`, `42ce98`, `42ca58`, `42ca7c`)
`n = 2` or `3` writes `[Movies] Movie<n>=1`. Backdrop Form1 cleared to black. A movie window is created:
borderless 640x480, black, centred, with a 640x480 background image and an MCI AVI player whose display panel is at
**(200, 170) for n=1 and (200, 150) for n=2/3, size 240x180** (the converted MP4s are 240x180).

| n | background | AVI | skip hot-spot (strict) |
|---|---|---|---|
| 1 (intro) | BM001.BMP ("Verder gaan" arrow) | BB001.AVI (213 s) | 515<X<565, 218<Y<256 |
| 2 (scene 042, party) | Bm002.BMP | BB002.AVI (179 s) | 570<X<610, 415<Y<460 |
| 3 (scene 069, end) | Bm003.BMP | BB003.AVI (169 s) | 570<X<610, 415<Y<460 |

A 100 ms timer closes the window when MCI mode is "stopped". A click on the skip hot-spot closes it at once.
The book back-buffer and screen are blacked while the movie plays. After it closes, Form1 redraws its frame and the
script continues (state 2). The scripts follow with `{AUTO_NEXT}` (042 to 044) or `{THE_END}` (069).

---------------------------------------------------------------------------------------------------

## 7. Minigames (TfrmG1..G6, all inside BBOEK32)

### 7.0 Common to all six
* FormCreate sets **bsNone, 640x480, poScreenCenter, fsStayOnTop** (the DFM 435x300 is overridden), so the game
  covers the book exactly. Result byte = 0 during create, **1** at the end of FormCreate, then **2 = won** or **3 = lost**.
  No other values are used. FormClose (Alt+F4 or forced) does this: if the result is not 2 or 3, play the fail sound (sync) and set 3.
  No keyboard handlers. The game form itself writes no INI keys (the book writes `GameN=1` before creating it).
* FormShow: state 1, then GameTimer on. State 1 counts **10 ticks of 50 ms (0.5 s)**, then plays the **instruction WAV
  synchronously**, then enters the play state.
* Rendering: a 640x480 clean background, a working buffer, sprites drawn as mask SRCAND then image SRCPAINT (masks are black
  for the shape and white elsewhere; sprites sit on black). Dirty rects are invalidated and FormPaint copies the buffer.
* Sound objects (class `0x42d564`: `42d600` create, `42d70c` load (WAVs of 0x32000 bytes or less are held in memory), `42d7c8` flags,
  `42d69c` play) use sndPlaySound. Flag bits: 1 = ASYNC, 2 = ASYNC|LOOP, 4 = NODEFAULT, 8 = NOSTOP, 0x10 = none.
  **Most game sounds use 0x10, which means synchronous**: the game freezes until the WAV ends (reproduce by awaiting the sound and
  pausing the game loop). Exceptions are noted below.
* Rounding is Delphi `Round` (banker's rounding, `FUN_00402af8`). Random is the Delphi LCG (any PRNG is fine).

### 7.1 G1 MOTTENSPEL (catch the moths), page 004
* Background `KAARS<burns>.BMP` (KAARS0..4, 640x480): the candle shrinks with every burn. Sprite sheet `MOTTEN.BMP`
  200x80 = five 40x40 cells (image row y 0..40, mask row y 40..80): frames 1-3 are the moth flapping, 4 is a crossed-out
  moth ("burned" icon), 5 is a green moth ("caught" icon). Status icons: burned at x=0,40,.. and caught at x=600,560,.. (y 439/440..480).
  (`42e434`)
* Round start (`42e0d0`): R1=300, R2=200, a=b=Random(628)*0.01-3.12, c=d=Random(628)*0.01. Loop sound `GE001001.WAV` (ASYNC|LOOP).
* Every 50 ms (`42dd4c`): a+=0.05, b+=0.06, c+=0.12, d+=0.23; r=Random(3); R1-=r and R2-=r (while >0).
  `x = Round(Round(cos a*R1+315)+cos c*30)`, `y = Round(Round(sin b*R2+165)+sin d*30)`, rect 40x40. The frame ping-pongs 1..3.
* Burn when the moth rect intersects the flame **(320,150)-(350,204)**. That takes at most about 300 ticks (15 s).
* Click (any button, state 2) inside the moth rect: caught on the next tick.
* Caught: hits++, `GE001002.WAV`. 5 hits: `GAME001B.WAV`, result 2. Burned: burns++, `GE001003.WAV`. With 3 burns and 0
  hits, replay the instruction `GAME001A.WAV`. 5 burns: `GAME001C.WAV`, result 3. Instruction: `GAME001A.WAV`.

### 7.2 G2 KISTENSPEL (open the four chests), page 010
* Background `IG02.BMP`. Four chests, each with a 9-frame strip (frame 1 closed, 9 open, 90 px high, frame stride = rect width):

  | chest | rect | strip |
  |---|---|---|
  | 1 | (30,185)-(180,275) | AG0201.BMP, stride 150 |
  | 2 | (183,185)-(320,275) | AG0202, stride 137 |
  | 3 | (330,185)-(460,275) | AG0203, stride 130 |
  | 4 | (465,185)-(620,275) | AG0204, stride 155 |
* All start closed. A click (state 2, first rect hit) toggles a set, animated one chest after another at
  **120 ms/frame**: chest 1 toggles {1,2,3}, chest 2 {2,3}, chest 3 {3,1}, chest 4 {4,1,2}. Opening plays `GE002002.WAV` and closing `GE002001.WAV` (async).
  When all are open: `GAME002B.WAV`, result 2. There is no lose condition. Instruction: `GAME002A.WAV`. Then the interval becomes 120 ms.
* **Timeout**: 1000 play-state ticks (about 120 s). Then the worm helper (7.7) crawls in from the left to (350,300), says
  `game002c.wav`, opens all remaining chests, leaves, and the result is **2**.

### 7.3 G3 ROEISPEL (rowing in rhythm), page 033
* Background `IG03.BMP`. Boat `AG0301.BMP`/`AG0302.BMP` (mask): 6 frames of 320x150 (frames 0-2 good rowing, 3-5 bad
  rowing/splash). Island `AG0303.BMP`/`AG0304.BMP` (mask) rises above the horizon.
* Start: draw the boat at (5,298). After the instruction `GAME003a.WAV`, the worm pops up in place at (500,200) (mode 4),
  says `ge003001.wav` and crawls off to the right. Then **MIDI `GE003002.MID` loops** (re-Play on notify stopped) and the
  interval becomes 10 ms.
* Each click (anywhere, any button) measures the interval since the previous click (in ticks). The stroke is **good** if it differs
  from the previous interval by **5 ticks or less**. A good stroke: boat x+=4, y-=2, progress+=4. A bad stroke only switches to splash frames.
  The tick is nominally 10 ms (tolerance 50 ms). On Win9x the tick was really about 55 ms (tolerance about 275 ms) **[?]**.
  Recommend a tolerance of about 250-300 ms.
* Island draw (`4311a4`): h = progress+25. Source (1,0)-(640,h) of AG0303/4, drawn to (1,235-h)-(640,234) on the persistent layer.
  AG0303 is only 200 px high: clamp it.
* **Win** at progress >= 281 (70 good clicks): `GAME002b.WAV`, result 2. No lose condition. CloseQuery allows closing only in state 2.

### 7.4 G4 KOKOSSPEL (catch coconuts), page 037
* Background `IG04.BMP`. Coconut `AG0401.BMP`/`AG0401A.BMP` (3 frames 40x40). Miss icon `AG0403`/`AG0403A`. Bas
  `AG0404.BMP`/`AG0404A.BMP` (21 frames, 120 wide, source height 0..110, ping-pong 1..20).
* Bas follows the mouse: `basketX = mouseX-50` (no clamp), drawn at (basketX,370)-(+120,480). There is no click input.
* Two coconuts, i=1,2. Spawn: `x = Random(4)*75+20+(i-1)*320`, y=-10, vy=1. Each 50 ms tick: x+=Random(7)-3, clamped 40..600.
  After `7i+30` ticks of hanging, `y+=vy; vy+=Round(caught*0.5)+1`.
* When y>380: caught if `basketX < x && x+40 < basketX+100`. Then caught++ and a coconut icon is stamped at (0, caught*50).
  5 catches: `GAME004B.WAV`, result 2. Otherwise, when y>450: missed++, icon at (600, missed*50), `GE001003.WAV`.
  5 misses: `GAME001C.WAV`, result 3. Instruction: `GAME004A.WAV`.

### 7.5 G5 MEMORYSPEL (pairs), page 061
* Background `IG05.BMP`. 4x4 grid of cells (120+100(i-1), 40+100(j-1), 100x100). Values 1..8 twice, shuffled with 100 random
  swaps. Card strips `AG0501..AG0508.BMP` are 11 frames of 100x100 (frame 0 = back, 10 = open), SRCCOPY with no mask.
* Click (any button) on an idle cell with phase<3: `GE005001.WAV` (async), and the card opens over frames 1..9 (50 ms each).
  The second card does the same. Match: optionally `GE005005`/`GE005006` (2/3 chance, sync), both cells revert to the background (removed),
  pairs++. Mismatch: optionally `GE005003`/`GE005004`, both close over frames 10..0 with `GE005002.WAV` (async), misses++.
* 8 pairs: result 2 (no specific win sound). 20 misses: `GE005007.WAV`, result 3. One-time hint `GE005008.WAV` at
  10 misses or pairs+misses = 15. Instruction: `GAME005A.WAV`.

### 7.6 G6 GROTSPEL (cave runner), page 068
* Title `IG0700.BMP`, then 5 screens. Each composite is A SRCCOPY, C (mask) SRCAND, B SRCPAINT from `IG070<n>A/B/C.BMP`.
  Screen 5 reuses the graphics of screen 1. Bas: `ag0705.bmp`/`ag0705m.bmp` (11 frames of 124x229): frames 0-5 walk, 6-10 duck, the jump uses frame 1.
* Obstacles (100x100 frames):

  | screen | obstacle | sprite | start | motion |
  |---|---|---|---|---|
  | 1 and 4 | bee | AG0703 (+M) | (540,185) | x-=2, wraps to 640 |
  | 2 and 5 | boulder | AG0702 | (540,350) | x-=4, vy+=1, bounces with vy=-25 at y 350 |
  | 3 | sparks | AG0704 | (290,-100) | y+=10, wraps |
* Tick 100 ms. Bas starts at (-100,230). Walking is x+=8. **Left button down = duck** (y down to 270). Release left = stand up.
  **Right button = jump** (apex y 170, x+=15 per jump tick, 11 ticks covering 165 px). Pixel-exact mask collision.
* x>620 goes to the next screen (level-change WAVs `GE007006`/`ge007007`/`ge007008` at screens 2/3/4).
  Clearing screen 5: `ge007004.wav`, result 2. A hit: `ge007002.wav`, lives-- (starting at 3), restart at screen 1.
  At 1 life left: `ge007005.wav`. At 0 lives: `ge007003.wav`, result 3. Instruction: `GE007001.WAV`.

### 7.7 Worm helper inside games (class 0x42e8ac..0x42fb98, `UrmTimerEvent_42f7b4`)
This is a separate implementation from the book's worm. It uses `URM1A.BMP` (sprites) and `URM1B.BMP` (masks), 60 frames of 100x100,
draws directly on the game image with its own per-record timer (delays of **10 ms** while moving and **100 ms** while posing),
and saves and restores the 100x100 background. The paths are the same as the book's (5.6) but the frame numbers are **offset by +12**
(enter 1 starts with f43, crawls 44-48, stands up 41..36. Mode 4 pops up with 31-36. Exit 1: 37, 38-42, crawl, 43 moving +20).
Talking plays the WAV via MCI and runs random mouth frames `s+1, s+1..s+n+3` (s=Random(4)*6, n=Random(3)) at 100 ms until the WAV ends.
Calls block (ProcessMessages loop) until the sequence ends.

---------------------------------------------------------------------------------------------------

## 8. Page graph (from NEXT_SCENE)

000 to 026 linearly, with these exceptions: 021 goes to 024, 024 to 022, 022 to 023, 023 to 025, and 016/017 can branch to 080/081, which return to 017/018. Then 026, 031..042 (042 movie 2), 044..052, 052 to 054, 049 can go to 053 (back to 050), 054..056, 056 to 058, 058 to 057, 057 to 059, 059 to 061 (or 060, then 061), 061 to 062 to 066, 066 to 068, 068 to 067, 067 to 069 (end).
Games: 004 Motten, 010 Kisten, 033 Roeien, 037 Kokos, 061 Memory, 068 Grot. The fail page is 100. Unused pages: 063, 064, 065 (template).
Pages without INIT_MENU auto-advance.

---------------------------------------------------------------------------------------------------

## 9. Launcher and the other programs

**Correction to the brief: BCD32 is not the launcher.** The CD menu is `Autorun.exe` in the disc root (AUTORUN.INF).

* **Autorun.exe** (TfrmAutorun): a borderless, centred **596x305** panel ("Distributed by: ToYou" bitmap), with the label "Maak Uw
  Keuze:" at (16,256) and an "X" close button at (8,8) 25x25. Four buttons of 146x23 at y=280, x = 5 / 151 / 297 / 443:
  **Berenboek** starts `BASWIN\BBOEK32.EXE`, **PrintStudio** starts `BPRINT32.EXE`, **BerenSpellen** starts `BSPEL32.EXE` and **BerenBios**
  starts `BBIOS32.EXE` (CreateProcess, no waiting; the launcher stays open behind the 640x480 on-top child). No CD, colour or
  install checks. Web: a start page with these 4 choices (PrintStudio is out of scope).
* **BCD32.EXE** ("CD Speler") is an audio-CD player for the disc's Red Book tracks (Play/Prev/Back/Forw/Next/Stop/Eject on a
  314x140 skin, "[TT] MM:SS" display). Nothing on the disc launches it. Not needed for the web port.
* **BBIOS32.EXE** ("BereBios", the bear cinema): 640x480 borderless on top. The start screen is `BB001.BMP` (cinema with 3 posters
  and an exit icon) plus `BB001.WAV`, with input blocked while it plays. Posters: movie 1 (79-228 x 9-211) is always available.
  Movie 2 (253-398 x 10-209) and movie 3 (418-570 x 8-209) need `[Movies] Movie2/3 != 0`. Otherwise `BB003.WAV` ("not yet")
  plays. Playing: the backdrop becomes `BB002/BB003/BB004.BMP` (auditorium) and the AVI shows at native size at **(200,100)**.
  Stop it by clicking 573-601 x 421-461 or at the end, then `BB002.WAV` plays and the cinema returns.
  The exit icon (570-620 x 420-470) plays hover `MNU002.WAV` and opens the same JA/NEE sign as the book (50 ms per step). JA quits.
* **BSPEL32.EXE** ("BereSpel"): an 800x600 BORD frame backdrop plus a 640x480 menu, `BG001.BMP` (six items) with a highlight
  from `BG004.BMP`. The item is chosen by **cursor Y** (<171, 171-225, 226-280, 281-327, 328-380, >=381), with highlight rects at x 190-440.
  Two spinning bear heads (`BG002.BMP` 20 frames of 50x50, mask `BG003.BMP`) sit at x=130 and 460, at y = clamp(mouseY-25, 110, 385).
  A click with x 191-439 starts the item's game **only if `[Games] GameN` is set**. Otherwise a message box: "Je mag dit spel nog niet
  spelen. Je moet het eerst in het BerenBoek gespeeld hebben". The games are the same 6 units as in the book.
  The result is ignored and play returns to the menu. Exit icon (600,425)-(630,472) leads to the JA/NEE sign.
* **BPRINT32.EXE** (Berenprintstudio) is only launched from Autorun. Out of scope.
* INI links: the book writes `Game1..6` (when a game is *started*), `Movie2/3` (when a movie starts) and `Pagina`.
  BSPEL reads `GameN`. BBIOS reads `Movie2/3`.

---------------------------------------------------------------------------------------------------

## 10. Open questions and uncertainties

1. **Timer granularity.** MouseTimer (10 ms) drives the cursor animation, the worm walk (20 px per step) and the worm idle
   countdown. G3's rhythm tolerance is in 10 ms ticks. On Win95 these really ran at about 55 ms. The spec recommends 55 ms for
   MouseTimer-driven things and 250-300 ms for the rowing tolerance. This needs a real-hardware or emulator check.
2. Worm idle time = `seconds*1000 div ScriptTimer.interval` MouseTimer ticks. The interval at INIT_URM time depends on
   earlier commands (often 40 from the reader, 70 initially), so the effective idle time varies.
3. TextHeight of Arial Bold 16 px (assumed 18-19). It affects the box bottom and word hit rects. The line pitch is fixed at 18.
4. The Windows arrow cursor is not hidden by any code found, so it is unclear whether users saw both the system cursor and the sprite.
   Recommend hiding the system cursor.
5. The pen style for the text-box outline (assumed a solid black 1 px border).
6. In 5.3, clicking a word does not set the interval to 40 ms. Highlight steps then advance at whatever the interval is (e.g. 100 ms
   after a JA/NEE sign). This is faithful but may look odd.
7. The 1024x768 frame (`bord<n>l.BMP`) is missing from the disc. Behaviour on 1024 screens is unknown (probably no frame).
8. `wordCount` when the text ends with a space (an off-by-one in the layout loop). `INIT_READER` overrides the count anyway on all real pages.
9. Whether Delphi TMediaPlayer AutoRewind restarts a still-playing identical effect. It is irrelevant in practice because effects block input.
10. Scene 065 is a broken template (would raise EConvertError) and is unreachable. 063 and 064 are also unreachable. 099 (after 069) does not exist,
    but THE_END quits first.
