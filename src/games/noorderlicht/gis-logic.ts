// GIS "IJsschotsspringen" / "Bergklimmen" (Noorderlicht PLAY_GAME 7 / 9, TGISfrmMain in BASNOORD.EXE), DOM-free logic.
//
// Bas (GISB001 image / GISB002 mask, 20x28) hops along a node graph drawn on GISMAIN.BMP (variant 0, ice floes)
// or GBKMAIN.BMP (variant 1, mountain). Clicking one of the (up to 6) neighbours of his node, within a +-10 px box,
// moves him there. An unsafe node sends him back to node 1 (GIS002); a safe node plays GIS003; the goal node
// (43 / 41) plays GIS004 and ends the game with result 1.
//
// Addresses: SetVariant FUN_0043cbfc, FormCreate @0x43cd44, FormMouseDown @0x43d058, DrawNode FUN_0043d1a8,
// click FUN_0043d6d0, FormShow @0x43d9fc, FormMouseMove @0x43db98 (hover FUN_0043dd8c / FUN_0043dc90).
// Graph records at 0x44cf74 + variant*0x2b0 + node*16: {x:i32, y:i32, safe:u8, nbr[6]:u8}, coordinates
// relative to SysDispRect. The goal node is read from 0x44cf80 + variant (the bytes 43 and 41 inside the
// unused record 0 of the variant-0 table). Variant 0's node 43 is the first record after its own table, i.e.
// variant 1's record 0, at (290, 22).
import { SRCAND, SRCCOPY, SRCPAINT, type Surface } from '../../engine/surface.ts';

/** [x, y, safe, neighbours[6]] */
export type NodeRec = [number, number, number, number[]];

// variant 0 (GISMAIN): 44 records (the last one is the record that follows the variant-0 table in the EXE: the goal)
const V0: NodeRec[] = [
  [0, 0, 0, [0, 0, 0, 43, 41, 139]],
  [276, 258, 1, [2, 3, 5, 6, 0, 0]],
  [230, 240, 1, [1, 4, 5, 0, 0, 0]],
  [330, 255, 0, [0, 0, 0, 0, 0, 0]],
  [150, 218, 1, [2, 14, 13, 0, 0, 0]],
  [255, 216, 0, [0, 0, 0, 0, 0, 0]],
  [300, 217, 1, [1, 5, 7, 12, 0, 0]],
  [338, 208, 1, [6, 11, 27, 0, 0, 0]],
  [399, 197, 1, [9, 10, 11, 0, 0, 0]],
  [427, 231, 0, [0, 0, 0, 0, 0, 0]],
  [446, 179, 1, [8, 30, 0, 0, 0, 0]],
  [358, 190, 1, [7, 8, 27, 28, 0, 0]],
  [276, 190, 0, [0, 0, 0, 0, 0, 0]],
  [202, 184, 0, [0, 0, 0, 0, 0, 0]],
  [128, 175, 1, [4, 15, 16, 21, 0, 0]],
  [178, 165, 1, [13, 14, 21, 22, 0, 0]],
  [83, 157, 1, [14, 17, 21, 0, 0, 0]],
  [56, 135, 0, [0, 0, 0, 0, 0, 0]],
  [60, 104, 0, [0, 0, 0, 0, 0, 0]],
  [23, 86, 0, [0, 0, 0, 0, 0, 0]],
  [160, 102, 1, [21, 22, 23, 36, 0, 0]],
  [149, 144, 0, [0, 0, 0, 0, 0, 0]],
  [206, 149, 1, [15, 20, 21, 23, 0, 0]],
  [235, 133, 0, [0, 0, 0, 0, 0, 0]],
  [278, 126, 0, [0, 0, 0, 0, 0, 0]],
  [329, 136, 1, [24, 27, 28, 34, 0, 0]],
  [265, 164, 0, [0, 0, 0, 0, 0, 0]],
  [305, 176, 1, [7, 11, 12, 25, 26, 0]],
  [363, 163, 0, [0, 0, 0, 0, 0, 0]],
  [395, 147, 0, [0, 0, 0, 0, 0, 0]],
  [472, 160, 1, [10, 31, 0, 0, 0, 0]],
  [476, 133, 1, [30, 32, 0, 0, 0, 0]],
  [459, 109, 1, [31, 33, 41, 0, 0, 0]],
  [408, 98, 1, [32, 34, 35, 40, 0, 0]],
  [354, 113, 0, [0, 0, 0, 0, 0, 0]],
  [338, 86, 0, [0, 0, 0, 0, 0, 0]],
  [208, 82, 1, [20, 37, 0, 0, 0, 0]],
  [230, 57, 1, [36, 43, 0, 0, 0, 0]],
  [359, 38, 1, [39, 43, 0, 0, 0, 0]],
  [392, 52, 1, [38, 40, 0, 0, 0, 0]],
  [444, 58, 1, [33, 39, 41, 42, 0, 0]],
  [476, 84, 0, [0, 0, 0, 0, 0, 0]],
  [471, 22, 0, [0, 0, 0, 0, 0, 0]],
  [290, 22, 1, [0, 0, 0, 0, 0, 0]],
];

// variant 1 (GBKMAIN): 43 records
const V1: NodeRec[] = [
  [290, 22, 1, [0, 0, 0, 0, 0, 0]],
  [317, 264, 1, [6, 7, 8, 0, 0, 0]],
  [89, 245, 0, [0, 0, 0, 0, 0, 0]],
  [154, 230, 1, [2, 4, 15, 0, 0, 0]],
  [190, 248, 1, [3, 5, 0, 0, 0, 0]],
  [224, 233, 1, [4, 6, 13, 14, 0, 0]],
  [277, 234, 1, [1, 5, 8, 13, 0, 0]],
  [354, 243, 1, [1, 8, 9, 12, 0, 0]],
  [320, 218, 0, [0, 0, 0, 0, 0, 0]],
  [394, 225, 1, [7, 11, 12, 21, 0, 0]],
  [467, 243, 0, [0, 0, 0, 0, 0, 0]],
  [436, 208, 1, [9, 10, 21, 0, 0, 0]],
  [358, 198, 0, [0, 0, 0, 0, 0, 0]],
  [228, 213, 0, [0, 0, 0, 0, 0, 0]],
  [186, 197, 0, [0, 0, 0, 0, 0, 0]],
  [118, 213, 1, [2, 3, 16, 0, 0, 0]],
  [104, 195, 1, [15, 17, 0, 0, 0, 0]],
  [128, 172, 1, [14, 16, 18, 0, 0, 0]],
  [175, 154, 1, [14, 17, 23, 0, 0, 0]],
  [235, 180, 0, [0, 0, 0, 0, 0, 0]],
  [322, 179, 0, [0, 0, 0, 0, 0, 0]],
  [403, 184, 1, [9, 11, 12, 22, 0, 0]],
  [440, 158, 1, [21, 26, 27, 0, 0, 0]],
  [228, 151, 1, [18, 19, 24, 33, 0, 0]],
  [281, 146, 1, [23, 32, 33, 0, 0, 0]],
  [334, 139, 0, [0, 0, 0, 0, 0, 0]],
  [403, 140, 0, [0, 0, 0, 0, 0, 0]],
  [434, 129, 1, [22, 26, 28, 29, 0, 0]],
  [465, 123, 0, [0, 0, 0, 0, 0, 0]],
  [450, 99, 1, [27, 28, 37, 0, 0, 0]],
  [368, 124, 0, [0, 0, 0, 0, 0, 0]],
  [337, 104, 0, [0, 0, 0, 0, 0, 0]],
  [293, 124, 0, [0, 0, 0, 0, 0, 0]],
  [235, 109, 1, [24, 32, 34, 35, 23, 0]],
  [197, 93, 0, [0, 0, 0, 0, 0, 0]],
  [256, 81, 1, [33, 34, 40, 0, 0, 0]],
  [360, 80, 1, [31, 37, 38, 39, 0, 0]],
  [405, 85, 1, [27, 36, 39, 29, 0, 0]],
  [332, 65, 0, [0, 0, 0, 0, 0, 0]],
  [357, 45, 1, [36, 37, 38, 41, 0, 0]],
  [277, 47, 1, [35, 41, 0, 0, 0, 0]],
  [316, 29, 1, [0, 0, 0, 0, 0, 0]],
  [0, 0, 0, [0, 0, 0, 0, 0, 0]],
];


export const GRAPHS: NodeRec[][] = [V0, V1];
/** Goal node per variant (bytes at 0x44cf80 / 0x44cf81). */
export const GOALS = [43, 41];
/** SysDispRect of the 800x600 layout. */
export const DISP = { left: 123, top: 85, right: 683, bottom: 365 };

export type GisSound = 'GIS001' | 'GIS002' | 'GIS003' | 'GIS004' | 'GKS001';

export interface GisEffects {
  /** sndPlaySound ASYNC (a new sound cuts the previous one). */
  playAsync(id: GisSound): void;
  /** sndPlaySound synchronous (option 0x10). */
  playSync(id: GisSound): Promise<void>;
  /** Form.Update: paint now. */
  update(): void;
  invalidate(): void;
}

export interface GisResources {
  /** GISBACK.BMP 800x600. */
  back: Surface;
  /** GISMAIN.BMP / GBKMAIN.BMP, 560x280. */
  main: Surface;
  bas: Surface; // GISB001 20x28
  basMask: Surface; // GISB002
}

const BAS_W = 20, BAS_H = 28;

export class GisLogic {
  /** 0x1c9: running; 0x1c8: result (0 quit, 1 won). */
  running = true;
  result = 0;
  /** 0x1ac: the picture shown by FormPaint. */
  readonly work: Surface;
  /** 0x1bc: Bas' current node. */
  node = 1;
  /** 0x1be: node under the mouse (cursor 1), 0 = none. */
  hoverNode = 0;
  /** Set while the goal sound plays synchronously (the original's UI thread is blocked then). */
  busy = false;

  private res: GisResources;
  private fx: GisEffects;
  private graph: NodeRec[];

  readonly variant: 0 | 1;

  constructor(variant: 0 | 1, res: GisResources, fx: GisEffects) {
    this.variant = variant;
    this.res = res;
    this.fx = fx;
    this.graph = GRAPHS[variant];
    this.work = res.back.clone();
    // SetVariant: GISMAIN drawn at the display rect, then Bas at node 1
    this.work.bitBlt(DISP.left, DISP.top, res.main.width, res.main.height, res.main, 0, 0, SRCCOPY);
    this.drawMove(0, 1);
  }

  /** FUN_0043d1a8(from, to): erase Bas at `from` (restore from the main picture), draw him at `to`. */
  private drawMove(from: number, to: number) {
    const g = this.graph;
    if (from !== 0) {
      const [x, y] = g[from];
      this.work.bitBlt(DISP.left + x - 10, DISP.top + y - 18, BAS_W, BAS_H, this.res.main, x - 10, y - 18, SRCCOPY);
    }
    const [x, y] = g[to];
    this.work.bitBlt(DISP.left + x - 10, DISP.top + y - 18, BAS_W, BAS_H, this.res.basMask, 0, 0, SRCAND);
    this.work.bitBlt(DISP.left + x - 10, DISP.top + y - 18, BAS_W, BAS_H, this.res.bas, 0, 0, SRCPAINT);
    this.fx.invalidate();
  }

  /** The 20x20 hit box (PtInRect: right/bottom exclusive) around node n. */
  private inBox(n: number, x: number, y: number) {
    const [nx, ny] = this.graph[n];
    return x >= nx - 10 && x < nx + 10 && y >= ny - 10 && y < ny + 10;
  }

  /** Neighbour of the current node under the point (display-relative), or 0. */
  nodeAt(x: number, y: number): number {
    for (const nb of this.graph[this.node][3]) {
      if (nb !== 0 && this.inBox(nb, x, y)) return nb;
    }
    return 0;
  }

  /** FormShow @0x43d9fc: Bas at node 1 again, then the intro sound (async). */
  show() {
    this.drawMove(0, 1);
    this.fx.playAsync(this.variant === 0 ? 'GIS001' : 'GKS001');
  }

  /** FUN_0043d6d0: click on the display area, x/y relative to its top-left. */
  async click(x: number, y: number) {
    let nb = this.nodeAt(x, y);
    if (nb === 0) return;
    if (nb === GOALS[this.variant]) {
      this.drawMove(this.node, nb);
      this.fx.update();
      this.busy = true;
      await this.fx.playSync('GIS004');
      this.result = 1;
      this.running = false;
      return;
    }
    if (this.graph[nb][2] === 0) {
      nb = 1;
      this.fx.playAsync('GIS002');
    } else this.fx.playAsync('GIS003');
    this.drawMove(this.node, nb);
    this.node = nb;
  }

  /** FUN_0043dd8c: hover; returns true when the pointer cursor should show. */
  hover(x: number, y: number): boolean {
    this.hoverNode = this.nodeAt(x, y);
    return this.hoverNode !== 0;
  }
}
