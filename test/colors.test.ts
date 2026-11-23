import { contrastRatio, lightColorNumber, readableTint } from '../src/common/colors';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
};
const hex = (n: number): string => `#${(n >>> 0).toString(16).padStart(6, '0')}`;

const DARK = 0x2a2a2a;   // Atlas' dark-theme badge plate
const LIGHT = 0xe3e3e3;  // Atlas' light-theme badge plate

const FIRE = 0xec7500;
const FROST = 0x8ad1f8;
const BOLT = 0x086ddd;
const MIST = 0xffffff;
const RADIANCE = 0xe0ac00;
const SHADOW = 0x7852ee;

// ---- the contrast the rule is decided by -----------------------------------------------------
{
  check('contrast: black on white is 21', Math.abs(contrastRatio(0x000000, 0xffffff) - 21) < 1e-9);
  check('contrast: a colour against itself is 1', Math.abs(contrastRatio(FIRE, FIRE) - 1) < 1e-9);
  check('contrast: order does not matter',
    Math.abs(contrastRatio(FIRE, DARK) - contrastRatio(DARK, FIRE)) < 1e-12);
  check('fire on the dark plate already contrasts enough (4.86)',
    contrastRatio(FIRE, DARK) >= 3, String(contrastRatio(FIRE, DARK)));
  check('lightning on the dark plate does not (2.90)',
    contrastRatio(BOLT, DARK) < 3, String(contrastRatio(BOLT, DARK)));
}

// ---- what Atlas leaves alone, and what it moves ----------------------------------------------
{
  check('dark plate: fire is left EXACTLY as it is',
    readableTint(FIRE, DARK) === FIRE, hex(readableTint(FIRE, DARK)));
  check('dark plate: frost is left alone', readableTint(FROST, DARK) === FROST);
  check('dark plate: mist is left alone', readableTint(MIST, DARK) === MIST);
  check('dark plate: radiance is left alone', readableTint(RADIANCE, DARK) === RADIANCE);
  check('dark plate: lightning is lifted to #0d70de',
    readableTint(BOLT, DARK) === 0x0d70de, hex(readableTint(BOLT, DARK)));
  check('dark plate: shadow is lifted to #7b56ee',
    readableTint(SHADOW, DARK) === 0x7b56ee, hex(readableTint(SHADOW, DARK)));
}

// ---- on a light plate it DARKENS, which the old code never did -------------------------------
{
  check('light plate: fire is DARKENED to #cc6500',
    readableTint(FIRE, LIGHT) === 0xcc6500, hex(readableTint(FIRE, LIGHT)));
  check('light plate: frost is darkened to #5987a1',
    readableTint(FROST, LIGHT) === 0x5987a1, hex(readableTint(FROST, LIGHT)));
  check('light plate: mist is darkened to #818181',
    readableTint(MIST, LIGHT) === 0x818181, hex(readableTint(MIST, LIGHT)));
  check('light plate: radiance is darkened to #a27c00',
    readableTint(RADIANCE, LIGHT) === 0xa27c00, hex(readableTint(RADIANCE, LIGHT)));
  check('light plate: lightning already contrasts, so it is left alone',
    readableTint(BOLT, LIGHT) === BOLT);
  check('light plate: shadow already contrasts, so it is left alone',
    readableTint(SHADOW, LIGHT) === SHADOW);
}

// ---- the properties that make it a tint and not a repaint ------------------------------------
{
  for (const [name, c] of [['fire', FIRE], ['frost', FROST], ['lightning', BOLT],
    ['mist', MIST], ['radiance', RADIANCE], ['shadow', SHADOW]] as const) {
    for (const [plateName, plate] of [['dark', DARK], ['light', LIGHT]] as const) {
      const tinted = readableTint(c, plate);
      check(`${name} on ${plate}: reaches contrast 3`,
        contrastRatio(tinted, plate) >= 3, String(contrastRatio(tinted, plate)));
      check(`${name} on ${plate}: applying it twice changes nothing`,
        readableTint(tinted, plate) === tinted, hex(readableTint(tinted, plate)));
    }
  }
  // The least mix that works: one halving less must fall short.
  const moved = readableTint(BOLT, DARK);
  check('the mix is minimal, not a fixed lerp', moved !== BOLT && contrastRatio(moved, DARK) < 3.1,
    String(contrastRatio(moved, DARK)));
}

// ---- reading a colour string -----------------------------------------------------------------
{
  check('lightColorNumber reads #rrggbb', lightColorNumber('#ec7500') === FIRE);
  check('lightColorNumber is case-insensitive', lightColorNumber('#EC7500') === FIRE);
  check('a name is not a hex: warm fallback', lightColorNumber('red') === 0xffcc66);
  check('a short hex is not #rrggbb: warm fallback', lightColorNumber('#f00') === 0xffcc66);
  check('nonsense: warm fallback', lightColorNumber('') === 0xffcc66);
}

console.log(failures === 0 ? '\nAll badge-colour checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);