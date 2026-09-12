// A real, recently-fetched-and-verified snapshot of the SV CAP Viability
// Rankings thread, shipped WITH the app as a last-resort fallback — NOT the
// primary source. buildCounterTeam (see ../team-builder.ts) always tries the
// live thread first (see ../vr-thread.ts), then the on-disk copy from
// whatever the last successful live fetch was; this only gets used when BOTH
// of those come up empty, which in practice means a deployment whose
// outbound IP is blocked by Smogon's forum bot-protection and has never once
// completed a live fetch (a hosted platform's shared egress IP — Render,
// Railway, Fly — is the common case; a home connection essentially never
// hits this).
//
// Fetched and parsed from the thread's first post on 2026-09-12 (103
// entries, cross-checked against the live parser's own output — see
// ../vr-thread.ts's parseVrThreadFirstPost/fetchLiveVrMap). Species names
// are already the real @pkmn/dex canonical names (resolved the same way the
// live parser resolves them), so no runtime resolution is needed here. This
// thread's own S rank was empty at fetch time (a "simplified" ranking
// system still in early SV CAP metagame stages, per the thread's own intro),
// and it has no separate +/- subranks under C — both are real facts about
// the thread, not a parsing gap.
// This WILL drift from the live thread over time — that's expected and fine
// for a last-resort fallback; if it's ever worth refreshing, just re-run
// fetchLiveVrMap from an unblocked network and paste its JSON output back in
// below.
import type { VrTier } from '../vr-thread.js';

export const GEN9_CAP_BUNDLED_VR: Record<string, VrTier> = {
  'Gliscor': 'S-',
  'Ting-Lu': 'S-',
  'Zamazenta': 'S-',
  'Arghonaut': 'A+',
  'Darkrai': 'A+',
  'Great Tusk': 'A+',
  'Hemogoblin': 'A+',
  'Kyurem': 'A+',
  'Ogerpon-Wellspring': 'A+',
  'Revenankh': 'A+',
  'Alomomola': 'A',
  'Cresceidon': 'A',
  'Dragapult': 'A',
  'Equilibra': 'A',
  'Garganacl': 'A',
  'Gholdengo': 'A',
  'Mollux': 'A',
  'Moltres': 'A',
  'Pecharunt': 'A',
  'Slowking-Galar': 'A',
  'Snaelstrom': 'A',
  'Clefable': 'A-',
  'Deoxys-Speed': 'A-',
  'Dragonite': 'A-',
  'Iron Moth': 'A-',
  'Kingambit': 'A-',
  'Kitsunoh': 'A-',
  'Tornadus-Therian': 'A-',
  'Caribolt': 'B+',
  'Ceruledge': 'B+',
  'Chuggalong': 'B+',
  'Corviknight': 'B+',
  'Hatterene': 'B+',
  'Heatran': 'B+',
  'Hydrapple': 'B+',
  'Landorus-Therian': 'B+',
  'Miasmaw': 'B+',
  'Ramnarok': 'B+',
  'Samurott-Hisui': 'B+',
  'Shox': 'B+',
  'Stratagem': 'B+',
  'Walking Wake': 'B+',
  'Weezing-Galar': 'B+',
  'Chromera': 'B',
  'Iron Crown': 'B',
  'Iron Valiant': 'B',
  'Krilowatt': 'B',
  'Latios': 'B',
  'Malaconda': 'B',
  'Naviathan': 'B',
  'Ogerpon': 'B',
  'Raging Bolt': 'B',
  'Rillaboom': 'B',
  'Skarmory': 'B',
  'Ursaluna': 'B',
  'Venomicon': 'B',
  'Zapdos': 'B',
  'Araquanid': 'B-',
  'Blissey': 'B-',
  'Cinderace': 'B-',
  'Dondozo': 'B-',
  'Enamorus': 'B-',
  'Garchomp': 'B-',
  'Glimmora': 'B-',
  'Latias': 'B-',
  'Lokix': 'B-',
  'Meowscarada': 'B-',
  'Ogerpon-Cornerstone': 'B-',
  'Primarina': 'B-',
  'Rotom-Wash': 'B-',
  'Serperior': 'B-',
  'Tyranitar': 'B-',
  'Volcanion': 'B-',
  'Weavile': 'B-',
  'Arcanine-Hisui': 'C',
  'Astrolotl': 'C',
  'Barraskewda': 'C',
  'Cawmodore': 'C',
  'Clodsire': 'C',
  'Colossoil': 'C',
  'Cyclohm': 'C',
  'Excadrill': 'C',
  'Fidgit': 'C',
  'Hawlucha': 'C',
  'Hoopa-Unbound': 'C',
  'Iron Hands': 'C',
  'Jumbao': 'C',
  'Kerfluffle': 'C',
  'Lilligant-Hisui': 'C',
  'Manaphy': 'C',
  'Necturna': 'C',
  'Ninetales': 'C',
  'Ninetales-Alola': 'C',
  'Pelipper': 'C',
  'Pyroak': 'C',
  'Scizor': 'C',
  'Sinistcha': 'C',
  'Skeledirge': 'C',
  'Tinkaton': 'C',
  'Tomohawk': 'C',
  'Toxapex': 'C',
  'Venomicon-Epilogue': 'C',
  'Venusaur': 'C',
};
