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
 * this size on its centroid. Singapore is 0.4 degrees across: at any scale a world
 * map is drawn, its true outline is a fraction of a pixel — unseeable and
 * unclickable. Every ISO code in the atlas must be visible and selectable or the
 * map silently refuses to answer questions about small countries, which for this
 * app (Singapore, Hong Kong, Malta, Bahrain, Luxembourg) is most of the
 * interesting ones. Natural Earth ships a separate "tiny countries" point layer
 * for the same reason. The substituted codes are listed in the asset's
 * `enlarged` field so the distortion is stated rather than hidden.
 */
const MIN_COUNTRY_SIZE = 9;

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

/** Douglas-Peucker, iterative so a long arc cannot blow the stack. */
function simplify(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const toleranceSq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
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
  return points.filter((_, i) => keep[i] === 1);
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
 * Bring rings that run off the side of the map back onto it.
 *
 * Natural Earth keeps a landmass that straddles the antimeridian contiguous by
 * letting its longitude run past 180 (Russia's Chukotka reaches 191E, and the
 * Aleutians and Fiji do the same in the other direction), so projecting
 * faithfully puts real land outside the viewBox — Chukotka simply vanished on the
 * first attempt. A ring that leaves the frame is therefore emitted at every
 * whole-map offset that puts some of it back inside, so the part past the
 * antimeridian reappears on the opposite edge, which is where it belongs. The
 * outer `<svg>`'s own viewBox crops the rest; no `clip-path` is involved, which
 * matters because the PDF capture cannot carry one (`lib/chart-capture.ts`).
 */
function wrapRings(rings, width) {
  const out = [];
  for (const ring of rings) {
    const box = bbox(ring);
    if (box.minX >= 0 && box.maxX <= width) {
      out.push(ring);
      continue;
    }
    for (const offset of [0, -width, width]) {
      if (box.maxX + offset < 0 || box.minX + offset > width) continue;
      out.push(offset === 0 ? ring : ring.map(([x, y]) => [x + offset, y]));
    }
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

  // 3. Project each arc, then simplify and round it. Rounding after simplification
  //    (not before) keeps the tolerance meaningful in the space it is expressed in.
  //    The unsimplified projection is kept as well: it is what decides whether a
  //    country is too small to draw, a judgement that must not be made from
  //    geometry the simplifier has already flattened.
  const trueArcs = geoArcs.map((arc) => arc.map(toView));
  const viewArcs = trueArcs.map((arc) =>
    simplify(arc, SIMPLIFY_TOLERANCE).map(([x, y]) => [Math.round(x), Math.round(y)])
  );

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
      // Judge the ring on its true projected size, not on the simplified copy:
      // a ring the simplifier has flattened to two points looks small because it
      // was flattened, not because it is small.
      const trueRing = stitch(indices, trueArcs);
      if (trueRing.length === 0) continue;
      const box = bbox(trueRing);
      const size = Math.hypot(box.width, box.height);
      // `< 3` catches an island the source itself quantised down to a couple of
      // points.
      if (trueRing.length < 3 || size < MIN_RING_SIZE) {
        noteSpeck(box, size);
        continue;
      }
      const ring = dedupe(stitch(indices, viewArcs));
      // Big enough to keep, but simplification and integer rounding left fewer
      // than three distinct vertices — so there is nothing to fill. It is a speck
      // after all, and saying so is what keeps Bahrain, Dominica, Curacao and Guam
      // on the map; treating it as "drawn" is what lost them on the first attempt.
      if (ring.length < 3) noteSpeck(box, size);
      else rings.push(ring);
    }

    if (!iso) {
      // Uncoded land is drawn as background so the map has no holes, but it gets
      // no size guarantee: nothing can select it, so an invisible one costs
      // nothing. Only the coded countries have to be reachable.
      if (rings.length > 0) unclaimed.push(toPath(wrapRings(rings, VIEW_WIDTH)));
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
      // Extent measured before wrapping: a wrapped copy spans the whole map by
      // construction, which would sort New Zealand as the largest country on
      // Earth and bury whatever sits under it.
      const box = bbox(entry.rings.flat());
      built.push({
        iso,
        d: toPath(wrapRings(entry.rings, VIEW_WIDTH)),
        extent: Math.max(box.width, box.height),
      });
      continue;
    }
    if (!entry.speck) {
      skipped.push(iso);
      continue;
    }
    // Everything this country has is sub-pixel. See MIN_COUNTRY_SIZE.
    const cx = Math.round(entry.speck.x);
    const cy = Math.round(entry.speck.y);
    const r = Math.round(MIN_COUNTRY_SIZE / 2);
    const square = [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];
    built.push({ iso, d: toPath(wrapRings([square], VIEW_WIDTH)), extent: MIN_COUNTRY_SIZE });
    enlarged.push(iso);
  }

  /**
   * Biggest first, so the smallest countries are the last paths in the file.
   *
   * SVG paints in document order and hit-tests the topmost painted shape, and an
   * enlarged square (Monaco, Vatican City, Macao) necessarily overlaps the large
   * neighbour it sits inside. Emitting small last is what keeps those countries
   * clickable rather than buried under France, Italy and Hong Kong. Consumers
   * must therefore render in `Object.keys(paths)` order — insertion order is
   * preserved for non-numeric keys through JSON.stringify and JSON.parse alike,
   * so the ordering survives being served as a static file.
   */
  built.sort((a, b) => b.extent - a.extent || a.iso.localeCompare(b.iso));
  const paths = {};
  for (const { iso, d } of built) paths[iso] = d;

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

  writeFileSync(out, `${JSON.stringify(atlas)}\n`);

  const bytes = Buffer.byteLength(JSON.stringify(atlas));
  process.stdout.write(
    [
      `wrote ${out}`,
      `  ${(bytes / 1024).toFixed(1)} KiB`,
      `  viewBox        ${atlas.viewBox}`,
      `  ISO codes      ${Object.keys(paths).length}`,
      `  enlarged       ${enlarged.length} (${enlarged.join(" ") || "none"})`,
      `  unclaimed      ${unclaimed.length}`,
      `  skipped        ${skipped.length}${skipped.length ? ` (${skipped.join(", ")})` : ""}`,
      "",
    ].join("\n")
  );

  // Cheap self-check: a handful of well-known codes must be present and closed.
  const expected = ["US", "GB", "DE", "IN", "AU", "BR", "ZA", "JP", "SG", "HK"];
  const bad = expected.filter((iso) => !/^M[-\d ]/.test(paths[iso] ?? "") || !paths[iso].endsWith("Z"));
  if (bad.length > 0) throw new Error(`sanity check failed for: ${bad.join(", ")}`);
  process.stdout.write(`  sanity         ${expected.join(" ")} all present and closed\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
