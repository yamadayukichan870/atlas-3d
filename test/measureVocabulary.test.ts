import {
  atlasModeOf,
  atlasModeOfLegacy,
  atlasShapeOf,
  isAtlasMode,
  isAtlasShape,
  isLegacyShape,
  legacyShapeOf,
  shapeOfMode,
  LEGACY_SHAPES,
  type LegacyShape,
} from '../src/atlas/measureVocabulary';
import { ATLAS_MEASURE_MODES, ATLAS_MEASURE_SHAPES } from '../src/atlas/measureRules';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};

// ---- THE BUG THIS MODULE EXISTS TO MAKE IMPOSSIBLE -------------------------------------------
{
  check('atlasShapeOf("line") is line, NOT ruler',
    atlasShapeOf('line') === 'line', String(atlasShapeOf('line')));
  check('a kept rectangle keeps its shape through the Atlas door',
    atlasShapeOf('line') === 'line' && shapeOfMode(atlasShapeOf('line')!) === 'line');
  check('the legacy door still reads its own line as a ruler',
    atlasModeOfLegacy('line') === 'ruler');
  check('the two doors give DIFFERENT answers for "line" — that is the point',
    atlasShapeOf('line') !== atlasModeOfLegacy('line'));
}

// ---- every Atlas shape reads as itself -------------------------------------------------------
{
  for (const shape of ATLAS_MEASURE_SHAPES) {
    check(`atlasShapeOf("${shape}") is itself`, atlasShapeOf(shape) === shape, String(atlasShapeOf(shape)));
  }
  for (const mode of ATLAS_MEASURE_MODES) {
    check(`atlasModeOf("${mode}") is itself`, atlasModeOf(mode) === mode, String(atlasModeOf(mode)));
  }
}

// ---- strict: a legacy name is refused, not guessed -------------------------------------------
{
  check('atlasShapeOf("sphere") is null, not circle', atlasShapeOf('sphere') === null);
  check('atlasShapeOf("cube") is null, not square', atlasShapeOf('cube') === null);
  check('atlasShapeOf("ranges") is null — a mode is not a shape', atlasShapeOf('ranges') === null);
  check('atlasModeOf("ranges") is ranges', atlasModeOf('ranges') === 'ranges');
  check('atlasShapeOf("nonsense") is null', atlasShapeOf('nonsense') === null);
  check('atlasShapeOf(undefined) is null', atlasShapeOf(undefined) === null);
  check('atlasShapeOf(7) is null', atlasShapeOf(7) === null);
  check('atlasShapeOf(null) is null', atlasShapeOf(null) === null);
}

// ---- case and space are tolerated, names are not translated ----------------------------------
{
  check('case is tolerated', atlasShapeOf('LINE') === 'line');
  check('space is tolerated', atlasShapeOf('  line  ') === 'line');
  check('an alias is NOT translated', atlasShapeOf('beam') === null);
}

// ---- ranges is a mode, never a persisted shape -----------------------------------------------
{
  check('shapeOfMode("ranges") is null', shapeOfMode('ranges') === null);
  for (const shape of ATLAS_MEASURE_SHAPES) {
    check(`shapeOfMode("${shape}") is itself`, shapeOfMode(shape) === shape);
  }
}

// ---- the legacy pair is lossy, and only in one direction -------------------------------------
{
  check('legacyShapeOf("ruler") is line', legacyShapeOf('ruler') === 'line');
  check('legacyShapeOf("line") is line', legacyShapeOf('line') === 'line');
  check('ruler and line COLLIDE on the way out',
    legacyShapeOf('ruler') === legacyShapeOf('line'));
  check('legacyShapeOf("ranges") is line (the fallback)', legacyShapeOf('ranges') === 'line');
  for (const shape of LEGACY_SHAPES) {
    const mode = atlasModeOfLegacy(shape);
    check(`legacy "${shape}" -> "${mode}" -> legacy is itself`,
      legacyShapeOf(mode) === shape, `${shape} -> ${mode} -> ${legacyShapeOf(mode)}`);
  }
  // The round trip that LOSES: an Atlas line goes out as 'line' and comes back as a ruler.
  check('an Atlas line does NOT survive the legacy round trip (documented loss)',
    atlasModeOfLegacy(legacyShapeOf('line')) !== 'line');
}

// ---- guards -----------------------------------------------------------------------------------
{
  check('isAtlasShape narrows', isAtlasShape('cone') && !isAtlasShape('cube'));
  check('isAtlasMode narrows', isAtlasMode('ranges') && !isAtlasMode('sphere'));
  check('isLegacyShape narrows', isLegacyShape('sphere') && !isLegacyShape('ruler'));
  const legacy: LegacyShape = 'cube';
  check('LegacyShape is assignable from its own union', atlasModeOfLegacy(legacy) === 'square');
}

console.log(failures === 0 ? '\nAll vocabulary checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);