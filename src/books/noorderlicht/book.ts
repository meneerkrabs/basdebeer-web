// "Bas de Beer naar het Noorderlicht" (BASNOORD.EXE): splash, welcome screen, page overview, story player and credits.
// Spec: docs/re/noorderlicht-engine.md. The program flow of the original (1.1-1.5):
//   splash -> welcome -> [ThumbJump] -> story player -> credits -> (the original terminates; here: back to the menu)

import type { Assets } from '../../engine/assets.ts';
import type { Display } from '../../engine/vcl.ts';
import { skipMedia } from '../../engine/skip.ts';
import { readBookmark, type Session } from './common.ts';
import { runCredits } from './credits.ts';
import { runSplash } from './splash.ts';
import { StoryPlayer } from './story.ts';
import { runThumbJump } from './thumbjump.ts';
import { Welcome } from './welcome.ts';

export async function runNoorderlicht(display: Display, assets: Assets): Promise<void> {
  const book = new NoorderlichtBook(display, assets);
  if (import.meta.env.DEV) (globalThis as { __book?: unknown }).__book = book;
  await book.run();
}

class NoorderlichtBook {
  readonly session: Session = { mode: 0 };
  story: StoryPlayer | null = null;
  /** 'splash' | 'welcome' | 'thumbjump' | 'story' | 'credits' (for tests and debugging) */
  phase = 'splash';

  private display: Display;
  private assets: Assets;

  constructor(display: Display, assets: Assets) {
    this.display = display;
    this.assets = assets;
  }

  async run() {
    // "Sla over" (not in the original): the splash and the story pages; the other screens only wait for a choice
    this.display.skipProvider = () => {
      if (this.phase === 'splash') return { label: 'Sla over ⏭', action: () => skipMedia() };
      if (this.phase === 'story') return this.story?.skipInfo() ?? null;
      return null;
    };
    try {
      await this.runFlow();
    } finally {
      this.display.skipProvider = null;
    }
  }

  private async runFlow() {
    // ?page=05N starts the story directly, like the original's "/S05N" ("direct mode": no splash, no welcome
    // screen, and closing the story ends the program without credits)
    const direct = new URLSearchParams(location.search).get('page');
    if (direct) {
      await this.play(direct);
      return;
    }
    await runSplash(this.display, this.assets);
    this.phase = 'welcome';
    const welcome = new Welcome(this.display, this.assets);
    await welcome.load();
    for (;;) {
      const choice = await welcome.show();
      let page: string | null = null;
      if (choice === 'quit') return;
      if (choice === 'begin') page = '01N';
      else if (choice === 'explain') page = '51N'; // tutorial: 51 -> 52 -> 53 -> 54 -> 01
      else {
        this.phase = 'thumbjump';
        page = await runThumbJump(this.display, this.assets, readBookmark());
        this.phase = 'welcome';
      }
      if (!page) continue; // left the overview: back to the welcome screen
      await this.play(page);
      this.phase = 'credits';
      await runCredits(this.display, this.assets);
      return;
    }
  }

  private async play(page: string) {
    this.session.mode = 0;
    this.phase = 'story';
    const story = (this.story = new StoryPlayer({ display: this.display, assets: this.assets, session: this.session }));
    await story.start(page);
    await story.closed;
  }
}
