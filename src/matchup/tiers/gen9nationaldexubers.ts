// National Dex Ubers Viability Rankings, transcribed from Smogon's official
// VR thread (raw page text, not AI-summarized — verified against a second
// independent fetch of the same page for consistency):
// https://www.smogon.com/forums/threads/national-dex-ubers-viability-rankings-update-12-at-post-377.3712169/
// "Last Update: June 11th 2026" per the thread itself. The council updates
// this every few weeks to months — species names/tiers here WILL drift from
// the live thread over time. This is a plain, flat, easy-to-hand-edit data
// structure specifically so a stale entry can just be fixed directly rather
// than needing a re-scrape; there's no live-parsing of the forum page.
//
// Keys are real @pkmn/dex species names (mapped from the thread's
// abbreviations — e.g. "Zacian-C" -> "Zacian-Crowned", "Primal Groudon" ->
// "Groudon-Primal") so they resolve directly via speciesMeta()/calc.Pokemon.
export type VrTier = 'S+' | 'S' | 'S-' | 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D';

export const VR_TIER_SCORE: Record<VrTier, number> = {
  'S+': 13, S: 12, 'S-': 11,
  'A+': 10, A: 9, 'A-': 8,
  'B+': 7, B: 6, 'B-': 5,
  'C+': 4, C: 3, 'C-': 2,
  D: 0,
};

export const NATIONAL_DEX_UBERS_VR: Record<string, VrTier> = {
  // S+
  'Groudon-Primal': 'S+',
  // S
  'Zacian-Crowned': 'S',
  'Zygarde-Complete': 'S',
  // S-
  'Ho-Oh': 'S-',
  // A+
  'Arceus-Dark': 'A+',
  'Arceus-Ground': 'A+',
  Eternatus: 'A+',
  'Kyogre-Primal': 'A+',
  Marshadow: 'A+',
  Yveltal: 'A+',
  // A
  Arceus: 'A',
  Lunala: 'A',
  // A-
  Ditto: 'A-',
  'Necrozma-Dusk-Mane': 'A-',
  'Necrozma-Ultra': 'A-',
  'Salamence-Mega': 'A-',
  // B+
  'Arceus-Fairy': 'B+',
  'Calyrex-Ice': 'B+',
  'Chi-Yu': 'B+',
  'Deoxys-Attack': 'B+',
  Ferrothorn: 'B+',
  'Giratina-Origin': 'B+',
  Smeargle: 'B+',
  // B
  Alomomola: 'B',
  'Deoxys-Speed': 'B',
  'Diancie-Mega': 'B',
  Garganacl: 'B',
  Pheromosa: 'B',
  Rayquaza: 'B',
  // B-
  'Arceus-Water': 'B-',
  'Chien-Pao': 'B-',
  Fezandipiti: 'B-',
  Glimmora: 'B-',
  'Kyurem-Black': 'B-',
  'Landorus-Therian': 'B-',
  // C+
  'Arceus-Rock': 'C+',
  Basculegion: 'C+',
  Chansey: 'C+',
  Dondozo: 'C+',
  Giratina: 'C+',
  Kingambit: 'C+',
  Mewtwo: 'C+',
  'Mewtwo-Mega-Y': 'C+',
  Ribombee: 'C+',
  // C
  'Arceus-Flying': 'C',
  'Arceus-Ghost': 'C',
  'Arceus-Grass': 'C',
  Clefable: 'C',
  Grimmsnarl: 'C',
  Gothitelle: 'C',
  Hatterene: 'C',
  'Palkia-Origin': 'C',
  Shuckle: 'C',
  'Tapu Lele': 'C',
  // C-
  Cresselia: 'C-',
  'Darmanitan-Galar': 'C-',
  Dialga: 'C-',
  'Iron Treads': 'C-',
  'Kyurem-White': 'C-',
  Melmetal: 'C-',
  Terapagos: 'C-',
  'Ting-Lu': 'C-',
  'Tyranitar-Mega': 'C-',
  Zekrom: 'C-',
  // D — "unviable, but Ubers by tiering" per the thread. Kept explicit
  // (rather than just omitted) so these are decisively excluded, not
  // silently confused with a genuinely-unranked/never-discussed species.
  Annihilape: 'D',
  'Arceus-Bug': 'D',
  'Arceus-Dragon': 'D',
  'Arceus-Electric': 'D',
  'Arceus-Fighting': 'D',
  'Arceus-Fire': 'D',
  'Arceus-Ice': 'D',
  'Arceus-Poison': 'D',
  'Arceus-Psychic': 'D',
  'Arceus-Steel': 'D',
  Baxcalibur: 'D',
  Darkrai: 'D',
  Deoxys: 'D',
  'Dialga-Origin': 'D',
  Dracovish: 'D',
  Dragapult: 'D',
  Espathra: 'D',
  'Flutter Mane': 'D',
  Genesect: 'D',
  Groudon: 'D',
  'Gouging Fire': 'D',
  'Iron Bundle': 'D',
  Kyogre: 'D',
  Landorus: 'D',
  Lugia: 'D',
  Magearna: 'D',
  'Alakazam-Mega': 'D',
  'Blastoise-Mega': 'D',
  'Blaziken-Mega': 'D',
  'Kangaskhan-Mega': 'D',
  'Lucario-Mega': 'D',
  'Mewtwo-Mega-X': 'D',
  'Metagross-Mega': 'D',
  Naganadel: 'D',
  'Ogerpon-Hearthflame': 'D',
  'Necrozma-Dawn-Wings': 'D',
  Palafin: 'D',
  Palkia: 'D',
  Reshiram: 'D',
  'Roaring Moon': 'D',
  'Shaymin-Sky': 'D',
  Solgaleo: 'D',
  Spectrier: 'D',
  Sneasler: 'D',
  'Ursaluna-Bloodmoon': 'D',
  Urshifu: 'D',
  'Walking Wake': 'D',
  Zacian: 'D',
  'Zamazenta-Crowned': 'D',
};
