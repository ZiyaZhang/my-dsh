/**
 * The art of my dsh's banner: the whale at its laptop, and Instrument Serif (SIL Open Font License 1.1, see
 * art/OFL-InstrumentSerif.txt) for the name and the numbers, cut down to the letters of "my dsh" in italic and to the digits, the
 * point, the comma and the space upright. The build inlines all three as data URLs.
 */
import whale from './art/whale-work.svg';
import serifItalic from './art/instrument-serif-italic-mydsh.woff2';
import serifDigits from './art/instrument-serif-digits.woff2';

export const WHALE_AT_WORK: string = whale;

/** The two faces under a family name of the plugin's own, so no other text on the page picks them up. */
export const ART_FACES = [
  `@font-face{font-family:"mydsh-serif";font-style:italic;font-weight:400;font-display:block;src:url(${serifItalic}) format("woff2")}`,
  `@font-face{font-family:"mydsh-serif";font-style:normal;font-weight:400;font-display:block;src:url(${serifDigits}) format("woff2")}`,
].join('\n');
