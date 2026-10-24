# "Bas de Beer naar het Noorderlicht": story-book engine, reimplementation spec

Source: `BASWIN/BASNOORD.EXE` (Delphi 2/3, Win32, Mindwarp 1998). Addresses are VAs in that EXE.
Functions are `FUN_xxxxxx` (Ghidra) or the published method name. Some functions exist only in
`BASNOORD.asm.txt`: StoryPlayer.FormCreate `0x444a24`, clTimerTimer `0x447bdc` and JumpTimerTimer `0x448c38`.

Conventions:
- TColor is `0x00BBGGRR`. `0xFF` is red and `0xFFFF00` is aqua (cyan).
- Rects are `(left,top,right,bottom)`. Hit tests use `PtInRect`, so the right and bottom edges are **exclusive**.
- "(?)" marks an inference that was not verified.

---

## 0. Key facts

- **D/N is not day/night.**
  - `N` = the normal 256-colour rendered art. The help file calls it "3D mode".
  - `D` = red/blue anaglyph art. The help calls it "3D-plus", for use with 3-D glasses.
  - The global mode byte is `DAT_0044e6af`: 0 = N, 1 = D.
  - Every page script exists as `<page>N.BSB`, and most also as `<page>D.BSB`. Pages without a D file: 04, 05C, 13B, 18, 20, 24, 35, 38, 41, 51–54. Most of these are game or tutorial pages.
- **Coordinate system.** The game has one canonical 800×600 layout.
  - When the screen width is ≤ 640, the game uses a 640×480 window. It is a crop of the 800×600 backgrounds at offset (80,44).
  - All hotspot and rect tables come in two copies, one per screen mode `DAT_0044e6ae`: 0 = 640, 1 = 800.
  - **Recommendation:** implement only the 800×600 layout (mode 1). All numbers below are for mode 1 unless noted otherwise.
- **Execution model.**
  - The script is a flat command list.
  - A 10 ms `CommandTimer` executes the next command whenever a `ready` flag is set.
  - Each command handler sets `ready` either at once or later, when its asynchronous work finishes (animation, delay, sound, reading, game). That gives sequential, blocking semantics.
  - A second, independent mini-interpreter runs "continuous labels" on `clTimer`.

---

## 1. Boot and program flow

### 1.1 Startup (`FUN_0042b000`, unit init)

**Base directory.**
- Base = the EXE directory (`DAT_0044e69c`).
- The directories are `<base>\IMAGES\` (`DAT_0044e690`), `\SOUNDS\` (`DAT_0044e694`) and `\SCRIPTS\` (`DAT_0044e698`).
- If any directory is missing, the game shows the message "Error - 001" and halts.

**Command line.** Parameters are case-insensitive.

| Parameter | Effect |
|---|---|
| `/P<path>` (ParamStr(1)) | Overrides the base directory. |
| `/S<name>` (the next parameter) | `DAT_0044e6a0 := copy(s,3,4)`, the start script (for example `/S01N`). Also sets `DAT_0044e6ad := 1` ("direct mode"): no splash sound, the welcome screen is skipped, and closing the story terminates the app. |
| `/GM` | Sets `DAT_0044e6ac := 1`. Nothing reads it, so it is unused. |

**Bookmark (registry).**
- Read through `FUN_0042ae00`: `HKCU\Software\Mindwarp\Bas de beer\`, section `Naar het noorderlicht`, value `Boekenlegger`, default `"01n"`.
- Only `copy(value,1,2)` is kept, in `DAT_0044e6a8`.

**Other setup.**
- Screen mode: `DAT_0044e6ae := Screen.Width > 640` (GetSystemMetrics(0)).
- `Screen.Cursors[1] := LoadCursor("CURSOR_1")`. This is the custom hand cursor, RT_CURSOR id 1, 32×32 monochrome, hotspot (0,0). It shows an open hand with fingers up and the thumb to the right.
- The Windows taskbar is hidden (`ShowWindow(FindWindow("Shell_TrayWnd"),SW_HIDE)`).

### 1.2 Forms created by `entry` (`0x44a868`)

**Main form.** frmWelcome (`DAT_0044e728`) is created first.

**Splash** (`DAT_0044e730`), which is shown immediately.
- The main loop pumps messages while `splash.running` (`+0x1bc`) is set.
- Window: borderless, black, centred, sized to MWSPLASH.BMP (286×412), which it paints.
- FormShow (`0x44a7f4`): unless in direct mode, plays `MWSPLASH.WAV` asynchronously and enables SplashTimer (100 ms).
- SplashTimerTimer (`0x44a81c`): tries `sndPlaySound(SE000000.WAV, SND_NOSTOP)`. SE000000.WAV is 11 samples of silence. The call succeeds only once no other sound is playing. When it succeeds, the splash ends.
- A mouse or key press calls `sndPlaySound(NULL)`, which stops the sound, so the splash ends on the next tick.
- **Web:** show the splash until MWSPLASH has ended or the user clicks or presses a key.

**Other forms**, created after the splash: frmBackGround (`DAT_0044e72c`), frmStoryPlayer (`DAT_0044e720`), frmCredits (`DAT_0044e6b4`), frmThumbJump (`DAT_0044e724`) and dlgQuit (`DAT_0044e6b8`).

**frmBackGround** (`0x44a42c`): borderless, black, covers the full screen. It is only a backdrop. All other windows are borderless, black (Color = 0), `poScreenCenter`, and some are `fsStayOnTop`.

**Unused forms.** TdlgCommands and TPalette_dlg exist only as DFM resources. Their classes are not linked into the code, so do not implement them. TfrmClickTip is used (see 1.7).

### 1.3 Welcome (`TfrmWelcome`, FormCreate `0x449840`)

- 640×480, background `WCSMAIN.BMP` (640×480). It paints its buffer, a second copy of WCSMAIN.
- The DFM buttons btnBegin and btnKiesScherm are invisible.
- **FormActivate** (`0x449c8c`):
  - In direct mode, it starts the story at once.
  - Otherwise it plays `WCS001.WAV` asynchronously and resets the hover state.

**Three hotspots** (records at `0x44d634`, `0x44d66c`, `0x44d6a4`; 0x38-byte "rect records", see 3.3):

| Name | Rect | Hover images (normal / mask / highlight) | Click action |
|---|---|---|---|
| SysBegin | (224,406,430,441) | WCSSTRTN / WCSSTRTM / WCSSTRTH (206×35) | `DAT_0044e6a0 := "01N"`, start the story |
| SysKies | (447,369,621,455) | WCSCHSEN / WCSCHSEM / WCSCHSEH (174×86) | Show ThumbJump |
| SysUitleg | (20,406,220,441) | WCSEXPLN / WCSEXPLM / WCSEXPLH (200×35) | `DAT_0044e6a0 := "51N"`, start the tutorial (pages 51N→52N→53N→54N→01N) |

- **Hover** (`FUN_00449ed0`, `FormMouseMove 0x44a0ac`):
  - Entering a hotspot blits the mask (`*M`, SRCAND) and then the highlight (`*H`, SRCPAINT) at the rect's top-left, and sets cursor 1.
  - Leaving all hotspots restores every hotspot (mask SRCAND, then `*N` SRCPAINT) and sets cursor 0.
- **Starting the story:** `StoryPlayer.Start()` (`FUN_00444380`), then `StoryPlayer.Show`, disable WelcomeTimer, then Hide.

### 1.4 ThumbJump, the "bookmark" page overview (`TfrmThumbJump`, FormCreate `0x4483cc`)

- 640×480. Background `BACKGRAY.BMP`, which contains greyscale versions of all thumbnails.
- `THUMBS.BMP` is 4032×36: 56 colour thumbnails of 72×36 each, side by side.
- **56 slots** (records at self+0x1d8, stride 0x38). The names come from the table at `0x44d554`:

  `01 02 03 04 05 05B 05C 06 07 08 09 10 10B 11 12 13 13B 14A 14B 15 16 17 18 19 20 21 22 22B 23 24 25 26 27 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 47A 48 49 50`

  There is no 28, and the tutorial pages 51–54 are not listed.
- **Slot i** (col = i mod 10, row = i div 10):
  - left = 30 + 57·col, top = 30 + 45·row, right = left + 72, bottom = top + 36.
  - Then for every col > 0, `slot[i-1].right := slot[i].left`. So columns 0–8 are 57 px wide and column 9 is 72 px wide.
- **Unlocked slots.** A slot is unlocked (`+0x34 = 1`) up to and including the slot whose name equals the bookmark `DAT_0044e6a8` (exact match). All later slots are locked. `bookmarkSlot` is stored at self+0x1bc.
  - Quirk: the bookmark keeps only 2 characters, so a bookmark such as "14" matches no slot. All slots then stay unlocked and bookmarkSlot stays 0.
- **FormShow** (`0x449620`) enables JumpTimer (200 ms). The selected index `sel` (self+0x1c0) starts at −3.
- **JumpTimerTimer** (`0x448c38`):
  - While sel < 0: sel++. This gives a 600 ms pause.
  - While sel ≤ bookmarkSlot:
    1. Play `TPOP.WAV` asynchronously.
    2. Blit `THUMBS` source (sel·72, 0, sel·72 + w, 36) into the slot rect.
    3. Draw an outline: brush clear, pen `0xFFFF00` (aqua) for the rect, then InflateRect(1) and pen `0xFF0000` (blue).
    4. sel++.
  - Then disable the timer.
  - Draw the preview `T<name[bookmarkSlot]>.BMP` (280×140) at (345,310) with a white outline inflated by 1 px.
  - Play `TINTRO.WAV` and set sel := bookmarkSlot.
- **Click on a slot** (`FormMouseDown 0x4488b4`; slots are checked from 55 down to 0):
  - `FUN_00449388`: redraw the previous selection with its aqua/blue frame (or the grey background if it is locked). Draw the new selection with a red (`0xFF`) frame plus a purple (`0x800080`) inflated frame.
  - Preview = `IMAGES\T<name>.BMP` at (345,310)-(625,450). Locked slots show `T00.BMP` instead.
  - Store sel and set "has selection" (+0x1d0 = 1).
- **"VerderRect"** (34,324)-(335,360), "VERDER GAAN" (continue): go to sel. Hover shows `THA1.BMP` (301×36). A double-click on the form also triggers "go" when a slot is selected.
- **"OpnieuwRect"** (37,376)-(333,453), "OPNIEUW BEGINNEN" (start again): sel := 0, then go. Hover shows `THA2.BMP` (296×77).
- **Go** (`FUN_00448bb8`):
  - If sel > bookmarkSlot: play `TERROR.WAV` and stay.
  - Otherwise: `DAT_0044e6a0 := name + "n"`. The page always starts in normal mode. Then stop sounds, `StoryPlayer.Start`, Show, and Hide.
- Hover cursor: 1 over unlocked slots and buttons (`FUN_00448f18`), 0 elsewhere. The hover images are restored from BACKGRAY on leave.
- FormClose (`0x449608`) shows Credits.

### 1.5 Story player (`TfrmStoryPlayer`)

The form is 640×480 or 800×600 and is painted from an offscreen buffer (`+0x1cc`). The rest of this document describes it.

**Field map**, used throughout:

| Offset | Field |
|---|---|
| 0x1ac | script (TBasIkScript) |
| 0x1b0 | CommandTimer |
| 0x1b4 | AniTimer |
| 0x1b8 | Reader MediaPlayer (MCI) |
| 0x1bc | MidiPlayer (MCI) |
| 0x1c0 | clTimer |
| 0x1c4 / 0x1c8 | clean background N / D |
| 0x1cc | screen buffer |
| 0x212 | current page `string[4]` (for example "01N") |
| 0x218 | PC |
| 0x21c | ready |
| 0x21d | reader-continues-script |
| 0x21e | runState (0 idle, 1 ONEXIT, 3 running) |
| 0x21f | animating |
| 0x220 | readerState (0 off, 1 reading, 2 post-read countdown) |
| 0x221 | waitState (1 delay, 2 wav, 3 midi, 4 game) |
| 0x222 | clState |
| 0x224 | clPC |
| 0x228 | history TStringList |
| 0x22c | PIJLEN.BMP |
| 0x230 | probe wave SE000000 (flags NOSTOP) |
| 0x234 | — |
| 0x235 | game id |
| 0x236 | "return to D when possible" |
| 0x238 | main image |
| 0x23c | animation list |
| 0x240 | click-area list |
| 0x244 | effect list |
| 0x248 | nextScene `string[4]` |
| 0x250 | ONEXIT label index |
| 0x254 | nextClicks counter |
| 0x258 | animation index |
| 0x259 / 0x25a | from / to |
| 0x25c | text runtime |
| 0x260 | topLine (byte) |
| 0x261 | lineCount (byte) |
| 0x264+4·k | lineStart[k] (1-based word number) |
| 0x2e8 | reader-scroll-back |
| 0x2e9 | countdown |
| 0x2ea | goForward |
| 0x2eb / 0x2ec / 0x2ed | buttons-saved / saved Prev / saved Next |
| 0x2f0 | clLabel |
| 0x2f4 | clPeriod |
| 0x2f8 | clCountdown |
| 0x2fc | clAnim |
| 0x300 / 0x301 | clFrom / clTo |
| 0x302 | clSoundPlaying |
| 0x303 | theEnd |
| 0x304 | mode before game |

**FormCreate** (`0x444a24`): sizes the form, creates the two background bitmaps and the history list, and loads the probe wave.

**Start()** (`FUN_00444380`):
1. Cursor = crHourGlass (−11).
2. Load `BACKD.BMP` and `BACKN.BMP` (800×600). In 640 mode, the crop (80,44,720,524) is copied into 640×480 instead.
3. Load `PIJLEN.BMP` and the 12 button overlays (see 4.2).
4. Page := `DAT_0044e6a0`. Mode := 1 if the last character is not 'N' (upper-cased), otherwise 0.
5. buffer := copy of BACK<mode>, clState := 0, enable clTimer, Repaint, then `LoadScene()`.

**FormClose** (`0x444b70`): unloads the scene. In direct mode it terminates the app. Otherwise it hides and shows Credits.

### 1.6 Quit / confirm dialog (`TdlgQuit`, SetType `FUN_00430eb0`, MouseDown `0x4312e4`)

- 300×200, borderless, stay-on-top, centred, shown modally.
- The image depends on type and mode. The two rect records are "SysJaRect" (Yes) and "SysNeeRect" (No):

| Type | Image (N / D mode) | Ja rect | Nee rect |
|---|---|---|---|
| 0 quit | STOPN / STOPD | (50,130,110,160) | (160,130,245,160) |
| 1 switch to 3D-plus | CTO3D | (59,135,110,165) | (160,135,236,165) |
| 2 switch to normal | CTON | (65,135,117,167) | (168,137,242,166) |
| 3 no 3D-plus page | NO3DN / NO3DD | (44,106,254,170), the OK button | disabled |

- Clicking Ja sets ModalResult = 1 (mrOK). Clicking Nee sets ModalResult = 2.
- Hover cursor is 1.

### 1.7 KlikTip, the help screen (`TfrmClickTip`, VMT `0x443670`, FormCreate `0x44378c`)

- 500×400, borderless, centred, stay-on-top, background `CLICKTIP.BMP`.
- TMemo at (20,20), 460×340, read-only with a vertical scrollbar. It loads `SCRIPTS\CLICKTIP.TXT`, which is plain cp1252 text, **not** encoded.
- Button "Klaar met lezen" at (150,370), 200×20, ModalResult 1.
- The story player creates it, shows it modally and frees it (`FormMouseDown`, Klik button).

### 1.8 Credits (`TfrmCredits`, FormActivate `0x4307e0`, CreditTimer 80 ms `0x430b44`)

**Window and layers.**
- 640×480. The base image is `CREDITS.BMP`.
- The foreground frame `CREDITSV.BMP` is drawn with the mask `CREDITSM.BMP` (1 bpp; mask SRCAND, then image SRCPAINT).
- The scrolling strip is `CREDITS1.BMP` (5943×35, colour) with the mask `CREDITS2.BMP` (1 bpp).

**Music.** `CREDITS.WAV` is played through the MCI MediaPlayer. It restarts whenever the probe shows the sound has finished and the scroll is not done yet.

**Each tick:**
1. Restore the base image in the strip band (dx, 370, 640, 370+35).
2. Blit the strip window: source (sx, 0, sx + 640 − dx, 35), mask then image.
3. Re-apply the foreground mask and image over the band.
4. Advance: first `dx` goes from 640 down to 0 in steps of −10. After that `sx` increases by +10.
5. When `stripWidth − sx < 350`, set `done`.
6. Once `done` is set and the music has ended, Close.

A click or key press stops the music and closes. FormClose calls **Application.Terminate**. For the web: return to the start screen.

---

## 2. Script files (`.BSB`)

### 2.1 Encoding and loading (`FUN_0042e590`, `FUN_0042e490`)

- Location: `SCRIPTS\<page>.BSB`, for example `01N.BSB`. File names are matched case-insensitively, as scripts write `13b`, `14a`, and so on.
- Load as a TStringList, split on CRLF.
- **First delete every empty line**, then decode every remaining byte as `c - 1`. The result is cp1252 text; `{` is stored as `|`.
- Parse with `FUN_0042ec58`:
  - The line counter is a **byte**, so a script must have ≤ 255 non-empty lines. The longest has 232.
  - The command list is `script+0x20`, a TList of 12-byte records `{type:u8, params:ptr, size:i32}`.

### 2.2 Tokenisation

**Command recognition.**
- For each line, every keyword is tested with `copy(line,1,len(kw)) == kw`. The test is case-sensitive, so only a prefix of the line must match.
- A line matching no keyword is **dropped**. This means commands are filtered at parse time.

**Arguments** (`FUN_0042e674(n)`):
- The arguments are the `~`-separated fields after `}`.
- Field 1 is the text between `}` (or the start of the line, if it does not begin with `{`) and the first `~`.
- Field n is the text between the (n−1)th and nth `~`.
- If the last requested field has no closing `~`, the following lines are appended until a line containing `~` is found. They are consumed (multi-line argument). This is not used in the shipped scripts.

**Conversions.**

| Kind | Conversion |
|---|---|
| Integers | StrToInt |
| Booleans | `UpperCase(s) == "TRUE"` (`FUN_0042e920`) |
| Colour names | clBlack…clWhite (`FUN_0042e9c0`). The values are ignored at runtime, see 5. |

**String sizes.** Strings are Pascal shortstrings and are truncated: names 32, file names 12–13, labels 64, words 20.

### 2.3 Command table

Every type id is the byte stored in the record. "Sets ready" means the handler finishes at once.

| id | Syntax (args after `}`) | Parse record | Runtime handler | Behaviour |
|---|---|---|---|---|
| 0 | `{ACTIVATE_MAINIMAGE}` | — | `FUN_004460c4` | Blit the main image (560×280) at the DispRect origin (123,85), overwriting all animation frames. Invalidate. Show the form if it is hidden (after a game). Cursor 0. Sets ready. |
| 1 | `{END}` | — | inline | Restore the buttons (`FUN_00443f50`) and set runState := 0. **ready is not set**, so the interpreter halts. |
| 2 | `{ACTIVATE_TEXTBOX}` | — | `FUN_0044615c` | Composite the text window: draw word[0] in the normal colour with autoscroll, which effectively shows the top lines. Sets ready. |
| 3 | `{TEXT_TOP}` | — | `FUN_00446188` | Identical to ACTIVATE_TEXTBOX ("scroll text to top"). |
| 4 | `{THE_END}` | — | `FUN_004461b4` | theEnd := 1. The next page turn closes the story and opens the credits. Sets ready. |
| 5 | `{AUTO_NEXT}` | — | `FUN_004461c4` | If runState ≠ 1 (not inside ONEXIT): **turn the page now** (`NextPage`, 6.1). Otherwise set ready. |
| 6 | `{NEXT_SCENE}nn~` | `string[3]` | `FUN_004461dc` | nextScene := nn + ('N' if mode = 0, 'D' if mode = 1). It may appear inside labels, which makes the story branch. Sets ready. |
| 7 | `{INIT_MAINIMAGE}file~` | `string[13]` | `FUN_00446258` | Load `IMAGES\file` as the main image (not drawn yet). Sets ready. |
| 8 | `{NEXT_CLICKS}n~` | u8 | `FUN_004462e8` | nextClicks := n. This is the number of hot-spot clicks needed before Next is enabled; the default per page is **2**. Values above 255 wrap (the scripts use up to 200). Sets ready. |
| 9 | `{ONEXIT}label~` | `string[32]` | `FUN_004462fc` | onExit := FindLabel(label), which is 0 if not found. Sets ready. |
| 10 | `{INIT_CLICKAREA}name~x1~y1~x2~y2~enabled~label~` | name@0 `s[32]`, rect@0x24, enabled@0x34, label@0x35 `s[32]` | `FUN_00446360` | Append a runtime record {name, rect (relative to the main image), labelName, enabled@0x5c, labelIdx@0x58 = FindLabel(label)}. Sets ready. |
| 11 | `{ENABLE_CLICKAREA}name~` | `s[32]` | `FUN_00446420` | Enable **every** area whose name matches (case-insensitive). Sets ready. |
| 12 | `{DISABLE_CLICKAREA}name~` | `s[32]` | `FUN_004464e8` | Disable every matching area. The name `SYSALL` disables all areas. Sets ready. |
| 13 | `{ACTIVATE_READER}a~b~` | u16 a, u16 b | `FUN_004465f8` | Read words a..b aloud (1-based, inclusive). `0~…` means all words. **Blocks** until the audio ends (see 5.4). |
| 14 | `{INIT_ANIMATION}name~file~frames~interval~x1~y1~x2~y2~wav~` | name `s[32]`@0, file `s[13]`@0x21, frames u8@0x2f, interval u16@0x30, rect@0x34..0x40, wav `s[13]`@0x44 | `FUN_00446798` | Load the strip `IMAGES\file`. If `SOUNDS\wav` exists, load it into memory (async play). Runtime record 0x54 bytes: bmp@0x24, frames@0x28, interval@0x2c, rect@0x30, wave@0x40, hasWave@0x44, playSnd@0x45, cur@0x48. Sets ready. |
| 15 | `{ACTIVATE_ANIMATION}name~from~to~sound~` | name, from i16@0x22, to i16@0x24, bool@0x26 | `FUN_00446910` | Play frames from→to, forwards or backwards, with the animation's interval. If `sound` is set and the animation has a wav, play it with the first frame. **Blocks** until the last frame. An unknown name sets ready. |
| 16 | `{INIT_TIPAREA}name~` | `s[32]` | `FUN_00446a1c` | No-op. Sets ready. |
| 17 | `{DELAY}n~` | i32 | `FUN_00446a24` | AniTimer.Interval := n·10 ms, waitState := 1. **Blocks** n×10 ms; in a continuous label it is n ms, see 3.4. |
| 18 | `{INIT_EFFECT}name~file~type~` | name, file `s[13]`@0x21, type u8@0x2f | `FUN_00446a54` | type 1: load `SOUNDS\file` into memory (sndPlaySound). Any other type: remember the file for MCI MIDI playback. All shipped scripts use type 1. Sets ready. |
| 19 | `{ACTIVATE_EFFECT}name~` | `s[32]` | `FUN_00446b30` | Find the effect (case-insensitive) and disable the buttons. WAV: play async, waitState := 2. MIDI: MidiPlayer close/open/play, waitState := 3. **Blocks** until the sound ends. An unknown name leaves ready unset, so the interpreter stalls (bug). |
| 20 | `{PLAY_GAME}n~` | u8 | `FUN_00446c84` | Start minigame n (see 7). **Blocks** until the game ends, then turns the page according to the game's result. |
| 21 | `{PLAY_MOVIE}n~` | u8 | `FUN_00446f68` | No-op. Sets ready. |
| 22 | `{LABEL}name~` | `s[64]` | inline | Sets ready, so execution **falls through** a label. Only `{END}` stops. |
| 23 | `{INIT_CONTINUOUS_LABEL}label~secs~` | label `s[64]`, secs u8@0x41 | `FUN_00446f70` | Start a background loop: every `secs` seconds run `label` on the cl-interpreter (3.4). `1000` truncates to 232. Calling it again replaces the loop. Sets ready. |
| 24 | `{INIT_TEXTBOX}fg~hl~voice.wav~` + word lines + `{END_TEXT}` | see 2.4 | `FUN_00447008` | Build the text bitmaps (5). Sets ready. |

**FindLabel** (`FUN_0042e3dc`):
- It returns the command index of the first `{LABEL}` whose name matches case-insensitively, or **0** if there is none.
- Jumping sets PC := index. The timer pre-increments PC, so execution starts at the command after the label.
- A missing label therefore runs from command 1, which re-executes the page init. Example: click area `treefall` in 25N has no label.

### 2.4 INIT_TEXTBOX and word lines

**Header** `{INIT_TEXTBOX}clRed~clAqua~V001.WAV~`:
- fg and hl are parsed into +0x34 and +0x38 **but are never used**. The runtime hard-codes normal = `0xFFFFFF` (white) and highlight = `0xFF` (red).
- voice is `string[12]` at +0x5f. This is the narration WAV, played through MCI.
- The parser also stores default rect (205,400,595,475), font "Arial", 12, bold. This is unused at runtime.

**Word lines.** Every following line up to the line starting with `{END_TEXT}` is one word or phrase record (0x3c bytes, `FUN_0042ec58`). Example `Het is~116~557~1~2~5~5~46~23~1~`:

| # | Field | Offset | Meaning |
|---|---|---|---|
| 1 | text | +0x00 `s[20]` | Text drawn with TextOut. It may contain spaces (several words per record). |
| 2 | start | +0x28 | Start time of this word in the voice WAV, in ms. |
| 3 | end | +0x2c | End time in ms. |
| 4 | phraseFirst | +0x30 | 1-based record number where the "click-to-hear" phrase starts. |
| 5 | phraseLast | +0x34 | 1-based record number where that phrase ends. |
| 6–9 | x1,y1,x2,y2 | +0x18..+0x24 | Word rect in **text-bitmap** coordinates. Lines are at y = 5 + 22·(line−1), height 18. Width 390. |
| 10 | line | +0x38 | 1-based line number. |

- Clicking a word plays `start(words[phraseFirst-1]) .. end(words[phraseLast-1])` and highlights that range.
- Example: "Het is" (1,2) replays "Het is winter".
- Phrases may begin before the clicked word. The last word "hij zich af..." has (45,46), so clicking it replays "vraagt hij zich af...".

---

## 3. Interpreter

### 3.1 Main loop: CommandTimer (10 ms, `0x445964`)

```
onCommandTimer():                      // every 10 ms (on Win9x effectively ≥55 ms)
  if ready != 1: return
  ready := 0
  PC := PC + 1
  cmd := commands[PC]                  // no bounds check in original
  dispatch(cmd.type)                   // table in 2.3; most handlers set ready:=1
```

Recommendation: keep "at most one command per tick" semantics, ticking at 10–16 ms. Script pacing (for example long ACTIVATE_ANIMATION sequences) depends on the per-command latency only marginally; animation intervals dominate. Alternatively, execute ready-immediately commands in a tight loop until a blocking command is reached. This is functionally equivalent apart from timing.

### 3.2 LoadScene (`FUN_00445068`)

1. clState := 0 (via the previous Unload). Free and recreate the lists: animations, click areas, effects, text runtime (two text bitmaps, font **Arial, Height 18 px, bold**).
2. Load and parse `SCRIPTS\<page>.BSB`. On failure: set direct-mode and close.
3. Reset the counters:

   | Field | Value |
   |---|---|
   | nextScene | "" |
   | onExit | 0 |
   | **nextClicks** | **2** |
   | PC | −1 |
   | animating, readerState, waitState, clState | 0 |
   | goForward | 1 |

4. Buttons:
   - Prev enabled = (history.Count > 0). Next, Read, Mode and Klik disabled. Stop enabled.
   - `DisableButtons()` (`FUN_00443ee0`) saves Prev/Next into +0x2ec/+0x2ed, then sets Prev=Next=Read=Mode=Klik=0 and Stop=1, and redraws.
5. runState := 3, ready := 1, enable CommandTimer.

### 3.3 Rect records

Several tables use the same layout, 0x38 bytes:
- `+0x00` shortstring name (≤ 31 characters)
- `+0x24` left, `+0x28` top, `+0x2c` right, `+0x30` bottom (i32)
- `+0x34` enabled (u8)

The story player layout tables sit at `0x44b784 + mode·0x1c0`. The click-area runtime record (0x60 bytes) has the rect at +0x24, the label name at +0x34, the label index at +0x58 and enabled at +0x5c.

### 3.4 Continuous-label interpreter: clTimer (`0x447bdc`)

It has its own PC (`clPC`) and state (`clState`). Only a subset of commands is supported.

```
onClTimer():
  switch clState:
   2 (countdown, Interval=1000):  if --clCountdown <= 0: clPC := clLabel; Interval:=10; clState:=1
   1 (step):  clPC++; clState:=0; cmd := commands[clPC]
       END(1):              clCountdown := clPeriod; Interval:=1000; clState:=2   // loop forever
       ACTIVATE_ANIMATION:  a := findAnim(name) else {clState:=1; break}
                            clFrom,clTo := from,to; Interval := a.interval; a.cur := from
                            a.playSnd := (runState==0 && a.hasWave) ? cmd.sound : 0
                            clAnim := a; clState := 4
       DELAY(17):           Interval := n            // NOTE: milliseconds, not n*10
                            clState := 3
       ACTIVATE_EFFECT(19): e := findEffect(name) else {clState:=1; break}
                            if e.type==1:
                               if probe() /*nothing playing*/: clSoundPlaying:=1; play(e, ASYNC); clState:=5
                               else clState:=1     // skip the effect if another sound is busy
                            else: MidiPlayer.open(e.file).play(); clState:=6
       LABEL(22), any other: clState := 1            // ignored / fall through
   3: clState := 1
   4 (anim frame): draw frame clAnim.cur (see 4.4)
                   if clSoundPlaying && probe(): clSoundPlaying := 0
                   if clAnim.playSnd: play(clAnim.wave); clSoundPlaying:=1; clAnim.playSnd:=0
                   step clAnim.cur toward clTo; when past clTo: Interval:=10; clState:=1
   5: if clSoundPlaying && probe(): Interval:=10; clState:=1; clSoundPlaying:=0
   6: if MidiPlayer.mode != playing: Interval:=10; clState:=1
```

- `INIT_CONTINUOUS_LABEL` sets clLabel, clPeriod = clCountdown = secs, Interval 1000, clState := 2 and clSoundPlaying := 0.
- The cl-loop runs in parallel with everything else, including reading. It stops only when the page is unloaded.
- A hot-spot or text click first calls `sndPlaySound(NULL)` if clSoundPlaying is set.

### 3.5 AniTimer (`0x447590`)

AniTimer is shared by delay, sound and game waits, the reader and main-interpreter animations. The **interval is whatever was set last**: the animation interval, n·10 for DELAY, or 10 for the reader.

```
onAniTimer():
  switch waitState:
    1: waitState:=0; ready:=1; return                       // DELAY done
    2: if probe(): waitState:=0; ready:=1; RestoreButtons(); return   // effect wav done
    3: if MidiPlayer.mode == stopped: ready:=1; waitState:=0; return
    4: gameReturn(); return                                  // see 7
  if readerState == 1: readerTick()                          // 5.4
  elif readerState == 2: if --countdown == 0: readerState:=0; drawWord(word[0], normal, scroll=true)
  if animating:
    a := anims[animIdx]; drawFrame(a, a.cur)                 // 4.4
    if a.playSnd: play(a.wave) /*async, cuts other sndPlaySound*/; a.playSnd:=0
    if to < from: a.cur--; if a.cur < to: ready:=1; animating:=0
    else:         a.cur++; if a.cur > to: ready:=1; animating:=0
```

- The first frame is drawn one interval after ACTIVATE_ANIMATION. The total duration is (|to−from|+1)·interval.
- The timer is never disabled; idle ticks do nothing.
- `probe()` = `sndPlaySound("SE000000.WAV", SND_NOSTOP|SND_SYNC)`. It returns true only when no sndPlaySound sound is playing. **Web:** check whether the single "effect channel" has ended.

---

## 4. Screen and rendering

### 4.1 Layout (800×600, mode 1; mode 0 = minus (80,44))

| Rect | Mode 1 (800×600) | Mode 0 (640×480) | Use |
|---|---|---|---|
| SysDispRect | (123,85,683,365) | (43,41,603,321) | Main image 560×280. Click areas and animation rects are relative to its top-left. |
| SysTextRect | (205,405,595,478) | (125,361,515,434) | Text window 390×73, which shows 3 lines. |
| SysPrevRect (TERUG, left book) | (90,410,200,470) | (10,366,120,426) | |
| SysNextRect (OMSLAAN, right book) | (600,405,715,470) | (520,361,635,426) | |
| SysStopRect (STOPPEN) | (145,495,260,600) | (65,451,180,480) | |
| SysReadRect (OPNIEUW) | (280,495,400,600) | (200,451,320,480) | Named "SysStopRect" in the mode-0 table. |
| SysModeRect (3-D) | (420,495,540,600) | (340,451,460,480) | |
| SysKlikRect (KLIK-TIP) | (555,495,675,600) | (475,451,595,480) | |

Background is `BACKN.BMP` in mode N and `BACKD.BMP` in mode D (800×600, 8 bpp). Each already contains the "enabled" art of all buttons.

### 4.2 Buttons (`FUN_00443d64`, `FUN_00443b78`; table `0x44bb04 + screenMode·0x90`, 6 × {xN, yN, bmpN, xD, yD, bmpD})

- Button order: 1 Prev, 2 Next, 3 Stop, 4 Read, 5 Mode, 6 Klik.
- Each button has an enabled byte in its rect record.
- **Disabled:** draw the greyed overlay bitmap (SRCCOPY) at (x,y) for the current mode.
- **Enabled:** copy the same rectangle from the clean background, which restores the coloured art.

Overlay positions and bitmaps:

| Button | N-mode position (bitmap) | D-mode position (bitmap) | Mode-0 position (N / D) |
|---|---|---|---|
| Prev | (120,426) nPrev 51×31 | (119,425) dPrev 51×32 | (40,382) / (39,381) |
| Next | (627,420) nNext 55×33 | (630,422) dNext 52×31 | (547,376) / (550,378) |
| Stop | (153,497) nStop 98×19 | (152,494) dStop 99×24 | (63,453) / (72,450) |
| Read | (291,497) nRead 99×19 | (292,496) dRead 99×22 | (211,453) / (212,452) |
| Mode | (465,498) nMode 34×20 | (463,497) dMode 35×22 | (385,454) / (383,453) |
| Klik | (568,497) nKlik 94×22 | (569,498) dKlik 94×23 | (488,453) / (489,454) |

**DisableButtons** (`FUN_00443ee0`, only if not already disabled, +0x2eb):
- Save Prev and Next, then set Prev=Next=0, Stop=1, Read=Mode=Klik=0.
- It is called on scene load, on a hot-spot click, on a word click, in ACTIVATE_READER and in ACTIVATE_EFFECT.

**RestoreButtons** (`FUN_00443f50`):
- Prev := saved Prev, Next := saved Next, and Stop, Read, Mode, Klik := 1.
- It is called by `{END}`, at the end of an effect WAV, and when a button-triggered reading finishes.

### 4.3 Draw order and buffer

**Order:** buffer = background, then button overlays, then the main image (ACTIVATE_MAINIMAGE), then animation frames, then the text window.

**Updates:** everything is drawn into the 800×600 buffer and the changed rect is invalidated. FormPaint blits the buffer. There is no per-frame full redraw.

**Palette:** 8-bit BMPs are realised with their own palette. For the web, just decode them to RGBA.

### 4.4 Animation frames

- The strip is horizontal. **Frame width w = rect.x2 − rect.x1**, taken from the INIT_ANIMATION rect, not from bitmap width divided by frames.
- Frame k (1-based) has source (( k−1)·w, 0, k·w, bmp.height).
- Destination = rect offset by the DispRect origin. It is drawn with CopyRect (SRCCOPY, stretched if the sizes differ). **There is no transparency**: frames include their background pixels.
- Example: `pigs~A01D000.BMP~6~200~148~114~183~150` gives a 210×36 strip, w = 35, drawn at (271,199).
- A frame stays in the buffer until the next ACTIVATE_MAINIMAGE.

---

## 5. Text, reader highlight and word clicks

### 5.1 Build (INIT_TEXTBOX runtime, `FUN_00447008`)

**Two bitmaps**, 390 px wide. Height = max(lastWord.y2 + 5, TextRect.bottom). The second term looks like a bug but is harmless.

| Bitmap | Background | Use |
|---|---|---|
| A (+0x28, text) | Brush black, filled black | Text in the word colour |
| B (+0x2c, mask) | Brush white, filled white | Font colour black |

**Font:** Arial, cell height 18 px (`TFont.Height = 18`, about CSS `bold 16px Arial`), bold. TextOut uses an opaque brush.

**Per word:** draw the text at (x1,y1) on A (white) and on B (black).

**Line table:** lineStart[k] = 1-based number of the first word on line k. lineCount = the last line number. topLine := 1.

### 5.2 Compositing (`FUN_00447244(word, highlight, compose, alsoMask)`)

1. Redraw the word on A in white, or in red if highlighted, with TextOut at (x1,y1). If alsoMask, also redraw it on B.
2. If compose is set:
   - **Autoscroll topLine:** while `(topLine−1)·22 + 65 < word.y1`, topLine++. While `word.y1 < (topLine−1)·22`, topLine−−.
   - Restore TextRect from the clean background.
   - src = (0, (topLine−1)·22, 390, (topLine−1)·22 + 73).
   - Blit B with SRCAND, then A with SRCPAINT, into TextRect. The effect is transparent text on the board.
3. **Scroll arrows**, shown if the text has ≥ 3 lines (lineStart[3] ≠ 0). They come from `PIJLEN.BMP` (40×50; top row images, bottom row masks; each cell 20×25):
   - Up arrow at (TR.right−20, TR.top+5)-(TR.right, TR.top+30). Mask src (0,25,20,50), image src (0,0,20,25).
   - Down arrow at (TR.right−20, TR.top+38)-(TR.right, TR.top+63). Mask src (20,25,40,50), image src (20,0,40,25).

### 5.3 Clicks on the text (`FUN_00445c0c`)

Clicks are accepted only when runState = 0 and readerState = 0. If clSoundPlaying is set, the cl sound is stopped first. Coordinates are relative to TextRect; w = 390.

**Arrow column** (x > w − 20):
- Up rect (370,5,390,35), when topLine > 1: topLine−−, then recomposite starting from word lineStart[topLine].
- Down rect (370,38,390,63), when lineCount − topLine > 2: topLine++, then recomposite.

**Otherwise:**
1. Visual row r = 1 by default. Rows are (0,0,w,20) → 1, (0,22,w,42) → 2 and (0,44,w,63) → 3. A click in a gap counts as row 1.
2. Scan the words of line L = topLine + r − 1, from lineStart[L] while word.line = L.
3. A word is hit when (x1, y1 − (topLine−1)·22, x2, y2 − (topLine−1)·22) contains the click.
4. On a hit:
   - first := word.phraseFirst − 1 and last := word.phraseLast − 1. Current := first.
   - Reader MCI: Close, FileName = `SOUNDS\<voice>`, Open, StartPos = words[first].start, EndPos = words[last].end, Play.
   - Highlight word[current] (compose).
   - AniTimer: Interval 10, Enabled.
   - reader-continues-script := 0, DisableButtons, scroll-back := 0, readerState := 1.

### 5.4 Reading (`FUN_004465f8(arg)`, readerTick in AniTimer)

**Start.**
- Script `ACTIVATE_READER a~b`: if a = 0, the range is all words; otherwise it is words a−1..b−1.
- Read button (arg = nil): all words.
- Then:
  1. Stop sndPlaySound and close and reopen the reader MCI.
  2. StartPos = words[first].start, EndPos = words[last].end. Play.
  3. Highlight words[first] and run AniTimer at 10 ms.
  4. reader-continues-script := (called from the script ? 1 : 0).
  5. DisableButtons, scroll-back := 1, readerState := 1.

**readerTick** (every 10 ms):

```
if Reader.mode == stopped:
    drawWord(words[last], normal, compose)
    countdown := 30
    readerState := scrollBack ? 2 : 0       // 2 = after 300 ms redraw word[0] (scroll to top)
    ready := readerContinuesScript          // script continues only for ACTIVATE_READER
    if !readerContinuesScript: RestoreButtons()
elif current < words.count-1 and words[current+1].start < Reader.position(ms):
    drawWord(words[current], normal, compose)
    if current < last: current++; drawWord(words[current], highlight=red, compose)
```

The highlight follows the MCI playback position in ms. The next word lights up as soon as the position passes its start time.

**Web:** use an `<audio>`/WebAudio slice of `Vxxx.WAV` from `start/1000` to `end/1000` and poll `currentTime` with requestAnimationFrame.

---

## 6. Input, navigation, persistence

### 6.1 Story player mouse handling

Mouse input is ignored entirely while runState = 1 (ONEXIT running). The order of tests is:

1. **DispRect:** hot-spot click (`FUN_00445b44`). Accepted only when runState = 0 and readerState ≠ 1.
   1. Take the first enabled click area in list order whose rect contains the point (relative to DispRect).
   2. Stop the cl sound if it is playing.
   3. PC := area.labelIdx. DisableButtons, runState := 3, ready := 1.
   4. If nextClicks > 0, decrement it. When it reaches 0, set **saved Next := 1**. Next then becomes enabled at that label's `{END}`.
2. **TextRect:** word or arrow click (5.3).
3. **Next** (when enabled): `NextPage()`.
4. **Prev** (when enabled): goForward := 0, then `NextPage()`.
5. **Stop:** dlgQuit type 0. On Ja: unload the scene and close the story player, which opens Credits.
6. **Read:** `FUN_004465f8(nil)`.
7. **Mode:** toggle 3D (6.3).
8. **Klik:** modal KlikTip.

**NextPage** (`FUN_00445534`):

```
if goForward and onExit > 0:                 // run ONEXIT label synchronously
    PC := onExit; runState := 1; ready := 1
    while runState != 0: pumpMessages()      // ends at that label's {END}
if not goForward:
    page := history.pop()                    // TStringList, last item
else:
    history.push(page)
    if returnTo3D and exists(SCRIPTS\ nextScene[0..-1] + "D.BSB"):
        nextScene := base + "D"; mode := 1; buffer := BACKD; repaint; returnTo3D := 0
    page := nextScene
Unload()                                     // FUN_00445358 (closes form if theEnd)
if theEnd: return                            // -> Credits
if mode == 1 and not exists(D version of page):
    dlgQuit(type 3 "NO3D").ShowModal; returnTo3D := 1; mode := 0
    buffer := BACKN; repaint; page := base + "N"
if not exists(SCRIPTS\page.BSB):
    ShowMessage("Applicatie wordt gestopt. Het volgende script bestaat nog niet : " + page); Close
else:
    WriteBookmark(page)                      // FUN_0042aea4
    LoadScene()
```

- **Unload** (`FUN_00445358`): cursor hourglass, all states 0, close the reader MCI, free the text runtime, animations (and their waves), click areas and effects. If theEnd is set, Close.
- Quirks:
  - A popped history entry keeps the D/N suffix it had when pushed, even if the mode changed since.
  - Prev does not run ONEXIT.

### 6.2 Hover and cursors (`FormMouseMove 0x444f6c`)

- **Over DispRect:** when idle and not reading, cursor 1 (hand) over any enabled click area (`FUN_00445fc0`), otherwise 0.
- **Over enabled buttons:** cursor 1.
- **During load and unload:** crHourGlass (−11).
- **After ACTIVATE_MAINIMAGE:** default (0).
- The cursor is never hidden. The help file's "your mouse disappears" is not in the code.

### 6.3 3D-plus toggle (`FUN_004440a8`)

- **Mode N:**
  - If `<page minus last char>D.BSB` does not exist: dlgQuit type 3 (NO3D, info only).
  - Otherwise dlgQuit type 1 (CTO3D). On Ja: Unload, replace the last character of page with 'D', set mode 1, buffer := BACKD, repaint, LoadScene.
- **Mode D:** dlgQuit type 2 (CTON). On Ja: Unload, page := …N, mode 0, buffer := BACKN, LoadScene.
- History is unchanged by a toggle.

### 6.4 Bookmark / progress

- **Write** (`FUN_0042aea4`, on every page load):
  1. n := int(copy(page,1,2)).
  2. If n < 51, read the stored value s.
  3. If int(copy(s,1,2)) < n, write the **full page name** (for example "05BN") to `HKCU\Software\Mindwarp\Bas de beer\Naar het noorderlicht\Boekenlegger`.
  - Only forward progress is stored, and the tutorial pages 51–54 never are.
- **Read at boot:** only the first 2 characters are kept. ThumbJump uses this value (1.4).
- History (Prev) is in memory only and lasts one session.
- **Web:** localStorage key `noorderlicht.bookmark`. Recommendation: match slots by number prefix to avoid the "14"/"47" mismatch quirk, or keep the quirk deliberately.

---

## 7. Minigames (`{PLAY_GAME}n`)

### 7.1 Launch and return

**Launch** (`FUN_00446c84`, jump table `0x446cfc`):
1. Prev enabled = history non-empty; Next enabled = 1. These are shared globals, which some games use.
2. Hide the story player and save the mode into +0x304.
3. Create the form and call `.Show`. It is **non-modal** and is drawn at the same screen position and size (640/800).
4. waitState := 4 and enable AniTimer.

**Return.** AniTimer (`0x447624`) polls the form's *running* byte.
- When it becomes 0, read the *result* byte and free the form.
- If the mode changed during the game (GMG has its own 3-D button), fix the nextScene suffix and the buffer background.
- Then act on the result:

| Result | Action |
|---|---|
| 0 | Unload and close the story, which opens Credits |
| 1 | `NextPage()` to nextScene |
| 2 | goForward := 0, then `NextPage()` (back) |

The story player re-shows itself at the next ACTIVATE_MAINIMAGE.

| n | Page | Form (VMT / global) | Game | running / result |
|---|---|---|---|---|
| 1 | 04N | TGSBfrmMain `0x431498` / `0x44e6bc` | Sneeuwballengevecht (snowball run) | +0x26b / +0x26c |
| 2 | 13BN | TGTQfrmMain `0x4342ac` / `0x44e6dc` | Trollenquiz | +0x234 / +0x235 |
| 3 | 15N/15D | TGMGfrmMain `0x437d04` / `0x44e6e4`, init(2 N / 3 D) | Mijnwagenrace (GMS) | +0x26e32 / +0x26e33 |
| 4 | 18N | TGSOfrmMain `0x439834` / `0x44e6e8` | Proeverij "Sjaak-o-maat" | +0x8b8 / +0x8b9 |
| 5 | 24N | TGSDfrmMain `0x43af04` / `0x44e6ec` | Stoelendans | +0x3d6 / +0x3d5 |
| 6 | 30N/30D | TGMGfrmMain, init(0 N / 1 D) | Skispel (GSK) | as 3 |
| 7 | 35N | TGISfrmMain `0x43cac0` / `0x44e6f0`, variant 0 | IJsschotsspringen (ice floes) | +0x1c9 / +0x1c8 |
| 8 | 38N | TGBDfrmMain `0x43f558` / `0x44e700` (+ Startup, SpelRegel) | Berendobbel | +0x470 / +0x46f |
| 9 | 41N | TGISfrmMain, variant 1 | Bergklimmen (mountain) | as 7 |

The help lists 12 "Berenspellen". The "Chocolademelk" and "Bakkerij" recipes are ordinary story pages with effects (05BN and similar), not forms.

**Common conventions:**
- Sprites are `…N.BMP` colour on black plus `…M.BMP` mask (black = opaque), drawn mask SRCAND then image SRCPAINT.
- The Stop rect opens dlgQuit type 0. Ja gives result 0.
- The Prev rect (when enabled) gives result 2.
- Background frames reuse the story layout rects.

### 7.2 Per game

**GSB: snowball run** (`0x43162c…`, GameTimer 75 ms)
- A side-scroller across 4 parallax layers on a 3500-unit track.
- Bas runs automatically. Up = jump (variable height), Down = duck; snowballs come from Tim at the end.
- Being hit means a pixel-exact mask collision. Bas goes back to a checkpoint (0/800/2000). Reaching Tim (3500 − pos < 235) wins: GSB007, result 1.
- Assets: GSBBACK, GSB009 (sky 1680×280), GSB010 (ground 6720×30), trees GSB001/002 N/M (150×280), Bas GSB003–005 N/M (60×110), Tim GSB006–008 N/M (50×113), ball GSB011N/M (20×20), CHECKN/M.
- Sounds: GSB001.MID loop; WAVs GSB001–009, mostly synchronous.
- Tables: trees at `0x44bc94` / `0x44bcd4`.

**GTQ: Trollenquiz** (`0x434460…`)
- Multiple choice. Play ends after **5 correct answers**; there is no lose condition. The display shows "Goed: N" and " Fout: N", plus a keeper troll GTQKEEPN/H/G (neutral / happy / grumpy).
- **`GTQQUEST.TXT`** (plain text, ≤ 70 lines): `nr~question~correctLetter(A-D)~media~ans1~ans2~ans3~ans4~`
  - media is empty, or `*.WAV` (a sound question; Read replays it), or a BMP (`GTQSE0xx.BMP`, drawn at (336,88)).
  - Questions are drawn at random from those not yet answered correctly.
- Sounds GTQ001–009 go through MCI. Text is Arial 18 bold: white normally, yellow on hover, lime for correct, red for wrong.

**GMG: Mijnwagenrace / Skispel** (`0x4382b0…`, GameTimer 70 ms)
- An interlaced "video" (560×280 at (40,60)) plays, with four lights (up/left/down/right at (295,20), (1,185), (295,340), (600,185), 40×40).
- Press the lit arrow, or Space when all four are lit, within the time window. Missing it is a crash (BOTS), followed by a retry.
- The end of the video is a win (END), result 1. Score: 5 digits from SCOR.BMP (600×55, 60×55 per digit).
- The variant v (0 GSKN, 1 GSKD, 2 GMSN, 3 GMSD) picks `SCRIPTS\G??xRUN.DAT`. Its 19 plain-text lines name the files in this order:

  `MAIN.BMP, INTR.MID (unused), BOTS.BMP, BOTS.MID, BACK.BMP, MAIN.MID, .SCR, LGH1.BMP (light off), LGH2.BMP (light on), LGH2.BMP (palette source), POP.WAV, SCOR.BMP, KEYS.DAT, END.BMP, END.MID, 001–004.WAV`

- **`*KEYS.DAT`**: plain integers, one per line, in triples `time(field#)`, `light(1 Up, 2 Left, 3 Down, 4 Right, 5 all/Space)`, `window(ticks)`.
- **`*.SCR`**: raw 8-bit fields of 560×140 (78 400 bytes). They are written into alternating rows of a 560×280 DIB (weave), one field per tick, using LGH2's palette. GMS has 701 fields, GSKD 792, GSKN 801.
- The in-game Mode button switches between N and D and writes `DAT_0044e6af`.

**GSO: Proeverij / Sjaak-o-maat** (`0x4399a0…`)
- Choose at most one of 6 ingredients in each of 4 rows (24 buttons GSONK01–24, 6-frame strips at 70 ms), then click the troll to taste.
- The code s1·1000 + s2·100 + s3·10 + s4 is looked up in a 134-entry "good recipe" table at `0x44cac8`. A good recipe plays GSOS01; a bad one plays GSOS02 plus troll animations.
- The recipe is then read aloud: GSOI01–24 (ingredient names), GSOK01–04 (connectors), GSOT01–04 (troll sounds).
- There is no win state. Next, Prev and Stop leave the game (result 1/2/0). Assets: GSONBACK, GSON001–004 (troll anims).

**GSD: Stoelendans** (`0x43b088…`, GameTimer 150 ms)
- 7 walkers (Bas and 6 trolls; sheets GSD006–012 N/M, 456×114 = 8 headings × 2 phases of 57×57) circle 6..1 chairs. The scenes are GSD000–006.BMP (560×280).
- When the music (GSD001–006) stops, click a chair; the AIs run to the nearest free chair.
- If Bas has no chair, the game restarts at round 0 (GSD008). After 6 rounds it is won: GSD010, result 1.
- Waypoint and chair tables: `0x44cce0`, `0x44ce60`.

**GIS: IJsschots / Bergklimmen** (`0x43cd44…`, variant byte `FUN_0043cbfc`)
- Bas (GISB001 image / GISB002 mask, 20×28) hops along a node graph on GISMAIN.BMP (variant 0, intro GIS001) or GBKMAIN.BMP (variant 1, intro GKS001).
- Clicking a neighbour node's ±10 px box moves him. An unsafe node sends him back to node 1 (GIS002), a safe one plays GIS003. Reaching the goal (node 43 / 41) plays GIS004, result 1.
- Graph records at `0x44cf74 + v·0x2b0 + node·16`: {x:i32, y:i32, safe:u8, nbr[6]:u8}.

**GBD: Berendobbel** (Startup `0x43e9b4`, Main `0x43f6d4`, rules form)
- A goose-style board race for 2–4 players (optionally vs. the computer "de Witte Beer") over 64 squares. The board is split across GBDBRD01 (0–31) and GBDBRD02 (32–63).
- Rolling `Random(6)+1`: rattle GBD001 with dice frames GBDRD000–010, then face GBDFD00n.
- **Special squares:**
  - Bear squares {1,5,10,23,26,32,41,45,54,59} advance again by the roll.
  - 3: jump ahead of the leader. 6→12, 15→10, 39→33, 42→30, 58→0.
  - 19: skip 1 turn. 52: skip 2 turns. 31: cave, needs a 6 to leave.
- Reaching ≥ 63 wins, but the form does not close. It always returns result 1 (via Stop or Cancel).
- Pawns are in GBDAPWNS (60×120). Rules are in `GBDRULES.TXT` (plain text). Sounds GBD001–033 go through an MCI queue.

---

## 8. Audio model summary

| Channel | API | Used for | Web equivalent |
|---|---|---|---|
| "effect" | sndPlaySound (TWave, memory if ≤ 0x32000 bytes, else filename) | Animation WAVs, INIT_EFFECT type 1, splash, welcome, thumb sounds | One shared `HTMLAudio`/WebAudio voice. **A new sound stops the previous one.** `probe()` = "voice idle". |
| reader | TMediaPlayer (MCI waveaudio), StartPos/EndPos in ms | `Vxxx.WAV` narration and word clicks | A separate voice with range playback and position polling |
| midi | TMediaPlayer | MIDI effects (unused in scripts), minigame music | Separate (soundfont or pre-rendered) |

TWave option bits (`FUN_0042dfe0`): 1 → ASYNC, 2 → ASYNC\|LOOP, 4 → NODEFAULT, 8 → NOSTOP, 0x10 → synchronous. Defaults:

| Sound | Option |
|---|---|
| Animation / effect | 1 |
| Probe | 8 |
| Thumb / welcome / splash | 1 |

---

## 9. Quirks to reproduce (or knowingly fix)

1. INIT_TEXTBOX colours are ignored: the text is always white with a red highlight.
2. A missing label in INIT_CLICKAREA or ONEXIT gives FindLabel = 0. Clicking such an area re-runs the page from command 1 (25N `treefall`). ONEXIT with 0 is skipped.
3. `{LABEL}` falls through when executed sequentially.
4. DELAY is ×10 ms in the main interpreter but ×1 ms inside a continuous label.
5. The NEXT_CLICKS and INIT_CONTINUOUS_LABEL arguments are bytes, so they wrap (1000 → 232).
6. ACTIVATE_EFFECT with an unknown name stalls the page (ready is never set).
7. Scroll arrows are shown when there are ≥ 3 lines, but scrolling only does something with > 3 lines.
8. The bookmark is truncated to 2 characters on read, so ThumbJump cannot match "14A"/"47A"-style pages.
9. A continuous-label effect is skipped while any other effect sound is playing. A main-interpreter sound cuts a cl sound.
10. The effect wait (state 2) restores the buttons mid-label. A MIDI effect wait does not.

## 10. Open questions / uncertainties

- `WelcomeTimer` (1000 ms) hides the welcome form when byte +0x38 is 0. The meaning of that field is unclear (?); it is probably housekeeping only.
- The exact Win9x pacing of CommandTimer (10 ms requested, ~55 ms real) has not been measured. Animation timing may have felt slower in the original.
- ThumbJump slot widths: the code makes columns 0–8 57 px wide (copying the first 57 px of each 72 px thumbnail) and column 9 72 px wide. Check this against THUMBS.BMP visually.
- Whether a mode change inside GMG is meant to alter the history suffixes. It is not handled.
- The MIDI path of INIT_EFFECT (type ≠ 1) is untested, as no script uses it.
- Minigame details in section 7.2 come from separate passes. Re-verify the tables at the cited addresses when implementing each game.
