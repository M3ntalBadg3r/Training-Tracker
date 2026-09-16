#!/usr/bin/env node
/**
 * Generate `public/geo/world-countries.json` — the pre-projected, pre-simplified
 * country geometry the `GeoMap` component fetches at runtime.
 *
 * This is a ONE-OFF generator, not part of the build and not a dependency. It is
 * committed so the asset is reproducible and its provenance is auditable, and it
 * is dependency-free Node like everything else in `scripts/`: the TopoJSON arc
 * decoding, the Equal Earth projection and the Douglas-Peucker simplification are
 * all hand-rolled below (~200 lines between them), which is cheaper than owning a
 * dependency the running app never loads.
 *
 *   node scripts/generate-geo-atlas.mjs [--out <path>] [--source <url|file>]
 *
 * ---------------------------------------------------------------------------
 * SOURCE AND LICENCE
 *
 *   Geometry: world-atlas v2 `countries-50m.json`
 *             https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json
 *             ISC licence (Mike Bostock), derived from Natural Earth 1:50m
 *             Admin 0 countries, which is in the PUBLIC DOMAIN.
 *             https://www.naturalearthdata.com/about/terms-of-use/
 *
 *   ISO 3166-1 numeric -> alpha-2: the table in `NUMERIC_TO_ALPHA2` below. ISO
 *             3166-1 code assignments are facts, not authorship; the table was
 *             cross-checked against the `world-countries` dataset (Unlicense /
 *             public domain, https://github.com/mledoze/countries).
 *
 * The generated asset records the same attribution in its own `source` /
 * `licence` fields, so it travels with the file.
 * ---------------------------------------------------------------------------
 *
 * WHY EQUAL EARTH, NOT MERCATOR
 *
 * Mercator inflates area with latitude without bound — Greenland renders larger
 * than Africa, which is fourteen times its size. On a map whose entire job is
 * "where are our people", that is not a stylistic preference, it is a false
 * statement about the data. Equal Earth (Savric, Patterson & Jenny, 2019) is
 * equal-area, has a closed-form polynomial forward projection, and looks like a
 * world map rather than an interrupted one. It is implemented directly below.
 *
 * WHY PER-ARC SIMPLIFICATION
 *
 * TopoJSON stores each shared border once, as an arc. Simplifying the arcs and
 * then stitching rings out of them keeps neighbouring countries sharing exactly
 * the same vertices. Simplifying finished rings instead would let two countries'
 * copies of one border diverge, opening hairline slivers of background along
 * every land frontier.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_SOURCE = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json";
const DEFAULT_OUT = resolve(HERE, "..", "public", "geo", "world-countries.json");

/** Output coordinate space. Integers throughout; see `round` below. */
const VIEW_WIDTH = 2000;

/**
 * Douglas-Peucker tolerance, in output units. 1.5 at a 2000-unit width is about
 * 0.6px on an 800px-wide render — below one device pixel, so the simplification
 * is invisible at the scale this map is ever drawn.
 */
const SIMPLIFY_TOLERANCE = 1.5;

/**
 * Rings smaller than this across their diagonal are dropped: at 2000 units wide
 * they are sub-pixel specks that cost bytes and draw nothing. A country's largest
 * ring is never dropped, so no country disappears — see `MIN_COUNTRY_SIZE`.
 */
const MIN_RING_SIZE = 4;

/**
 * A country whose whole geometry is narrower than this is replaced by a square of
 * exactly this side on its centroid. Singapore is 0.4 degrees across: at any scale
 * a world map is drawn, its true outline is a fraction of a pixel — unseeable and
 * unclickable. Every ISO code in the atlas must be visible and selectable or the
 * map silently refuses to answer questions about small countries, which for this
 * app (Singapore, Hong Kong, Malta, Bahrain, Luxembourg) is most of the
 * interesting ones. Natural Earth ships a separate "tiny countries" point layer
 * for the same reason. The substituted codes are listed in the asset's
 * `enlarged` field so the distortion is stated rather than hidden.
 *
 * **Keep it even.** The half-width has to be a whole number of output units, and
 * the first version used `Math.round(9 / 2)` — which drew a 10-unit square while
 * every overlap calculation believed it was 9. A square is ~200km on this
 * projection, so a unit of slop here is tens of kilometres of extra collision.
 */
const MIN_COUNTRY_SIZE = 8;
const SQUARE_HALF = MIN_COUNTRY_SIZE / 2;

/**
 * Two enlarged squares that overlap are nudged apart until they only touch.
 *
 * Anguilla, Sint Maarten, Saint Martin and Saint Barthelemy are within 30km of
 * each other; four 200km squares cannot share that space, and whichever paints
 * last simply erases the others. Displacement is the standard cartographic answer
 * (the alternative is a country nobody can see or click), and at this scale the
 * whole cluster moves a few pixels. Only squares are moved — real outlines stay
 * exactly where the projection put them, so nothing that is drawn truthfully is
 * ever moved to make room.
 */
const NUDGE_PASSES = 400;
const NUDGE_EPSILON = 0.1;

/**
 * Every country must keep at least this share of its painted area after the ones
 * above it are drawn, or the generator refuses to write the file.
 *
 * Half is the line where the picture starts lying rather than merely crowding:
 * below it, most of the ink a reader sees inside a country's outline belongs to
 * something else, so they read the neighbour's colour, hover the neighbour's name
 * and click the neighbour's code — with nothing to tell them. The unmapped notice
 * cannot help, because an occluded country *has* a path and is not missing; it is
 * present and wrong, which is worse. Half of the minimum square is still 32 square
 * units, a usable target at any width this map is drawn at.
 */
const MIN_VISIBLE_FRACTION = 0.5;

/**
 * No edge may run further than this across the map, unless it lies along the
 * polar boundary (see `POLAR_BAND`).
 *
 * A seam — the straight line a ring draws back across the world when it has been
 * cut at the dateline by accident rather than on purpose — is 1300 to 1400 units
 * here. The longest *legitimate* edge in the finished atlas is 127 units: the
 * 49th-parallel stretch of the Canada/United States border, which really is a
 * straight line that long. 250 leaves both a doubling of headroom over the
 * longest honest edge and a fivefold margin below the shortest seam, so the check
 * can neither nag nor miss.
 *
 * It exists because the first two defects in this file were both invisible to the
 * check that was here: ten named codes existed and their paths began `M` and
 * ended `Z` while Russia was drawing three bars across the Arctic, each hoverable
 * and clickable along its whole length. A point-in-polygon probe cannot catch a
 * seam either — it adds area over ocean and moves no country — so the only thing
 * that can is a rule about the geometry itself.
 */
const MAX_EDGE_DX = 250;

/**
 * How close to the top or bottom of the viewBox an edge must be to count as
 * running along the pole line rather than across the map.
 *
 * Antarctica's ring closes along latitude -90, which Equal Earth draws as a
 * 1201-unit horizontal line at y 970 of 974. That is the map's own southern
 * boundary and is correct; it is the one long edge that must be allowed.
 */
const POLAR_BAND = 8;

/**
 * ISO 3166-1 numeric -> alpha-2. Space-separated `nnn:AA` pairs, one screenful
 * rather than 249 object lines.
 */
const NUMERIC_TO_ALPHA2 = parsePairs(`
  004:AF 008:AL 010:AQ 012:DZ 016:AS 020:AD 024:AO 028:AG 031:AZ 032:AR
  036:AU 040:AT 044:BS 048:BH 050:BD 051:AM 052:BB 056:BE 060:BM 064:BT
  068:BO 070:BA 072:BW 074:BV 076:BR 084:BZ 086:IO 090:SB 092:VG 096:BN
  100:BG 104:MM 108:BI 112:BY 116:KH 120:CM 124:CA 132:CV 136:KY 140:CF
  144:LK 148:TD 152:CL 156:CN 158:TW 162:CX 166:CC 170:CO 174:KM 175:YT
  178:CG 180:CD 184:CK 188:CR 191:HR 192:CU 196:CY 203:CZ 204:BJ 208:DK
  212:DM 214:DO 218:EC 222:SV 226:GQ 231:ET 232:ER 233:EE 234:FO 238:FK
  239:GS 242:FJ 246:FI 248:AX 250:FR 254:GF 258:PF 260:TF 262:DJ 266:GA
  268:GE 270:GM 275:PS 276:DE 288:GH 292:GI 296:KI 300:GR 304:GL 308:GD
  312:GP 316:GU 320:GT 324:GN 328:GY 332:HT 334:HM 336:VA 340:HN 344:HK
  348:HU 352:IS 356:IN 360:ID 364:IR 368:IQ 372:IE 376:IL 380:IT 384:CI
  388:JM 392:JP 398:KZ 400:JO 404:KE 408:KP 410:KR 414:KW 417:KG 418:LA
  422:LB 426:LS 428:LV 430:LR 434:LY 438:LI 440:LT 442:LU 446:MO 450:MG
  454:MW 458:MY 462:MV 466:ML 470:MT 474:MQ 478:MR 480:MU 484:MX 492:MC
  496:MN 498:MD 499:ME 500:MS 504:MA 508:MZ 512:OM 516:NA 520:NR 524:NP
  528:NL 531:CW 533:AW 534:SX 535:BQ 540:NC 548:VU 554:NZ 558:NI 562:NE
  566:NG 570:NU 574:NF 578:NO 580:MP 581:UM 583:FM 584:MH 585:PW 586:PK
  591:PA 598:PG 600:PY 604:PE 608:PH 612:PN 616:PL 620:PT 624:GW 626:TL
  630:PR 634:QA 638:RE 642:RO 643:RU 646:RW 652:BL 654:SH 659:KN 660:AI
  662:LC 663:MF 666:PM 670:VC 674:SM 678:ST 682:SA 686:SN 688:RS 690:SC
  694:SL 702:SG 703:SK 704:VN 705:SI 706:SO 710:ZA 716:ZW 724:ES 728:SS
  729:SD 732:EH 740:SR 744:SJ 748:SZ 752:SE 756:CH 760:SY 762:TJ 764:TH
  768:TG 772:TK 776:TO 780:TT 784:AE 788:TN 792:TR 795:TM 796:TC 798:TV
  800:UG 804:UA 807:MK 818:EG 826:GB 831:GG 832:JE 833:IM 834:TZ 840:US
  850:VI 854:BF 858:UY 860:UZ 862:VE 876:WF 882:WS 887:YE 894:ZM
`);

/**
 * Natural Earth carries a few polygons that ISO 3166-1 gives no code to. They are
 * emitted as uncoloured background land (the asset's `unclaimed` array) rather
 * than left as holes in the map, which would read as sea.
 *
 * Kosovo is the exception: it has no ISO 3166-1 entry either, but `XK` is the
 * user-assigned code the EU, the IMF and most software use, so an operator typing
 * a code for it will type that one.
 */
const UNCODED_NAMES = {
  Kosovo: "XK",
};

function parsePairs(text) {
  const out = new Map();
  for (const token of text.trim().split(/\s+/)) {
    const [numeric, alpha2] = token.split(":");
    out.set(numeric, alpha2);
  }
  return out;
}

// --------------------------------------------------------------------------
// Equal Earth (Savric, Patterson & Jenny, 2019). Forward projection only.
// --------------------------------------------------------------------------

const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const DEG = Math.PI / 180;

/** Degrees lon/lat -> unitless Equal Earth x/y (y up). */
function project(lon, lat) {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const l = Math.asin(M * Math.sin(phi));
  const l2 = l * l;
  const l6 = l2 * l2 * l2;
  return [
    (lambda * Math.cos(l)) / (M * (A1 + 3 * A2 * l2 + l6 * (7 * A3 + 9 * A4 * l2))),
    l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2)),
  ];
}

// --------------------------------------------------------------------------
// TopoJSON decoding. Enough of the spec to read this one file, no more.
// --------------------------------------------------------------------------

/**
 * Undo the quantisation and delta encoding of one arc, giving absolute lon/lat.
 * TopoJSON stores every arc's points as deltas from the previous point, in
 * integer quantised units, with a per-topology scale/translate to get back.
 */
function decodeArc(arc, transform) {
  const [sx, sy] = transform.scale;
  const [tx, ty] = transform.translate;
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * sx + tx, y * sy + ty];
  });
}

/**
 * Stitch a ring out of arc indices. A negative index `~i` means arc `i` traversed
 * backwards; consecutive arcs share an endpoint, so each arc after the first drops
 * its first point.
 */
function stitch(indices, arcs) {
  const ring = [];
  for (const index of indices) {
    const reversed = index < 0;
    const points = arcs[reversed ? ~index : index];
    const ordered = reversed ? points.slice().reverse() : points;
    for (let i = ring.length === 0 ? 0 : 1; i < ordered.length; i++) ring.push(ordered[i]);
  }
  return ring;
}

/** Every polygon of a geometry, as arrays of arc-index arrays (outer + holes). */
function polygonsOf(geometry) {
  if (geometry.type === "Polygon") return [geometry.arcs];
  if (geometry.type === "MultiPolygon") return geometry.arcs;
  return [];
}

// --------------------------------------------------------------------------
// Simplification and geometry helpers
// --------------------------------------------------------------------------

/** Squared perpendicular distance from `p` to the segment `a`-`b`. */
function segmentDistanceSq(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      [x, y] = b;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/**
 * Douglas-Peucker, iterative so a long arc cannot blow the stack.
 *
 * Returns which points survive rather than the points themselves, because the
 * decision is made in projected space (where the tolerance means something) but
 * has to be applied to the lon/lat copy as well — the two must keep exactly the
 * same vertices or a shared border stops being shared.
 */
function simplifyMask(points, tolerance) {
  const keep = new Uint8Array(points.length);
  if (points.length <= 2) return keep.fill(1);
  const toleranceSq = tolerance * tolerance;
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistanceSq(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index !== -1 && worst > toleranceSq) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return keep;
}

function bbox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Drop points that round onto their predecessor; a ring needs 3 distinct ones. */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const previous = out[out.length - 1];
    if (!previous || previous[0] !== p[0] || previous[1] !== p[1]) out.push(p);
  }
  // A closed ring repeats its first point last; that duplicate is implied by `Z`.
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
    else break;
  }
  return out;
}

/**
 * Cut a ring at the antimeridian, in LONGITUDE space, before it is projected.
 *
 * Natural Earth keeps a landmass that straddles the antimeridian contiguous by
 * letting its longitude run past 180 — Russia's Chukotka reaches 191E, the
 * Aleutians pass -180 the other way — so a faithful projection puts real land on
 * the wrong side of the map, and the ring then closes by drawing a straight line
 * back across it.
 *
 * The first version tried to detect this from the ring's projected bounding box
 * and shift whole rings back inside `[0, width]`. **That test cannot work in this
 * projection**, and the failure was silent: Equal Earth converges towards the
 * poles, so `x = 2000` is longitude 180 *at the equator only*. At 68N, longitude
 * 180 is x 1695 and longitude 191 is x 1810 — comfortably "inside" a 2000-unit
 * box. Russia therefore took the untouched early return and shipped with three
 * Russia-coloured bars across the Arctic at y 35-61, each one hoverable and
 * clickable along its whole length, reporting Russia over open ocean from Alaska
 * to Siberia. A bounding box in projected units cannot answer a question about
 * longitude; only longitude can.
 *
 * So: shift the ring by each whole turn that could bring part of it into
 * `[-180, 180]` and clip. Clipping (rather than shifting) is what closes the cut
 * edge along the meridian, so each piece is a fillable polygon in its own right.
 *
 * A ring already inside `[-180, 180]` is returned untouched — which is what keeps
 * Antarctica correct. Its ring legitimately runs the full -180..180 and closes
 * along the pole line; that full-width edge is the map's own southern boundary,
 * not a seam.
 */
function splitAtAntimeridian(ring) {
  const unwrapped = unwrapLongitudes(ring);

  // A ring that comes back a whole turn from where it started encircles a pole.
  // That is Antarctica, whose full-width closing edge runs along the pole line —
  // the map's own southern boundary, not a seam. Unwrapping it would tear it in
  // two for no gain, so leave it exactly as the projection found it.
  const encirclesPole =
    Math.abs(unwrapped[unwrapped.length - 1][0] - unwrapped[0][0]) > 180;
  const base = encirclesPole ? ring : unwrapped;

  let min = Infinity;
  let max = -Infinity;
  for (const [lon] of base) {
    if (lon < min) min = lon;
    if (lon > max) max = lon;
  }
  if (min >= -180 && max <= 180) return [base];

  const pieces = [];
  for (const shift of [0, -360, 360]) {
    if (max + shift < -180 || min + shift > 180) continue;
    const shifted = shift === 0 ? base : base.map(([lon, lat]) => [lon + shift, lat]);
    const clipped = densifyMeridian(clipLongitude(shifted, -180, 180));
    if (clipped.length >= 3) pieces.push(clipped);
  }
  return pieces;
}

/**
 * Make a ring's longitudes continuous, so a landmass that crosses the dateline
 * reads as one unbroken run rather than as a jump from +179.9 to -179.9.
 *
 * This is the detection the first version lacked. A ring crossing the
 * antimeridian is stored entirely within [-180, 180] with one 360-degree step in
 * the middle of it, so nothing about its coordinate *range* is unusual — which is
 * why a bounding-box test, in any space, cannot see it. The step between
 * consecutive vertices is the only place the crossing is visible.
 */
function unwrapLongitudes(ring) {
  if (ring.length === 0) return ring;
  const out = [ring[0]];
  let previous = ring[0][0];
  let offset = 0;
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0] + offset;
    if (lon - previous > 180) {
      offset -= 360;
      lon -= 360;
    } else if (lon - previous < -180) {
      offset += 360;
      lon += 360;
    }
    out.push([lon, ring[i][1]]);
    previous = lon;
  }
  return out;
}

/** Sutherland-Hodgman against one vertical line. `side` +1 keeps lon >= limit. */
function clipHalfPlane(ring, limit, side) {
  const inside = (point) => (side > 0 ? point[0] >= limit : point[0] <= limit);
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i];
    const previous = ring[(i + ring.length - 1) % ring.length];
    if (inside(current) !== inside(previous)) {
      const span = current[0] - previous[0];
      const t = span === 0 ? 0 : (limit - previous[0]) / span;
      out.push([limit, previous[1] + t * (current[1] - previous[1])]);
    }
    if (inside(current)) out.push(current);
  }
  return out;
}

function clipLongitude(ring, lo, hi) {
  // Drop the repeated closing vertex first: Sutherland-Hodgman treats the ring as
  // implicitly closed, and a duplicate would emit a zero-length edge.
  const open =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  return clipHalfPlane(clipHalfPlane(open, lo, 1), hi, -1);
}

/**
 * Add intermediate points along a cut edge that runs down the meridian.
 *
 * The meridian is a straight line in longitude but a curve once projected, so a
 * cut spanning many degrees of latitude would be drawn as a chord across it.
 */
function densifyMeridian(ring) {
  const STEP = 2;
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i];
    const next = ring[(i + 1) % ring.length];
    out.push(current);
    const onEdge = Math.abs(current[0]) === 180 && current[0] === next[0];
    if (!onEdge) continue;
    const span = next[1] - current[1];
    const steps = Math.floor(Math.abs(span) / STEP);
    for (let s = 1; s < steps; s++) out.push([current[0], current[1] + (span * s) / steps]);
  }
  return out;
}

/**
 * `M x y L x y ... Z` with integer coordinates and no separators beyond the
 * minimum. Absolute rather than relative commands: relative saves a few percent
 * on a file this size and costs the ability to eyeball a path against the viewBox.
 */
function toPath(rings) {
  return rings
    .map((ring) => `M${ring.map(([x, y]) => `${x} ${y}`).join("L")}Z`)
    .join("");
}

// --------------------------------------------------------------------------
// Enlarged squares: placement, and the occlusion audit that polices it
// --------------------------------------------------------------------------

function squareRing(cx, cy) {
  return [
    [cx - SQUARE_HALF, cy - SQUARE_HALF],
    [cx + SQUARE_HALF, cy - SQUARE_HALF],
    [cx + SQUARE_HALF, cy + SQUARE_HALF],
    [cx - SQUARE_HALF, cy + SQUARE_HALF],
  ];
}

/**
 * Push overlapping enlarged squares apart until they only touch.
 *
 * Pairwise relaxation along the axis of least penetration, which for
 * axis-aligned squares is the smallest move that resolves the overlap and so
 * keeps every country as near its true position as the constraint allows. Ties
 * (two squares on exactly the same point) are broken on the ISO code so the
 * output is deterministic; a generator whose result depends on iteration order
 * is a generator nobody can diff.
 *
 * Mutates `built` in place and returns what it had to do, for the report.
 */
function nudgeSquares(built) {
  const squares = built.filter((item) => item.square);
  let passes = 0;
  for (; passes < NUDGE_PASSES; passes++) {
    let moved = false;
    for (let i = 0; i < squares.length; i++) {
      for (let j = i + 1; j < squares.length; j++) {
        const a = squares[i].square;
        const b = squares[j].square;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const penX = MIN_COUNTRY_SIZE - Math.abs(dx);
        const penY = MIN_COUNTRY_SIZE - Math.abs(dy);
        // An epsilon, not zero: relaxing to exact contact leaves a penetration of
        // a few ulps that never resolves, so every pass "moves" something and the
        // loop runs to its cap while converged. A tenth of a unit is a twentieth
        // of a pixel at any width this map is drawn at.
        if (penX <= NUDGE_EPSILON || penY <= NUDGE_EPSILON) continue;
        if (dx === 0 && dy === 0) {
          // Exactly coincident. Separate along x in a fixed direction.
          dx = squares[i].iso < squares[j].iso ? -1 : 1;
        }
        // Half the smallest move that resolves it, applied to each side.
        if (penX <= penY) {
          const push = (penX / 2) * (dx >= 0 ? 1 : -1);
          a.x -= push;
          b.x += push;
        } else {
          const push = (penY / 2) * (dy >= 0 ? 1 : -1);
          a.y -= push;
          b.y += push;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  let worst = 0;
  let worstIso = null;
  for (const item of squares) {
    const shift = Math.hypot(item.square.x - item.trueX, item.square.y - item.trueY);
    if (shift > worst) {
      worst = shift;
      worstIso = item.iso;
    }
  }

  // Positions are rounded to whole units when the path is built, which can put
  // back up to a unit of overlap. That is measured for real by the occlusion
  // audit; this figure only says whether the relaxation itself settled.
  let residual = 0;
  for (let i = 0; i < squares.length; i++) {
    for (let j = i + 1; j < squares.length; j++) {
      const a = squares[i].square;
      const b = squares[j].square;
      if (
        MIN_COUNTRY_SIZE - Math.abs(b.x - a.x) > NUDGE_EPSILON &&
        MIN_COUNTRY_SIZE - Math.abs(b.y - a.y) > NUDGE_EPSILON
      ) {
        residual++;
      }
    }
  }
  return { passes, squares: squares.length, worst, worstIso, residual };
}

/**
 * Edges that run further than `MAX_EDGE_DX` across the map without being part of
 * the polar boundary. Also reports the longest honest edge, so the threshold can
 * be re-justified from the output rather than from memory.
 */
function findSeams(items, viewHeight) {
  const found = [];
  for (const { iso, rings } of items) {
    for (const ring of rings ?? []) {
      for (let i = 0; i < ring.length; i++) {
        const from = ring[i];
        const to = ring[(i + 1) % ring.length];
        const dx = Math.abs(to[0] - from[0]);
        if (dx <= MAX_EDGE_DX) continue;
        const polar =
          (from[1] <= POLAR_BAND && to[1] <= POLAR_BAND) ||
          (from[1] >= viewHeight - POLAR_BAND && to[1] >= viewHeight - POLAR_BAND);
        if (!polar) found.push({ iso, dx, from, to });
      }
    }
  }
  return found.sort((a, b) => b.dx - a.dx);
}

/** The longest edge that is neither a seam nor part of the polar boundary. */
function longestHonestEdge(items, viewHeight) {
  let best = { iso: "none", dx: 0 };
  for (const { iso, rings } of items) {
    for (const ring of rings ?? []) {
      for (let i = 0; i < ring.length; i++) {
        const from = ring[i];
        const to = ring[(i + 1) % ring.length];
        const polar =
          (from[1] <= POLAR_BAND && to[1] <= POLAR_BAND) ||
          (from[1] >= viewHeight - POLAR_BAND && to[1] >= viewHeight - POLAR_BAND);
        if (polar) continue;
        const dx = Math.abs(to[0] - from[0]);
        if (dx > best.dx) best = { iso, dx };
      }
    }
  }
  return best;
}

/** `M x y L x y … Z` back into rings. Only has to read what `toPath` writes. */
function ringsFromPath(d) {
  return d
    .split("Z")
    .filter((part) => part.length > 0)
    .map((part) => {
      const numbers = part.match(/-?\d+/g) ?? [];
      const ring = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        ring.push([Number(numbers[i]), Number(numbers[i + 1])]);
      }
      return ring;
    })
    .filter((ring) => ring.length >= 3);
}

/** Even-odd, matching how a browser fills a multi-ring path by default. */
function pointInRings(px, py, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * How much of each country a reader can actually see, given the paint order.
 *
 * The first sanity check this file carried only asserted that ten named codes
 * existed and that their path data began `M` and ended `Z`. Every one of those
 * assertions passed on an atlas that painted Anguilla and then painted Sint
 * Maarten exactly over it — a country present, coloured, hoverable and clickable
 * as its neighbour, with no notice anywhere saying so, which is a worse failure
 * than a country simply being absent. A check that cannot see the defect it is
 * there to prevent is decoration; this one rasterises the finished paths in paint
 * order and measures.
 *
 * Sampling is a grid clamped to the viewBox (geometry outside it is cropped by
 * the root `<svg>` and is not "visible" by any definition a reader would accept),
 * with the step chosen per country so a big one costs no more samples than a
 * small one.
 */
function occlusionReport(built, viewWidth, viewHeight) {
  const parsed = built.map((item) => {
    const rings = item.rings ?? [];
    return { iso: item.iso, rings, box: bbox(rings.flat()) };
  });

  return parsed.map((me, index) => {
    const minX = Math.max(0, me.box.minX);
    const maxX = Math.min(viewWidth, me.box.maxX);
    const minY = Math.max(0, me.box.minY);
    const maxY = Math.min(viewHeight, me.box.maxY);
    const area = Math.max(1, (maxX - minX) * (maxY - minY));
    const step = Math.max(0.5, Math.sqrt(area / 2500));

    // Only the countries painted after this one can hide any of it, and only
    // those whose bounding box actually reaches it.
    const over = parsed
      .slice(index + 1)
      .filter(
        (other) =>
          other.box.minX <= maxX &&
          other.box.maxX >= minX &&
          other.box.minY <= maxY &&
          other.box.maxY >= minY
      );

    let total = 0;
    let visible = 0;
    for (let y = minY + step / 2; y <= maxY; y += step) {
      for (let x = minX + step / 2; x <= maxX; x += step) {
        if (!pointInRings(x, y, me.rings)) continue;
        total++;
        const hidden = over.some(
          (other) =>
            x >= other.box.minX &&
            x <= other.box.maxX &&
            y >= other.box.minY &&
            y <= other.box.maxY &&
            pointInRings(x, y, other.rings)
        );
        if (!hidden) visible++;
      }
    }
    // A shape too thin to catch a sample at this resolution is not occluded by
    // anything we can measure; call it whole rather than invent a failure.
    return { iso: me.iso, total, visible, fraction: total === 0 ? 1 : visible / total };
  });
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadTopology(source) {
  if (/^https?:/.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

async function main() {
  const source = arg("source", DEFAULT_SOURCE);
  const out = arg("out", DEFAULT_OUT);

  const topology = await loadTopology(source);
  if (!topology.transform) throw new Error("expected a quantised topology (no `transform`)");
  const geometries = topology.objects?.countries?.geometries;
  if (!Array.isArray(geometries)) throw new Error("expected `objects.countries.geometries`");

  // 1. Decode every arc to lon/lat, then project. Done once per arc, before any
  //    ring is stitched, so a shared border is projected and simplified exactly
  //    once and both its owners get identical vertices.
  const geoArcs = topology.arcs.map((arc) => decodeArc(arc, topology.transform));

  // 2. Find the projected extent so the whole world fits the viewBox. Derived
  //    rather than hardcoded: it is a property of the projection, and computing
  //    it means a future projection swap needs no second edit.
  //
  //    Scan the whole graticule, not just its corners. Equal Earth's widest
  //    point is the equator and its tallest is the meridian, so sampling only
  //    the poles (as the first attempt did) measures a box two thirds of the
  //    true width, silently scaling every coordinate 1.7x and throwing the
  //    equator clean outside the viewBox. A corner scan is only valid for a
  //    projection whose extremes sit at the corners, and this is not one.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let lon = -180; lon <= 180; lon += 1) {
    for (let lat = -90; lat <= 90; lat += 1) {
      const [x, y] = project(lon, lat);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const scale = VIEW_WIDTH / (maxX - minX);
  const viewHeight = Math.ceil((maxY - minY) * scale);
  // y is flipped: the projection puts north at +y, SVG puts it at -y.
  const toView = ([lon, lat]) => {
    const [x, y] = project(lon, lat);
    return [(x - minX) * scale, (maxY - y) * scale];
  };

  // 3. Decide which vertices survive simplification. The decision is made on the
  //    PROJECTED arc, because that is the space the tolerance is expressed in, and
  //    the same mask is then applied to the lon/lat copy — rings are stitched and
  //    cut at the antimeridian in longitude space (see `splitAtAntimeridian`) and
  //    only projected afterwards, so both copies must carry identical vertices or
  //    a shared border stops being shared.
  const simpleGeoArcs = geoArcs.map((arc) => {
    const mask = simplifyMask(arc.map(toView), SIMPLIFY_TOLERANCE);
    return arc.filter((_, i) => mask[i] === 1);
  });

  /** lon/lat ring -> the drawable, integer, projected pieces of it. */
  const toViewPieces = (geoRing) =>
    splitAtAntimeridian(geoRing)
      .map((piece) => dedupe(piece.map(toView).map(([x, y]) => [Math.round(x), Math.round(y)])))
      .filter((piece) => piece.length >= 3);

  /** The same, unsimplified and unrounded: what size judgements are made on. */
  const toTruePieces = (geoRing) => splitAtAntimeridian(geoRing).map((piece) => piece.map(toView));

  /** iso -> { rings: drawable rings, speck: the biggest thing we dropped } */
  const collected = new Map();
  const unclaimed = [];
  const enlarged = [];
  const skipped = [];

  for (const geometry of geometries) {
    const name = geometry.properties?.name ?? "(unnamed)";
    const numeric = geometry.id == null ? null : String(geometry.id).padStart(3, "0");
    const iso = numeric ? NUMERIC_TO_ALPHA2.get(numeric) : UNCODED_NAMES[name];

    const rings = [];
    let speck = null;
    /**
     * A ring too small to draw. The biggest one is remembered, because if it
     * turns out to be all this country has we still owe it a visible shape.
     */
    const noteSpeck = (box, size) => {
      if (!speck || size > speck.size) {
        speck = { size, x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      }
    };

    for (const indices of polygonsOf(geometry).flat()) {
      const geoRing = stitch(indices, geoArcs);
      if (geoRing.length === 0) continue;

      // Judge the ring on its true projected size, not on the simplified copy:
      // a ring the simplifier has flattened to two points looks small because it
      // was flattened, not because it is small. Measure the largest antimeridian
      // piece, since that is the largest thing actually drawn.
      const truePieces = toTruePieces(geoRing);
      if (truePieces.length === 0) continue;
      let box = null;
      let size = -1;
      for (const piece of truePieces) {
        const pieceBox = bbox(piece);
        const pieceSize = Math.hypot(pieceBox.width, pieceBox.height);
        if (pieceSize > size) {
          size = pieceSize;
          box = pieceBox;
        }
      }

      // `truePieces` losing every vertex, or a ring the source itself quantised
      // down to a couple of points, is a speck like any other.
      if (geoRing.length < 3 || size < MIN_RING_SIZE) {
        noteSpeck(box, size);
        continue;
      }
      const pieces = toViewPieces(stitch(indices, simpleGeoArcs));
      // Big enough to keep, but simplification and integer rounding left fewer
      // than three distinct vertices — so there is nothing to fill. It is a speck
      // after all, and saying so is what keeps Bahrain, Dominica, Curacao and Guam
      // on the map; treating it as "drawn" is what lost them on the first attempt.
      if (pieces.length === 0) noteSpeck(box, size);
      else rings.push(...pieces);
    }

    if (!iso) {
      // Uncoded land is drawn as background so the map has no holes, but it gets
      // no size guarantee: nothing can select it, so an invisible one costs
      // nothing. Only the coded countries have to be reachable.
      if (rings.length > 0) unclaimed.push(toPath(rings));
      else skipped.push(name);
      continue;
    }

    // Natural Earth can carry several polygons for one ISO code (Australia's
    // offshore territories are separate geometries), so accumulate rather than
    // assign — otherwise the last one wins and the mainland vanishes.
    const entry = collected.get(iso) ?? { rings: [], speck: null };
    entry.rings.push(...rings);
    if (speck && (!entry.speck || speck.size > entry.speck.size)) entry.speck = speck;
    collected.set(iso, entry);
  }

  const built = [];
  for (const [iso, entry] of collected) {
    if (entry.rings.length > 0) {
      // New Zealand sorts first, and legitimately so: the Chatham Islands sit
      // east of the dateline, so its rings really do span most of the map. It
      // overlaps nothing, so painting it first costs nothing.
      const box = bbox(entry.rings.flat());
      built.push({
        iso,
        rings: entry.rings,
        extent: Math.max(box.width, box.height),
      });
      continue;
    }
    if (!entry.speck) {
      skipped.push(iso);
      continue;
    }
    // Everything this country has is sub-pixel. See MIN_COUNTRY_SIZE. The square
    // is not built yet: it may still have to move (see `nudgeSquares`).
    built.push({
      iso,
      square: { x: entry.speck.x, y: entry.speck.y },
      trueX: entry.speck.x,
      trueY: entry.speck.y,
      // The TRUE size, not the drawn one. Sorting on the drawn size made all 57
      // squares tie, and the alphabetical fallback then decided, by nothing at
      // all, that Sint Maarten paints over Anguilla — erasing it completely.
      extent: entry.speck.size,
    });
    enlarged.push(iso);
  }

  /**
   * Smallest country last.
   *
   * SVG paints in document order and hit-tests the topmost painted shape, so a
   * small country overlapped by a bigger one is only reachable if it is emitted
   * afterwards. Ordering on the **true** extent — the real size of the country,
   * not the size it happens to be drawn at — is what makes that rule hold for the
   * enlarged squares too: Liechtenstein is genuinely smaller than Switzerland, so
   * it paints on top of it, and Macao is genuinely smaller than Hong Kong.
   *
   * Consumers must render in `Object.keys(paths)` order. Insertion order is
   * preserved for non-numeric keys through `JSON.stringify` and `JSON.parse`
   * alike, so the ordering survives being served as a static file.
   */
  built.sort((a, b) => b.extent - a.extent || a.iso.localeCompare(b.iso));

  const nudge = nudgeSquares(built);

  const paths = {};
  for (const item of built) {
    const rings = item.rings ?? [squareRing(Math.round(item.square.x), Math.round(item.square.y))];
    paths[item.iso] = toPath(rings);
    item.rings = rings;
  }

  const atlas = {
    format: "training-tracker/geo-atlas@1",
    projection: "Equal Earth (Savric, Patterson & Jenny, 2019) — equal-area",
    source:
      "world-atlas v2 countries-50m.json (ISC, Mike Bostock), derived from Natural Earth 1:50m Admin 0 (public domain)",
    licence:
      "Geometry: public domain (Natural Earth) via ISC-licensed world-atlas. Generated by scripts/generate-geo-atlas.mjs; see public/geo/README.md.",
    generatedBy: "scripts/generate-geo-atlas.mjs",
    viewBox: `0 0 ${VIEW_WIDTH} ${viewHeight}`,
    /** ISO codes whose true outline is sub-pixel and is drawn as a fixed square. */
    enlarged: enlarged.sort(),
    /** Render in key order: paths are ordered biggest first so small ones stay on top. */
    order: "largest-first",
    /** Land that ISO 3166-1 gives no alpha-2 code; drawn as background, never coloured. */
    unclaimed,
    paths,
  };

  // ------------------------------------------------------------------
  // Checks run BEFORE the write, not after. The first version wrote the file
  // and then asserted, so a failing run still left the bad atlas on disk for
  // the next person to commit.
  // ------------------------------------------------------------------

  // A handful of well-known codes must be present and closed.
  const expected = ["US", "GB", "DE", "IN", "AU", "BR", "ZA", "JP", "SG", "HK"];
  const malformed = expected.filter(
    (iso) => !/^M[-\d ]/.test(paths[iso] ?? "") || !paths[iso].endsWith("Z")
  );
  if (malformed.length > 0) throw new Error(`sanity check failed for: ${malformed.join(", ")}`);

  // No ring may draw a line back across the map. See MAX_EDGE_DX.
  const seams = findSeams([...built.map((b) => ({ iso: b.iso, rings: b.rings }))], viewHeight);
  const unclaimedSeams = findSeams(
    unclaimed.map((d, i) => ({ iso: `unclaimed[${i}]`, rings: ringsFromPath(d) })),
    viewHeight
  );
  const allSeams = [...seams, ...unclaimedSeams];
  if (allSeams.length > 0) {
    throw new Error(
      `seam check failed — ${allSeams.length} edge(s) run more than ${MAX_EDGE_DX} units across the map:\n` +
        allSeams
          .slice(0, 10)
          .map((s) => `    ${s.iso}  dx=${s.dx}  [${s.from}] -> [${s.to}]`)
          .join("\n")
    );
  }

  // And every country must survive being painted over. See MIN_VISIBLE_FRACTION.
  const occlusion = occlusionReport(built, VIEW_WIDTH, viewHeight);
  const buried = occlusion
    .filter((row) => row.fraction < MIN_VISIBLE_FRACTION)
    .sort((a, b) => a.fraction - b.fraction);
  const tightest = occlusion.slice().sort((a, b) => a.fraction - b.fraction).slice(0, 8);
  const longestEdge = longestHonestEdge(built, viewHeight);

  if (buried.length > 0) {
    throw new Error(
      `occlusion check failed — ${buried.length} ${
        buried.length === 1 ? "country keeps" : "countries keep"
      } less than ${Math.round(MIN_VISIBLE_FRACTION * 100)}% of ${
        buried.length === 1 ? "its" : "their"
      } painted area:\n` +
        buried
          .map((row) => `    ${row.iso}  ${(row.fraction * 100).toFixed(1)}% visible`)
          .join("\n")
    );
  }

  writeFileSync(out, `${JSON.stringify(atlas)}\n`);

  const bytes = Buffer.byteLength(JSON.stringify(atlas));
  process.stdout.write(
    [
      `wrote ${out}`,
      `  ${(bytes / 1024).toFixed(1)} KiB`,
      `  viewBox        ${atlas.viewBox}`,
      `  ISO codes      ${Object.keys(paths).length}`,
      `  enlarged       ${enlarged.length} (${enlarged.join(" ") || "none"})`,
      `  nudged apart   ${nudge.squares} squares settled in ${nudge.passes} ${
        nudge.passes === 1 ? "pass" : "passes"
      }; furthest moved ${nudge.worst.toFixed(1)} units (${
        nudge.worstIso ?? "none"
      }); ${nudge.residual} residual overlaps`,
      `  unclaimed      ${unclaimed.length}`,
      `  skipped        ${skipped.length}${skipped.length ? ` (${skipped.join(", ")})` : ""}`,
      `  sanity         ${expected.join(" ")} all present and closed`,
      `  seams          none; longest non-polar edge ${longestEdge.dx} units (${longestEdge.iso})`,
      `  occlusion      all ${occlusion.length} countries keep >= ${Math.round(
        MIN_VISIBLE_FRACTION * 100
      )}% of their painted area`,
      `  tightest       ${tightest
        .map((row) => `${row.iso} ${(row.fraction * 100).toFixed(0)}%`)
        .join("  ")}`,
      "",
    ].join("\n")
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
