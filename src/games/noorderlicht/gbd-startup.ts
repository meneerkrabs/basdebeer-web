// GBDfrmStartup of BASNOORD.EXE (FormCreate @0x43e9b4, PlayersGroupClick @0x43ebb0, ANameChange @0x43f0d4,
// ColorGroupClick @0x43f254, FormShow @0x43f338, Timer1 @0x43f3a8, OK @0x43f41c, Cancel @0x43f4f8):
// the modal player setup of Berendobbel. A 620x460 form with GBDSFTBC.BMP as picture and native controls
// (positions from the DFM): who plays (against the Witte Beer / 1, 2 or 3 friends), the names and a pawn
// colour per player (the colours are a permutation: picking one that another player has swaps them).
// Voice: GBD003 on show, GBD005 once the intro is over (and when "tegen de Witte Beer" is chosen),
// GBD004 once for the friend options.
import { MediaPlayer } from '../../engine/audio.ts';
import type { Assets } from '../../engine/assets.ts';
import { SRCCOPY } from '../../engine/surface.ts';
import { Form } from '../../engine/vcl.ts';
import type { Display } from '../../engine/vcl.ts';
import type { GbdSettings } from './gbd-logic.ts';

const FONT = '"MS Sans Serif", Tahoma, Arial, sans-serif';
const INFO = '#ffffe1'; // clInfoBk
const WITTE_BEER = 'de Witte Beer';
/** colour code (0 blue, 1 green, 2 white, 3 yellow) <-> radio index (Blauw, Groen, Geel, Wit) */
const RADIO_OF = [0, 1, 3, 2];
const COLOR_OF = [0, 1, 3, 2];
const COLOR_LABELS = ['Blauw', 'Groen', 'Geel', 'Wit'];

const css = (el: HTMLElement, style: Partial<CSSStyleDeclaration>) => Object.assign(el.style, style);

function radioGroup(caption: string, items: string[], name: string, onPick: (i: number) => void) {
  const fs = document.createElement('fieldset');
  css(fs, { background: INFO, border: '1px solid #808080', margin: '0', padding: '0 0.5em', fontFamily: FONT, color: '#000', overflow: 'hidden' });
  const lg = document.createElement('legend');
  lg.textContent = caption;
  css(lg, { padding: '0 2px', whiteSpace: 'nowrap' });
  fs.appendChild(lg);
  const radios: HTMLInputElement[] = [];
  items.forEach((t, i) => {
    const lab = document.createElement('label');
    css(lab, { display: 'block', whiteSpace: 'nowrap', lineHeight: '1.45' });
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = name;
    css(r, { margin: '0 0.4em 0 0', verticalAlign: 'middle' });
    r.onclick = () => onPick(i);
    lab.append(r, t);
    fs.appendChild(lab);
    radios.push(r);
  });
  const setEnabled = (on: boolean) => radios.forEach((r) => { r.disabled = !on; });
  return { fs, radios, setEnabled };
}

const labels: HTMLElement[] = [];
function label(text: string) {
  const l = document.createElement('div');
  labels.push(l);
  l.textContent = text;
  css(l, { background: INFO, fontFamily: FONT, color: '#000', whiteSpace: 'nowrap' });
  return l;
}

/** The original keeps one startup form alive: a second game (after a win) opens with the previous choices. */
export interface StartupMemory { mode: number; names: string[]; colors: number[] }
export const newStartupMemory = (): StartupMemory => ({ mode: 0, names: ['', '', WITTE_BEER, '', ''], colors: [0, 0, 2, 1, 3] });

/** Shows the setup form modally. Resolves with the settings (OK) or null ("Geen Berendobbel spelen"). */
export async function showStartup(display: Display, assets: Assets, memory: StartupMemory): Promise<GbdSettings | null> {
  const bg = await assets.image('GBDSFTBC.BMP');
  await assets.preload(['GBD003.WAV', 'GBD004.WAV', 'GBD005.WAV']);
  const f = new Form(display, 620, 460, 'GBDfrmStartup');
  f.center();
  f.onPaint = () => f.surface.bitBlt(0, 0, 620, 460, bg, 0, 0, SRCCOPY);

  // state (+0x1f4 count, +0x1f8.. names, +0x208.. colours, +0x231 computer opponent)
  let count = 2, computer = true, mode = memory.mode;
  const names = memory.names.slice();
  const colors = memory.colors.slice();

  // voice (TMediaPlayer "Sounds")
  const mp = new MediaPlayer();
  let heardBeer = false, heardFriends = false, closed = false;
  let chain: Promise<void> = Promise.resolve();
  let closeVoice: () => void = () => {};
  const speak = (n: string) => {
    chain = chain.then(async () => {
      if (closed) return;
      let buf: AudioBuffer;
      try { buf = await assets.sound(n); } catch (e) { console.warn(e); return; }
      if (closed) return;
      await new Promise<void>((res) => {
        mp.onNotify = () => res();
        mp.open(buf);
        mp.play();
        closeVoice = res;
      });
    });
  };

  // controls
  const players = radioGroup('Wie gaan het Berendobbel-spel spelen?', [
    'Jij speelt tegen de Witte Beer (twee spelers, waarvan een de computer is)',
    'Jij speelt met een vriendje (twee spelers)',
    'Jij speelt met twee vriendjes (drie spelers)',
    'Jij speelt met drie vriendjes (vier spelers)',
  ], 'gbd-players', (i) => playersClick(i, true));
  players.radios[mode].checked = true;

  const edits: HTMLInputElement[] = [];
  for (let i = 1; i <= 4; i++) {
    const e = document.createElement('input');
    e.type = 'text';
    e.maxLength = 15;
    css(e, { font: 'inherit', boxSizing: 'border-box', width: '100%', height: '100%', margin: '0' });
    e.oninput = () => { names[i] = e.value; checkOk(); };
    edits[i] = e;
  }
  for (let i = 1; i <= 4; i++) edits[i].value = names[i];

  const colorTitles = ['Kleur van jouw pion', 'Kleur van de pion van het eerste vriendje', 'Kleur van de pion van het tweede vriendje', 'Kleur van de pion van het derde vriendje'];
  const colorGroups = [1, 2, 3, 4].map((p) => radioGroup(colorTitles[p - 1], COLOR_LABELS, `gbd-color${p}`, (i) => colorClick(p, i)));
  const syncRadios = () => colorGroups.forEach((g, k) => { g.radios[RADIO_OF[colors[k + 1]]].checked = true; });

  const ok = document.createElement('button');
  ok.textContent = 'Ik ben klaar met invullen. Begin!';
  ok.disabled = true;
  const cancel = document.createElement('button');
  cancel.textContent = 'Geen Berendobbel spelen';
  for (const b of [ok, cancel]) css(b, { font: 'inherit', fontFamily: FONT, background: '#c0c0c0', border: '2px outset #eee', color: '#000', padding: '0', cursor: 'pointer' });

  /** ColorGroupClick: player p picks radio i; whoever holds that colour gets p's old one. */
  function setColor(p: number, code: number) {
    const old = colors[p];
    if (old === code) return;
    for (let j = 1; j <= 4; j++) {
      if (j !== p && colors[j] === code) { colors[j] = old; break; }
    }
    colors[p] = code;
    syncRadios();
  }
  function colorClick(p: number, radio: number) { setColor(p, COLOR_OF[radio]); }

  /** ANameChange: OK is enabled when every active player has a name. */
  function checkOk() {
    let good = true;
    for (let i = 1; i <= count; i++) if (names[i] === '') good = false;
    ok.disabled = !good;
  }

  /** PlayersGroupClick */
  function playersClick(idx: number, voice: boolean) {
    mode = idx;
    computer = false;
    edits[1].disabled = false;
    colorGroups[0].setEnabled(true);
    colorGroups[1].setEnabled(false); colorGroups[2].setEnabled(false); colorGroups[3].setEnabled(false);
    edits[2].disabled = true; edits[3].disabled = true; edits[4].disabled = true;
    if (edits[2].value === WITTE_BEER) { edits[2].value = ''; names[2] = ''; }
    if (idx === 0) {
      count = 2;
      names[2] = WITTE_BEER;
      computer = true;
      edits[2].value = WITTE_BEER;
      colorGroups[0].radios[3].disabled = true; // the Witte Beer is white
      setColor(2, 2);
      if (voice && !heardBeer) { heardBeer = true; speak('GBD005.WAV'); }
    } else {
      count = idx + 1;
      colorGroups[1].setEnabled(true);
      edits[2].disabled = false;
      if (idx >= 2) { colorGroups[2].setEnabled(true); edits[3].disabled = false; }
      if (idx >= 3) { colorGroups[3].setEnabled(true); edits[4].disabled = false; }
      if (voice && !heardFriends) { heardFriends = true; speak('GBD004.WAV'); }
    }
    checkOk();
  }

  // initial state: FormCreate for the first game, the previous choices afterwards
  syncRadios();
  playersClick(mode, false);

  const done = f.showModal();
  // DFM positions (client coordinates)
  display.attachControl(players.fs, f.left + 123, f.top + 8, 385, 129);
  display.attachControl(label('Jouw naam: '), f.left + 8, f.top + 148, 85, 13);
  display.attachControl(edits[1], f.left + 96, f.top + 144, 121, 21);
  display.attachControl(label('Eerste vriendje: '), f.left + 320, f.top + 148, 85, 13);
  display.attachControl(edits[2], f.left + 408, f.top + 144, 121, 21);
  display.attachControl(label('Tweede vriendje: '), f.left + 8, f.top + 284, 85, 13);
  display.attachControl(edits[3], f.left + 96, f.top + 280, 121, 21);
  display.attachControl(label('Derde vriendje: '), f.left + 320, f.top + 284, 85, 13);
  display.attachControl(edits[4], f.left + 408, f.top + 280, 121, 21);
  display.attachControl(colorGroups[0].fs, f.left + 8, f.top + 176, 217, 89);
  display.attachControl(colorGroups[1].fs, f.left + 320, f.top + 176, 217, 89);
  display.attachControl(colorGroups[2].fs, f.left + 8, f.top + 304, 217, 89);
  display.attachControl(colorGroups[3].fs, f.left + 320, f.top + 304, 217, 89);
  display.attachControl(ok, f.left + 240, f.top + 416, 179, 25);
  display.attachControl(cancel, f.left + 432, f.top + 416, 177, 25);

  const cleanup = () => {
    closed = true;
    mp.close();
    closeVoice();
    for (const el of [players.fs, ...colorGroups.map((g) => g.fs), ...edits.slice(1), ok, cancel, ...labels]) el.remove();
    labels.length = 0;
  };

  ok.onclick = () => {
    // OKButtonClick: strip a leading space and double spaces from the names
    for (let i = 1; i <= count; i++) {
      let s = names[i];
      while (s.startsWith(' ')) s = s.slice(1);
      while (s.includes('  ')) s = s.replace('  ', ' ');
      names[i] = s;
    }
    f.close(1);
  };
  cancel.onclick = () => f.close(2);
  f.onKeyDown = (key) => {
    if (key === 'Enter' && !ok.disabled) ok.click();
    else if (key === 'Escape') cancel.click();
  };

  // FormShow: introduction, then (Timer1, 1 s) the second voice once it is over
  speak('GBD003.WAV');
  const t = f.timer(1000, () => {
    if (!mp.playing) {
      speak('GBD005.WAV');
      t.enabled = false;
    }
  });
  edits[1].focus();

  const result = await done;
  cleanup();
  if (result !== 1) return null;
  memory.mode = mode;
  memory.names = names.slice();
  memory.colors = colors.slice();
  return { count, names: names.slice(), colors: colors.slice(), computer };
}
