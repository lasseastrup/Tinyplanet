import { Rng, mixSeed } from '../core/rng';

const START = [
  'Ka', 'Ze', 'Lu', 'Mo', 'Vi', 'Ta', 'Ori', 'Ny', 'Pe', 'Sol', 'Ari', 'Bel', 'Cy', 'Dra', 'El', 'Fen', 'Gal', 'Hel',
  'Io', 'Ju', 'Kep', 'Lyr', 'Mir', 'No', 'Oph', 'Pyx', 'Qua', 'Rho', 'Syl', 'Tes', 'Ul', 'Vel', 'Wy', 'Xan', 'Yo', 'Zel',
  'Bo', 'Pi', 'Mu', 'Ko', 'Nim', 'Tu', 'Ama', 'Esk', 'Ilo', 'Umb',
];
const MID = ['ra', 'lo', 'mi', 'na', 've', 'ti', 'sa', 'ru', 'do', 'ne', 'li', 'ka', 'to', 'ri', 'zu', 'be', 'mo', 'ga'];
const END = ['n', 's', 'x', 'ra', 'ia', 'on', 'is', 'us', 'a', 'e', 'or', 'ix', 'um', 'ar', 'o', 'el', 'ine', 'ea'];
const SUFFIX = ['', '', '', '', '', ' Prime', ' Minor', ' II', ' III', ' IV', ' VII', ' b', ' c', ' d', '-9', ' Major'];

/** Cute pronounceable planet names, deterministic per seed. */
export function planetName(seed: number): string {
  const rng = new Rng(mixSeed(seed, 0xa11ce));
  let name = rng.pick(START);
  if (rng.chance(0.55)) name += rng.pick(MID);
  name += rng.pick(END);
  return name + rng.pick(SUFFIX);
}
